import { z } from 'zod'

import type { AgentMemory } from '../../../lib-orchestrator/agentMemory/agentMemory'
import type { AgentMemoryLocation } from '../../../lib-orchestrator/agentMemory/agentMemoryApi.types'
import type { AgentMemoryTarget, AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'

/**
 * The Memory files dialog: an agent's memory files, listed, read, edited and deleted. A session of
 * this client names its memory through its record; Historic sessions names it by agent and project,
 * because its rows include conversations no record holds; Global memory names the agent alone.
 */
export class AgentMemoryOperations {
  /** The library limits bytes; this keeps an oversized body from being parsed at all. */
  private static readonly textCharactersMaxConst = 1_048_576

  static register(
    registry: Pick<RemoteControlRegistry, 'registrar'>,
    memory: AgentMemory,
    sessions: Pick<SessionManager, 'memoryOf'>,
  ): void {
    const op = registry.registrar<AppOperationMap>()
    const target = z.union([
      z.strictObject({ sessionId: RemoteControlZod.text() }),
      z.strictObject({
        scope: z.literal('project').optional(),
        agentId: z.enum(['claude', 'codex', 'antigravity']),
        projectPath: RemoteControlZod.text(4_096),
        nativeSessionId: RemoteControlZod.text().optional(),
      }),
      z.strictObject({ scope: z.literal('user'), agentId: z.enum(['claude', 'codex', 'antigravity']) }),
    ])
    const name = RemoteControlZod.text(1_024)
    const queryOf = (value: AgentMemoryTarget): AgentMemoryLocation | null =>
      'sessionId' in value ? sessions.memoryOf(value.sessionId) : value
    const unknown = (value: AgentMemoryTarget) => RemoteControlOutcome.of<never>({
      ok: false, code: 'not-found', detail: `Session ${'sessionId' in value ? value.sessionId : ''} is not an agent session of this computer`,
    })
    op('agentMemory.list', {
      kind: 'read',
      description: 'The memory files of an agent for a session, a project or its user, marking those the conversation wrote.',
      input: z.strictObject({ target }),
      run: async (body) => {
        const query = queryOf(body.target)
        return query === null ? unknown(body.target) : RemoteControlOutcome.of(await memory.list(query))
      },
    })
    op('agentMemory.read', {
      kind: 'read',
      description: 'The text of one memory file.',
      input: z.strictObject({ target, name }),
      run: async (body) => {
        const query = queryOf(body.target)
        return query === null ? unknown(body.target) : RemoteControlOutcome.of(await memory.read(query, body.name))
      },
    })
    op('agentMemory.write', {
      kind: 'write',
      description: 'Replace one memory file, refused when it changed since it was read.',
      input: z.strictObject({ target, name, text: z.string().max(AgentMemoryOperations.textCharactersMaxConst), expectedModifiedAt: z.number().nonnegative() }),
      run: async (body) => {
        const query = queryOf(body.target)
        return query === null ? unknown(body.target)
          : RemoteControlOutcome.of(await memory.write(query, body.name, body.text, body.expectedModifiedAt))
      },
    })
    op('agentMemory.delete', {
      kind: 'write',
      description: 'Delete one memory file, and the lines of Claude\'s MEMORY.md index that link to it.',
      input: z.strictObject({ target, name }),
      run: async (body) => {
        const query = queryOf(body.target)
        return query === null ? unknown(body.target) : RemoteControlOutcome.of(await memory.remove(query, body.name))
      },
    })
  }
}
