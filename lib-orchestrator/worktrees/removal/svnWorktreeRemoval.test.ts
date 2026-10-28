import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TreeRemovalHeld, TreeRemovalListener } from '../../shared/treeRemoval'
import type { SvnRemovalRow, SvnResult, SvnWorktreeLocation } from '../../svn/svn.types'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SessionStepProgress } from '../../sessionManager/sessionManagerApi.types'
import { type SessionStepFacts, SessionStepWords } from '../../sessionManager/worktreeSessionRuntime'
import { type SvnRemovalPort, SvnWorktreeRemoval } from './svnWorktreeRemoval'
import { WorktreeContentCopy } from './worktreeContentCopy'
import type { WorktreeHolderLookup } from './worktreeFileHolders'

describe('lib-orchestrator/sessionManager/lifecycle/svnWorktreeRemoval', () => {
  const ownerConst = 'Q:\\Work\\App'
  const worktreeConst = `${ownerConst}\\.worktrees\\014-fix`
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  class FakeSvn implements SvnRemovalPort {
    readonly log: string[] = []
    rename: 'renamed' | 'in-use' | 'absent' | { ok: false; detail: string } = 'renamed'
    purge: 'removed' | 'undeleted' = 'removed'
    /** A file the purge meets held, reported before it ends. */
    held: TreeRemovalHeld | null = null
    rows: SvnRemovalRow[] = []

    async removalSource(location: SvnWorktreeLocation) { return { ok: true as const, value: { path: location.worktreePath, aside: false, present: true } } }

    async removalStatus(): Promise<SvnResult<SvnRemovalRow[]>> { return { ok: true, value: this.rows } }

    renameAside(location: SvnWorktreeLocation): ReturnType<SvnRemovalPort['renameAside']> {
      this.log.push(`renameAside ${location.worktreePath} ${location.directoryId ?? '-'}`)
      return Promise.resolve(typeof this.rename === 'string'
        ? { ok: true, value: this.rename }
        : { ok: false, code: 'refused', detail: this.rename.detail })
    }

    purgeAside(_location: SvnWorktreeLocation, onProgress?: TreeRemovalListener): Promise<SvnResult<'removed' | 'undeleted'>> {
      this.log.push('purgeAside')
      onProgress?.({ phase: 'counting', done: 2, total: null })
      onProgress?.({ phase: 'counting', done: 3, total: null })
      onProgress?.({ phase: 'deleting', done: 2, total: 3 })
      if (this.held !== null) onProgress?.({ phase: 'deleting', done: 2, total: 3, held: this.held })
      else onProgress?.({ phase: 'deleting', done: 3, total: 3 })
      return Promise.resolve({ ok: true, value: this.purge })
    }

    removeEmptyWorktreesDir(ownerDir: string): Promise<void> {
      this.log.push(`removeEmptyWorktreesDir ${ownerDir}`)
      return Promise.resolve()
    }
  }

  async function harness(overrides: Partial<SessionRecord> = {}, beforeQueue?: (store: SessionRecordsStore) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-removal-'))
    created.push(root)
    const store = await SessionRecordsStore.load(join(root, 'session-records.json'), { snapshotsDirectory: join(root, 'snapshots') })
    const worktree = { worktreePath: worktreeConst, branch: 'https://svn.test/app/trunk', baseCommit: 'r10', repositoryRoot: ownerConst, kind: 'svn' as const, directoryId: '1:2:3' }
    await store.put({
      sessionId: 's1', kind: 'shell', title: 't', createdAt: 0, life: 'ended', binding: null, directory: { mode: 'default' },
      worktree, worktreeCleanup: { phase: 'pending', trigger: 'committed', requestedAt: 1, attempts: 1 }, ...overrides,
    })
    const svn = new FakeSvn()
    const steps: { sessionId: string; facts: SessionStepFacts; progress: SessionStepProgress | null }[] = []
    const holders = {
      lookup: { kind: 'none' } as WorktreeHolderLookup,
      asked: [] as string[],
      below(path: string) { this.asked.push(path); return Promise.resolve(this.lookup) },
    }
    const removal = new SvnWorktreeRemoval({
      holders,
      skillRoots: [join(root, 'skills')],
      results: { savedDirectoryOf: (id) => join(root, 'results', id, 'saved') },
      records: store,
      svn,
      onQueue: async (work) => {
        await beforeQueue?.(store)
        return work()
      },
      changed: () => undefined,
      steps: { at: (sessionId, facts, progress = null) => { steps.push({ sessionId, facts, progress }) } },
      now: () => 7_000,
    })
    return { root, store, svn, removal, steps, holders, location: SvnWorktreeRemoval.locationOf(worktree) }
  }

  it.each([{ allowed: [] }, { allowed: ['setup.lock'] }])('keeps a late file even when its setup path was allowed: %j', async ({ allowed }) => {
    const h = await harness()
    h.svn.rows = [{ path: 'setup.lock', kind: 'item', conflict: false, ignored: false }]
    expect(await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed }, 'action-1'))
      .toEqual({ state: 'kept', blocked: true, lines: ['KEPT: changed after the check: setup.lock'] })
    expect(h.svn.log.some((line) => line.startsWith('renameAside'))).toBe(false)
  })

  it('makes no copies while rename is held and ignored output keeps changing', async () => {
    const h = await harness(), root = join(h.root, 'worktree')
    mkdirSync(root)
    h.svn.rows = [{ path: 'dev.log', ignored: true, kind: 'clean', conflict: false }]
    h.svn.rename = 'in-use'
    for (let attempt = 0; attempt < 4; attempt++) {
      writeFileSync(join(root, 'dev.log'), `output ${attempt}`)
      expect(await h.removal.remove('s1', { ...h.location, worktreePath: root }, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
        .toMatchObject({ state: 'in-use' })
    }
    expect(existsSync(join(h.root, 'results', 'action-1', 'ignored'))).toBe(false)
  })

  it('resumes copying an intact renamed worktree but refuses changed content after purge began', async () => {
    const h = await harness(), root = join(h.root, 'worktree'), aside = `${root}.deleting`
    mkdirSync(root)
    mkdirSync(join(h.root, 'outside'))
    symlinkSync(join(h.root, 'outside'), join(root, 'link'), 'junction')
    writeFileSync(join(root, 'dev.log'), 'retained output')
    h.svn.removalSource = async () => ({ ok: true, value: { path: existsSync(aside) ? aside : root, aside: existsSync(aside), present: true } })
    h.svn.renameAside = async () => { if (existsSync(root)) renameSync(root, aside); return { ok: true, value: 'renamed' } }
    h.svn.rows = [{ path: 'link/private', kind: 'clean', conflict: false, ignored: true }]
    const location = { ...h.location, worktreePath: root }, permit = { kind: 'clean' as const, provedAt: 1, allowed: [] }
    expect(await h.removal.remove('s1', location, [], permit, 'action-1')).toMatchObject({ state: 'kept', blocked: true })
    expect(readFileSync(join(aside, 'dev.log'), 'utf8')).toBe('retained output')
    // An older build persisted the directory identity, but not the preservation action.
    await h.store.update('s1', (record) => ({ ...record, worktree: { ...record.worktree!, preservationActionId: undefined } }))
    h.svn.rows = [{ path: 'dev.log', kind: 'clean', conflict: false, ignored: true }]
    h.svn.purge = 'undeleted'
    const restarted = new SvnWorktreeRemoval({ records: h.store, svn: h.svn, onQueue: (work) => work(),
      changed: () => {}, steps: { at: () => {} }, skillRoots: [], results: { savedDirectoryOf: (id) => join(h.root, 'results', id, 'saved') } })
    expect(await restarted.remove('s1', location, [], permit, 'different-action')).toMatchObject({ state: 'undeleted' })
    const destination = join(h.root, 'results', 'action-1')
    expect(JSON.parse(readFileSync(join(destination, 'removal-copy.json'), 'utf8'))).toMatchObject({ stage: 'purge', attempts: 2 })
    writeFileSync(join(aside, 'dev.log'), 'late edit after purge started')
    expect(await restarted.remove('s1', location, [], permit, 'action-1')).toMatchObject({ state: 'kept', blocked: true,
      lines: [expect.stringContaining(`partially removed worktree ${aside} changed since its saved copy: dev.log (changed)`),
        `The partly deleted worktree lies at ${aside}; nothing more of it was deleted.`] })
    expect(readFileSync(join(aside, 'dev.log'), 'utf8')).toBe('late edit after purge started')
  })

  it('saves a later discard under its own action when an earlier attempt stopped before the rename', async () => {
    const h = await harness(), root = join(h.root, 'worktree')
    mkdirSync(root)
    writeFileSync(join(root, 'a.txt'), 'changed')
    h.svn.rows = [{ path: 'a.txt', kind: 'item', conflict: false, ignored: false }]
    const location = { ...h.location, worktreePath: root }
    expect(await h.removal.remove('s1', location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'finish-1')).toMatchObject({ state: 'kept', blocked: true })
    expect(await h.removal.remove('s1', location, [], { kind: 'discard', by: 'person', at: 1 }, 'discard-9')).toMatchObject({ state: 'removed' })
    expect(existsSync(join(h.root, 'results', 'finish-1', 'discarded'))).toBe(false)
    expect(existsSync(join(h.root, 'results', 'discard-9', 'discarded'))).toBe(true)
  })

  it('allows a personal discard of dirty content', async () => {
    const h = await harness()
    h.svn.rows = [{ path: 'a.txt', kind: 'item', conflict: false, ignored: false }]
    expect(await h.removal.remove('s1', h.location, [], { kind: 'discard', by: 'person', at: 1 }, 'action-1')).toMatchObject({ state: 'removed' })
  })

  it('keeps a versioned dirty file under a waste-named directory', async () => {
    const h = await harness()
    h.svn.rows = [{ path: 'node_modules/tracked.txt', kind: 'item', conflict: false, ignored: false }]
    expect(await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toMatchObject({ state: 'kept', blocked: true, lines: ['KEPT: changed after the check: node_modules/tracked.txt'] })
  })

  it('keeps a physical worktree targeted through an intermediate junction', async () => {
    const h = await harness()
    const worktree = join(h.root, 'worktree')
    mkdirSync(worktree)
    mkdirSync(join(h.root, 'skills'))
    symlinkSync(worktree, join(h.root, 'indirect'), 'junction')
    symlinkSync(join(h.root, 'indirect'), join(h.root, 'skills', 'linked'), 'junction')
    expect(await h.removal.remove('s1', { ...h.location, worktreePath: worktree }, [], { kind: 'discard', by: 'person', at: 1 }, 'action-1'))
      .toMatchObject({ state: 'kept', blocked: true, lines: [expect.stringContaining('global skill links')] })
  })

  it('keeps a worktree targeted by a global skill link', async () => {
    const h = await harness()
    mkdirSync(join(h.root, 'skills'))
    symlinkSync(h.location.worktreePath, join(h.root, 'skills', 'linked'), 'junction')
    expect(await h.removal.remove('s1', h.location, [], { kind: 'discard', by: 'person', at: 1 }, 'action-1'))
      .toMatchObject({ state: 'kept', blocked: true, lines: [expect.stringContaining('global skill links')] })
  })

  it('retains a legacy removal remainder without a verified preservation receipt', async () => {
    const h = await harness()
    const aside = join(h.root, 'worktree.deleting')
    mkdirSync(aside)
    mkdirSync(join(aside, '.cache'))
    writeFileSync(join(aside, '.cache/left.txt'), 'surviving bytes')
    h.svn.removalSource = async () => ({ ok: true, value: { path: aside, aside: true, present: true } })
    const answer = await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
    expect(answer).toMatchObject({ state: 'kept', blocked: true, lines: [expect.stringContaining('no verified preservation receipt'),
      `The partly deleted worktree lies at ${aside}; nothing more of it was deleted.`] })
    expect(answer.lines[0]).toContain(`${aside} was moved aside`)
    expect(answer.lines[0]).toContain('Copy what you need from it, delete it, then press Try again')
    expect(readFileSync(join(aside, '.cache/left.txt'), 'utf8')).toBe('surviving bytes')
  })

  it('names the aside, every intent file and the way out when several attempts claim one directory', async () => {
    const h = await harness()
    const aside = join(h.root, 'worktree.deleting')
    mkdirSync(aside)
    h.svn.removalSource = async () => ({ ok: true, value: { path: aside, aside: true, present: true } })
    await h.store.update('s1', (record) => ({ ...record, worktree: { ...record.worktree!, preservationActionId: undefined } }))
    const intents = ['act-A', 'act-B'].map((id) => join(h.root, 'results', id, 'removal-copy.json'))
    for (const intent of intents) {
      mkdirSync(join(intent, '..'), { recursive: true })
      writeFileSync(intent, JSON.stringify({ identity: '1:2:3', stage: 'copy', attempts: 1 }))
    }
    const answer = await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'act-C')
    expect(answer).toMatchObject({ state: 'kept', blocked: true })
    for (const text of [...intents, aside, 'delete it, then press Try again']) expect(answer.lines[0]).toContain(text)
  })

  it('keeps the worktree when its ignored copy encounters a child beneath a link', async () => {
    const h = await harness()
    const root = join(h.root, 'worktree')
    mkdirSync(root)
    mkdirSync(join(h.root, 'outside'))
    symlinkSync(join(h.root, 'outside'), join(root, 'link'), 'junction')
    h.svn.rows = [{ path: 'link/private', kind: 'clean', conflict: false, ignored: true }]
    expect(await h.removal.remove('s1', { ...h.location, worktreePath: root }, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toMatchObject({ state: 'kept', blocked: true })
    expect(h.svn.log).not.toContain('purgeAside')
  })

  /** A worktree on disk whose rename aside is real, as `SvnWorktreeManager.renameAside` makes it. */
  function onDisk(h: Awaited<ReturnType<typeof harness>>) {
    const root = join(h.root, 'worktree'), aside = `${root}.deleting`
    mkdirSync(root)
    h.svn.removalSource = async () => ({ ok: true, value: { path: existsSync(aside) ? aside : root, aside: existsSync(aside), present: true } })
    h.svn.renameAside = async () => {
      try { if (existsSync(root)) await rename(root, aside) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return { ok: true, value: { blocked: code, path: root, detail: String(error) } }
        throw error
      }
      return { ok: true, value: 'renamed' }
    }
    return { root, aside, location: { ...h.location, worktreePath: root }, saved: join(h.root, 'results', 'action-1') }
  }

  it('says where the worktree lies and that its copy is incomplete when the copy fails after the rename (UA1-J11-4)', async () => {
    const h = await harness(), disk = onDisk(h)
    mkdirSync(join(h.root, 'outside'))
    symlinkSync(join(h.root, 'outside'), join(disk.root, 'link'), 'junction')
    h.svn.rows = [{ path: 'link/private', kind: 'clean', conflict: false, ignored: true }]
    expect(await h.removal.remove('s1', disk.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toEqual({ state: 'kept', blocked: true, lines: [
      expect.stringMatching(/^KEPT: removal-blocked: preserve the link before removal/),
      `The worktree now lies at ${disk.aside}; nothing of it was deleted, and its saved copy in ${disk.saved} is incomplete. Remove the cause, then press Try again.`,
    ] })
    expect(h.holders.asked).toEqual([])
  })

  it('names the program holding a file the copy cannot read after the rename', async () => {
    const h = await harness(), disk = onDisk(h)
    writeFileSync(join(disk.root, 'dev.log'), 'output')
    h.svn.rows = [{ path: 'dev.log', kind: 'clean', conflict: false, ignored: true }]
    const held = join(disk.aside, 'dev.log')
    h.holders.lookup = { kind: 'found', files: [{ path: held, holders: [{ pid: 87888, name: 'Syncovery Background Process' }] }] }
    const copy = vi.spyOn(WorktreeContentCopy.prototype, 'copy').mockRejectedValueOnce(
      Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${held}'`), { code: 'EBUSY', path: held }))
    try {
      const answer = await h.removal.remove('s1', disk.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
      expect(answer.lines).toEqual([
        `KEPT: EBUSY: resource busy or locked, copyfile '${held}'`,
        'HELD: dev.log by Syncovery Background Process (PID 87888)',
        `The worktree now lies at ${disk.aside}; nothing of it was deleted, and its saved copy in ${disk.saved} is incomplete. Remove the cause, then press Try again.`,
      ])
      expect(h.holders.asked).toEqual([held])
    } finally { copy.mockRestore() }
  })

  it('names the held file and its program when the rename aside is refused (UA1-J11-5)', async () => {
    const h = await harness()
    const detail = `EPERM: operation not permitted, rename '${worktreeConst}' -> '${worktreeConst}.deleting'`
    h.svn.renameAside = async () => ({ ok: true, value: { blocked: 'EPERM', path: worktreeConst, detail } })
    h.holders.lookup = { kind: 'found', files: [{ path: join(worktreeConst, '.checkpoints', 'store.bundle.lock'), holders: [{ pid: 39524, name: 'Windows PowerShell' }] }] }
    expect(await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toEqual({ state: 'in-use', lines: [
      `REMOVAL BLOCKED (EPERM): ${worktreeConst}. ${detail}`,
      `HELD: ${join('.checkpoints', 'store.bundle.lock')} by Windows PowerShell (PID 39524)`,
      `The worktree stays whole at ${worktreeConst}; publication receipts are retained. Close the programs named above, then press Try again.`,
    ] })
    expect(h.holders.asked).toEqual([worktreeConst])
  })

  it('says what may hold the worktree when Windows names no program, or why none could be named', async () => {
    const h = await harness()
    h.svn.renameAside = async () => ({ ok: true, value: { blocked: 'EBUSY', path: worktreeConst, detail: 'EBUSY: resource busy or locked' } })
    expect((await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).lines.slice(1)).toEqual([
      'Windows names no program with a file open in the worktree; a terminal, dev server or editor may have its working directory there. '
        + `Close it, then press Try again. The worktree stays whole at ${worktreeConst}; publication receipts are retained.`,
    ])
    h.holders.lookup = { kind: 'unavailable', reason: 'the Restart Manager query failed: timeout' }
    expect((await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).lines.slice(1)).toEqual([
      'Jamat could not name the program (the Restart Manager query failed: timeout). Close dev servers, terminals or other programs using the worktree, '
        + `then press Try again. The worktree stays whole at ${worktreeConst}; publication receipts are retained.`,
    ])
  })

  it.runIf(process.platform === 'win32')('names a held .checkpoints/store.bundle.lock and the real process holding it (CL12)', async () => {
    const h = await harness(), disk = onDisk(h)
    const lock = join(disk.root, '.checkpoints', 'store.bundle.lock')
    mkdirSync(join(disk.root, '.checkpoints'))
    writeFileSync(lock, '')
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$s = [IO.File]::Open('${lock.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); Start-Sleep -Seconds 60`], { windowsHide: true })
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) resolve() })
        holder.once('exit', () => reject(new Error('the holder ended before it held the lock')))
      })
      const real = new SvnWorktreeRemoval({ records: h.store, svn: h.svn, onQueue: (work) => work(), changed: () => {},
        steps: { at: () => {} }, skillRoots: [], results: { savedDirectoryOf: (id) => join(h.root, 'results', id, 'saved') } })
      const answer = await real.remove('s1', disk.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
      expect(answer.state).toBe('in-use')
      expect(answer.lines[1]).toContain(`HELD: ${join('.checkpoints', 'store.bundle.lock')} by `)
      expect(answer.lines[1]).toContain(`(PID ${holder.pid})`)
      expect(existsSync(lock)).toBe(true)
    } finally {
      const exited = new Promise((resolve) => holder.exitCode === null ? holder.once('exit', resolve) : resolve(null))
      holder.kill()
      await exited
    }
  }, 60_000)

  it('says which file the purge waits for and who holds it, and names it when the purge gives up (UA1-J11-6)', async () => {
    const h = await harness(), disk = onDisk(h)
    const held = join(disk.aside, 'src', 'blocks.txt')
    h.svn.held = { path: held, code: 'EBUSY', attempt: 3, attempts: 10, delayMilliseconds: 5_000 }
    h.svn.purge = 'undeleted'
    h.holders.lookup = { kind: 'found', files: [{ path: held, holders: [{ pid: 85832, name: 'Windows PowerShell' }] }] }
    const answer = await h.removal.remove('s1', disk.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
    const words = h.steps.map((step) => SessionStepWords.of(step.facts, step.progress))
    expect(words).toContainEqual({ text: 'Waiting for a held file', detail: `${join('src', 'blocks.txt')} is held by another program (EBUSY); try 3 of 10, again every 5 s` })
    expect(words).toContainEqual({ text: 'Waiting for a held file', detail: `${join('src', 'blocks.txt')} is held by Windows PowerShell (PID 85832); try 3 of 10, again every 5 s` })
    expect(answer).toEqual({ state: 'undeleted', lines: [
      `ERROR: ${disk.aside} is left half deleted.`,
      `HELD: ${join('src', 'blocks.txt')} by Windows PowerShell (PID 85832)`,
      `Close the programs named above, then press Try again. The verified saved copy in ${disk.saved} is retained.`,
    ] })
    expect(h.holders.asked).toEqual([held])
  })

  it('records an original path created again after the rename and leaves it in place (UA1-J11-9, R4-RM3)', async () => {
    const h = await harness(), disk = onDisk(h)
    h.svn.purgeAside = async () => {
      rmSync(disk.aside, { recursive: true, force: true })
      mkdirSync(join(disk.root, 'src'), { recursive: true })
      writeFileSync(join(disk.root, 'src', 'late-write.txt'), 'late')
      return { ok: true, value: 'removed' }
    }
    const answer = await h.removal.remove('s1', disk.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
    expect(answer).toEqual({ state: 'removed', lines: [
      '   worktree removed',
      `RECREATED: the original path was created again after removal: ${disk.root} (holds ${join('src', 'late-write.txt')}); Jamat left it in place. `
        + 'Find the program that writes there, then move or delete that folder yourself.',
    ] })
    expect(readFileSync(join(disk.root, 'src', 'late-write.txt'), 'utf8')).toBe('late')
    expect(h.store.get('s1')?.retiredWorktree?.worktreePath).toBe(disk.root)
  })

  it('hands a durable result the copy line and a recreated original path, nothing else', () => {
    expect(SvnWorktreeRemoval.resultLinesOf(['COPIED: 2 ignored files', '   worktree removed', 'RECREATED: the original path was created again', 'KEPT: x']))
      .toEqual(['COPIED: 2 ignored files', 'RECREATED: the original path was created again'])
  })

  it('does not copy link descriptions while a holder prevents removal', async () => {
    const h = await harness()
    const root = join(h.root, 'worktree')
    mkdirSync(root)
    mkdirSync(join(h.root, 'outside'))
    symlinkSync(join(h.root, 'outside'), join(root, 'link'), 'junction')
    h.svn.rows = [{ path: 'link', kind: 'clean', conflict: false, ignored: true }]
    h.svn.rename = 'in-use'
    expect(await h.removal.remove('s1', { ...h.location, worktreePath: root }, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toMatchObject({ state: 'in-use', lines: [expect.stringContaining('IN USE')] })
  })

  it('releases its own handles, renames aside by identity, purges and leaves a tombstone with every revision', async () => {
    const it_ = await harness({
      worktreeOutcome: { result: 'partial', revisions: ['https://svn.test/app:r12'], main: 'none', worktree: 'kept', lines: [], at: 1 },
    })

    expect(await it_.removal.remove('s1', it_.location, ['https://svn.test/app:r14', 'https://svn.test/app:r12'], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toEqual({ state: 'removed', lines: ['   worktree removed'] })
    expect(it_.svn.log).toEqual([
      `renameAside ${worktreeConst} 1:2:3`, 'purgeAside', `removeEmptyWorktreesDir ${ownerConst}`,
    ])
    const record = it_.store.get('s1')
    expect(record?.worktree).toBeUndefined()
    expect(record?.worktreeCleanup).toBeUndefined()
    expect(record?.completed).toBe(true)
    expect(record?.retiredWorktree).toEqual({
      worktreePath: worktreeConst, kind: 'svn', revisions: ['https://svn.test/app:r12', 'https://svn.test/app:r14'], removedAt: 7_000,
      ownerDir: ownerConst, directoryId: '1:2:3',
    })
  })

  it.each([true, false])('ends pending setup only after removal succeeds, agreement=%s (UA2-J01-01)', async (agreement) => {
    const pendingSetup = { setupSessionId: 'setup-1', ...agreement ? { agreement: { hash: 'setup-hash', commands: ['node setup.js'] } } : {} }
    const endedReason = agreement ? 'Setup waits for command approval' : 'Setup failed with exit 3'
    const h = await harness({ pendingSetup, endedReason })
    h.svn.rename = 'in-use'
    expect(await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toMatchObject({ state: 'in-use' })
    expect(h.store.get('s1')?.pendingSetup).toEqual(pendingSetup)
    h.svn.rename = 'renamed'
    expect(await h.removal.remove('s1', h.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1'))
      .toMatchObject({ state: 'removed' })
    expect(h.store.get('s1')?.pendingSetup).toBeUndefined()
    expect(h.store.get('s1')?.endedReason).toBe(agreement ? 'Setup cancelled; worktree removed' : endedReason)
    expect(h.store.get('s1')?.stopRequested).toBe(agreement ? true : undefined)
  })

  it('keeps the caller of the worktree on the tombstone, so a later result still carries its tag', async () => {
    const caller = { tag: 'run-7', notify: { sessionId: 'coordinator', text: 'wake' } }
    const it_ = await harness()
    await it_.store.put({ ...it_.store.get('s1')!, worktree: { ...it_.store.get('s1')!.worktree!, caller } })

    await it_.removal.remove('s1', it_.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')

    expect(it_.store.get('s1')?.retiredWorktree?.caller).toEqual(caller)
  })

  it('counts a worktree already renamed aside or gone as removed', async () => {
    const it_ = await harness()
    it_.svn.rename = 'absent'

    expect(await it_.removal.remove('s1', it_.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toMatchObject({ state: 'removed' })
  })

  it('keeps the worktree whole when a process holds it, a purge leaves a rest, or another directory stands there', async () => {
    const held = await harness()
    held.svn.rename = 'in-use'
    expect(await held.removal.remove('s1', held.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toMatchObject({ state: 'in-use', lines: [expect.stringMatching(/^IN USE: /)] })
    expect(held.store.get('s1')?.worktree).toBeDefined()

    const half = await harness()
    half.svn.purge = 'undeleted'
    expect(await half.removal.remove('s1', half.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toMatchObject({ state: 'undeleted' })

    const foreign = await harness()
    foreign.svn.rename = { ok: false, detail: `${worktreeConst} is another directory than the worktree this session created` }
    expect(await foreign.removal.remove('s1', foreign.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toEqual({
      state: 'kept', lines: [`ERROR: ${worktreeConst} is another directory than the worktree this session created; the worktree is kept`],
    })
  })

  it('touches nothing when a reopen won the queue', async () => {
    const it_ = await harness({}, async (store) => {
      const current = store.get('s1')
      if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op', pendingOperationKind: 'reopen' })
    })

    expect(await it_.removal.remove('s1', it_.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')).toEqual({ state: 'kept', lines: [`KEPT: session s1 runs again, so ${worktreeConst} stays`] })
    expect(it_.svn.log).toEqual([])
  })

  it('reports waiting, moving aside, counting, deleting and recording into the step, in order', async () => {
    const it_ = await harness()

    await it_.removal.remove('s1', it_.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')

    expect(it_.steps.every((step) => step.sessionId === 's1')).toBe(true)
    expect(it_.steps.map((step) => step.facts)).toEqual([
      'queue', 'rename', 'copy', 'count', 'count', 'delete', 'delete', 'tombstone',
    ].map((phase) => ({ kind: 'removal', phase, path: worktreeConst })))
    expect(it_.steps.map((step) => step.progress)).toEqual([
      null, null, null, { done: 2, total: null }, { done: 3, total: null }, { done: 2, total: 3 }, { done: 3, total: 3 }, null,
    ])
    expect(it_.steps.map((step) => SessionStepWords.of(step.facts, step.progress))).toEqual([
      { text: 'Waiting for other operations', detail: worktreeConst },
      { text: 'Moving the worktree aside', detail: `${worktreeConst}.deleting` },
      { text: 'Saving the files to keep before deleting', detail: `${worktreeConst}.deleting` },
      { text: 'Counting the files to delete', detail: '2 files so far' },
      { text: 'Counting the files to delete', detail: '3 files so far' },
      { text: 'Removing the worktree', detail: '2 of 3 files' },
      { text: 'Removing the worktree', detail: '3 of 3 files' },
      { text: 'Recording the removal', detail: 'session record' },
    ])
  })

  it('says that a removal resumed after a restart deletes what the interrupted one left (UA1-J09-10)', async () => {
    const h = await harness(), root = join(h.root, 'worktree'), aside = `${root}.deleting`
    mkdirSync(root)
    writeFileSync(join(root, 'dev.log'), 'retained output')
    h.svn.removalSource = async () => ({ ok: true, value: { path: existsSync(aside) ? aside : root, aside: existsSync(aside), present: true } })
    h.svn.renameAside = async () => { if (existsSync(root)) renameSync(root, aside); return { ok: true, value: 'renamed' } }
    h.svn.rows = [{ path: 'dev.log', kind: 'clean', conflict: false, ignored: true }]
    h.svn.purge = 'undeleted'
    const location = { ...h.location, worktreePath: root }, permit = { kind: 'clean' as const, provedAt: 1, allowed: [] }
    expect(await h.removal.remove('s1', location, [], permit, 'action-1')).toMatchObject({ state: 'undeleted' })
    expect(h.steps.map((step) => SessionStepWords.of(step.facts, step.progress).text).slice(1, 3))
      .toEqual(['Moving the worktree aside', 'Saving the files to keep before deleting'])
    h.steps.splice(0)
    h.svn.purge = 'removed'
    expect(await h.removal.remove('s1', location, [], permit, 'action-1')).toMatchObject({ state: 'removed' })
    expect(h.steps.map((step) => SessionStepWords.of(step.facts, step.progress))).toEqual([
      { text: 'Waiting for other operations', detail: root },
      { text: 'Resuming the interrupted removal', detail: aside },
      { text: 'Checking the files the interrupted removal left', detail: aside },
      { text: 'Counting the files left to delete', detail: '2 files so far' },
      { text: 'Counting the files left to delete', detail: '3 files so far' },
      { text: 'Deleting the rest of the worktree', detail: '2 of 3 files' },
      { text: 'Deleting the rest of the worktree', detail: '3 of 3 files' },
      { text: 'Recording the removal', detail: 'session record' },
    ])
  })

  it('names the count in the words of the step with grouped numbers', () => {
    const facts = (phase: 'count' | 'delete'): SessionStepFacts => ({ kind: 'removal', phase, path: worktreeConst })
    expect(SessionStepWords.of(facts('count'), { done: 23_000, total: null }).detail).toBe('23,000 files so far')
    expect(SessionStepWords.of(facts('count'), { done: 1, total: null }).detail).toBe('1 file so far')
    expect(SessionStepWords.of(facts('delete'), { done: 12_000, total: 30_001 }).detail).toBe('12,000 of 30,001 files')
    expect(SessionStepWords.of(facts('delete'), { done: 0, total: null }).detail).toBe(worktreeConst)
  })

  it('stops the step after the rename when a process holds the worktree, and before the rename when a reopen won', async () => {
    const held = await harness()
    held.svn.rename = 'in-use'
    await held.removal.remove('s1', held.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
    expect(held.steps.map((step) => step.facts.kind === 'removal' ? step.facts.phase : step.facts.kind)).toEqual(['queue', 'rename'])

    const reopened = await harness({}, async (store) => {
      const current = store.get('s1')
      if (current?.life === 'ended') await store.put({ ...current, life: 'starting', pendingOperationId: 'op', pendingOperationKind: 'reopen' })
    })
    await reopened.removal.remove('s1', reopened.location, [], { kind: 'clean', provedAt: 1, allowed: [] }, 'action-1')
    expect(reopened.steps.map((step) => step.facts.kind === 'removal' ? step.facts.phase : step.facts.kind)).toEqual(['queue'])
  })

  it('joins revision lists once each, by repository and number', () => {
    expect(SvnWorktreeRemoval.joined(['b:r2', 'a:r10'], ['a:r9', 'b:r2', 'hand-edited'])).toEqual(['a:r9', 'a:r10', 'b:r2', 'hand-edited'])
  })
})
