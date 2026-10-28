import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { NotifySource, PendingNotify } from '../../sessionManager/worktreeSessionRuntime'

/** What the notices read and write: the records store, once the lifecycle loaded it. */
export type SvnWaitNoticeRecords = Pick<SessionRecordsStore, 'list' | 'update'>

/**
 * The caller's line when a worktree Finish or Discard starts to wait for the person: the text the
 * caller gave with `worktree.notify`, typed once into its session like a result's line. The notice
 * lives on the action (`SessionRecordSvnAction.notice`), so it survives a client restart, the next
 * wait replaces it with a new id, and it goes with the action. Delivered, refused and expired tries
 * are written back on it.
 */
export class SvnWaitNotices implements NotifySource {
  private readonly records: () => SvnWaitNoticeRecords | null

  constructor(records: () => SvnWaitNoticeRecords | null) {
    this.records = records
  }

  pending(): PendingNotify[] {
    return (this.records()?.list() ?? []).flatMap((record) => {
      const notice = record.svnAction?.notice
      const notify = SvnWaitNotices.notifyOf(record)
      return notice?.state === 'pending' && notify !== undefined
        ? [{ id: notice.id, sessionId: notify.sessionId, text: notify.text, at: notice.at, attempts: notice.attempts }]
        : []
    })
  }

  /** `attempted` counts a refused try; the other two end the notice. */
  async note(ids: readonly string[], state: 'delivered' | 'attempted' | 'expired', at: number): Promise<void> {
    const records = this.records()
    if (records === null) return
    for (const record of records.list()) {
      const id = record.svnAction?.notice?.id
      if (id === undefined || !ids.includes(id)) continue
      await records.update(record.sessionId, (latest) => {
        const action = latest.svnAction
        const notice = action?.notice
        if (action === undefined || notice?.id !== id || notice.state !== 'pending') return null
        if (state === 'attempted') return { ...latest, svnAction: { ...action, notice: { ...notice, attempts: notice.attempts + 1 } } }
        else if (state === 'delivered' || state === 'expired') return { ...latest, svnAction: { ...action, notice: { ...notice, state, settledAt: at } } }
        else throw new Error(`Unknown notify state: ${JSON.stringify(state satisfies never)}`)
      })
    }
  }

  /** The caller's line, on the worktree while it stands, on the tombstone after. */
  private static notifyOf(record: SessionRecord): { sessionId: string; text: string } | undefined {
    return (record.worktree ?? record.retiredWorktree)?.caller?.notify
  }
}
