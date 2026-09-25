import type { RemoteControlConst, RemoteControlLocalConst } from './remoteControlProtocol'

import type {
  CategoryInfo,
  ProjectListResult,
  ProjectsOpResult,
} from '../projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionColorName,
  SessionCreateSpec,
  SessionGroup,
  SessionInfo,
  SessionsSnapshot,
  TerminalComposerState,
  TerminalFrame,
} from '../sessionManager/sessionManagerApi.types'
import type { AgentWorkHint } from '../sessionManager/workState/agentWorkInspector.types'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import type { SessionTranscriptReading } from '../sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type {
  RemoteControlPeerPairingBundle,
  RemoteControlPeerProfile,
} from './remoteControlPeerApi.types'

export type RemoteControlProtocol = typeof RemoteControlConst.protocol
export type RemoteControlOperation =
  | typeof RemoteControlConst.operations[number]
  | typeof RemoteControlConst.optionalOperations[number]
export type RemoteControlDescriptorOperation = typeof RemoteControlConst.descriptorOperations[number]
export type RemoteControlOptionalOperation = typeof RemoteControlConst.optionalOperations[number]
export type RemoteControlMutatingOperation = typeof RemoteControlConst.mutatingOperations[number]
export type RemoteControlLocalOperation = typeof RemoteControlLocalConst.operations[number]
export type RemoteControlLocalMutatingOperation =
  typeof RemoteControlLocalConst.mutatingOperations[number]

/**
 * `number` is whatever sits in the session's number slot and is matched against it verbatim: an
 * allocated `014`, a custom `i34`, or a fork pair of either. `SessionTitle.selectorConst` is the
 * one rule, so what a session can be CALLED and what it can be selected by cannot drift apart.
 */
export type RemoteControlSessionSelector =
  | { kind: 'sessionId'; sessionId: string }
  | { kind: 'number'; number: string }

export interface RemoteControlSystemIdentity {
  configIdentity: string
  runtimeChannel: RuntimeChannel
  instanceId: string
  startedAt: number
  applicationVersion: string
}

export interface RemoteControlDescriptor extends RemoteControlSystemIdentity {
  schemaVersion: 1
  protocol: RemoteControlProtocol
  address: '127.0.0.1'
  port: number
  pid: number
  token: string
  operations: readonly RemoteControlDescriptorOperation[]
  optionalOperations?: readonly RemoteControlOptionalOperation[]
  localOperations?: readonly RemoteControlLocalOperation[]
  websocket: true
}

/**
 * `idle` and `offline` are both "not connected" and they are not the same answer: idle is nobody
 * asked, offline is somebody asked and the dial did not land. A computer that is switched off reads
 * idle here until a window or a command wants it, which is the whole point of dialling on demand.
 */
export type RemoteOutboundConnectionStatus = 'idle' | 'connecting' | 'connected' | 'offline'

/**
 * What both surfaces say about one paired computer. Written once because it is the same fields: the
 * CLI adds a session count to it and the window adds the live connection and its snapshot, and
 * before this they were two lists side by side, drifting one careful edit at a time.
 *
 * The last four are the connection's own diagnosis and are additive on purpose: `remote.computers
 * .list` and the settings screen ask the same connector the same question, so a reason a dial is
 * not happening has one wording rather than one per surface.
 */
export interface RemoteControlComputerFactsDto {
  profileId: string
  remoteComputerId: string
  remoteEndpointId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  displayName: string
  endpoint: { host: string; port: number }
  status: RemoteOutboundConnectionStatus
  error: RemoteControlError | null
  /** When a connection to it last stood. It survives the disconnection: that is the whole point. */
  lastConnectedAt: number | null
  /** When the next dial is due, written where the reconnect is scheduled; null while none waits. */
  nextRetryAt: number | null
  /** What that computer answered it runs, from one `system.hello` after the connection stood. */
  applicationVersion: string | null
  /**
   * What it offered BEYOND the operations every controller may call, from that same hello. Null
   * until one has been answered, which is not the same as an empty list: nothing has been asked yet.
   * Names this build does not know are dropped rather than kept as text - a gate reads this.
   */
  optionalOperations: readonly RemoteControlOptionalOperation[] | null
}

/** One paired computer as the CLI is told about it. */
export interface RemoteControlComputerDto extends RemoteControlComputerFactsDto {
  sessionCount: number | null
}

