import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RemoteControlRequestValidation } from '../../lib-orchestrator/remoteControl/remoteControlRequestValidation.js';
import type { RemoteControlAgentsDto, RemoteControlProjectsDto, RemoteControlRequestUnion } from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js';

export interface SessionLaunchOptions {
  projects: RemoteControlProjectsDto;
  agents: RemoteControlAgentsDto | null;
  createAvailable: boolean;
}

const input = z.strictObject({
  operationId: z.uuid(),
  categoryId: z.string().trim().min(1).max(256),
  projectPath: z.string().trim().min(1).max(4096),
  title: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f\u2028\u2029]+$/),
  agentId: z.enum(['codex', 'claude']),
  model: z.string().min(1).max(128).nullable(),
  worktree: z.boolean(),
});

export type SessionLaunchInput = z.infer<typeof input>;

export class SessionLaunch {
  static request(value: unknown): Extract<RemoteControlRequestUnion, { operation: 'sessions.create' }> {
    const parsed = input.safeParse(value);
    if (!parsed.success) throw new Error('Vyplňte projekt, název, agenta, model a volbu worktree.');
    const fields = parsed.data;
    const request = RemoteControlRequestValidation.parse({
      protocol: 'appjamat-v3-control.v1', requestId: randomUUID(), operationId: fields.operationId,
      operation: 'sessions.create', body: { spec: {
        kind: 'agent', directory: { mode: 'project', categoryId: fields.categoryId, projectPath: fields.projectPath },
        title: fields.title, agent: { agentId: fields.agentId, mode: 'new', ...(fields.model === null ? {} : { model: fields.model }) },
        ...(fields.worktree ? { worktree: { slug: fields.title } } : {}),
      } },
    });
    if (!request.ok) throw new Error(request.error.detail);
    if (request.request.operation !== 'sessions.create') throw new Error('Unexpected launch operation');
    return request.request;
  }
}
