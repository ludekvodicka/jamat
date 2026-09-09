import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'

export interface IpcSnapshotPorts<T> {
  /** What this reader is reading, named for the line a user sees when it gives up. */
  subject: string
  read(): Promise<IpcResult<T>>
  /** One subscription for the whole reader; the returned function removes it. */
  subscribe(onChanged: () => void): () => void
  reportError(message: string): void
}

/**
 * A push that says "something changed", a read that answers with the whole document, and the three
 * rules that make the pair usable.
 *
 * Each rule is here because of what happens without it. The push carries nothing, so every push
 * means "read again" - the burst one create produces would be five reads of the same document, and
 * the 100 ms window turns them into one. A read that has not answered yet is never repeated; a push
 * arriving during it sets a trailing read instead, so the state the user ends on is the one after
 * the last change rather than before it. And a read that keeps failing backs off and then STOPS:
 * V1's incident of 2026-06-11 is what an unbounded retry against a gone main process looks like.
 *
 * Generic since 2026-08-10, when the Debug window became the second reader of a snapshot. The rules
 * are the reason it is one class: a copy of a hundred lines of them is a copy that drifts.
 */
export class IpcSnapshotReader<T> {
  /** Long enough to swallow the burst one operation produces, short enough to feel immediate. */
  static readonly coalesceMillisecondsConst = 100
  /** After this many reads in a row have failed, nothing is scheduled again without `refresh`. */
  static readonly maxAttemptsConst = 5

  private timer: ReturnType<typeof setTimeout> | null = null
  private reading = false
  /** A change arrived while a read was in flight: the answer in hand is already out of date. */
  private trailing = false
  private failures = 0
  private stopped = false
  private disposed = false

  constructor(
    private readonly ports: IpcSnapshotPorts<T>,
    private readonly onSnapshot: (snapshot: T) => void,
    private readonly onError: (message: string | null) => void,
  ) {}

  /** Subscribes, reads once, and hands back the one function that undoes both. */
  start(): () => void {
    const unsubscribe = this.ports.subscribe(() =>
      this.schedule(IpcSnapshotReader.coalesceMillisecondsConst))
    this.read()
    return () => {
      this.disposed = true
      unsubscribe()
      this.clearTimer()
    }
  }

  refresh(): void {
    if (this.disposed)
      return
    this.stopped = false
    this.failures = 0
    this.onError(null)
    this.read()
  }

  private schedule(delay: number): void {
    // An armed timer is the coalescing window: every push inside it is the same "read again".
    if (this.stopped || this.disposed || this.timer)
      return
    this.timer = setTimeout(() => {
      this.timer = null
      this.read()
    }, delay)
  }

  private read(): void {
    if (this.disposed || this.stopped)
      return
    if (this.reading) {
      this.trailing = true
      return
    }
    this.reading = true
    void this.ports.read()
      .then((answer) => this.answered(answer))
      .catch((thrown: unknown) => {
        this.reading = false
        if (!this.disposed)
          this.failed(ErrorText.of(thrown))
      })
  }

  private answered(answer: IpcResult<T>): void {
    this.reading = false
    if (this.disposed)
      return
    if (!answer.ok) {
      this.failed(answer.error)
      return
    }
    this.failures = 0
    this.onError(null)
    this.onSnapshot(answer.value)
    if (this.trailing) {
      this.trailing = false
      this.read()
    }
  }

  private failed(detail: string): void {
    // The trailing read is dropped with the failure: the next read, whenever it comes, reads the
    // whole document anyway, so remembering that one more change happened buys nothing.
    this.trailing = false
    this.failures += 1
    if (this.failures >= IpcSnapshotReader.maxAttemptsConst) {
      this.stopped = true
      const message = `${this.ports.subject} could not be read after `
        + `${IpcSnapshotReader.maxAttemptsConst} attempts (${detail}); it has stopped refreshing`
      this.ports.reportError(message)
      this.onError(message)
      return
    }
    this.ports.reportError(`${this.ports.subject} could not be read (${detail}); retrying`)
    this.schedule(IpcSnapshotReader.coalesceMillisecondsConst * 2 ** this.failures)
  }

  private clearTimer(): void {
    if (this.timer)
      clearTimeout(this.timer)
    this.timer = null
  }
}