export interface RemoteControlComputersDto {
  revision: number
  computers: readonly RemoteControlComputerDto[]
}

export interface RemoteControlHelloDto extends RemoteControlSystemIdentity {
  protocol: RemoteControlProtocol
  operations: readonly RemoteControlDescriptorOperation[]
  optionalOperations?: readonly RemoteControlOptionalOperation[]
}

export interface RemoteControlStatusDto {
  identity: RemoteControlSystemIdentity
  sessions: {
    revision: number
    reconciled: boolean
    count: number
    host: SessionsSnapshot['host']
  }
  tabs: { count: number }
}

/**
 * One model the ANSWERING computer offers, as its own catalog names it. Structural on purpose: this
 * library may never import app-client-ui, where that catalog lives, so the shape is written here and
 * the composing side maps its own entries onto it.
 */
export interface RemoteControlAgentModelDto {
  id: string
  label: string
  kind: 'alias' | 'version'
  context: number
  efforts: readonly string[]
  note?: string
}

export interface RemoteControlAgentDto {
  agentId: SessionAgentId
  /**
   * What the ANSWERING computer has configured for this agent, or null where it has no opinion and
   * the agent starts on its own default. A value that is no longer in `models` is still returned:
   * an id that left the catalog keeps working, and hiding it would draw the wrong thing as chosen.
   */
  configuredModel: string | null
  /** That computer's catalog, which matches ITS CLI versions and not the asking side's. */
  models: readonly RemoteControlAgentModelDto[]
}

export interface RemoteControlAgentsDto {
  agents: readonly RemoteControlAgentDto[]
}

export interface RemoteControlProjectCategoryDto {
  category: CategoryInfo
  listing: ProjectsOpResult<ProjectListResult>
}

export interface RemoteControlProjectsDto {
  categories: readonly RemoteControlProjectCategoryDto[]
}

export interface RemoteControlTabDto {
  commitReviews?: readonly RemoteControlCommitStatusDto[]
  panelId: string
  windowId: string
  key: string
  title: string
  params: Record<string, unknown>
  sessionId: string | null
  active: boolean
}

export type RemoteControlTabCommandDto =
  | { kind: 'opened'; panelId: string; windowId: string }
  | { kind: 'focused-existing'; panelId: string; windowId: string }
  | { kind: 'closed'; panelId: string; windowId: string }

export interface RemoteControlTabOpenFileDto {
  kind: 'file-opened'
  panelId: string
  windowId: string
  path: string
}

export interface RemoteControlTabOpenCommitDto {
  kind: 'commit-opened'
  commitSessionId?: string
  panelId: string
  windowId: string
  scopeRoot: string
  messageApplied: boolean
}

export interface RemoteControlCommitStatusDto {
  paths?: readonly string[]
  kind: 'commit-status'
  commitSessionId: string
  sessionId: string
  vcs: 'svn' | 'git'
  scopeRoot: string
  state: 'editing' | 'running' | 'committed' | 'failed' | 'cancelled' | 'external-closed'
  closed: boolean
  revision: string | null
  detail: string | null
}

export type RemoteControlErrorCode = typeof RemoteControlConst.errorCodes[number]

export interface RemoteControlError {
  code: RemoteControlErrorCode
  detail: string
  data?: Record<string, unknown>
}

export type RemoteControlStepResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteControlError }

export interface RemoteControlSessionCreateDto {
  session: { sessionId: string; tabTitle: string }
  tabOpen: RemoteControlStepResult<RemoteControlTabCommandDto> | null
  /**
   * Null when no group was asked for. A group that was asked for and could not be written is a
   * failure of its own step rather than of the create: the session exists, and refusing the call
   * over the section it was filed under would leave the caller holding a session it thinks it does
   * not have. The same shape and the same reason as `tabOpen` beside it.
   */
  groupAssign: RemoteControlStepResult<{ group: SessionGroup }> | null
}

export interface RemoteControlSessionTranscriptDto {
  sessionId: string
  transcriptContentUntrusted: true
  reading: SessionTranscriptReading
}

export interface RemoteControlTerminalPeekDto {
  sessionId: string
  snapshot: {
    type: 'terminal.snapshot'
    projection: Omit<
      Extract<TerminalFrame, { type: 'terminal.snapshot' }>['projection'],
      'raw' | 'screen'
    > & {
      screen: string
      screenTruncated: boolean
    }
  }
  terminalOutputUntrusted: true
}

