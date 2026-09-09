import type { IpcResult } from '../../shared/appClientUiIpc'
import { IpcSnapshotReader } from './ipcSnapshotReader'

export interface SnapshotStorePorts<T> {
  read(): Promise<IpcResult<T>>
  subscribe(onChanged: () => void): () => void
  reportError(message: string): void
}

export interface SnapshotStoreState<T> {
  snapshot: T | null
  error: string | null
}

/**
 * One document, one reader over it and one give-up state, for every surface in a window that draws
 * it. Beside the reader it wraps, and generic for the same reason that one is: the sessions store and
 * the rate store were the same hundred lines under two names, which is a pair that drifts.
 *
 * The revision gate is the part a caller must not lose. A push carries nothing, so every push costs a
 * read of the whole document, and most of what a poll republishes is the numbers again; a store that
 * published them anyway would re-render every subscriber for a document that did not move.
 *
 * `subject` is what a user sees when the reads give up, so it names the document rather than the
 * store: "The sessions snapshot could not be read after 5 attempts".
 */
export class SnapshotStore<T extends { revision: number }> {
  private state: SnapshotStoreState<T> = { snapshot: null, error: null }
  private readonly subscribers = new Set<() => void>()
  private reader: IpcSnapshotReader<T> | null = null

  constructor(
    private readonly subject: string,
    private readonly ports: SnapshotStorePorts<T>,
  ) {}

  start(): () => void {
    if (this.reader !== null)
      throw new Error(`${this.subject} store is already started`)
    const reader = new IpcSnapshotReader<T>(
      {
        subject: this.subject,
        read: () => this.ports.read(),
        subscribe: (onChanged) => this.ports.subscribe(onChanged),
        reportError: (message) => this.ports.reportError(message),
      },
      (snapshot) => this.arrived(snapshot),
      (error) => this.errorChanged(error),
    )
    this.reader = reader
    const stop = reader.start()
    return () => {
      if (this.reader !== reader)
        return
      stop()
      this.reader = null
    }
  }

  current(): SnapshotStoreState<T> {
    return this.state
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  refresh(): void {
    this.reader?.refresh()
  }

  private arrived(snapshot: T): void {
    if (this.state.snapshot?.revision === snapshot.revision)
      return
    this.state = { snapshot, error: this.state.error }
    this.publish()
  }

  private errorChanged(error: string | null): void {
    if (this.state.error === error)
      return
    this.state = { snapshot: this.state.snapshot, error }
    this.publish()
  }

  private publish(): void {
    for (const subscriber of this.subscribers)
      subscriber()
  }
}
