import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { RemoteControlInstanceRegistry } from '../remoteControl/remoteControlInstanceRegistry'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { PathCompare } from '../shared/pathCompare'
import { ErrnoCode } from '../shared/errnoCode'
import type { SvnStepKind } from './worktreeState'

export interface WorktreeLeaseFile {
  instanceId: string
  pid: number
  processBirth?: string
  purpose: SvnStepKind | 'finish' | 'removal'
  takenAt: number
  token: string
}

export class WorktreeLeaseHeld extends Error {}

export class WorktreeLease {
  private static currentBirth: Promise<string | undefined> | undefined
  private readonly instanceId: string
  private readonly registry: typeof RemoteControlInstanceRegistry.readComplete
  private readonly alive: (pid: number) => boolean
  private readonly svnProcesses: () => Promise<number[]>
  private readonly writers = new AsyncLocalStorage<Map<string, { unproved: boolean; spawned(pid: number): void }>>()
  private readonly scope = new AsyncLocalStorage<ReadonlySet<string>>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly activeWriters = new Set<string>()

  constructor(instanceId: string, registry = RemoteControlInstanceRegistry.readComplete,
    alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true }
      catch (error) { return ErrnoCode.of(error) !== 'ESRCH' }
    }, svnProcesses = WorktreeLease.machineSvnProcesses) {
    this.instanceId = instanceId
    this.registry = registry
    this.alive = alive
    this.svnProcesses = svnProcesses
  }

  static rootOf(path: string): string | null {
    let current = resolve(path)
    while (dirname(current) !== current) {
      if (basename(dirname(current)) === '.worktrees') return current
      current = dirname(current)
    }
    return null
  }

  static fileOf(root: string): string {
    const worktree = WorktreeLease.rootOf(root)
    return worktree === null ? join(resolve(root), '.worktrees', '.leases', 'main.json') : join(dirname(worktree), '.leases', `${basename(worktree)}.json`)
  }

  async take(root: string, purpose: WorktreeLeaseFile['purpose'], checkedWriter?: string): Promise<
    { ok: true; release(): Promise<void> } | { ok: false; heldBy: WorktreeLeaseFile }> {
    const file = WorktreeLease.fileOf(root)
    await this.assertNoWriter(file, checkedWriter)
    await mkdir(dirname(file), { recursive: true })
    const processBirth = await WorktreeLease.ownBirth()
    const lease: WorktreeLeaseFile = { instanceId: this.instanceId, pid: process.pid, processBirth, purpose, takenAt: Date.now(), token: randomUUID() }
    const candidate = `${file}.${lease.token}.candidate`
    await writeFile(candidate, JSON.stringify(lease), { encoding: 'utf8', flag: 'wx' })
    try {
      try { await link(candidate, file) }
      catch (error) {
        if (ErrnoCode.of(error) !== 'EEXIST') throw error
        const previous = await WorktreeLease.read(file)
        if (previous === null) throw new Error('The lease owner disappeared; retry acquisition')
        let holder = previous
        // Immutable claims serialize retirement without an ownerless lock creation window.
        const seen = new Set<string>()
        for (;;) {
          if (seen.has(holder.token) || seen.size >= 64) throw new Error('Invalid lease takeover chain; takeover is refused')
          seen.add(holder.token)
          if (await this.ownerAlive(holder))
            return { ok: false, heldBy: holder }
          await this.assertNoWriter(file, checkedWriter)
          const claim = `${file}.${holder.token}.takeover`
          try { await link(candidate, claim); break }
          catch (claimError) {
            if (ErrnoCode.of(claimError) !== 'EEXIST') throw claimError
            const next = await WorktreeLease.read(claim)
            if (next === null) throw new Error('The lease takeover evidence disappeared')
            holder = next
          }
        }
        const latest = await WorktreeLease.read(file)
        if (latest !== null && latest.token !== previous.token) return { ok: false, heldBy: latest }
        if (latest !== null) await WorktreeLease.removeFile(file, previous.token)
        try { await link(candidate, file) }
        catch (installError) {
          if (ErrnoCode.of(installError) !== 'EEXIST') throw installError
          const installed = await WorktreeLease.read(file)
          if (installed === null) throw new Error('The lease owner disappeared during takeover')
          return { ok: false, heldBy: installed }
        }
      }
      let releasing: Promise<void> | undefined
      return { ok: true, release: () => releasing ??= (async () => {
        const latest = await WorktreeLease.read(file)
        if (latest?.token === lease.token) await WorktreeLease.removeFile(file, lease.token)
      })() }
    } finally { await WorktreeLease.removeFile(candidate) }
  }

  private async assertNoWriter(file: string, checkedWriter?: string): Promise<void> {
    try {
      const marker = await readFile(`${file}.writer`, 'utf8')
      if (checkedWriter !== undefined && marker === checkedWriter) return
      let saved: { pid?: number; processBirth?: string; instanceId?: string; children?: number[] } | undefined
      try { saved = JSON.parse(marker) } catch { /* An incomplete identity cannot authorize recovery. */ }
      if (Number.isSafeInteger(saved?.pid) && saved!.pid! > 0 && typeof saved?.instanceId === 'string'
        && !await this.ownerAlive({ pid: saved!.pid!, processBirth: saved?.processBirth, instanceId: saved.instanceId })
        && Array.isArray(saved.children) && saved.children.length > 0
        && saved.children.every((pid) => Number.isSafeInteger(pid) && pid > 0 && !this.alive(pid))) {
        await WorktreeLease.removeFile(`${file}.writer`)
        return
      }
      throw new WorktreeLeaseHeld(`SVN writer termination is unproved. Inspect the recorded process owner and retained command log before recovery. Marker: ${file}.writer. ${marker}`)
    } catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error }
  }

  heldRoot(cwd: string): string | undefined {
    return [...this.scope.getStore() ?? []].filter((root) => PathCompare.isInside(root, cwd)).sort((left, right) => right.length - left.length)[0]
  }

  heldRootsFor(cwd: string): string[] {
    return [...this.scope.getStore() ?? []].filter((root) => PathCompare.isInside(root, cwd) || PathCompare.isInside(cwd, root)).sort()
  }

  /**
   * Work started under a held lease that must not carry it, such as the UPDATE a Finish starts as it
   * ends: the async scope would hand its every svn write the leases of a worktree already removed.
   */
  outside<T>(work: () => Promise<T>): Promise<T> {
    return this.scope.exit(() => this.writers.exit(work))
  }

  async checkAndRelease(root: string): Promise<void> {
    const file = WorktreeLease.fileOf(root), key = PathCompare.comparable(file)
    const marker = await readFile(`${file}.writer`, 'utf8').catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
    if (marker === null) return
    if (this.activeWriters.has(key)) throw new WorktreeLeaseHeld('An SVN writer is still active; wait for its command to exit')
    let saved: Partial<WorktreeLeaseFile> & { children?: number[] }
    try { saved = JSON.parse(marker) } catch { throw new WorktreeLeaseHeld(`The writer marker is unreadable. Inspect ${file}.writer with a compatible client.`) }
    if (!Number.isSafeInteger(saved.pid) || typeof saved.instanceId !== 'string')
      throw new WorktreeLeaseHeld(`The writer marker has no verifiable owner. Inspect ${file}.writer with a compatible client.`)
    if (!(saved.pid === process.pid && saved.instanceId === this.instanceId)
      && await this.ownerAlive({ pid: saved.pid!, processBirth: saved.processBirth, instanceId: saved.instanceId }))
      throw new WorktreeLeaseHeld('The writer owner is still alive; stop or reconnect that client before recovery')
    const children = Array.isArray(saved.children) && saved.children.length > 0
      && saved.children.every((pid) => Number.isSafeInteger(pid) && pid > 0) ? saved.children : null
    if (children !== null) {
      const running = children.filter((pid) => this.alive(pid))
      if (running.length > 0)
        throw new WorktreeLeaseHeld(`The interrupted SVN writer still runs (process ${running.join(', ')}); wait for it to end, then try again`)
    }
    // A marker without children lost its client between writing the marker and recording the spawn.
    // Windows can still rule out every svn process of the machine; elsewhere nothing proves the end.
    else if (process.platform === 'win32') {
      const active = await this.svnProcesses()
      if (active.length > 0)
        throw new WorktreeLeaseHeld(`SVN processes are still running (${active.join(', ')}); wait before releasing the writer marker`)
    } else throw new WorktreeLeaseHeld('Cannot prove that the old SVN writer has exited; inspect its recorded processes first')
    const lease = await this.take(root, 'cleanup', marker)
    if (!lease.ok) throw new WorktreeLeaseHeld('Another owner is using this working copy')
    try {
      if (await readFile(`${file}.writer`, 'utf8') !== marker) throw new WorktreeLeaseHeld('The writer marker changed during inspection')
      await WorktreeLease.removeFile(`${file}.writer`)
    } finally { await lease.release() }
  }

  async writer<T>(root: string, work: (closed: () => void, spawned: (pid: number) => void) => Promise<T>): Promise<T> {
    const file = WorktreeLease.fileOf(root), key = PathCompare.comparable(file)
    const nested = this.writers.getStore()?.get(key)
    if (nested !== undefined) {
      let closed = false
      let spawned = false
      try { return await work(() => { closed = true }, (pid) => { spawned = true; nested.spawned(pid) }) }
      finally { if (spawned && !closed) nested.unproved = true }
    }
    const owner = await WorktreeLease.read(file)
    if (owner?.instanceId !== this.instanceId || owner.pid !== process.pid) throw new Error('An SVN writer requires its current lease owner')
    const marker = `${file}.writer`
    await writeFile(marker, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', flush: true })
    this.activeWriters.add(key)
    const children = new Set<number>()
    const proof = { unproved: false, spawned: (pid: number) => {
      children.add(pid)
      writeFileSync(marker, JSON.stringify({ ...owner, children: [...children] }), { encoding: 'utf8', flush: true })
    } }
    let closed = false
    try { return await this.writers.run(new Map([...this.writers.getStore() ?? [], [key, proof]]), () => work(() => { closed = true }, proof.spawned)) }
    finally {
      this.activeWriters.delete(key)
      if ((closed || children.size === 0) && !proof.unproved) await WorktreeLease.removeFile(marker, owner.token)
    }
  }

  private static async machineSvnProcesses(): Promise<number[]> {
    const output = await new Promise<string>((accept, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='svn.exe'\" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],
    // A CIM query under load has taken more than 5 s here, the same budget as the Host's descendant query.
    { windowsHide: true, timeout: 10_000 }, (error, stdout) => error === null ? accept(stdout) : reject(error)))
    const active: unknown = output.trim() === '' ? [] : JSON.parse(output)
    if (typeof active === 'number') return [active]
    if (!Array.isArray(active) || active.some((pid) => !Number.isSafeInteger(pid)))
      throw new WorktreeLeaseHeld(`The list of svn processes is unreadable: ${output.trim()}`)
    return active
  }

  private async ownerAlive(owner: Pick<WorktreeLeaseFile, 'pid' | 'processBirth' | 'instanceId'>): Promise<boolean> {
    if (!this.alive(owner.pid)) return this.registry().some((entry) => entry.instanceId === owner.instanceId)
    if (owner.processBirth === undefined) return true
    const birth = await (owner.pid === process.pid ? WorktreeLease.ownBirth()
      : WorktreeLease.birth(owner.pid)).catch(() => undefined)
    return birth === undefined || birth === owner.processBirth
  }

  private static async ownBirth(): Promise<string | undefined> {
    const pending = WorktreeLease.currentBirth ??= WorktreeLease.birth(process.pid).catch(() => undefined)
    const birth = await pending
    if (birth === undefined && WorktreeLease.currentBirth === pending) WorktreeLease.currentBirth = undefined
    return birth
  }

  private static async birth(pid: number): Promise<string> {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const birth = stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/)[19]
      if (!/^\d+$/.test(birth ?? '')) throw new Error('Cannot read process birth identity')
      return birth
    }
    const windows = process.platform === 'win32'
    if (!windows && process.platform !== 'darwin') throw new Error('Process birth identity is unavailable on this platform')
    const output = await new Promise<string>((accept, reject) => execFile(windows ? 'powershell.exe' : 'ps', windows
      ? ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`]
      : ['-p', String(pid), '-o', 'lstart='], { windowsHide: true, timeout: 5000 },
    (error, stdout) => error === null ? accept(stdout.trim()) : reject(error)))
    if (output.length === 0) throw new Error('Cannot read process birth identity')
    return output
  }

  async within<T>(root: string, purpose: WorktreeLeaseFile['purpose'], work: () => Promise<T>, wait = true): Promise<T> {
    const key = PathCompare.comparable(WorktreeLease.rootOf(root) ?? root)
    const held = this.scope.getStore()
    if (held?.has(key)) return work()
    if (!wait && this.queues.has(key)) throw new WorktreeLeaseHeld('Another SVN operation is still running for this root. Wait for it to finish, then retry.')
    const previous = this.queues.get(key) ?? Promise.resolve()
    let releaseQueue: () => void = () => {}
    const completed = new Promise<void>((done) => { releaseQueue = done })
    this.queues.set(key, completed)
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    try {
      await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => reject(new WorktreeLeaseHeld('Another SVN operation is still running for this root. Wait for it to finish, then retry.')), 15_000)
      })])
    } catch (error) {
      void previous.finally(() => { releaseQueue(); if (this.queues.get(key) === completed) this.queues.delete(key) })
      throw error
    } finally { if (timer !== undefined) globalThis.clearTimeout(timer) }
    try {
      await this.checkAndRelease(root)
      const lease = await this.take(root, purpose)
      if (!lease.ok) throw new WorktreeLeaseHeld(`The worktree SVN lease is held by ${lease.heldBy.instanceId} (${lease.heldBy.purpose})`)
      try { return await this.scope.run(new Set([...held ?? [], key]), work) }
      finally { await lease.release() }
    } finally {
      releaseQueue()
      if (this.queues.get(key) === completed) this.queues.delete(key)
    }
  }

  private static async removeFile(file: string, token?: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (token !== undefined && (await WorktreeLease.read(file))?.token !== token) return
        await unlink(file)
        return
      } catch (error) {
        if (ErrnoCode.of(error) === 'ENOENT') return
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(ErrnoCode.of(error) ?? '') || attempt >= 5) throw error
        await setTimeout(20 * 2 ** attempt)
      }
    }
  }

  private static async read(file: string): Promise<WorktreeLeaseFile | null> {
    let text: string
    try { text = await readFile(file, 'utf8') }
    catch (error) { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error }
    const value = JSON.parse(text) as Partial<WorktreeLeaseFile>
    if (typeof value.instanceId !== 'string' || !value.instanceId || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1
      || typeof value.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token) || !Number.isFinite(value.takenAt)
      || !['checkout', 'update', 'cleanup', 'status', 'diff', 'commit', 'revert', 'resolve', 'finish', 'removal'].includes(value.purpose ?? ''))
      throw new Error('The worktree lease is invalid; takeover is refused')
    return value as WorktreeLeaseFile
  }
}

/**
 * The svn state of a worktree: its hash, and per status path its item, properties and BASE revision
 * with a digest of the rest, so a changed hash can name the paths that changed. `locked` are the
 * paths an svn command holds, or left for `svn cleanup` when it died.
 */
export interface WorktreeSvnState {
  hash: string
  entries: Record<string, string>
  locked: string[]
}

export class WorktreeFingerprint {
  static readonly infoKeyConst = '(svn info)'
  private static readonly lockConst = '@_wc-locked'

  static of(info: string, status: string): string {
    return WorktreeFingerprint.stateOf(info, status).hash
  }

  /**
   * A working-copy lock is no part of the state: a running svn command holds one, and a command that
   * died leaves it for `svn cleanup`. Recovery cleans up after its own interrupted write, which the
   * guard would otherwise refuse as a change made outside Jamat. Unlocked states hash as before.
   */
  static stateOf(info: string, status: string): WorktreeSvnState {
    const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false })
    if (XMLValidator.validate(info) !== true || XMLValidator.validate(status) !== true) throw new Error('Invalid SVN fingerprint XML')
    // Lower case as written before svn ran under the on-disk casing, so a stored fingerprint still matches.
    info = info.replace(/<wcroot-abspath>([^<]*)<\/wcroot-abspath>/g, (_whole, path: string) => `<wcroot-abspath>${path.toLowerCase()}</wcroot-abspath>`)
    const facts = WorktreeFingerprint.ordered(parser.parse(info))
    const raw: unknown = parser.parse(status)
    const states = new Map<string, string[]>()
    const locked: string[] = []
    for (const { path, state } of WorktreeFingerprint.entriesOf(raw)) {
      const name = path.replace(/\\/g, '/')
      if (state[WorktreeFingerprint.lockConst] === 'true') locked.push(name)
      const ordered = WorktreeFingerprint.ordered(state) as Record<string, unknown>
      const props = String(ordered['@_props'] ?? 'none')
      const summary = `${String(ordered['@_item'] ?? 'none')}${props === 'none' || props === 'normal' ? '' : ` props ${props}`}`
        + `${ordered['@_revision'] === undefined ? '' : ` r${String(ordered['@_revision'])}`}`
      states.set(name, [...states.get(name) ?? [], `${summary} #${WorktreeFingerprint.digest(ordered)}`])
    }
    const entries: Record<string, string> = { [WorktreeFingerprint.infoKeyConst]: `#${WorktreeFingerprint.digest(facts)}` }
    for (const [name, values] of states) entries[name] = values.sort().join(' + ')
    return { hash: createHash('sha256').update(JSON.stringify([facts, WorktreeFingerprint.ordered(raw)])).digest('hex'), entries, locked }
  }

  static async read(svn: CommandRunner, root: string): Promise<string> {
    return (await WorktreeFingerprint.state(svn, root)).hash
  }

  static async state(svn: CommandRunner, root: string): Promise<WorktreeSvnState> {
    // The on-disk casing: svn finds a node of an enclosing working copy only under its recorded case,
    // and one casing keeps the fingerprint stable across callers.
    root = await realpath(resolve(root)).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return resolve(root); throw error })
    const info = await svn.run(root, ['info', '--xml', '--depth', 'empty', '--', '.'])
    const status = await svn.run(root, ['status', '-v', '--xml', '--', '.'])
    if (info.code !== 0 || info.failure !== null || status.code !== 0 || status.failure !== null)
      throw new Error(`Cannot read SVN state: ${info.stderr} ${status.stderr}`)
    return WorktreeFingerprint.stateOf(info.stdout, status.stdout)
  }

  /** The status paths whose recorded state differs between two readings, in path order. */
  static changed(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort()
  }

  /** `src/a.txt: normal r4 -> modified r4`, one changed path as a person reads it. */
  static describe(path: string, before: string | undefined, after: string | undefined): string {
    const shown = (value: string) => value.split(' + ').map((part) => part.replace(/ ?#[0-9a-f]+$/, '')).join(' + ')
    if (before === undefined) return `${path}: new, ${shown(after!)}`
    if (after === undefined) return `${path}: gone, was ${shown(before)}`
    return shown(before) === shown(after) ? `${path}: svn metadata changed` : `${path}: ${shown(before)} -> ${shown(after)}`
  }

  private static entriesOf(parsed: unknown): { path: string; state: Record<string, unknown> }[] {
    const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
    const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    const status = record(record(parsed)?.status)
    if (status === null) return []
    return [...list(status.target), ...list(status.changelist)].flatMap((group) => list(record(group)?.entry)).flatMap((value) => {
      const entry = record(value)
      const state = record(entry?.['wc-status'])
      return typeof entry?.['@_path'] === 'string' && state !== null ? [{ path: entry['@_path'], state }] : []
    })
  }

  private static digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
  }

  private static ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(WorktreeFingerprint.ordered).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== WorktreeFingerprint.lockConst)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, WorktreeFingerprint.ordered(item)]))
    return value
  }
}
