import { resolve } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import type { ReviewCandidates } from './reviewCandidates'
import type { FinishDriverDeps } from './finishDriver.types'
import type { WorktreeLifecycle } from '../worktreeState'
import type { FinishState } from './finishState'

export class ReviewStep {
  private readonly deps: Pick<FinishDriverDeps, 'now' | 'records' | 'svn'>
  private readonly state: Pick<FinishState, 'write' | 'wait'>
  private readonly reviews: Pick<ReviewCandidates, 'create' | 'approve'>

  constructor(deps: ReviewStep['deps'], state: ReviewStep['state'], reviews: ReviewStep['reviews']) {
    this.deps = deps
    this.state = state
    this.reviews = reviews
  }

  async run(sessionId: string, state: WorktreeLifecycle): Promise<boolean> {
    if (state.review === undefined) await this.review(sessionId)
    else if (!state.hasWindow && state.wait === undefined)
      await this.state.wait(sessionId, 'waiting-for-review', 'Review the synced changes in Session actions')
    return this.deps.records.get(sessionId)?.worktreeLifecycle?.step !== 'reviewing'
  }

  async review(sessionId: string): Promise<void> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const created = await this.reviews.create(sessionId, state.review?.message ?? state.execution?.commit?.message ?? '', state.review?.source ?? state.execution?.commit?.messageSource ?? 'unknown')
    // Nothing to commit: the empty selection is the only answer, so no dialog opens to ask for it.
    if (created.rows.length === 0) {
      const { message, source, version } = created.review
      const approved = await this.reviews.approve(sessionId, { selection: [], message, source, acknowledged: [], repositories: undefined, reviewVersion: version })
      if (!approved.ok) throw new Error(approved.detail)
      await this.prepareRoots(sessionId)
      return
    }
    if (!state.hasWindow) await this.state.wait(sessionId, 'waiting-for-review', 'Review the synced changes in Session actions')
  }

  async prepareRoots(sessionId: string): Promise<void> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const root = state.execution!.root
    const review = state.review!
    const read = await this.deps.svn.reviewRoots(root)
    if (!read.ok) throw new Error(read.detail)
    const selection = review.selection.map((path) => resolve(root, path))
    const roots = read.value.map((candidate) => ({ path: candidate.path, own: candidate.own, pinned: candidate.pinned,
      selection: selection.filter((path) => PathCompare.isInside(candidate.path, path)
        && !read.value.some((other) => other.path !== candidate.path && PathCompare.isInside(candidate.path, other.path) && PathCompare.isInside(other.path, path))) }))
      .filter((candidate) => candidate.selection.length > 0)
    if (roots.some((candidate) => candidate.pinned)) { await this.state.wait(sessionId, 'pinned-external', 'A selected external is pinned'); return }
    const bounds = await this.deps.svn.lowerBounds(read.value.filter((candidate) => roots.some((root) => root.path === candidate.path)))
    if (!bounds.ok) throw new Error(bounds.detail)
    const published = state.execution!.roots?.filter((candidate) => !roots.some((root) => root.path === candidate.path)
      && state.verified?.some((row) => PathCompare.comparable(row.root) === PathCompare.comparable(candidate.path))) ?? []
    const selected = roots.map((candidate) => ({ ...candidate, changed: read.value.find((row) => row.path === candidate.path)!.changed.map((row) => row.path), bounds: bounds.value[candidate.own] }))
    await this.state.write(sessionId, (current) => ({ ...current, step: roots.length === 0 ? 'disposing' : 'awaiting-idle',
      execution: { ...current.execution!, commit: undefined, roots: [...published, ...selected], rootCursor: published.length } }))
  }
}
