import type { SvnConflictOption } from '../../svn/svn.types'
import type { SessionStepInfo, SessionStepProgress, SvnActionStage } from '../sessionManagerApi.types'
import { SvnConflictWords } from '../../worktrees/worktreeConflicts'

/** The client reads of an SVN action and of the cleanup after a session's end, each one step. */
export type SessionStepRead =
  | 'owner' | 'own-commits' | 'receipts' | 'fingerprint' | 'schedule-missing' | 'base-revision'
  | 'lock' | 'conflicts' | 'incoming' | 'review-roots' | 'review-bounds' | 'review-labels'
  | 'markers' | 'changes' | 'resolve' | 'leftovers' | 'assembly'

/**
 * The phases of a worktree removal that a step names, in their order: the wait for the operation
 * queue, letting go of this client's own reads below the worktree, the rename aside, the copy of
 * what the removal keeps (or the check of what an interrupted removal left), the count of the
 * files, their deletion and the tombstone on the record.
 */
export type SessionStepRemovalPhase = 'queue' | 'rename' | 'copy' | 'count' | 'delete' | 'tombstone'

/** A file the removal waits for: its error code, its holders when Windows named them, and the try of how many. */
export interface SessionStepHeld {
  file: string
  code: string
  holders: string | null
  attempt: number
  attempts: number
  everySeconds: number
}

/** What a client step is, before it is put into words. */
export type SessionStepFacts =
  | { kind: 'stopping'; limitSeconds: number }
  | { kind: 'lock-wait'; relaunch: number; relaunches: number }
  /** A client stage on the record that no drive runs yet: after a press, a verdict or a restart. */
  | { kind: 'pending'; stage: SvnActionStage }
  /**
   * `revision`: the one being read (own commits, receipts) or the first one asked for (incoming).
   * `count`: the files a read covers. `mount`: the external mount it reads, `''` for the worktree.
   */
  | { kind: 'read'; read: SessionStepRead; revision?: number; count?: number; mount?: string }
  /**
   * `resumed`: an earlier removal left `<path>.deleting`, and this one goes on with it (UA1-J09-10).
   * `held`: the deletion waits for a file a program holds, named relative to the aside (UA1-J11-6).
   */
  | { kind: 'removal'; phase: SessionStepRemovalPhase; path: string; resumed?: true; held?: SessionStepHeld }
  | { kind: 'recording' }
  /** A Finish reads its own publication back: the revision its receipt names, null when none does. */
  | { kind: 'publication'; revision: number | null }
  /** One option the `fixing` stage runs on a conflicted path: the `index`th of `count`. */
  | { kind: 'fixing'; path: string; option: SvnConflictOption; index: number; count: number }

/**
 * The words of a session's step. They are composed here, never by a surface, so the window, a
 * peer's window and the CLI say one thing. Nothing here reads a clock.
 */
export class SessionStepWords {
  /** Grouped the same on every machine: `12,000`, never the locale's own separator. */
  private static readonly numbersConst = new Intl.NumberFormat('en-US')

  /** The text alone: a step with a new text is a new step, one with the same text only moved on. */
  static textOf(facts: SessionStepFacts): string {
    return SessionStepWords.of(facts, null).text
  }

