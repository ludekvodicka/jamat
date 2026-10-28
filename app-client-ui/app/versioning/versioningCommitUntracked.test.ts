import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { FileDiffComputer } from '../../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer'
import { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangesWorkingTreeSnapshotResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesVcsSvn } from '../../../lib-orchestrator/fileChangesManager/vcs/fileChangesVcsSvn'
import { VcsStatusView } from '../../../lib-orchestrator/fileChangesManager/vcsStatusView'
import { FileChangesSvnUntracked } from '../../../lib-orchestrator/fileChangesManager/working/fileChangesSvnUntracked'
import { FileChangesWorkingTreeSources } from '../../../lib-orchestrator/fileChangesManager/working/fileChangesWorkingTreeSources'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { GitCommitManager } from '../../../lib-orchestrator/git/gitCommitManager'
import { GitInvoker } from '../../../lib-orchestrator/git/gitInvoker'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { CommandInvoker } from '../../../lib-orchestrator/shared/commandInvoker'
import type { CommandRunner } from '../../../lib-orchestrator/shared/commandInvoker.types'
import { SvnCommitManager } from '../../../lib-orchestrator/svn/svnCommitManager'
import { SvnInvoker } from '../../../lib-orchestrator/svn/svnInvoker'
import { FileChangesAccess } from '../fileChanges/fileChangesAccess'
import { RemoteContentAccess } from '../remoteControl/remoteContentAccess'
import { RemoteReviewAccess } from '../remoteControl/remoteReviewAccess'
import type { ReviewInteractionAccess } from './reviewInteractionAccess'
import { ServiceVersioningCommitIpc } from './serviceVersioningCommitIpc'
import { VersioningCommitManager } from './versioningCommitManager'
import { VersioningCommitMessageStore } from './versioningCommitMessageStore'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } }))

