import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CheckpointLayout } from './checkpointLayout'
import { GitCheckpointStore } from './gitCheckpointStore'
import { GitInvoker } from './gitInvoker'
import { StoreCutWorktrees } from './storeCutWorktrees'

describe('lib-orchestrator/git/storeCutWorktrees', () => {
  const created: string[] = []
  const invoker = new GitInvoker()

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function temporaryDirectory(prefix: string): string {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
    created.push(directory)
    return directory
  }

  async function skipWithoutGit(context: { skip: () => void }): Promise<void> {
    const version = await invoker.run(tmpdir(), ['--version'])
    if (version.failure !== null || version.code !== 0)
      context.skip()
  }

  /** What `checkpoints` mode left behind before the retirement: a worktree cut from the store. */
  async function legacyWorktree(): Promise<{ root: string; storeDir: string; worktreePath: string; branch: string }> {
    const root = temporaryDirectory('jamat-v3-store-cut-')
    writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')
    expect((await new GitCheckpointStore(invoker).checkpoint(root, 'checkpoint: baseline')).ok).toBe(true)
    const storeDir = join(root, CheckpointLayout.storeRelativeConst)
    const worktreePath = join(root, '.worktrees', '014-legacy')
    const branch = 'jamat/014-legacy'
    const added = await invoker.run(root, ['--git-dir', storeDir, 'worktree', 'add', '-b', branch, worktreePath, CheckpointLayout.branchConst])
    expect(added.code, added.stderr).toBe(0)
    return { root, storeDir, worktreePath, branch }
  }

  async function branchExists(storeDir: string, root: string, branch: string): Promise<boolean> {
    return (await invoker.run(root, ['--git-dir', storeDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  }

  it('recognizes only a worktree whose pointer names a checkpoint store', async () => {
    const root = temporaryDirectory('jamat-v3-store-cut-pointer-')
    const legacy = join(root, 'legacy')
    const human = join(root, 'human')
    const plain = join(root, 'plain')
    for (const directory of [legacy, human, plain]) mkdirSync(directory)
    const app = join(root, 'app')
    writeFileSync(join(legacy, '.git'), `gitdir: ${join(app, CheckpointLayout.storeRelativeConst, 'worktrees', '042-feat')}\n`, 'utf8')
    writeFileSync(join(human, '.git'), `gitdir: ${join(app, '.git', 'worktrees', '042-feat')}\n`, 'utf8')
    const stores = new StoreCutWorktrees(invoker)

    expect(await stores.recognize(legacy)).toEqual({ storeDir: join(app, CheckpointLayout.storeRelativeConst) })
    expect(await stores.recognize(human)).toBeNull()
    expect(await stores.recognize(plain)).toBeNull()
    expect(await stores.recognize(join(root, 'absent'))).toBeNull()
  })

  it('discards a legacy worktree from the store, and a second discard finds nothing left to do', {
    timeout: 120_000,
  }, async (context) => {
    await skipWithoutGit(context)
    const { root, storeDir, worktreePath, branch } = await legacyWorktree()
    const stores = new StoreCutWorktrees(invoker)
    expect(await stores.recognize(worktreePath)).toEqual({ storeDir })

    const worktree = { worktreePath, branch, baseCommit: 'abc', repositoryRoot: root }
    expect(await stores.discard(worktree)).toEqual({ ok: true, value: undefined })

    expect(existsSync(worktreePath)).toBe(false)
    expect(existsSync(`${worktreePath}.deleting`)).toBe(false)
    expect(await branchExists(storeDir, root, branch)).toBe(false)
    const listed = await invoker.run(root, ['--git-dir', storeDir, 'worktree', 'list', '--porcelain'])
    expect(listed.stdout).not.toContain('014-legacy')
    expect(await stores.discard(worktree)).toEqual({ ok: true, value: undefined })
  })

  it('leaves a directory at the recorded path alone when the store did not cut it', {
    timeout: 120_000,
  }, async (context) => {
    await skipWithoutGit(context)
    const { root, storeDir, branch } = await legacyWorktree()
    const foreign = join(root, '.worktrees', '015-foreign')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'work.txt'), 'somebody else\n', 'utf8')

    const refused = await new StoreCutWorktrees(invoker)
      .discard({ worktreePath: foreign, branch, baseCommit: 'abc', repositoryRoot: root })

    expect(refused).toMatchObject({ ok: false, code: 'git-failed' })
    expect(existsSync(join(foreign, 'work.txt'))).toBe(true)
    expect(await branchExists(storeDir, root, branch)).toBe(true)
  })

  it.runIf(process.platform === 'win32')('keeps a worktree something still holds open, and says it is in use', {
    timeout: 120_000,
  }, async (context) => {
    await skipWithoutGit(context)
    const { root, worktreePath, branch } = await legacyWorktree()
    const handle = openSync(join(worktreePath, 'a.txt'), 'r')
    try {
      const refused = await new StoreCutWorktrees(invoker)
        .discard({ worktreePath, branch, baseCommit: 'abc', repositoryRoot: root })
      expect(refused).toMatchObject({ ok: false, code: 'locked' })
      expect(existsSync(join(worktreePath, 'a.txt'))).toBe(true)
    }
    finally { closeSync(handle) }
  })
})
