import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteControlInstanceRegistration } from '../remoteControl/remoteControlInstanceRegistry'
import { WorktreeFingerprint, WorktreeLease } from './worktreeLease'
import { WorktreeSvnCommands } from './worktreeSvnCommands'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'jamat-lease-'))
  directories.push(directory)
  return join(directory, '.worktrees', 'tree')
}
function registered(instanceId: string): RemoteControlInstanceRegistration {
  return { schemaVersion: 1, instanceId, pid: process.pid, configIdentity: 'test', runtimeChannel: 'development', startedAt: 1,
    applicationVersion: 'test', descriptorFile: join(tmpdir(), 'descriptor') }
}

describe('WorktreeLease', () => {
  it('retries unknown own birth while a writer marker prevents reaching take', async () => {
    const original = Reflect.get(WorktreeLease, 'currentBirth')
    Reflect.set(WorktreeLease, 'currentBirth', undefined)
    const birth = vi.spyOn(WorktreeLease as unknown as { birth(pid: number): Promise<string> }, 'birth').mockResolvedValue('own-birth')
    try {
      const path = await root(), owner = new WorktreeLease('old-owner', () => [])
      expect((await owner.take(path, 'update')).ok).toBe(true)
      const file = WorktreeLease.fileOf(path), saved = { ...JSON.parse(await readFile(file, 'utf8')), processBirth: 'reused-pid' }
      await writeFile(file, JSON.stringify(saved))
      await writeFile(`${file}.writer`, JSON.stringify({ ...saved, children: [999999] }))
      Reflect.set(WorktreeLease, 'currentBirth', undefined)
      birth.mockRejectedValueOnce(new Error('Temporary inspection failure'))
      const next = new WorktreeLease('new-owner', () => [])
      await expect(next.take(path, 'update')).rejects.toThrow('termination is unproved')
      const recovered = await next.take(path, 'update')
      expect(recovered.ok).toBe(true)
      if (recovered.ok) await recovered.release()
    } finally { birth.mockRestore(); Reflect.set(WorktreeLease, 'currentBirth', original) }
  })
  it('retries a failed own birth query on the next lease instead of caching unknown forever', async () => {
    const original = Reflect.get(WorktreeLease, 'currentBirth')
    Reflect.set(WorktreeLease, 'currentBirth', undefined)
    const birth = vi.spyOn(WorktreeLease as unknown as { birth(pid: number): Promise<string> }, 'birth')
      .mockRejectedValueOnce(new Error('Temporary process query timeout')).mockResolvedValue('recovered-birth')
    try {
      const path = await root(), lease = new WorktreeLease('retry-birth', () => [])
      const first = await lease.take(path, 'update')
      expect(first.ok).toBe(true)
      if (first.ok) await first.release()
      const second = await lease.take(path, 'update')
      expect(second.ok).toBe(true)
      expect(JSON.parse(await readFile(WorktreeLease.fileOf(path), 'utf8')).processBirth).toBe('recovered-birth')
      if (second.ok) await second.release()
    } finally { birth.mockRestore(); Reflect.set(WorktreeLease, 'currentBirth', original) }
  })
  it('marks every held project when a coordinated writer runs from their common parent', async () => {
    const tree = await root(), scope = join(tree, '..', '..'), roots = [join(scope, 'one'), join(scope, 'two')]
    const lease = new WorktreeLease('coordinated', () => [])
    const run = vi.fn(async () => {
      for (const root of roots) expect(JSON.parse(await readFile(`${WorktreeLease.fileOf(root)}.writer`, 'utf8')).instanceId).toBe('coordinated')
      return { code: 0, failure: null, stdout: '', stderr: '', closed: true }
    })
    const commands = new WorktreeSvnCommands({ run }, lease, async () => 'stop')
    await lease.within(roots[0], 'commit', () => lease.within(roots[1], 'commit', () => commands.run(scope, ['commit', '--', 'one/a', 'two/b'])))
    for (const root of roots) await expect(readFile(`${WorktreeLease.fileOf(root)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('takes over a lease whose live PID now belongs to a different process birth', async () => {
    const path = await root(), owner = new WorktreeLease('old', () => [])
    const original = await owner.take(path, 'update')
    expect(original.ok).toBe(true)
    const file = WorktreeLease.fileOf(path), saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.processBirth).toEqual(expect.any(String))
    await writeFile(file, JSON.stringify({ ...saved, processBirth: 'earlier-process-with-reused-pid' }))
    const next = await new WorktreeLease('new', () => [registered('old')]).take(path, 'update')
    expect(next.ok).toBe(true)
    if (next.ok) await next.release()
  })
  it('removes outer and nested markers when preflight throws without starting a writer', async () => {
    const path = await root(), lease = new WorktreeLease('owner', () => [])
    await expect(lease.within(path, 'update', () => lease.writer(path, () => lease.writer(path, async () => {
      throw new Error('svn state changed outside Jamat')
    })))).rejects.toThrow('changed outside')
    await expect(readFile(`${WorktreeLease.fileOf(path)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await new WorktreeLease('restarted', () => []).take(path, 'update')
    expect(next.ok).toBe(true)
    if (next.ok) await next.release()
  })

  it('ignores a historical main-copy fingerprint across two commits with edits', async () => {
    const tree = await root(), main = join(tree, '..', '..'), lease = new WorktreeLease('owner', () => [])
    await mkdir(join(main, '.worktrees', '.leases'), { recursive: true })
    const fingerprint = `${WorktreeLease.fileOf(main)}.fingerprint`
    await writeFile(fingerprint, 'old fingerprint')
    const outside = vi.fn(async () => 'stop' as const)
    const run = vi.fn(async () => ({ code: 0, failure: null, stdout: '', stderr: '', closed: true }))
    const commands = new WorktreeSvnCommands({ run }, lease, outside)
    for (const text of ['first edit', 'second edit']) {
      await writeFile(join(main, 'file'), text)
      await lease.within(main, 'commit', () => commands.run(main, ['commit']))
    }
    expect(run).toHaveBeenCalledTimes(2)
    expect(outside).not.toHaveBeenCalled()
    expect(await readFile(fingerprint, 'utf8')).toBe('old fingerprint')
  })
  it('queues concurrent calls in one owner and releases the queue after a failure', async () => {
    const path = await root(), lease = new WorktreeLease('one', () => [])
    const order: string[] = []
    let finish: () => void = () => {}
    const wait = new Promise<void>((done) => { finish = done })
    const first = lease.within(path, 'update', async () => { order.push('first'); await wait; throw new Error('expected failure') })
    const second = lease.within(path, 'finish', async () => { order.push('second') })
    await vi.waitFor(() => expect(order).toEqual(['first']))
    finish()
    await expect(first).rejects.toThrow('expected failure')
    await second
    expect(order).toEqual(['first', 'second'])
  })

  it.each([true, false])('recovers a retained writer only when its recorded SVN child is dead (%s)', async (alive) => {
    const path = await root(), owner = new WorktreeLease('owner', () => [])
    await owner.within(path, 'update', () => owner.writer(path, async (_closed, spawned) => { spawned(999999) }))
    const next = new WorktreeLease('next', () => [], (pid) => pid === 999999 && alive)
    if (alive) await expect(next.take(path, 'update')).rejects.toThrow('termination is unproved')
    else {
      const held = await next.take(path, 'update')
      expect(held.ok).toBe(true)
      if (held.ok) await held.release()
      await expect(readFile(`${WorktreeLease.fileOf(path)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('refuses a live lease without requiring a complete registry scan', async () => {
    const path = await root(), first = await new WorktreeLease('one', () => []).take(path, 'update')
    const registry = vi.fn(() => { throw new Error('The instance registry is incomplete') })
    expect(await new WorktreeLease('two', registry).take(path, 'finish')).toMatchObject({ ok: false, heldBy: { instanceId: 'one' } })
    expect(registry).not.toHaveBeenCalled()
    if (first.ok) await first.release()
  })
  it('keeps main-root lease and fingerprint runtime inside its owned ignored worktree directory', async () => {
    const worktree = await root(), main = join(worktree, '..', '..')
    expect(WorktreeLease.fileOf(main)).toBe(join(main, '.worktrees', '.leases', 'main.json'))
    expect(WorktreeLease.fileOf(worktree)).toBe(join(main, '.worktrees', '.leases', 'tree.json'))
    const first = await new WorktreeLease('one', () => []).take(main, 'update')
    expect((await new WorktreeLease('two', () => []).take(main, 'update')).ok).toBe(false)
    if (first.ok) await first.release()
  })
  it('retains unproved writer termination and removes the marker only after confirmed command close', async () => {
    const path = await root(), lease = new WorktreeLease('owner', () => [])
    await lease.within(path, 'update', async () => {
      await lease.writer(path, async (closed) => {
        expect(await readFile(`${WorktreeLease.fileOf(path)}.writer`, 'utf8')).toContain('owner')
        await expect(new WorktreeLease('other', () => [], () => false).take(path, 'update')).rejects.toThrow('termination is unproved')
        closed()
      })
      await expect(readFile(`${WorktreeLease.fileOf(path)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await lease.within(path, 'update', () => lease.writer(path, async (_closed, spawned) => { spawned(process.pid) }))
    await expect(new WorktreeLease('next', () => []).take(path, 'update')).rejects.toThrow('Marker:')
  })
  it('proves an interrupted writer ended by its recorded children, not by any svn process on the machine (UA1-J13-2)', async () => {
    const path = await root(), file = WorktreeLease.fileOf(path), marker = `${file}.writer`
    await mkdir(join(path, '..', '.leases'), { recursive: true })
    const owner = { instanceId: 'old-client', pid: 999_991, purpose: 'update', takenAt: 1, token: randomUUID() }
    const running = new Set<number>()
    const machine = vi.fn(async () => [4242])
    const lease = new WorktreeLease('new-client', () => [], (pid) => running.has(pid), machine)
    await writeFile(marker, JSON.stringify({ ...owner, children: [999_992] }))
    await lease.checkAndRelease(path)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(machine).not.toHaveBeenCalled()
    running.add(999_992)
    await writeFile(marker, JSON.stringify({ ...owner, children: [999_992] }))
    await expect(lease.checkAndRelease(path)).rejects.toThrow('999992')
    expect(machine).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'win32')('falls back to the svn processes of the machine for a marker that names no child', async () => {
    const path = await root(), marker = `${WorktreeLease.fileOf(path)}.writer`
    await mkdir(join(path, '..', '.leases'), { recursive: true })
    const machine = vi.fn(async () => [4242])
    const lease = new WorktreeLease('new-client', () => [], () => false, machine)
    await writeFile(marker, JSON.stringify({ instanceId: 'old-client', pid: 999_991, purpose: 'update', takenAt: 1, token: randomUUID() }))
    await expect(lease.checkAndRelease(path)).rejects.toThrow('4242')
    machine.mockResolvedValue([])
    await lease.checkAndRelease(path)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not launch after an ambiguous existing writer marker, including an empty marker', async () => {
    const path = await root(), lease = new WorktreeLease('owner', () => [])
    await lease.within(path, 'update', async () => {
      await writeFile(`${WorktreeLease.fileOf(path)}.writer`, '')
      const work = vi.fn()
      await expect(lease.writer(path, work)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(work).not.toHaveBeenCalled()
    })
    await expect(new WorktreeLease('next', () => [], () => false).take(path, 'update')).rejects.toThrow('termination is unproved')
  })
  it('does not clear ambiguous marker removal failure or nested unproved writes', async () => {
    const path = await root(), lease = new WorktreeLease('owner', () => []), marker = `${WorktreeLease.fileOf(path)}.writer`
    await expect(lease.within(path, 'update', () => lease.writer(path, async (closed) => {
      await unlink(marker)
      await mkdir(marker)
      closed()
    }))).rejects.toThrow()
    await expect(new WorktreeLease('other', () => [], () => false).take(path, 'update')).rejects.toThrow()
    await rm(marker, { recursive: true })
    await lease.within(path, 'update', () => lease.writer(path, async (closed) => {
      await lease.writer(path, async (_closed, spawned) => { spawned(process.pid) })
      closed()
    }))
    await expect(new WorktreeLease('other', () => []).take(path, 'update')).rejects.toThrow('termination is unproved')
  })
  it('marks every managed write and reuses the writer proof within a main-root lease', async () => {
    const path = await root(), main = join(path, '..', '..'), lease = new WorktreeLease('owner', () => [])
    const run = vi.fn(async (_cwd: string, args: string[]) => {
      if (!['info', 'status'].includes(args[0])) {
        expect(await readFile(`${WorktreeLease.fileOf(main)}.writer`, 'utf8')).toContain('owner')
        await expect(readFile(`${WorktreeLease.fileOf(path)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      return { code: 0, failure: null, closed: true, stdout: args[0] === 'info' ? '<info/>' : args[0] === 'status' ? '<status/>' : '', stderr: '' }
    })
    const commands = new WorktreeSvnCommands({ run }, lease, async () => 'stop' as const)
    await lease.within(main, 'update', async () => {
      for (const command of ['add', 'revert', 'resolve', 'update']) await lease.writer(main, async (closed) => {
        await commands.run(main, [command, '--', '.'])
        closed()
      })
    })
    await expect(readFile(`${WorktreeLease.fileOf(main)}.writer`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('recovers a crash after a takeover claim and before retiring the old lease', async () => {
    const path = await root()
    await new WorktreeLease('old', () => []).take(path, 'update')
    const file = WorktreeLease.fileOf(path)
    const old = JSON.parse(await readFile(file, 'utf8'))
    const dead = { ...old, instanceId: 'crashed-claimant', token: randomUUID(), pid: 987654 }
    await writeFile(file, JSON.stringify({ ...old, pid: 987654 }))
    await writeFile(`${file}.${old.token}.takeover`, JSON.stringify(dead))
    const next = await new WorktreeLease('next', () => [], (pid) => pid === process.pid).take(path, 'update')
    expect(next.ok).toBe(true)
    if (next.ok) await next.release()
    // A crash after retirement leaves no lease, so installation can start normally.
    const afterRetirement = await new WorktreeLease('next', () => []).take(path, 'update')
    expect(afterRetirement.ok).toBe(true)
    if (afterRetirement.ok) await afterRetirement.release()
  })

  it('releases once and never removes a subsequent owner on a repeated release', async () => {
    const path = await root()
    const first = await new WorktreeLease('first', () => []).take(path, 'update')
    if (!first.ok) throw new Error('Expected lease')
    const releasing = first.release()
    expect(first.release()).toBe(releasing)
    await releasing
    const second = await new WorktreeLease('second', () => []).take(path, 'update')
    await first.release()
    expect(JSON.parse(await readFile(WorktreeLease.fileOf(path), 'utf8')).instanceId).toBe('second')
    if (second.ok) await second.release()
  })

  it('refuses cyclic, excessive and path-like takeover tokens', async () => {
    const path = await root()
    await new WorktreeLease('old', () => []).take(path, 'update')
    const file = WorktreeLease.fileOf(path)
    const old = JSON.parse(await readFile(file, 'utf8'))
    const contender = new WorktreeLease('next', () => [], () => false)
    await writeFile(`${file}.${old.token}.takeover`, JSON.stringify(old))
    await expect(contender.take(path, 'update')).rejects.toThrow('takeover chain')
    let holder = old
    for (let index = 0; index < 64; index++) {
      const next = { ...old, token: randomUUID() }
      await writeFile(`${file}.${holder.token}.takeover`, JSON.stringify(next))
      holder = next
    }
    await expect(contender.take(path, 'update')).rejects.toThrow('takeover chain')
    await writeFile(file, JSON.stringify({ ...old, token: '../../outside' }))
    await expect(contender.take(path, 'update')).rejects.toThrow('lease is invalid')
  })
  it('refuses a registered holder, takes over an absent dead holder, and checks release tokens', async () => {
    const path = await root()
    let registry = [registered('first')]
    const first = await new WorktreeLease('first', () => registry, () => false).take(path, 'update')
    expect(first.ok).toBe(true)
    const second = new WorktreeLease('second', () => registry, () => false)
    expect(await second.take(path, 'commit')).toMatchObject({ ok: false, heldBy: { instanceId: 'first' } })
    registry = [registered('second')]
    const takeover = await second.take(path, 'commit')
    expect(takeover.ok).toBe(true)
    if (!first.ok || !takeover.ok) throw new Error('Expected leases')
    await first.release()
    expect(JSON.parse(await readFile(WorktreeLease.fileOf(path), 'utf8')).instanceId).toBe('second')
    await takeover.release()
  })

  it('allows startup before registration but refuses stealing its live process', async () => {
    const path = await root()
    const first = await new WorktreeLease('starting', () => { throw new Error('not registered') }).take(path, 'cleanup')
    expect(first.ok).toBe(true)
    expect(await new WorktreeLease('second', () => [], () => true).take(path, 'update')).toMatchObject({ ok: false })
    if (first.ok) await first.release()
  })

  it('fails closed on incomplete registry or malformed lease evidence', async () => {
    const path = await root()
    await new WorktreeLease('first', () => []).take(path, 'cleanup')
    await expect(new WorktreeLease('second', () => { throw new Error('registry incomplete') }, () => false).take(path, 'update'))
      .rejects.toThrow('registry incomplete')
    await writeFile(WorktreeLease.fileOf(path), '{')
    await expect(new WorktreeLease('second', () => [], () => false).take(path, 'update')).rejects.toThrow()
  })

  it('permits only one concurrent stale takeover and reuses nested scopes', async () => {
    const path = await root()
    await new WorktreeLease('old', () => []).take(path, 'update')
    const old = JSON.parse(await readFile(WorktreeLease.fileOf(path), 'utf8'))
    await writeFile(WorktreeLease.fileOf(path), JSON.stringify({ ...old, pid: 987654 }))
    const results = await Promise.allSettled(['a', 'b'].map((id) => new WorktreeLease(id, () => [], (pid) => pid === process.pid).take(path, 'commit')))
    expect(results.filter((entry) => entry.status === 'fulfilled' && entry.value.ok)).toHaveLength(1)
    const winner = results.find((entry) => entry.status === 'fulfilled' && entry.value.ok)
    if (winner?.status === 'fulfilled' && winner.value.ok) await winner.value.release()
    const lease = new WorktreeLease('nested', () => [])
    expect(WorktreeLease.fileOf(join(path, 'shared', 'external'))).toBe(WorktreeLease.fileOf(path))
    await expect(lease.within(path, 'finish', () => lease.within(join(path, 'shared', 'external'), 'update', async () => 42))).resolves.toBe(42)
  })

  it('normalizes XML attribute order but retains revisions and property/conflict facts', () => {
    const info = '<info><entry revision="1" path="."/></info>'
    const status = '<status><entry path="a"><wc-status item="modified" props="normal" revision="1"/></entry></status>'
    expect(WorktreeFingerprint.of(info, status)).toBe(WorktreeFingerprint.of('<info><entry path="." revision="1"/></info>',
      '<status><entry path="a"><wc-status revision="1" props="normal" item="modified"/></entry></status>'))
    expect(WorktreeFingerprint.of('<info><entry path="."><wc-info><wcroot-abspath>Q:/Projects</wcroot-abspath></wc-info></entry></info>', status))
      .toBe(WorktreeFingerprint.of('<info><entry path="."><wc-info><wcroot-abspath>q:/projects</wcroot-abspath></wc-info></entry></info>', status))
    for (const changed of [status.replace('normal', 'conflicted'), status.replace('revision="1"', 'revision="2"')])
      expect(WorktreeFingerprint.of(info, changed)).not.toBe(WorktreeFingerprint.of(info, status))
  })

  it.skipIf(process.platform !== 'win32')('keeps the fingerprint stable when a held main-copy lease uses normalized path casing', async () => {
    const svn = { run: async (cwd: string, args: string[]) => ({ code: 0, failure: null, stderr: '',
      stdout: args[0] === 'info' ? `<info><entry path="${cwd}" revision="1"/></info>` : '<status/>' }) }
    const main = await mkdtemp(join(tmpdir(), 'Jamat-Main-'))
    try {
      const cwds: string[] = []
      const recording = { run: async (cwd: string, args: string[]) => { cwds.push(cwd); return svn.run(cwd, args) } }
      expect(await WorktreeFingerprint.read(recording, main.toUpperCase())).toBe(await WorktreeFingerprint.read(recording, main.toLowerCase()))
      // svn looks a node of an enclosing working copy up by its recorded case; a lowercased cwd was "not found".
      expect(new Set(cwds)).toEqual(new Set([await realpath(main)]))
    } finally { await rm(main, { recursive: true, force: true }) }
  })

  it('detects outside changes, then accepts explicit ready and permits sync', async () => {
    const path = await root()
    let status = '<status><entry path="a"><wc-status item="normal" revision="1"/></entry></status>'
    let decision: 'accept' | 'stop' = 'stop'
    const outside = vi.fn(async () => decision)
    const run = vi.fn(async (_cwd: string, args: string[]) => ({ code: 0, failure: null,
      stdout: args[0] === 'info' ? '<info><entry revision="1"/></info>' : args[0] === 'status' ? status : '', stderr: '' }))
    const commands = new WorktreeSvnCommands({ run }, new WorktreeLease('self', () => []), outside)
    await commands.run(path, ['checkout', 'url', '.'])
    status = status.replace('normal', 'modified')
    await expect(commands.run(path, ['update'])).rejects.toThrow('changed outside Jamat')
    expect(outside).toHaveBeenCalledOnce()
    await commands.accept(path)
    await expect(commands.run(path, ['update'])).resolves.toMatchObject({ code: 0 })
    status = status.replace('modified', 'conflicted')
    await expect(commands.run(path, ['--username', 'status', 'revert', 'a'])).rejects.toThrow('changed outside Jamat')

    // Before any review the worker's own svn work is the new baseline, and the command runs.
    decision = 'accept'
    await expect(commands.run(path, ['update'])).resolves.toMatchObject({ code: 0 })
    decision = 'stop'
    await expect(commands.run(path, ['update'])).resolves.toMatchObject({ code: 0 })
  })

  /** UA1-J09-1: a killed `svn commit` left its lock in `lib/ea`; the stop named the agent's own older edit of the root. */
  describe('after an interrupted own write', () => {
    const entry = (path: string, state: string) => `<entry path="${path}"><wc-status ${state}/></entry>`
    const before = `<status><target path=".">${entry('.', 'item="normal" revision="1"')}${entry('src\\config.json', 'item="modified" revision="1"')}`
      + `${entry('lib\\ea', 'item="external"')}${entry('lib\\ea', 'item="normal" revision="1"')}${entry('lib\\ea\\version.txt', 'item="modified" revision="1"')}</target></status>`
    const locked = before.replace(`${entry('lib\\ea', 'item="normal" revision="1"')}`, entry('lib\\ea', 'wc-locked="true" item="normal" revision="1"'))
    async function guarded() {
      const path = await root()
      let status = before
      const outside = vi.fn(async (_root: string, _reason: string) => 'stop' as const)
      const run = vi.fn(async (_cwd: string, args: string[]) => ({ code: 0, failure: null, stderr: '',
        stdout: args[0] === 'info' ? '<info><entry revision="1"/></info>' : args[0] === 'status' ? status : '' }))
      const commands = new WorktreeSvnCommands({ run }, new WorktreeLease('self', () => []), outside)
      await commands.run(path, ['checkout', 'url', '.'])
      return { path, commands, outside, run, set: (value: string) => { status = value } }
    }

    it('takes no lock for an outside change, so its own cleanup runs', async () => {
      const h = await guarded()
      h.set(locked)
      expect(WorktreeFingerprint.of('<info/>', locked)).toBe(WorktreeFingerprint.of('<info/>', before))
      await expect(h.commands.run(h.path, ['cleanup', '--', '.'])).resolves.toMatchObject({ code: 0 })
      expect(h.outside).not.toHaveBeenCalled()
    })

    it('names the path that changed, in an external as well, and the lock, not an edit that was there before', async () => {
      const h = await guarded()
      h.set(locked.replace('</target>', `${entry('lib\\ea\\notes.txt', 'item="modified" revision="1"')}</target>`))
      await expect(h.commands.run(h.path, ['cleanup', '--', '.'])).rejects.toThrow('changed outside Jamat')
      const reason = h.outside.mock.calls[0][1]
      expect(reason).toContain('lib/ea/notes.txt')
      expect(reason).toMatch(/locked.*lib\/ea/)
      expect(reason).not.toContain('config.json')
    })

    it('accepts what the interrupted write may have changed on its own paths, and still stops for any other path', async () => {
      const h = await guarded()
      h.set(locked.replace(entry('lib\\ea\\version.txt', 'item="modified" revision="1"'), entry('lib\\ea\\version.txt', 'item="normal" revision="2"')))
      await h.commands.acceptInterrupted(join(h.path, 'lib', 'ea'), [join(h.path, 'lib', 'ea', 'version.txt')])
      await expect(h.commands.run(join(h.path, 'lib', 'ea'), ['cleanup', '--', '.'])).resolves.toMatchObject({ code: 0 })
      expect(h.outside).not.toHaveBeenCalled()
      h.set(before.replace('item="modified" revision="1"/></entry><entry path="lib\\ea"', 'item="conflicted" revision="1"/></entry><entry path="lib\\ea"'))
      await expect(h.commands.acceptInterrupted(join(h.path, 'lib', 'ea'), [join(h.path, 'lib', 'ea', 'version.txt')])).rejects.toThrow('changed outside Jamat')
      expect(h.outside.mock.calls[0][1]).toContain('src/config.json: modified r1 -> conflicted r1')
      expect(h.outside.mock.calls[0][1]).not.toContain('version.txt')
    })
  })
})