const roots: string[] = []
afterEach(async () => {
  handlers.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it.each([
  { ordinary: false, remote: false }, { ordinary: true, remote: false },
  { ordinary: false, remote: true }, { ordinary: true, remote: true },
])('publishes a Git-ignored dot-file below new SVN parents (ordinary: $ordinary, remote: $remote)', async ({ ordinary, remote }) => {
  const root = await mkdtemp(join(tmpdir(), 'jamat-76-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const working = join(root, 'working')
  const config = join(root, 'svn-config')
  await mkdir(config)
  await writeFile(join(config, 'config'), '[miscellany]\nglobal-ignores = .git *.ignored\n')
  const invoker = new SvnInvoker()
  const svn: CommandRunner = { run: (cwd, args, options) => invoker.run(cwd, ['--config-dir', config, ...args], options) }
  const git = new GitInvoker()
  const run = async (runner: CommandRunner | GitInvoker, cwd: string, args: string[]) => {
    const result = await runner.run(cwd, args)
    if (result.failure !== null || result.code !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
  expect(created).toMatchObject({ code: 0, failure: null })
  await run(svn, root, ['checkout', pathToFileURL(repository).href, working])
  await run(git, working, ['init'])
  const excludes = join(root, 'git-excludes')
  await writeFile(excludes, '.atomix-shared.json\n')
  await run(git, working, ['config', 'core.excludesFile', excludes])
  const dotfile = join(working, 'components', 'flow', 'ui', '.atomix-shared.json')
  const source = join(dirname(dotfile), 'view.ts')
  const sibling = join(dirname(dotfile), 'unchecked.txt')
  await mkdir(dirname(dotfile), { recursive: true })
  await writeFile(dotfile, '{"kind":"shared"}\n')
  await writeFile(source, 'export const view = true\n')
  await writeFile(sibling, 'leave local\n')
  await writeFile(join(dirname(dotfile), 'scratch.ignored'), 'ignored by SVN\n')
  const selected = ordinary ? [dotfile, source] : [dotfile]
  expect(await git.run(dirname(dotfile), ['check-ignore', '-q', '--', '.'])).toMatchObject({ code: 1 })
  expect(await git.run(working, ['check-ignore', '-q', '--', dotfile])).toMatchObject({ code: 0 })

  const files = new FileChangesManager({ diffExecutor: new FileDiffComputer(),
    workingSources: new FileChangesWorkingTreeSources({ commitSvn: new FileChangesVcsSvn(svn) }),
    svnUntracked: new FileChangesSvnUntracked({ git, svn, configFile: join(config, 'config'),
      checkpointStore: { existingContextOf: async () => ({ ok: true, value: null }) } }),
  })
  const sessions = { worktreeAt: async () => null,
    workingContext: async () => ({ ok: true as const, value: { sessionId: 'dotfile', cwd: working, agent: null, worktree: null } }),
  }
  const access = new FileChangesAccess(files, {} as FileViewer, sessions as unknown as SessionManager, {} as ConfigStore)
  const manager = new VersioningCommitManager({ sessions, vcsStatus: new VcsStatusView(),
    messages: new VersioningCommitMessageStore(join(root, 'messages.json'), (detail) => { throw new Error(detail) }),
    fileAccess: (owner, snapshot, file) => access.ownedFileAccess(owner, snapshot, file),
    snapshotOf: (owner, snapshot) => access.ownedWorkingTreeSnapshot(owner, snapshot),
    git: new GitCommitManager(git), svn: new SvnCommitManager(svn),
    tortoise: { open: async () => { throw new Error('Unexpected Tortoise fallback') } }, onChanged: () => {},
  })
  const prepared = await manager.prepare('dotfile', 'svn', null, 'Add selected files', selected)
  if (!prepared.ok) throw new Error(prepared.detail)
  const view = { peerId: 'peer', sessionId: 'dotfile', epoch: 'epoch', viewId: 'view', viewerId: 'window' }
  const owner = remote ? RemoteContentAccess.owner(view) : 'owner'
  manager.attach(prepared.value.draftId, owner)
  let response: FileChangesWorkingTreeSnapshotResult & { checkedPaths?: readonly string[] }
  if (remote) {
    const review = new RemoteReviewAccess(manager, {} as ReviewInteractionAccess, access, () => true, () => {})
    const page = await review.request(view, { kind: 'files', reviewId: prepared.value.draftId })
    if (!page.ok) throw new Error('Missing remote review page')
    response = JSON.parse(Buffer.from(page.value.base64, 'base64').toString())
  }
  else {
    new ServiceVersioningCommitIpc(manager, () => owner, access, vi.fn()).initialize()
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const envelope = await handlers.get('versioning:commit-files')!({ sender }, prepared.value.draftId) as { ok: true; value: typeof response }
    expect(envelope.ok).toBe(true)
    response = envelope.value
  }
  if (!response.ok) throw new Error(response.detail)
  const snapshot = response.value
  const checked = response.checkedPaths
  expect(snapshot.entries.map((entry) => entry.path)).toContain(dotfile)
  expect(checked).toEqual(expect.arrayContaining(selected))
  expect(snapshot.entries.some((entry) => entry.path === sibling)).toBe(false)
  const refresh = await files.workingTree({ sessionId: 'dotfile', cwd: working, agent: null, worktree: null }, 'svn', true, dotfile)
  expect(refresh.ok && refresh.value.entries.map((entry) => entry.path)).toEqual([dotfile])
  const result = await manager.run(owner, { draftId: prepared.value.draftId, snapshotId: snapshot.snapshotId,
    fileIds: snapshot.entries.filter((entry) => checked?.includes(entry.path)).map((entry) => entry.fileId),
    message: 'Add selected files',
  })
  expect(result).toMatchObject({ ok: true, revision: '1' })
  expect(manager.status(prepared.value.draftId)?.committedPaths).toEqual(expect.arrayContaining(selected))
  const published = (await run(svn, working, ['list', '--recursive', pathToFileURL(repository).href])).trim().split(/\r?\n/)
  expect(published).toEqual(['components/', 'components/flow/', 'components/flow/ui/',
    'components/flow/ui/.atomix-shared.json', ...(ordinary ? ['components/flow/ui/view.ts'] : [])])
  expect(await run(svn, working, ['cat', `${pathToFileURL(repository).href}/components/flow/ui/.atomix-shared.json`]))
    .toBe(await readFile(dotfile, 'utf8'))
  expect(await run(svn, working, ['status', '--', sibling])).toContain('?')
  if (!ordinary) expect(await run(svn, working, ['status', '--', source])).toContain('?')
})