  static of(facts: SessionStepFacts, progress: SessionStepProgress | null): Pick<SessionStepInfo, 'text' | 'detail'> {
    const kind = facts.kind
    switch (kind) {
      case 'stopping':
        return { text: 'Stopping the session', detail: `the action waits up to ${facts.limitSeconds} s for its end` }
      case 'lock-wait':
        return { text: 'Waiting for the svn lock', detail: `relaunch ${facts.relaunch} of ${facts.relaunches}` }
      case 'pending': return SessionStepWords.pendingOf(facts.stage)
      case 'read': return SessionStepWords.readOf(facts, progress)
      case 'removal': return SessionStepWords.removalOf(facts, progress)
      case 'recording': return { text: 'Recording the result', detail: 'run logs, durable result, session record' }
      case 'publication':
        return { text: `Verifying the publication${facts.revision === null ? '' : ` r${facts.revision}`}`, detail: 'svn log, status, contents and properties at that revision' }
      case 'fixing':
        return {
          text: `Fixing ${facts.path} (${SvnConflictWords.optionWordOf(facts.option)}), ${facts.index} of ${facts.count}`,
          detail: 'saved first, then svn resolve',
        }
      default: throw new Error(`Unknown session step: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static number(value: number): string {
    return SessionStepWords.numbersConst.format(value)
  }

  private static readOf(facts: Extract<SessionStepFacts, { kind: 'read' }>, progress: SessionStepProgress | null)
    : Pick<SessionStepInfo, 'text' | 'detail'> {
    const read = facts.read
    const where = facts.mount === undefined || facts.mount === '' ? '' : ` in ${facts.mount}`
    const files = facts.count === undefined ? '' : ` (${SessionStepWords.counted(facts.count, 'file')})`
    switch (read) {
      case 'owner': return { text: 'Checking the worktree\'s owner', detail: 'svn info --xml of the main copy' }
      case 'own-commits': {
        const total = progress?.total ?? null
        const detail = progress === null || total === null || facts.revision === undefined
          ? 'svn status -v --xml'
          : `svn log -v -r${facts.revision} (${SessionStepWords.number(progress.done)} of ${SessionStepWords.counted(total, 'revision')})`
        return { text: 'Reading what the worktree committed', detail: `${detail}${where}` }
      }
      case 'receipts':
        return {
          text: 'Confirming the commits from the session\'s split',
          detail: `${facts.revision === undefined ? 'svn log -v' : `svn log -v -r${facts.revision}`}${where}`,
        }
      case 'fingerprint': return { text: 'Checking whether the passed checks still hold', detail: `svn status -v --xml${where}` }
      case 'assembly': return { text: 'Verifying the prepared application', detail: `Reading source contents, properties and SVN identities${where}${files}` }
      case 'schedule-missing': return { text: 'Scheduling the files deleted from disk', detail: 'svn status --xml, svn delete' }
      case 'base-revision': return { text: 'Reading the revision the update starts from', detail: 'svn info --xml' }
      case 'lock': return { text: 'Checking the svn lock', detail: 'svn status --xml' }
      case 'conflicts': return { text: 'Reading conflicts after the update', detail: 'svn status --xml' }
      case 'incoming':
        return {
          text: 'Reading what the update brought in',
          detail: facts.revision === undefined ? 'svn log -v --xml' : `svn log -v --xml -r${facts.revision}:HEAD`,
        }
      case 'review-roots': return { text: 'Finding what is left to review', detail: 'svn status --xml, svn propget svn:externals' }
      case 'review-bounds': return { text: 'Reading the bounds of the review', detail: `svn info --xml${where}` }
      case 'review-labels': return { text: 'Reading what the review committed', detail: `svn log -v${where}` }
      case 'markers': return { text: 'Checking the resolved files for conflict markers', detail: `conflict markers${files}` }
      case 'changes': return { text: 'Checking what the resolver changed', detail: 'svn status --xml' }
      case 'resolve': return { text: 'Marking the conflicts resolved', detail: `svn resolve --accept working${files}` }
      case 'leftovers': return { text: 'Checking what is left in the worktree', detail: 'svn status --xml' }
      default: throw new Error(`Unknown session step read: ${JSON.stringify(read satisfies never)}`)
    }
  }

  private static removalOf(facts: Extract<SessionStepFacts, { kind: 'removal' }>, progress: SessionStepProgress | null)
    : Pick<SessionStepInfo, 'text' | 'detail'> {
    const phase = facts.phase
    const resumed = facts.resumed === true
    switch (phase) {
      case 'queue': return { text: 'Waiting for other operations', detail: facts.path }
      case 'rename': return { text: resumed ? 'Resuming the interrupted removal' : 'Moving the worktree aside', detail: `${facts.path}.deleting` }
      case 'copy':
        return { text: resumed ? 'Checking the files the interrupted removal left' : 'Saving the files to keep before deleting', detail: `${facts.path}.deleting` }
      case 'count':
        return {
          text: resumed ? 'Counting the files left to delete' : 'Counting the files to delete',
          detail: progress === null ? `${facts.path}.deleting` : `${SessionStepWords.counted(progress.done, 'file')} so far`,
        }
      case 'tombstone': return { text: 'Recording the removal', detail: 'session record' }
      case 'delete': {
        const held = facts.held
        if (held !== undefined)
          return {
            text: 'Waiting for a held file',
            detail: `${held.file} is held by ${held.holders ?? `another program (${held.code})`}; try ${held.attempt} of ${held.attempts}, again every ${held.everySeconds} s`,
          }
        const total = progress?.total ?? null
        return {
          text: resumed ? 'Deleting the rest of the worktree' : 'Removing the worktree',
          detail: progress === null || total === null
            ? facts.path
            : `${SessionStepWords.number(progress.done)} of ${SessionStepWords.counted(total, 'file')}`,
        }
      }
      default: throw new Error(`Unknown removal phase: ${JSON.stringify(phase satisfies never)}`)
    }
  }

  /** A client stage the record names and no drive runs yet. A run stage speaks through its own row. */
  private static pendingOf(stage: SvnActionStage): Pick<SessionStepInfo, 'text' | 'detail'> {
    switch (stage) {
      case 'committing': return { text: 'Committing the selected files', detail: 'waiting to start' }
      case 'changes': return { text: 'Review the changes', detail: 'waits for you' }
      case 'main-update': return { text: 'Update main copy', detail: 'waits for you' }
      case 'stopping': return { text: 'Stopping the session', detail: 'waiting to start' }
      case 'evidence': return { text: 'Reading what the worktree committed', detail: 'waiting to start' }
      case 'verifying': return { text: 'Checking what the resolver left', detail: 'waiting to start' }
      case 'fixing': return { text: 'Checking the conflicts', detail: 'waiting to start' }
      case 'removing': return { text: 'Removing the worktree', detail: 'waiting to start' }
      case 'recording': return { text: 'Recording the result', detail: 'waiting to start' }
      case 'checks': case 'updating': case 'cleaning': case 'resolving': case 'merging': case 'diffing': case 'reviewing':
        throw new Error(`The run stage ${stage} is never a pending client step`)
      default: throw new Error(`Unknown SVN action stage: ${JSON.stringify(stage satisfies never)}`)
    }
  }

  private static counted(value: number, noun: string): string {
    return `${SessionStepWords.number(value)} ${noun}${value === 1 ? '' : 's'}`
  }
}
