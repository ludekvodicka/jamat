import { lstatSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'

import {
  SessionMutationRules,
  type FileChangesShellRun,
  type SessionMutationBatch,
} from '../fileChangesManager/sessionMutationsView'
import type { ProviderSubagentFileRef, ProviderTranscriptRef, ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import type { SessionAgentId } from '../sessionManager/sessionManagerApi.types'
import type { SessionUncommittedCandidate } from '../sessionManager/sessionUncommittedView'
import { PathCompare } from '../shared/pathCompare'
import { ContentHashCache } from '../svn/svnContentHash'
import { SvnIgnoreRules } from '../svn/svnIgnoreRules'
import { SvnPathStates, type SvnPathFacts } from '../svn/svnPathStates'
import { SvnWcStamp } from '../svn/svnWcStamp'
import { ClaimCache, type ClaimCacheContent, type ClaimCacheSession } from './claims/claimCache'
import { SessionClaims, type PathClaim } from './claims/sessionClaims'
import { TranscriptCursor } from './claims/transcriptCursor'
import type { SessionUncommittedEntry } from './sessionUncommitted.types'

export interface SessionUncommittedTrackerOptions {
  transcripts: Pick<ProviderTranscriptView, 'resolve' | 'subagentFiles'>
  /** `%APPDATA%`, where svn's runtime config keeps `global-ignores`. */
  appData: string
  cache: ClaimCache
  now: () => number
}

/** What the tracker holds of one Jamat session between scans. */
interface TrackedSession {
  /** The candidate of the latest scan that named the session: what Finish's catch-up read needs. */
  candidate: SessionUncommittedCandidate
  cwd: string
  root: string
  nativeIds: string[]
  claims: SessionClaims
  /** Transcript file to its cursor: the session's own files and its sub-agents'. */
  cursors: Map<string, TranscriptCursor>
  /** The sub-agent files of each conversation, listed again only after the parent transcript grew. */
  subagents: Map<string, readonly ProviderSubagentFileRef[]>
  seenAt: number
}

/**
 * The uncommitted mark of every eligible session (D17), computed from each session's own claims
 * (D1): transcripts are read only past their cursors, and the claimed paths are decided from
 * `.svn/wc.db` with one read per working copy, without an svn process. Meant for a worker thread:
 * the path reads are synchronous.
 */
export class SessionUncommittedTracker {
  static readonly sampleSizeConst = 5
  /** Directory to its working-copy root; cleared whole when it grows past this. */
  private static readonly rootsMaxConst = 4_096
  private static readonly filesMaxConst = 4_096

  private readonly transcripts: Pick<ProviderTranscriptView, 'resolve' | 'subagentFiles'>
  private readonly appData: string
  private readonly cache: ClaimCache
  private readonly now: () => number
  private readonly hashes = new ContentHashCache()
  private readonly sessions = new Map<string, TrackedSession>()
  /** Sessions of the cache no scan has named yet; written back unchanged until one does or they expire. */
  private readonly restorable: Map<string, ClaimCacheSession>
  private readonly entries = new Map<string, SessionUncommittedEntry>()
  private readonly roots = new Map<string, string | null>()
  /** Agent, transcript directory and conversation id to the transcript file found for them. */
  private readonly files = new Map<string, string>()
  private pathStates: { ignores: SvnIgnoreRules; states: SvnPathStates } | null = null

  constructor(options: SessionUncommittedTrackerOptions) {
    this.transcripts = options.transcripts
    this.appData = options.appData
    this.cache = options.cache
    this.now = options.now
    this.restorable = new Map(Object.entries(options.cache.load().sessions))
  }

  /**
   * The entries of all `candidates` that have uncommitted claims; a session without one is absent.
   * With `roots`, only the sessions of those working copies are read and decided again; every other
   * candidate keeps the entry its last evaluation gave it.
   */
  async scan(candidates: readonly SessionUncommittedCandidate[], roots?: readonly string[]): Promise<Record<string, SessionUncommittedEntry>> {
    const now = this.now()
    const limited = roots === undefined ? null : new Set(roots.map((root) => PathCompare.comparable(root)))
    let changed = false
    const tracked: { candidate: SessionUncommittedCandidate; session: TrackedSession }[] = []
    const kept: Record<string, SessionUncommittedEntry> = {}
    const current = new Set<string>()
    for (const candidate of candidates) {
      const root = await this.rootOf(candidate.cwd)
      if (root === null) continue
      if (limited !== null && !limited.has(PathCompare.comparable(root))) {
        current.add(candidate.sessionId)
        const known = this.sessions.get(candidate.sessionId)
        if (known !== undefined) known.seenAt = now
        const entry = this.entries.get(candidate.sessionId)
        if (entry !== undefined) kept[candidate.sessionId] = entry
        continue
      }
      const session = this.tracked(candidate, root, now)
      session.candidate = candidate
      if (!session.nativeIds.includes(candidate.nativeSessionId)) {
        session.nativeIds.push(candidate.nativeSessionId)
        changed = true
      }
      session.seenAt = now
      for (const nativeId of session.nativeIds)
        if (await this.readTranscripts(candidate, session, nativeId)) changed = true
      tracked.push({ candidate, session })
    }
    const facts = await this.factsOf(tracked.map(({ session }) => session))
    const result: Record<string, SessionUncommittedEntry> = kept
    for (const { candidate, session } of tracked) {
      current.add(candidate.sessionId)
      const open = session.claims.open().length
      const dirty = session.claims.settle(facts, now)
      if (session.claims.open().length !== open) changed = true
      const undecided = session.claims.open().some((claim) => facts.get(claim.path)?.state.kind === 'unknown')
      const entry = undecided ? this.entries.get(candidate.sessionId) ?? null : SessionUncommittedTracker.entryOf(dirty, session.cwd)
      if (entry === null) this.entries.delete(candidate.sessionId)
      else {
        this.entries.set(candidate.sessionId, entry)
        result[candidate.sessionId] = entry
      }
    }
    for (const sessionId of [...this.entries.keys()])
      if (!current.has(sessionId)) this.entries.delete(sessionId)
    for (const [sessionId, session] of this.sessions)
      if (!current.has(sessionId) && ClaimCache.expired(session.seenAt, now)) {
        this.sessions.delete(sessionId)
        changed = true
      }
    if (changed) this.cache.scheduleWrite(this.content())
    return result
  }

  /**
   * A status Jamat computed anyway for `root`: its entries become `status` claims of each session
   * of that root whose shell run named them while they were written (D6).
   */
  observeStatus(root: string, entries: readonly { absolutePath: string; nodeKind: 'file' | 'directory' }[]): void {
    const sessions = [...this.sessions.values()].filter((session) => PathCompare.comparable(session.root) === PathCompare.comparable(root))
    if (sessions.length === 0) return
    const mtimes = new Map<string, number>()
    for (const entry of entries) {
      const modifiedAt = SessionUncommittedTracker.modifiedAt(entry.absolutePath)
      if (modifiedAt !== null) mtimes.set(entry.absolutePath, modifiedAt)
    }
    let changed = false
    for (const session of sessions) {
      const before = session.claims.all().length
      session.claims.observeStatus(root, entries, mtimes)
      if (session.claims.all().length !== before) changed = true
    }
    if (changed) this.cache.scheduleWrite(this.content())
  }

  /**
   * For Finish (D15): the open claims and shell runs of a tracked session, or null for one never
   * scanned. Its transcripts are read past their cursors first, so an edit made after the last scan
   * counts; nothing is settled here, because Finish decides with its own status.
   */
  async claims(sessionId: string): Promise<{ touched: readonly string[]; shellRuns: readonly FileChangesShellRun[] } | null> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return null
    let changed = false
    for (const nativeId of session.nativeIds)
      if (await this.readTranscripts(session.candidate, session, nativeId)) changed = true
    if (changed) this.cache.scheduleWrite(this.content())
    return { touched: session.claims.open().map((claim) => claim.path), shellRuns: session.claims.shellRuns() }
  }

  /** For the stop of the worker. */
  flush(): Promise<void> {
    return this.cache.flush()
  }

  private tracked(candidate: SessionUncommittedCandidate, root: string, now: number): TrackedSession {
    const found = this.sessions.get(candidate.sessionId) ?? this.restored(candidate, root)
    if (found !== undefined && PathCompare.comparable(found.cwd) === PathCompare.comparable(candidate.cwd)) return found
    const session: TrackedSession = {
      candidate,
      cwd: candidate.cwd,
      root,
      nativeIds: found?.nativeIds ?? [],
      claims: new SessionClaims({ cwd: candidate.cwd, root, claims: found?.claims.all(), shellRuns: found?.claims.shellRuns() }),
      cursors: found?.cursors ?? new Map(),
      subagents: found?.subagents ?? new Map(),
      seenAt: now,
    }
    this.sessions.set(candidate.sessionId, session)
    return session
  }

  /**
   * The cache's state of a session the first time a scan names it (D8): its claims, shell runs and
   * conversation ids, and one cursor per transcript, so only what grew since is read. The cache has
   * no directory of its own: that comes from the candidate.
   */
  private restored(candidate: SessionUncommittedCandidate, root: string): TrackedSession | undefined {
    const saved = this.restorable.get(candidate.sessionId)
    if (saved === undefined) return undefined
    this.restorable.delete(candidate.sessionId)
    const session: TrackedSession = {
      candidate,
      cwd: candidate.cwd,
      root,
      nativeIds: [...saved.nativeIds],
      claims: new SessionClaims({ cwd: candidate.cwd, root, claims: saved.claims, shellRuns: saved.shellRuns }),
      cursors: new Map(Object.entries(saved.cursors).map(([file, state]) => [file, new TranscriptCursor(state.agentId, state.role, state)])),
      subagents: new Map(),
      seenAt: saved.seenAt,
    }
    this.sessions.set(candidate.sessionId, session)
    return session
  }

  /** Whether anything was read: the conversation's own transcript, then its sub-agents'. */
  /**
   * A conversation's transcript file, resolved once and kept while it exists. The worker's view has
   * no Codex cwd memo, so each resolve of a Codex conversation would read every rollout header again.
   */
  private async resolve(agent: { agentId: SessionAgentId; cwd: string; nativeSessionId: string }): Promise<ProviderTranscriptRef | null> {
    const key = `${agent.agentId}\n${PathCompare.comparable(agent.cwd)}\n${agent.nativeSessionId}`
    const known = this.files.get(key)
    if (known !== undefined) {
      const stats = await stat(known).catch(() => null)
      if (stats?.isFile() === true)
        return { agentId: agent.agentId, nativeSessionId: agent.nativeSessionId, file: known, mtimeMs: stats.mtimeMs, size: stats.size }
      this.files.delete(key)
    }
    const ref = await this.transcripts.resolve(agent).catch(() => null)
    if (ref === null) return null
    if (this.files.size >= SessionUncommittedTracker.filesMaxConst) this.files.clear()
    this.files.set(key, ref.file)
    return ref
  }

  private async readTranscripts(candidate: SessionUncommittedCandidate, session: TrackedSession, nativeId: string): Promise<boolean> {
    const agent = { agentId: candidate.agentId, cwd: candidate.transcriptCwd, nativeSessionId: nativeId }
    const ref = await this.resolve(agent)
    if (ref === null) return false
    const grew = await this.read(session, candidate.agentId, ref.file, 'session')
    if (grew || !session.subagents.has(nativeId)) {
      const since = SessionMutationRules.subagentsSince(ref)
      session.subagents.set(nativeId, since === null ? [] : await this.transcripts.subagentFiles({ ...agent, since }).catch(() => []))
    }
    let read = grew
    for (const subagent of session.subagents.get(nativeId)!)
      if (await this.read(session, candidate.agentId, subagent.file, 'subagent')) read = true
    return read
  }

  private async read(
    session: TrackedSession,
    agentId: SessionAgentId,
    file: string,
    role: 'session' | 'subagent',
  ): Promise<boolean> {
    const cursor = session.cursors.get(file) ?? new TranscriptCursor(agentId, role)
    let batch: SessionMutationBatch | 'unchanged'
    // A transcript that vanished or cannot be read keeps the claims already taken from it.
    try { batch = await cursor.read(file) }
    catch { return false }
    session.cursors.set(file, cursor)
    if (batch === 'unchanged') return false
    session.claims.addMutations(batch.mutations)
    session.claims.addShellRuns(batch.shellRuns)
    return true
  }

  /** One `SvnPathStates.read` per working copy, over the open claims of every session. */
  private async factsOf(sessions: readonly TrackedSession[]): Promise<ReadonlyMap<string, SvnPathFacts>> {
    const byRoot = new Map<string, { root: string; paths: Set<string> }>()
    const facts = new Map<string, SvnPathFacts>()
    for (const session of sessions)
      for (const claim of session.claims.open()) {
        const root = await this.rootOf(dirname(claim.path))
        if (root === null) {
          facts.set(claim.path, { state: { kind: 'outside' }, changedAtMs: null })
          continue
        }
        const key = PathCompare.comparable(root)
        const group = byRoot.get(key) ?? { root, paths: new Set<string>() }
        group.paths.add(claim.path)
        byRoot.set(key, group)
      }
    if (byRoot.size === 0) return facts
    const states = this.states()
    for (const { root, paths } of byRoot.values())
      for (const [path, fact] of states.read(root, [...paths])) facts.set(path, fact)
    return facts
  }

  /** The ignore rules are read again when svn's runtime config changed; the hash cache outlives them. */
  private states(): SvnPathStates {
    const ignores = SvnIgnoreRules.fromRuntimeConfig(this.appData)
    if (this.pathStates?.ignores !== ignores)
      this.pathStates = { ignores, states: new SvnPathStates({ ignores, hashes: this.hashes }) }
    return this.pathStates.states
  }

  private async rootOf(directory: string): Promise<string | null> {
    const key = PathCompare.comparable(directory)
    const known = this.roots.get(key)
    if (known !== undefined) return known
    let root: string | null
    try { root = await SvnWcStamp.rootOf(directory) }
    catch { root = null }
    if (this.roots.size >= SessionUncommittedTracker.rootsMaxConst) this.roots.clear()
    this.roots.set(key, root)
    return root
  }

  private content(): ClaimCacheContent {
    const content = ClaimCache.empty()
    for (const [sessionId, saved] of this.restorable) content.sessions[sessionId] = saved
    for (const [sessionId, session] of this.sessions)
      content.sessions[sessionId] = {
        nativeIds: [...session.nativeIds],
        cursors: Object.fromEntries([...session.cursors].flatMap(([file, cursor]) => {
          const state = cursor.state()
          return state === null ? [] : [[file, state]]
        })),
        claims: session.claims.all().map((claim) => ({ ...claim })),
        shellRuns: [...session.claims.shellRuns()],
        seenAt: session.seenAt,
      }
    return content
  }

  private static entryOf(dirty: readonly PathClaim[], cwd: string): SessionUncommittedEntry | null {
    if (dirty.length === 0) return null
    const sample = [...dirty]
      .sort((left, right) => right.lastWriteAt - left.lastWriteAt)
      .slice(0, SessionUncommittedTracker.sampleSizeConst)
      .map((claim) => relative(cwd, claim.path).split(sep).join('/'))
    return { files: dirty.length, sample }
  }

  private static modifiedAt(path: string): number | null {
    try { return lstatSync(path, { throwIfNoEntry: false })?.mtimeMs ?? null }
    catch { return null }
  }
}
