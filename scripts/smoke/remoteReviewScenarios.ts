import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SvnCommitManager } from '../../lib-orchestrator/svn/svnCommitManager.js'
import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { VcsStatusView } from '../../lib-orchestrator/fileChangesManager/vcsStatusView.js'
import type { ConfigStore } from '../../lib-orchestrator/configStore/configStore.js'
import type { SessionManager } from '../../lib-orchestrator/sessionManager/sessionManager.js'
import type { RemoteReviewDecision, RemoteReviewRequest } from '../../lib-orchestrator/remoteControl/remoteReviewApi.types.js'
import type { RemoteSessionView } from '../../lib-orchestrator/remoteControl/remoteSessionApi.types.js'
import type { RemoteConnectionsManager } from '../../app-client-ui/app/remoteControl/remoteConnectionsManager.js'

import type { VersioningCommitDraftDto, VersioningCommitFilesResult, VersioningCommitOpenResult, VersioningCommitRunResult, VersioningReviewEditResult } from '../../app-client-ui/shared/versioningCommit.js'

import { RemoteContentScenarios } from './remoteContentScenarios.js'

const requireUi = createRequire(import.meta.url)
const { RemoteReviewAccess } = requireUi('../../app-client-ui/app/remoteControl/remoteReviewAccess.ts') as typeof import('../../app-client-ui/app/remoteControl/remoteReviewAccess.js')
const { FileChangesAccess } = requireUi('../../app-client-ui/app/fileChanges/fileChangesAccess.ts') as typeof import('../../app-client-ui/app/fileChanges/fileChangesAccess.js')
const { VersioningCommitManager } = requireUi('../../app-client-ui/app/versioning/versioningCommitManager.ts') as typeof import('../../app-client-ui/app/versioning/versioningCommitManager.js')
const { VersioningCommitMessageStore } = requireUi('../../app-client-ui/app/versioning/versioningCommitMessageStore.ts') as typeof import('../../app-client-ui/app/versioning/versioningCommitMessageStore.js')
const { VersioningReviewStore } = requireUi('../../app-client-ui/app/versioning/versioningReviewStore.ts') as typeof import('../../app-client-ui/app/versioning/versioningReviewStore.js')
const { ReviewInteractionAccess } = requireUi('../../app-client-ui/app/versioning/reviewInteractionAccess.ts') as typeof import('../../app-client-ui/app/versioning/reviewInteractionAccess.js')
const { RemoteContentRead } = requireUi('../../app-client-ui/shared/remoteContentRead.ts') as typeof import('../../app-client-ui/shared/remoteContentRead.js')
const { RemoteReviewResults } = requireUi('../../app-client-ui/shared/remoteReviewResults.ts') as typeof import('../../app-client-ui/shared/remoteReviewResults.js')

