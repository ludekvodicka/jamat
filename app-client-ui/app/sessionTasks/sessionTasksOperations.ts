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
import { TabControlTask } from '../../shared/tabControl'
import { AgentSessionContext } from '../shared/agentSessionContext'
import type { TabControlBroker } from '../tabs/tabControlBroker'

/**
 * The sub-agents and background shells of local agent sessions, the output of local script runs, and
 * the workflow item of a local session's tab.
 *
 * A client operation, so it is never on the peer list and never in `SessionInfo`: a paired computer
 * receives no process content. Sub-agent and shell reads pass the transcript gate, so a session with
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
      run: async (body) => RemoteControlOutcome.of(await this.sessions.scriptOutputOf(body.sessionId, body.runId)),
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
      run: async (body) => {
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
        })
        return opened.ok ? { ok: true, value: { panelId: opened.value.panelId } } : opened
      },
    })
    op('sessionTasks.openWorkflow', {
      kind: 'write',
      description: "Bring a local session's tab forward with its workflow split item active.",
      input: z.strictObject({ sessionId: RemoteControlZod.text() }),
      run: async (body) => {
        const info = this.sessions.snapshot().sessions.find((one) => one.sessionId === body.sessionId)
        if (info === undefined)
          return { ok: false, error: { code: 'not-found', detail: `Session ${body.sessionId} does not exist` } }
        const opened = await this.tabs.openWorkflow(body.sessionId, info.tabTitle)
        return opened.ok ? { ok: true, value: { panelId: opened.value.panelId } } : opened
      },
    })
  }

  private async listingOf(sessionId: string): Promise<SessionTaskListing> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', code: context.code, reason: context.reason }
    return this.tasks.list({
      agentId: context.value.agentId,
      cwd: context.value.cwd,
      nativeSessionId: context.value.nativeSessionId,
      startedAt: context.value.startedAt,
    }, this.parentOf(sessionId))
  }

  private async transcriptOf(
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

  private async shellOutputOf(
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
