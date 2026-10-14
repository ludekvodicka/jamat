import { z } from 'zod'

import { SessionTitle } from '../sessionManager/records/sessionTitle'
import { SessionColors } from '../sessionManager/sessionColors'
import { SessionGroups } from '../sessionManager/sessionGroups'
import { SessionLimits } from '../sessionManager/sessionLimits'
import type { SessionColorName, SessionGroup, SessionParentKind } from '../sessionManager/sessionManagerApi.types'
import type { RemoteControlOperation, RemoteControlRequestBody } from './remoteControlApi.types'
import { RemoteControlDeliverConst } from './remoteControlProtocol'

/**
 * The pieces every body is built from. Each carries the sentence a caller reads, and the registry puts
 * the field's path in front of it, so `spec.agent.mode: agent mode is invalid` names where it went wrong.
 */
export class RemoteControlZod {
  static readonly idLengthConst = 256
  static readonly pathLengthConst = 32_768

  /** Non-empty text: an id, a path, a name. */
  static text(maximum: number = RemoteControlZod.idLengthConst): z.ZodString {
    return z.string({ error: 'must be a string' })
      .min(1, { error: 'must not be empty' })
      .max(maximum, { error: `exceeds ${maximum} characters` })
  }

  /** Text that may be empty: a prompt, a terminal line. */
  static string(maximum: number): z.ZodString {
    return z.string({ error: 'must be a string' }).max(maximum, { error: `exceeds ${maximum} characters` })
  }

  static integer(minimum: number, maximum: number): z.ZodNumber {
    const error = `must be an integer from ${minimum} to ${maximum}`
    return z.number({ error }).int({ error }).min(minimum, { error }).max(maximum, { error })
  }

  static boolean(): z.ZodBoolean {
    return z.boolean({ error: 'must be a boolean' })
  }

  /** A body with nothing in it, and nothing in it is the assertion: an unknown key is refused. */
  static empty(): z.ZodType<Record<string, never>> {
    return z.strictObject({}) as unknown as z.ZodType<Record<string, never>>
  }

  /**
   * A value whose owner validates it field by field, such as a config section: the body proves only
   * that it is an object, and the owner's refusal names the field it cannot store.
   */
  static ownedObject<T>(): z.ZodType<T> {
    return z.custom<T>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), {
      error: 'must be an object',
    })
  }

  /** The library's own list, so the validator, the CLI parser and the lifecycle refuse the same set. */
  static color(): z.ZodType<SessionColorName> {
    return z.custom<SessionColorName>(SessionColors.isName, {
      error: `must be one of ${SessionColors.namesConst.join(', ')}`,
    })
  }

  /** Only the shape: whether this computer has the group is the client's answer, naming those it has. */
  static group(): z.ZodType<SessionGroup> {
    return z.custom<SessionGroup>(SessionGroups.isId, { error: `is invalid: ${SessionGroups.idRuleConst}` })
  }

  static readonly sessionSelector = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('sessionId'), sessionId: RemoteControlZod.text() }),
    z.strictObject({
      kind: z.literal('number'),
      number: RemoteControlZod.text(SessionTitle.numberCharactersConst).refine(SessionTitle.isSelectorNumber, {
        error: 'must be a session number, a custom number such as "i34", or two such parts separated by a hyphen',
      }),
    }),
  ], { error: 'session selector kind must be sessionId or number' })

  static sessionBody(): z.ZodType<{ session: z.infer<typeof RemoteControlZod.sessionSelector> }> {
    return z.strictObject({ session: RemoteControlZod.sessionSelector })
  }

  /**
   * Every issue with its path, joined. A caller fixing a body reads each wrong field in one answer
   * rather than one per round trip.
   */
  static problemOf(error: z.ZodError, operation: string): string {
    return error.issues.map((issue) => {
      const path = issue.path.length === 0 ? `${operation} body` : issue.path.map(String).join('.')
      return `${path}: ${issue.message}`
    }).join('; ')
  }
}

/**
 * A DELIBERATE copy of `AgentSettings.modelShapeConst`: this library may never import app-client-ui,
 * and the value reaches a command line either way. It rules out anything that could be read as a flag
 * by the CLI it is handed to or acted on by the win32 `cmd /d /q /c` wrap - whether the model EXISTS
 * is the agent's own answer and is never checked here.
 */