export class RemoteReviewScenarios {
  static async prove(workspace: RemoteContentScenarios, sessions: SessionManager, config: ConfigStore,
    connections: RemoteConnectionsManager, endpointId: string, sessionId: string, root: string): Promise<void> {
    const files = new FileChangesManager({ diffExecutor: new FileDiffComputer() })
    const access = new FileChangesAccess(files, workspace.viewer, sessions, config)
    const interactions = new ReviewInteractionAccess()
    const git = new GitInvoker(), svn = new SvnInvoker()
    const gitCommits = new GitCommitManager(git), svnCommits = new SvnCommitManager(svn)
    let gate: (() => Promise<void>) | null = null
    const reviews = new VersioningReviewStore(join(root, 'reviews.json'), (detail) => { throw new Error(detail) })
    const manager = new VersioningCommitManager({
      messages: new VersioningCommitMessageStore(join(root, 'messages.json'), (detail) => { throw new Error(detail) }),
      reviews, interactions, sessions, vcsStatus: new VcsStatusView(),
      fileAccess: (owner, snapshot, file) => access.ownedFileAccess(owner, snapshot, file),
      snapshotOf: (owner, snapshot) => access.ownedWorkingTreeSnapshot(owner, snapshot),
      git: { commit: async (...args) => { await gate?.(); return gitCommits.commit(...args) }, revertFile: (...args) => gitCommits.revertFile(...args) },
      svn: { commit: async (...args) => { await gate?.(); return svnCommits.commit(...args) }, revertFile: (...args) => svnCommits.revertFile(...args), update: (...args) => svnCommits.update(...args) },
      tortoise: { open: async () => { throw new Error('Unexpected native dialog in isolated smoke') } }, onChanged: () => {},
    })
    workspace.reviews = new RemoteReviewAccess(manager, interactions, access, (view) => workspace.views.isActive(view),
      (view, source) => workspace.content.admitSource(view, source), async () => {})
    const run = async (vcs: 'svn' | 'git', cwd: string, args: string[]): Promise<string> => {
      const result = await (vcs === 'git' ? git : svn).run(cwd, args)
      assert.equal(result.code, 0, result.stderr || JSON.stringify(result))
      return result.stdout.trim()
    }
    const messageFile = join(root, 'seed-message.txt')
    await writeFile(messageFile, 'Disposable source fixture')
    for (const vcs of ['svn', 'git'] as const) {
      const working = join(root, `dual-${vcs}`)
      if (vcs === 'svn') {
        const repository = join(root, 'dual-svn-repository')
        const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
        assert.equal(created.code, 0, created.stderr)
        await run(vcs, root, ['checkout', pathToFileURL(repository).href, working])
      } else {
        await mkdir(working)
        await run(vcs, working, ['init', '--initial-branch=main'])
        await run(vcs, working, ['config', 'user.name', 'Smoke Fixture'])
        await run(vcs, working, ['config', 'user.email', 'smoke@example.invalid'])
      }
      await writeFile(join(working, 'selected.txt'), 'base selected')
      await writeFile(join(working, 'kept.txt'), 'base kept')
      await run(vcs, working, ['add', '--', 'selected.txt', 'kept.txt'])
      await run(vcs, working, ['commit', '--file', messageFile])
      await writeFile(join(working, 'selected.txt'), 'selected source change')
      await writeFile(join(working, 'kept.txt'), 'unselected source work')
      const count = () => run(vcs, working, vcs === 'svn' ? ['log', '--xml', '-r', '1:HEAD'] : ['rev-list', '--count', 'HEAD'])
      const before = await count()
      const one = await RemoteContentScenarios.open(connections, endpointId, sessionId, `review-${vcs}-one`)
      const two = await RemoteContentScenarios.open(connections, endpointId, sessionId, `review-${vcs}-two`)
      const create = await this.request<VersioningCommitOpenResult>(connections, endpointId, one, { kind: 'create', vcs, scopeRoot: working, openId: randomUUID() })
      assert(create.ok)
      const reviewId = create.value.draftId
      const attach = await this.request<VersioningCommitOpenResult>(connections, endpointId, two, { kind: 'open', reviewId })
      assert(attach.ok)
      const listing = await this.request<VersioningCommitFilesResult>(connections, endpointId, one, { kind: 'files', reviewId })
      assert(listing.ok)
      const selected = listing.value.entries.filter((entry) => entry.path === join(working, 'selected.txt'))
      assert.equal(selected.length, 1)
      const current = await this.request<VersioningCommitDraftDto>(connections, endpointId, one, { kind: 'read', reviewId })
      const edit = { draftId: reviewId, epoch: current.epoch!, expectedRevision: current.revision,
        message: `Publish selected ${vcs} source file`, selection: { snapshotId: listing.value.snapshotId, fileIds: selected.map((entry) => entry.fileId) } }
      const edited = await this.request<VersioningReviewEditResult>(connections, endpointId, one, { kind: 'edit', edit })
      assert(edited.ok)
      const stale = await this.request<VersioningReviewEditResult>(connections, endpointId, two, { kind: 'edit', edit: { ...edit, message: 'Overwritten stale text' } })
      assert(!stale.ok && stale.code === 'stale')
      const proof: RemoteReviewDecision = { kind: 'approve', draftId: reviewId, epoch: current.epoch!, expectedRevision: edited.value.revision,
        ...edit.selection, message: edit.message, operationId: randomUUID() }
      const [first, duplicate] = await Promise.all([one, two].map((view) => this.request<VersioningCommitRunResult>(connections, endpointId, view, { kind: 'decide', decision: proof })))
      assert(first.ok, JSON.stringify(first))
      assert.deepEqual(duplicate, first, 'A repeated accepted operation returns its actual receipt')
      const [a, b] = await Promise.all([one, two].map((view) => this.request<VersioningCommitDraftDto>(connections, endpointId, view, { kind: 'read', reviewId })))
      assert.deepEqual(a.phase, b.phase)
      assert.equal(a.phase.kind, 'done')
      const after = await count()
      assert.equal(vcs === 'git' ? Number(after) - Number(before) : (after.match(/<logentry/g)?.length ?? 0) - (before.match(/<logentry/g)?.length ?? 0), 1)
      assert.equal(await readFile(join(working, 'kept.txt'), 'utf8'), 'unselected source work')
      assert((await run(vcs, working, vcs === 'svn' ? ['status'] : ['status', '--porcelain'])).includes('kept.txt'))

      await writeFile(join(working, 'selected.txt'), 'second source change')
      const next = await this.request<VersioningCommitOpenResult>(connections, endpointId, one, { kind: 'create', vcs, scopeRoot: working, openId: randomUUID() })
      assert(next.ok)
      const secondId = next.value.draftId
      const nextFiles = await this.request<VersioningCommitFilesResult>(connections, endpointId, one, { kind: 'files', reviewId: secondId })
      assert(nextFiles.ok)
      const nextDraft = await this.request<VersioningCommitDraftDto>(connections, endpointId, one, { kind: 'read', reviewId: secondId })
      const nextProof: RemoteReviewDecision = { kind: 'approve', draftId: secondId, epoch: nextDraft.epoch!, expectedRevision: nextDraft.revision,
        snapshotId: nextFiles.value.snapshotId, fileIds: nextFiles.value.entries.filter((entry) => entry.path === join(working, 'selected.txt')).map((entry) => entry.fileId),
        message: 'Accepted work survives a closed viewer', operationId: randomUUID() }
      const nextEdit = await this.request<VersioningReviewEditResult>(connections, endpointId, one, { kind: 'edit', edit: {
        draftId: secondId, epoch: nextDraft.epoch!, expectedRevision: nextDraft.revision, message: nextProof.message,
        selection: { snapshotId: nextProof.snapshotId, fileIds: nextProof.fileIds },
      } })
      assert(nextEdit.ok)
      nextProof.expectedRevision = nextEdit.value.revision
      let accepted!: () => void, resume!: () => void
      const acceptedPromise = new Promise<void>((resolve) => { accepted = resolve })
      const resumePromise = new Promise<void>((resolve) => { resume = resolve })
      gate = async () => { accepted(); await resumePromise }
      const pending = this.request<VersioningCommitRunResult>(connections, endpointId, one, { kind: 'decide', decision: nextProof }).catch(() => null)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([acceptedPromise, pending.then((result) => { throw new Error(`Publication ended before acceptance: ${JSON.stringify(result)}`) }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Publication was not accepted')), 10000) })])
        const closed = await connections.sessionView(endpointId, { ...one, requestId: randomUUID(), operation: 'views.close', body: {} })
        assert(closed.ok)
      } finally { clearTimeout(timer); resume(); gate = null }
      assert.equal(await pending, null, 'Revoked view loses the reply while accepted work continues')
      const reopened = await RemoteContentScenarios.open(connections, endpointId, sessionId, `review-${vcs}-replacement`)
      await this.request(connections, endpointId, reopened, { kind: 'open', reviewId: secondId })
      const receipt = await this.request<VersioningCommitRunResult>(connections, endpointId, reopened, { kind: 'decide', decision: nextProof })
      assert(receipt.ok, JSON.stringify(receipt))
      const finalCount = await count()
      assert.equal(vcs === 'git' ? Number(finalCount) - Number(after) : (finalCount.match(/<logentry/g)?.length ?? 0) - (after.match(/<logentry/g)?.length ?? 0), 1)
      const persisted = new VersioningReviewStore(join(root, 'reviews.json'), (detail) => { throw new Error(detail) }).read().find((record) => record.dto.draftId === secondId)
      assert(persisted?.decisions?.some((entry) => entry.operationId === nextProof.operationId && entry.result?.ok && entry.result.revision === receipt.revision))
      for (const view of [two, reopened]) await connections.sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'views.close', body: {} })
      console.log(`remote-review: ${vcs} dual review, stale edit, one revision, unselected work, revoked reply and durable receipt passed`)
    }
    workspace.reviews = undefined
  }

  private static async request<T>(connections: RemoteConnectionsManager, endpointId: string, view: RemoteSessionView, request: RemoteReviewRequest): Promise<T> {
    const first = await connections.sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'reviews.request', body: request })
    assert(first.ok && first.value && 'transferId' in first.value, JSON.stringify(first))
    const bytes = await RemoteContentRead.collect(first.value, async (cursor) => {
      const next = await connections.sessionView(endpointId, { ...view, requestId: randomUUID(), operation: 'reviews.page', body: cursor })
      assert(next.ok && next.value && 'transferId' in next.value, JSON.stringify(next))
      return next.value
    })
    return RemoteReviewResults.parse(request, JSON.parse(Buffer.from(bytes).toString('utf8')), view.sessionId) as T
  }
}