export interface RemoteControlTerminalSendDto {
  sessionId: string
  accepted: true
  characterCount: number
  enter: boolean
}

/** `paste` wraps the text in bracketed-paste markers as one write; `typed` writes it raw. */
export type RemoteControlTerminalDeliverInput = 'paste' | 'typed'

/** What proved the submit: the user turn in the transcript, a queued row, a new busy hint, or Claude's echo. */
export type RemoteControlTerminalDeliverProof = 'transcript' | 'queued' | 'working' | 'echo'

/** What proved the composer took the text: the text itself, or a new collapsed-paste placeholder. */
export type RemoteControlTerminalDeliverComposeProof = 'text' | 'placeholder'

/**
 * The key that submitted the draft. `tab` only for `queue: true` on a Codex target that was busy at
 * ready time: Codex treats Enter during a running turn as a steer into that turn, and Tab queues.
 */
export type RemoteControlTerminalDeliverSubmitKey = 'enter' | 'tab'

export interface RemoteControlTerminalDeliverDto {
  sessionId: string
  accepted: true
  characterCount: number
  delivered: true
  input: RemoteControlTerminalDeliverInput
  composeProof: RemoteControlTerminalDeliverComposeProof
  proof: RemoteControlTerminalDeliverProof
  submitKey: RemoteControlTerminalDeliverSubmitKey
  readyAfterMs: number
  submittedAfterMs: number
}

export type RemoteControlTerminalDeliverStage = 'validate' | 'attach' | 'ready' | 'compose' | 'submit'

export type RemoteControlTerminalDeliverReason =
  | 'shell-session' | 'not-live'
  | 'dialog' | 'foreign-draft' | 'read-only' | 'in-flight'
  | 'not-ready'
  | 'text-not-visible'
  | 'draft-remains' | 'unproven'
  | 'disconnected' | 'reattached' | 'exited'
  | 'failed'

/** What `RemoteControlError.data` holds on a refused or failed delivery. Codes are the existing ones. */
export interface RemoteControlTerminalDeliverFailureData {
  stage: RemoteControlTerminalDeliverStage
  reason: RemoteControlTerminalDeliverReason
  typed: boolean
  entered: 0 | 1 | 2
  hint: AgentWorkHint | null
  composer: TerminalComposerState | null
}

export type RemoteControlEventKind = 'sessions.changed' | 'tabs.changed'

export interface RemoteControlEventDto {
  revision: number
  kind: RemoteControlEventKind
  at: number
}

export type RemoteControlSocketOperation = typeof RemoteControlConst.socketOperations[number]

export type RemoteControlSocketRequest =
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operation: 'events.subscribe'
      afterRevision?: number
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operationId: string
      operation: 'terminal.attach'
      attachId: string
      sessionId: string
      size: { cols: number; rows: number } | null
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operationId: string
      operation: 'terminal.input'
      attachId: string
      data: string
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operationId: string
      operation: 'terminal.resize'
      attachId: string
      cols: number
      rows: number
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operationId: string
      operation: 'terminal.active'
      attachId: string
      active: boolean
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string
      operationId: string
      operation: 'terminal.detach'
      attachId: string
    }

export type RemoteControlSocketResponse =
  | {
      protocol: RemoteControlProtocol
      type: 'response'
      requestId: string | null
      operation: RemoteControlSocketOperation | null
      operationId: string | null
      ok: true
      value: unknown
    }
  | {
      protocol: RemoteControlProtocol
      type: 'response'
      requestId: string | null
      operation: RemoteControlSocketOperation | null
      operationId: string | null
      ok: false
      error: RemoteControlError
    }
  | {
      protocol: RemoteControlProtocol
      type: 'event'
      event: RemoteControlEventDto
    }
  | {
      protocol: RemoteControlProtocol
      type: 'terminal.frame'
      attachId: string
      frame: TerminalFrame
      terminalOutputUntrusted: true
    }