const modelShapeConst = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$/
const promptLengthConst = 1_000_000
const terminalTextLengthConst = 1_000_000
const messageLengthConst = 65_536
/** A requested run's title is its row's name in the tree: one short line, as the library holds it. */
const scriptTitleLengthConst = 80

const projectDirectory = z.strictObject({
  mode: z.literal('project'),
  categoryId: RemoteControlZod.text(),
  projectPath: RemoteControlZod.text(RemoteControlZod.pathLengthConst),
})

const directory = z.discriminatedUnion('mode', [
  projectDirectory,
  z.strictObject({ mode: z.literal('adHoc'), path: RemoteControlZod.text(RemoteControlZod.pathLengthConst) }),
  z.strictObject({ mode: z.literal('default') }),
], { error: 'directory mode must be project, adHoc or default' })

const agent = z.strictObject({
  agentId: z.enum(['claude', 'codex'], { error: 'agentId must be claude or codex' }),
  mode: z.enum(['new', 'continue', 'resume', 'fork'], { error: 'agent mode is invalid' }),
  nativeSessionId: RemoteControlZod.text().optional(),
  forkParentId: RemoteControlZod.text().optional(),
  initialPrompt: RemoteControlZod.string(promptLengthConst).optional(),
  model: RemoteControlZod.text(128).regex(modelShapeConst, { error: 'model has an invalid shape' }).optional(),
})

const worktreeTag = z.string({ error: 'must be a string' })
  .regex(SessionLimits.worktreeTagShape, { error: 'must be 1 to 128 letters, digits, dots, underscores, colons or hyphens' })

const worktree = z.strictObject({
  slug: RemoteControlZod.text(256),
  baseRef: RemoteControlZod.text(1_024).optional(),
  owner: RemoteControlZod.text(RemoteControlZod.pathLengthConst).optional(),
  removeWhenEnded: z.literal(true, { error: 'removeWhenEnded must be true when given' }).optional(),
  tag: worktreeTag.optional(),
  notify: z.strictObject({
    sessionId: RemoteControlZod.text(),
    text: RemoteControlZod.text(SessionLimits.worktreeNotifyCharacters),
  }).optional(),
})

const sessionSpec = z.strictObject({
  kind: z.enum(['shell', 'agent'], { error: 'session kind must be shell or agent' }),
  directory,
  agent: agent.optional(),
  worktree: worktree.optional(),
  notify: z.strictObject({
    sessionId: RemoteControlZod.text(),
    text: RemoteControlZod.text(SessionLimits.worktreeNotifyCharacters)
      .regex(/^[^\x00-\x1f\x7f\u2028\u2029]+$/, { error: 'must be one line without control characters' }),
    onGroups: z.array(RemoteControlZod.group()).max(8, { error: 'onGroups names at most 8 groups' }),
  }).optional(),
  parent: z.strictObject({
    sessionId: RemoteControlZod.text(),
    kind: z.enum(['worktree', 'ticket', 'worker'] satisfies SessionParentKind[], { error: 'parent kind must be worktree, ticket or worker' }),
  }).optional(),
  title: RemoteControlZod.string(512).optional(),
  // The shape alone, here and in the library both: this one is a wire contract and the library's is
  // the write, and neither may be the only place a malformed number is stopped.
  number: RemoteControlZod.text(SessionTitle.numberCharactersConst).refine(SessionTitle.isCustomNumber, {
    error: 'number must be one to three letters then up to six digits, such as "i34"',
  }).optional(),
  color: RemoteControlZod.color().optional(),
  flowId: RemoteControlZod.text().optional(),
  acknowledgeSetup: RemoteControlZod.text().optional(),
}).superRefine((spec, context) => {
  if (spec.kind === 'agent' && spec.agent === undefined)
    context.addIssue({ code: 'custom', path: ['agent'], message: 'agent is required for an agent session' })
  if (spec.kind === 'shell' && spec.agent !== undefined)
    context.addIssue({ code: 'custom', path: ['agent'], message: 'agent is not allowed for a shell session' })
})

