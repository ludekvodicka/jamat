import type { IpcResult } from '../../shared/appClientUiIpc'
import type { ProjectTodoOperation, ProjectTodosApplyResult, ProjectTodosListResult, ProjectTodosSnapshot } from '../../shared/projectTodos'
import { AppControl, type AppControlRefusal } from '../ipc/appControl'

type ProjectTodosAnswer<TCode extends string> = IpcResult<{ ok: true; value: ProjectTodosSnapshot } | AppControlRefusal<TCode>>

export type ProjectTodosApplyRefusal = Extract<ProjectTodosApplyResult, { ok: false }>['code']

export interface ProjectTodosPorts {
  list(sessionId: string): Promise<ProjectTodosAnswer<Extract<ProjectTodosListResult, { ok: false }>['code']>>
  apply(sessionId: string, operation: ProjectTodoOperation): Promise<ProjectTodosAnswer<ProjectTodosApplyRefusal>>
  subscribe(changed: (project: string) => void): () => void
}

export const localProjectTodosPorts: ProjectTodosPorts = {
  list: (sessionId) => AppControl.library('projectTodos.list', { session: AppControl.sessionOf(sessionId) }),
  apply: (sessionId, operation) => AppControl.library('projectTodos.apply', { session: AppControl.sessionOf(sessionId), operation }),
  subscribe: (changed) => window.appClient.onProjectTodosChanged(changed),
}