export interface RemoteControlOperationMap {
  'system.hello': {
    request: Record<string, never>
    response: RemoteControlHelloDto
  }
  'system.status': {
    request: Record<string, never>
    response: RemoteControlStatusDto
  }
  'projects.list': {
    request: { categoryId?: string; sort?: 'alpha' | 'recent' }
    response: RemoteControlProjectsDto
  }
  'sessions.list': {
    request: Record<string, never>
    response: Omit<SessionsSnapshot, 'sessions'> & {
      // Older controllers omit group; current controllers always send the effective id or null.
      sessions: readonly (SessionInfo & { group?: SessionGroup | null })[]
    }
  }
  'sessions.create': {
    request: { spec: SessionCreateSpec; openTab?: boolean; group?: SessionGroup }
    response: RemoteControlSessionCreateDto
  }
  'sessions.reopen': {
    request: { session: RemoteControlSessionSelector }
    response: { sessionId: string }
  }
  'sessions.finalize': {
    request: { session: RemoteControlSessionSelector }
    response: { sessionId: string }
  }
  /**
   * Delete an ended record from the list, the tree's Remove. A live runtime is refused with
   * `conflict` rather than stopped: ending work is a separate decision this operation never takes.
   * A worktree is left on disk, as the tree's Remove leaves it.
   */
  'sessions.remove': {
    request: { session: RemoteControlSessionSelector }
    response: { sessionId: string }
  }
  'sessions.transcript': {
    request: { session: RemoteControlSessionSelector }
    response: RemoteControlSessionTranscriptDto
  }
  /**
   * What a session LOOKS like after it exists, which a create could already say and nothing could
   * say afterwards. The caller they are for is a scheduler: a worker that finishes its automatic
   * work and starts waiting for a person has become a different kind of session, and the tree is
   * where a person reads that. Naming it at birth and never again means the row goes on claiming
   * what the session was.
   *
   * Both name the value rather than toggling it, so repeating a request is the same as sending it
   * once. `color` has no way to say "no colour": clearing one is a person's gesture in the menu and
   * no caller has asked for it.
   */
  'sessions.color': {
    request: { session: RemoteControlSessionSelector; color: SessionColorName }
    response: { sessionId: string; color: SessionColorName }
  }
  'sessions.group': {
    request: { session: RemoteControlSessionSelector; group: SessionGroup }
    response: { sessionId: string; group: SessionGroup }
  }
  /**
   * The person's note about a session, and the one field of a session with a read of its own.
   *
   * It is what a caller writes in order to be READ - by the person hovering the row, and by the
   * next pass of the same automation - so it is the one field where "what does it say now" is a
   * question worth a round trip of its own rather than a filter over `sessions.list`.
   *
   * `null` in `setNote` clears it, which `color` deliberately has no way to say: a colour is a mark
   * somebody chose and takes away by hand, while a note that is no longer true is worse than no
   * note. The stored value is answered back by both, trimmed the way the record holds it.
   */
  'sessions.note': {
    request: { session: RemoteControlSessionSelector }
    response: { sessionId: string; note: string | null }
  }
  'sessions.setNote': {
    request: { session: RemoteControlSessionSelector; note: string | null }
    response: { sessionId: string; note: string | null }
  }
  'agents.describe': {
    request: Record<string, never>
    response: RemoteControlAgentsDto
  }
  'tabs.list': {
    request: Record<string, never>
    response: { tabs: readonly RemoteControlTabDto[] }
  }
  'tabs.open': {
    request: { session: RemoteControlSessionSelector }
    response: RemoteControlTabCommandDto
  }
  'tabs.openFile': {
    request: { session: RemoteControlSessionSelector; path: string }
    response: RemoteControlTabOpenFileDto
  }
  'tabs.openCommit': {
    request: { session: RemoteControlSessionSelector; vcs: 'svn' | 'git'; scope?: string; paths?: readonly string[]; message?: string }
    response: RemoteControlTabOpenCommitDto
  }
  'tabs.commitStatus': {
    request: { commitSessionId: string }
    response: RemoteControlCommitStatusDto
  }
  'tabs.cancelCommit': {
    request: { commitSessionId: string }
    response: RemoteControlCommitStatusDto
  }
  'tabs.focus': {
    request: { panelId: string }
    response: RemoteControlTabCommandDto
  }
  'tabs.close': {
    request: { panelId: string }
    response: RemoteControlTabCommandDto
  }
  'terminal.peek': {
    request: { session: RemoteControlSessionSelector; cols?: number; rows?: number; timeoutMs?: number }
    response: RemoteControlTerminalPeekDto
  }
  'terminal.send': {
    request: {
      session: RemoteControlSessionSelector
      text: string
      enter?: boolean
      timeoutMs?: number
    }
    response: RemoteControlTerminalSendDto
  }
  'terminal.deliver': {
    request: {
      session: RemoteControlSessionSelector
      text: string
      input?: RemoteControlTerminalDeliverInput
      readyTimeoutMs?: number
      submitTimeoutMs?: number
      /** Queue behind a busy Codex turn with Tab instead of steering it with Enter. Default false. */
      queue?: boolean
    }
    response: RemoteControlTerminalDeliverDto
  }
}