const commitSessionId = z.string({ error: 'commitSessionId must be a UUID' })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { error: 'commitSessionId must be a UUID' })

/**
 * `typed` stays one line: a raw `\r` or `\n` would submit the text early. A paste carries its line
 * breaks inside the bracketed-paste markers, so line breaks and tabs are the only control characters
 * it may carry. An ESC would let the text close the bracketed paste itself (`\x1b[201~\r`).
 */
const terminalDeliver = z.strictObject({
  session: RemoteControlZod.sessionSelector,
  text: RemoteControlZod.string(terminalTextLengthConst),
  input: z.enum(['paste', 'typed'], { error: 'input must be paste or typed' }).optional(),
  readyTimeoutMs: RemoteControlZod.integer(
    RemoteControlDeliverConst.readyTimeoutMinimumMillisecondsConst,
    RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst,
  ).optional(),
  submitTimeoutMs: RemoteControlZod.integer(
    RemoteControlDeliverConst.submitTimeoutMinimumMillisecondsConst,
    RemoteControlDeliverConst.submitTimeoutMaximumMillisecondsConst,
  ).optional(),
  queue: RemoteControlZod.boolean().optional(),
}).superRefine((body, context) => {
  const typed = body.input === 'typed'
  const problem = (message: string): void => context.addIssue({ code: 'custom', path: ['text'], message })
  if (body.text.length === 0) problem('text must not be empty')
  else if (typed && body.text.length > RemoteControlDeliverConst.textLengthConst)
    problem(`exceeds ${RemoteControlDeliverConst.textLengthConst} characters`)
  else if (typed && /[\r\n]/.test(body.text)) problem('typed text must be one line: deliver it as a paste instead')
  else if (typed && /[\x00-\x1f\x7f]/.test(body.text)) problem('typed text must not contain control characters')
  else if (!typed && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.text))
    problem('pasted text must not contain control characters other than line breaks and tabs')
})

const terminalPeek = z.strictObject({
  session: RemoteControlZod.sessionSelector,
  cols: RemoteControlZod.integer(2, 1_000).optional(),
  rows: RemoteControlZod.integer(1, 500).optional(),
  timeoutMs: RemoteControlZod.integer(50, 60_000).optional(),
}).refine((body) => (body.cols === undefined) === (body.rows === undefined), {
  error: 'cols and rows must be provided together',
})

const tabsOpenCommit = z.strictObject({
  session: RemoteControlZod.sessionSelector,
  vcs: z.enum(['svn', 'git'], { error: 'vcs must be svn or git' }),
  scope: RemoteControlZod.text(RemoteControlZod.pathLengthConst).optional(),
  paths: z.array(z.union([
    RemoteControlZod.text(RemoteControlZod.pathLengthConst),
    z.strictObject({
      path: RemoteControlZod.text(RemoteControlZod.pathLengthConst),
      depth: z.enum(['empty', 'infinity'], { error: 'depth must be empty or infinity' }),
    }),
  ], { error: 'must be a literal path or { path, depth }' }), {
    error: 'paths must contain between 1 and 2000 literal paths',
  }).min(1, { error: 'paths must contain between 1 and 2000 literal paths' })
    .max(2_000, { error: 'paths must contain between 1 and 2000 literal paths' }).optional(),
  message: RemoteControlZod.string(messageLengthConst).optional(),
})

const panelBody = z.strictObject({ panelId: RemoteControlZod.text() })

/**
 * The body of every protocol operation, as one table keyed by the operation, so an operation without
 * a body schema does not compile, and a schema whose output is not the request type does not either.
 */
