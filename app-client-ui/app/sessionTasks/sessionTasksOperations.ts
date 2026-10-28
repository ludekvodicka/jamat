import type { SessionScriptOutput } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { z } from 'zod'

import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionTasks } from '../../../lib-orchestrator/sessionTasks/sessionTasks'
import type {
  SessionShellOutput,
  SessionSubagentTranscript,
  SessionTaskListing,
  SessionTaskParentState,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { AppOperationMap } from '../../shared/appOperationMap'
import { TabControlTask, type TabControlTaskRef, type TabControlTaskItem } from '../../shared/tabControl'
import { AgentSessionContext } from '../shared/agentSessionContext'
import type { TabControlBroker } from '../tabs/tabControlBroker'

/**
 * The sub-agents and background shells of local agent sessions, the output of local script runs, and
 * the workflow item of a local session's tab.
 *
 * Local operations and authenticated source task views share these readers. Sub-agent and shell
 * reads pass the transcript gate, so a session with
 * no native id is answered without the disk being asked; script output needs only its parent and run.
 */
export class SessionTasksOperations {
  private static readonly sessionIdsMaxConst = 64
  private static readonly titleMaxConst = 400

  private readonly tasks: SessionTasks
  private readonly sessions: SessionManager
  private readonly tabs: Pick<TabControlBroker, 'openTask' | 'openWorkflow'>

  constructor(tasks: SessionTasks, sessions: SessionManager, tabs: Pick<TabControlBroker, 'openTask' | 'openWorkflow'>) {
    this.tasks = tasks
    this.sessions = sessions
    this.tabs = tabs
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('sessions.scriptOutput', {
      kind: 'read',
      description: 'The live output or saved log of one script run of a local session.',
      input: z.strictObject({ sessionId: RemoteControlZod.text(), runId: RemoteControlZod.text() }),
      run: (body) => this.scriptOutputOf(body.sessionId, body.runId),
    })
    op('sessionTasks.list', {
      kind: 'read',
      description: "The sub-agents and background shells of local agent sessions, read from their CLIs' own files.",
      input: z.strictObject({
        sessionIds: z.array(RemoteControlZod.text()).max(SessionTasksOperations.sessionIdsMaxConst),
      }),
      run: async (body) => ({
        ok: true,
        value: Object.fromEntries(await Promise.all(body.sessionIds.map(async (sessionId) =>
          [sessionId, await this.listingOf(sessionId)] as const))),
      }),
    })
    op('sessionTasks.transcript', {
      kind: 'read',
      description: 'The prompt, messages, tool calls and edits of one sub-agent of a local agent session.',
      input: z.strictObject({
        sessionId: RemoteControlZod.text(),
        subagentId: RemoteControlZod.text(),
        known: RemoteControlZod.text().optional(),
      }),
      run: async (body) => ({ ok: true, value: await this.transcriptOf(body.sessionId, body.subagentId, body.known ?? null) }),
    })
    op('sessionTasks.shellOutput', {
      kind: 'read',
      description: 'The end of the output of one background shell of a local agent session, as plain text.',
      input: z.strictObject({
        sessionId: RemoteControlZod.text(),
        shellId: RemoteControlZod.text(),
        known: RemoteControlZod.text().optional(),
      }),
      run: async (body) => ({ ok: true, value: await this.shellOutputOf(body.sessionId, body.shellId, body.known ?? null) }),
    })
    op('sessionTasks.open', {
      kind: 'write',
      description: "Show one sub-agent, background shell or script run of a local session in its parent's split, bringing the parent's tab forward.",
      input: z.strictObject({
        sessionId: RemoteControlZod.text(),
        task: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('subagent'), subagentId: RemoteControlZod.text() }),
          z.strictObject({ kind: z.literal('shell'), shellId: RemoteControlZod.text() }),
          z.strictObject({ kind: z.literal('script'), runId: RemoteControlZod.text() }),
        ]),
        title: RemoteControlZod.text(SessionTasksOperations.titleMaxConst),
      }),
      run: async (body, context) => {
        const info = this.sessions.snapshot().sessions.find((one) => one.sessionId === body.sessionId)
        if (info === undefined)
          return { ok: false, error: { code: 'not-found', detail: `Session ${body.sessionId} does not exist` } }
        const task = body.task
        if (task.kind === 'script' && !info.scripts?.runs.some((run) => run.runId === task.runId))
          return { ok: false, error: { code: 'not-found', detail: `Session ${body.sessionId} has no script run ${task.runId}` } }
        const opened = await this.tabs.openTask(info.tabTitle, {
          key: TabControlTask.keyOf(body.sessionId, body.task),
          title: body.title,
          sessionId: body.sessionId,
          task: body.task,
        }, JSON.stringify([context.callerId, context.operationId]))
        return opened.ok ? { ok: true, value: { panelId: opened.value.panelId } } : opened
      },
    })
    op('sessionTasks.openWorkflow', {
      kind: 'write',
      description: "Bring a local session's tab forward with Session actions active in its split.",
      input: z.strictObject({ sessionId: RemoteControlZod.text() }),
      run: async (body, context) => {
        const info = this.sessions.snapshot().sessions.find((one) => one.sessionId === body.sessionId)
        if (info === undefined)
          return { ok: false, error: { code: 'not-found', detail: `Session ${body.sessionId} does not exist` } }
        const opened = await this.tabs.openWorkflow(body.sessionId, info.tabTitle, JSON.stringify([context.callerId, context.operationId]))
        return opened.ok ? { ok: true, value: { panelId: opened.value.panelId } } : opened
      },
    })
  }

  async itemOf(sessionId: string, task: TabControlTaskRef): Promise<TabControlTaskItem> {
    let title: string
    if (task.kind === 'subagent') {
      const read = await this.transcriptOf(sessionId, task.subagentId, null)
      if (read.kind !== 'transcript') throw new Error(read.kind === 'none' ? read.reason : 'Source transcript is unavailable')
      title = `${read.header.agentType}: ${read.header.description}`
    } else if (task.kind === 'shell') {
      const read = await this.shellOutputOf(sessionId, task.shellId, null)
      if (read.kind !== 'output') throw new Error(read.kind === 'none' ? read.reason : 'Source shell output is unavailable')
      title = `$ ${read.command}`
    } else if (task.kind === 'script') {
      const read = await this.scriptOutputOf(sessionId, task.runId)
      if (!read.ok) throw new Error(read.error.detail)
      const run = this.scriptsOf(sessionId)?.runs.find((run) => run.runId === task.runId)
      if (!run) throw new Error('Source script run is no longer retained')
      title = run.title
    } else throw new Error(`Unknown source task: ${JSON.stringify(task satisfies never)}`)
    return { key: TabControlTask.keyOf(sessionId, task), sessionId, task, title: title.slice(0, 400) }
  }

  scriptsOf(sessionId: string) { return this.sessions.snapshot().sessions.find((session) => session.sessionId === sessionId)?.scripts ?? null }

  async scriptOutputOf(sessionId: string, runId: string) { return RemoteControlOutcome.of<SessionScriptOutput>(await this.sessions.scriptOutputOf(sessionId, runId)) }

  async listingOf(sessionId: string): Promise<SessionTaskListing> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', code: context.code, reason: context.reason }
    return this.tasks.list({
      agentId: context.value.agentId,
      cwd: context.value.cwd,
      nativeSessionId: context.value.nativeSessionId,
      startedAt: context.value.startedAt,
    }, this.parentOf(sessionId))
  }

  async transcriptOf(
    sessionId: string,
    subagentId: string,
    known: string | null,
  ): Promise<SessionSubagentTranscript> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', code: context.code, reason: context.reason }
    return this.tasks.transcript({
      agentId: context.value.agentId,
      cwd: context.value.cwd,
      nativeSessionId: context.value.nativeSessionId,
      startedAt: context.value.startedAt,
    }, subagentId, this.parentOf(sessionId), known)
  }

  async shellOutputOf(
    sessionId: string,
    shellId: string,
    known: string | null,
  ): Promise<SessionShellOutput> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', code: context.code, reason: context.reason }
    return this.tasks.shellOutput({
      agentId: context.value.agentId,
      cwd: context.value.cwd,
      nativeSessionId: context.value.nativeSessionId,
      startedAt: context.value.startedAt,
    }, shellId, this.parentOf(sessionId), known)
  }

  private parentOf(sessionId: string): SessionTaskParentState {
    const info = this.sessions.snapshot().sessions.find((one) => one.sessionId === sessionId)
    return {
      live: info?.life === 'live',
      busy: info?.activity === 'working',
      now: Date.now(),
    }
  }
}