export interface RemoteControlLocalOperationMap {
  'remote.computers.list': {
    request: Record<string, never>
    response: RemoteControlComputersDto
  }
  'remote.pairing.export': {
    request: Record<string, never>
    response: RemoteControlPeerPairingBundle
  }
  /**
   * The bundle and nothing else. Taking another computer in grants ONE direction - this computer
   * may reach that one - and what that computer may do here is the target's own to allow, at its
   * own dialog, so there is no right left for this body to carry.
   */
  'remote.pairing.import': {
    request: { bundle: RemoteControlPeerPairingBundle }
    response: RemoteControlPeerProfile
  }
}

/**
 * The map is closed in BOTH directions.
 *
 * The indexed access below already refuses an operation the map has no entry for. This refuses the
 * other way round: an entry that is no longer an operation, which would otherwise sit here forever
 * describing a request nobody can send. It is a type alias with no runtime part; the constraint is
 * the whole of it, and it fails at this declaration rather than somewhere downstream.
 */
export type RemoteControlOperationMapIsClosed<
  K extends RemoteControlOperation = keyof RemoteControlOperationMap,
> = K

export type RemoteControlRequestBody<K extends RemoteControlOperation> =
  RemoteControlOperationMap[K]['request']
export type RemoteControlResponseBody<K extends RemoteControlOperation> =
  RemoteControlOperationMap[K]['response']

/** The same closure for the local map, for the same reason. */
export type RemoteControlLocalOperationMapIsClosed<
  K extends RemoteControlLocalOperation = keyof RemoteControlLocalOperationMap,
> = K

export type RemoteControlLocalRequestBody<K extends RemoteControlLocalOperation> =
  RemoteControlLocalOperationMap[K]['request']
export type RemoteControlLocalResponseBody<K extends RemoteControlLocalOperation> =
  RemoteControlLocalOperationMap[K]['response']

export type RemoteControlRequest<K extends RemoteControlOperation = RemoteControlOperation> =
  K extends RemoteControlOperation
    ? {
        protocol: RemoteControlProtocol
        requestId: string
        operation: K
        operationId?: string
        body: RemoteControlRequestBody<K>
      }
    : never

export type RemoteControlRequestUnion = {
  [K in RemoteControlOperation]: RemoteControlRequest<K>
}[RemoteControlOperation]

export type RemoteControlLocalRequest<
  K extends RemoteControlLocalOperation = RemoteControlLocalOperation,
> = K extends RemoteControlLocalOperation
  ? {
      protocol: RemoteControlProtocol
      requestId: string
      operation: K
      operationId?: string
      body: RemoteControlLocalRequestBody<K>
    }
  : never

export type RemoteControlLocalRequestUnion = {
  [K in RemoteControlLocalOperation]: RemoteControlLocalRequest<K>
}[RemoteControlLocalOperation]

export type RemoteControlResponse<K extends RemoteControlOperation = RemoteControlOperation> =
  | {
      protocol: RemoteControlProtocol
      requestId: string | null
      operation: K | null
      operationId: string | null
      ok: true
      value: RemoteControlResponseBody<K>
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string | null
      operation: K | null
      operationId: string | null
      ok: false
      error: RemoteControlError
    }

export type RemoteControlLocalResponse<
  K extends RemoteControlLocalOperation = RemoteControlLocalOperation,
> =
  | {
      protocol: RemoteControlProtocol
      requestId: string | null
      operation: K | null
      operationId: string | null
      ok: true
      value: RemoteControlLocalResponseBody<K>
    }
  | {
      protocol: RemoteControlProtocol
      requestId: string | null
      operation: K | null
      operationId: string | null
      ok: false
      error: RemoteControlError
    }

export interface RemoteControlSessionCandidate {
  sessionId: string
  number: string | null
  tabTitle: string
  project: SessionInfo['project']
}