export const RemoteControlBodySchemas: { [K in RemoteControlOperation]: z.ZodType<RemoteControlRequestBody<K>> } = {
  'system.hello': RemoteControlZod.empty(),
  'system.status': RemoteControlZod.empty(),
  'system.operations': RemoteControlZod.empty(),
  'system.calls': RemoteControlZod.empty(),
  'system.events': z.strictObject({
    after: RemoteControlZod.integer(0, Number.MAX_SAFE_INTEGER).optional(),
    waitMs: RemoteControlZod.integer(0, 30_000).optional(),
  }),
  'projects.list': z.strictObject({
    categoryId: RemoteControlZod.text().optional(),
    sort: z.enum(['alpha', 'recent'], { error: 'sort must be alpha or recent' }).optional(),
  }),
  'projects.config': RemoteControlZod.empty(),
  // The library validates every field of a root and refuses what it cannot store, naming it.
  'projects.saveConfig': z.strictObject({
    categories: z.array(z.looseObject({
      id: RemoteControlZod.text(),
      label: RemoteControlZod.string(RemoteControlZod.idLengthConst),
      path: RemoteControlZod.text(RemoteControlZod.pathLengthConst),
    })),
  }),
  'projects.categories': RemoteControlZod.empty(),
  'projects.listing': z.strictObject({
    categoryId: RemoteControlZod.text(),
    sort: z.enum(['alpha', 'recent'], { error: 'sort must be alpha or recent' }),
  }),
  'projects.sessions': z.strictObject({ categoryId: RemoteControlZod.text(), projectName: RemoteControlZod.text(1_024) }),
  'projects.create': z.strictObject({
    categoryId: RemoteControlZod.text(),
    name: RemoteControlZod.text(1_024),
    virtualFolderPrefix: RemoteControlZod.text(1_024).nullable(),
  }),
  'projects.rename': z.strictObject({
    categoryId: RemoteControlZod.text(),
    oldName: RemoteControlZod.text(1_024),
    newName: RemoteControlZod.text(1_024),
  }),
  'projects.movePrefix': z.strictObject({
    categoryId: RemoteControlZod.text(),
    name: RemoteControlZod.text(1_024),
    targetPrefix: RemoteControlZod.text(1_024).nullable(),
  }),
  'projects.archive': z.strictObject({ categoryId: RemoteControlZod.text(), name: RemoteControlZod.text(1_024) }),
  'projects.deletePreview': z.strictObject({ categoryId: RemoteControlZod.text(), name: RemoteControlZod.text(1_024) }),
  'projects.delete': z.strictObject({ token: RemoteControlZod.text() }),
  'sessions.list': RemoteControlZod.empty(),
  'sessions.create': z.strictObject({
    spec: sessionSpec,
    openTab: RemoteControlZod.boolean().optional(),
    group: RemoteControlZod.group().optional(),
  }),
  'sessions.reopen': RemoteControlZod.sessionBody(),
  'sessions.finalize': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    expect: z.literal('stop', { error: 'expect must be stop' }).optional(),
    acknowledgeSetup: RemoteControlZod.text().optional(),
  }),
  'sessions.remove': RemoteControlZod.sessionBody(),
  'sessions.worktree': RemoteControlZod.sessionBody(),
  'sessions.discardWorktree': RemoteControlZod.sessionBody(),
  'sessions.retrySetup': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    acknowledgeSetup: RemoteControlZod.text().optional(),
  }),
  'sessions.cleanupWorktree': RemoteControlZod.sessionBody(),
  'sessions.finishWorktree': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    choice: z.enum(['commit', 'discard', 'keep'], { error: 'choice must be commit, discard or keep' }),
    acknowledgeSetup: RemoteControlZod.text().optional(),
    confirmWorking: z.literal(true, { error: 'confirmWorking must be true' }).optional(),
    agent: z.literal(true, { error: 'agent must be true' }).optional(),
  }),
  'sessions.updateMain': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    confirmLive: z.array(RemoteControlZod.text(128)).max(200, { error: 'confirmLive names at most 200 sessions' }).optional(),
  }),
  'sessions.worktreeReview': RemoteControlZod.sessionBody(),
  'sessions.notifies': z.strictObject({ sessionId: RemoteControlZod.text().optional() }),
  'sessions.conflicts': RemoteControlZod.sessionBody(),
  'sessions.resolveConflict': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    path: RemoteControlZod.text(4096),
    option: z.enum(['merged', 'take-incoming', 'keep-mine', 'keep-both', 'union'],
      { error: 'option must be merged, take-incoming, keep-mine, keep-both or union' }),
    confirm: z.literal(true, { error: 'confirm must be true' }).optional(),
  }),
  'sessions.children': z.strictObject({ sessionId: RemoteControlZod.text() }),
  'sessions.worktreeResults': z.strictObject({
    tag: worktreeTag.optional(),
    sessionId: RemoteControlZod.text().optional(),
    unacknowledged: z.literal(true, { error: 'unacknowledged must be true when given' }).optional(),
  }),
  'sessions.acknowledgeWorktreeResult': z.strictObject({ actionId: RemoteControlZod.text(128) }),
  'sessions.proposeCommit': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    message: RemoteControlZod.string(messageLengthConst),
  }),
  'sessions.transcript': RemoteControlZod.sessionBody(),
  'sessions.scripts': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    runId: RemoteControlZod.text().optional(),
  }),
  'sessions.runScript': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    command: RemoteControlZod.text(SessionLimits.scriptCommandCharacters),
    cwd: RemoteControlZod.text(RemoteControlZod.pathLengthConst).optional(),
    title: RemoteControlZod.string(scriptTitleLengthConst).optional(),
  }),
  'sessions.color': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    color: RemoteControlZod.color().nullable(),
  }),
  'sessions.fork': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    name: RemoteControlZod.string(512).optional(),
  }),
  'sessions.restart': RemoteControlZod.sessionBody(),
  'sessions.setDetails': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    update: z.strictObject({
      name: RemoteControlZod.string(512).optional(),
      note: RemoteControlZod.string(SessionLimits.noteCharacters).nullable().optional(),
      color: RemoteControlZod.color().nullable().optional(),
    }),
  }),
  'sessions.adoptOrphan': z.strictObject({ runtimeSessionId: RemoteControlZod.text() }),
  'sessions.reference': RemoteControlZod.sessionBody(),
  'sessions.historyReferences': z.strictObject({ directory: projectDirectory }),
  'sessions.openHistory': z.strictObject({
    spec: z.strictObject({
      directory: projectDirectory,
      agentId: z.enum(['claude', 'codex'], { error: 'agentId must be claude or codex' }),
      nativeSessionId: RemoteControlZod.text(),
      providerName: RemoteControlZod.string(512),
      providerActive: RemoteControlZod.boolean(),
      action: z.enum(['rerun', 'fork'], { error: 'action must be rerun or fork' }).optional(),
    }),
  }),
  'sessions.nextNumber': z.strictObject({ projectPath: RemoteControlZod.text(RemoteControlZod.pathLengthConst) }),
  'sessions.allocateNumber': z.strictObject({ projectPath: RemoteControlZod.text(RemoteControlZod.pathLengthConst) }),
  'host.status': RemoteControlZod.empty(),
  'host.ping': RemoteControlZod.empty(),
  'host.start': RemoteControlZod.empty(),
  'host.restart': z.strictObject({ expectedHostInstanceId: RemoteControlZod.text() }),
  'host.stop': z.strictObject({ expectedHostInstanceId: RemoteControlZod.text() }),
  'sessions.group': z.strictObject({ session: RemoteControlZod.sessionSelector, group: RemoteControlZod.group() }),
  'sessions.note': RemoteControlZod.sessionBody(),
  // `null` clears the note and is not an absent key, which is a caller who forgot what to write.
  'sessions.setNote': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    note: RemoteControlZod.string(SessionLimits.noteCharacters).nullable(),
  }),
  'agents.describe': RemoteControlZod.empty(),
  'tabs.list': RemoteControlZod.empty(),
  'tabs.open': RemoteControlZod.sessionBody(),
  'tabs.openFile': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    path: RemoteControlZod.text(RemoteControlZod.pathLengthConst),
  }),
  'tabs.openCommit': tabsOpenCommit,
  'tabs.commitStatus': z.strictObject({ commitSessionId }),
  'tabs.cancelCommit': z.strictObject({ commitSessionId }),
  'tabs.focus': panelBody,
  'tabs.close': panelBody,
  'terminal.peek': terminalPeek,
  'terminal.send': z.strictObject({
    session: RemoteControlZod.sessionSelector,
    text: RemoteControlZod.string(terminalTextLengthConst),
    enter: RemoteControlZod.boolean().optional(),
    timeoutMs: RemoteControlZod.integer(50, 60_000).optional(),
  }),
  'terminal.deliver': terminalDeliver,
}
