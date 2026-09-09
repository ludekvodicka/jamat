import { AtomicJsonFile } from '../shared/atomicJsonFile.js'
import type {
  RuntimeRef,
  RuntimeSessionInfo,
} from '../wire/hostWire.js'

interface SessionDocument {
  schemaVersion: 1
  savedAt: number
  sessions: Record<string, RuntimeSessionInfo>
  operations: Record<string, SessionOperationRecord>
}

export interface SessionOperationRecord {
  kind: 'create' | 'replace'
  requestKey: string
  target: RuntimeRef
}

/**
 * The live registry of one Host instance. It is NOT durable state.
 *
 * A Host owns PTYs as child processes, so its death takes them with it. Nothing it wrote can still be
 * true afterwards, which `docs/architecture/app-host.md` already states: "AppHost crash means PTY loss
 * and must be reported as such." A new Host therefore starts empty, and the file it writes has no
 * reader: it exists for diagnostics only.
 *
 * Reading it back was the single source of the hardest defect class in the V2 codebase. It made a
 * recorded answer outlive the reality it described, which is what produced replays reporting a live
 * session under a new Host's identity, evicted records executing an old stop against a later namesake,
 * and the whole cross-instance provenance problem. Durable truth belongs to whoever knows which
 * execution and project a session belonged to and can recreate it under the same id.
 */
export class SessionStore {
  /**
   * The ledger answers one question: is this operationId a client replaying a request it never got an
   * answer to? That replay arrives within seconds, so a bound is enough and a lifetime is not needed.
   * Without one the map grows for as long as the Host lives and flush() re-serializes all of it on
   * every write. A thousand is far past any burst a single Host instance can be asked to serve.
   */
  private static readonly operationLimitConst = 1_000
  private readonly sessions = new Map<string, RuntimeSessionInfo>()
  private readonly operations = new Map<string, SessionOperationRecord>()

  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string) => void,
  ) {}

  upsert(session: RuntimeSessionInfo, persist = true): void {
    this.sessions.set(session.runtimeSessionId, { ...session })
    if (persist) this.flush()
  }

  remove(runtimeSessionId: string, persist = true): boolean {
    const removed = this.sessions.delete(runtimeSessionId)
    if (removed && persist) this.flush()
    return removed
  }

  get(runtimeSessionId: string): RuntimeSessionInfo | undefined {
    const value = this.sessions.get(runtimeSessionId)
    return value ? { ...value } : undefined
  }

  list(): RuntimeSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session }))
  }

  /**
   * Idempotency within this Host's lifetime, which is the only span over which a recorded answer can
   * still be true. A retry after the Host died finds nothing and is answered by the runtime's absence.
   */
  operation(
    operationId: string,
    kind: SessionOperationRecord['kind'],
    requestKey: string,
  ): SessionOperationRecord | undefined {
    const operation = this.operations.get(operationId)
    if (!operation)
      return undefined
    if (operation.kind !== kind || operation.requestKey !== requestKey)
      throw new Error(`operationId ${operationId} was reused for a different request`)
    return {
      ...operation,
      target: { ...operation.target },
    }
  }

  recordOperation(
    operationId: string,
    operation: SessionOperationRecord,
  ): void {
    this.operations.set(operationId, {
      ...operation,
      target: { ...operation.target },
    })
    for (const oldest of this.operations.keys()) {
      if (this.operations.size <= SessionStore.operationLimitConst)
        break
      this.operations.delete(oldest)
    }
    this.flush()
  }

  /** Diagnostics only; nothing reads this file back. `onWarn` reports a dump that could not be written. */
  private flush(): void {
    const document: SessionDocument = {
      schemaVersion: 1,
      savedAt: Date.now(),
      sessions: Object.fromEntries(
        [...this.sessions.entries()].map(([id, session]) => [id, { ...session }]),
      ),
      operations: Object.fromEntries(this.operations),
    }
    try { AtomicJsonFile.write(this.file, document) }
    catch (error) {
      this.onWarn(
        `Host diagnostics dump could not be written: ${
          error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
