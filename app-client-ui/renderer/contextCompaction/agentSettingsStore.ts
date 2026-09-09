import {
  AgentSettings,
  type AgentSettingsAgentId,
  type AgentSettingsSaveResult,
  type AgentSettingsValue,
} from '../../shared/agentSettings'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'

export interface AgentSettingsStorePorts {
  read(): Promise<IpcResult<AgentSettingsValue>>
  subscribe(onChanged: () => void): () => void
  setAutoCompact(
    agentId: AgentSettingsAgentId,
    enabled: boolean,
  ): Promise<IpcResult<AgentSettingsSaveResult>>
  reportError(message: string): void
}

export interface AgentSettingsStoreState {
  value: AgentSettingsValue | null
  error: string | null
}

export type AgentSettingsMutationResult =
  | { ok: true }
  | { ok: false; detail: string }

export class AgentSettingsStore {
  private state: AgentSettingsStoreState = { value: null, error: null }
  private readonly subscribers = new Set<() => void>()
  private reader: IpcSnapshotReader<AgentSettingsValue> | null = null

  constructor(private readonly ports: AgentSettingsStorePorts) {}

  start(): () => void {
    if (this.reader !== null)
      throw new Error('The agent settings store is already started')
    const reader = new IpcSnapshotReader<AgentSettingsValue>(
      {
        subject: 'The agent settings',
        read: () => this.ports.read(),
        subscribe: (onChanged) => this.ports.subscribe(onChanged),
        reportError: (message) => this.ports.reportError(message),
      },
      (value) => this.arrived(value),
      (error) => this.errorChanged(error),
    )
    this.reader = reader
    const stop = reader.start()
    return () => {
      if (this.reader !== reader) return
      stop()
      this.reader = null
    }
  }

  current(): AgentSettingsStoreState {
    return this.state
  }

  subscribe(onChanged: () => void): () => void {
    this.subscribers.add(onChanged)
    return () => {
      this.subscribers.delete(onChanged)
    }
  }

  async setAutoCompact(
    agentId: AgentSettingsAgentId,
    enabled: boolean,
  ): Promise<AgentSettingsMutationResult> {
    try {
      const answer = await this.ports.setAutoCompact(agentId, enabled)
      if (!answer.ok) return { ok: false, detail: answer.error }
      if (!answer.value.ok) return { ok: false, detail: answer.value.detail }
      if (this.state.value !== null)
        this.arrived(AgentSettings.withAutoCompactEnabled(this.state.value, agentId, enabled))
      this.reader?.refresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: ErrorText.of(error) }
    }
  }

  private arrived(value: AgentSettingsValue): void {
    this.state = { value, error: this.state.error }
    this.publish()
  }

  private errorChanged(error: string | null): void {
    if (this.state.error === error) return
    this.state = { value: this.state.value, error }
    this.publish()
  }

  private publish(): void {
    for (const subscriber of this.subscribers)
      subscriber()
  }
}
