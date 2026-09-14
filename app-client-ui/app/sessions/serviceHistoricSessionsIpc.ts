import type { HistoricSessions } from './history/historicSessions'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export class ServiceHistoricSessionsIpc extends ServiceIpcBase<typeof ServiceHistoricSessionsIpc.channelsConst> {
  static readonly channelsConst = { 'historic-sessions:project': true, 'historic-sessions:appjamat': true } as const
  private readonly history: HistoricSessions

  constructor(history: HistoricSessions) {
    super()
    this.history = history
  }

  initialize(): void {
    this.register('historic-sessions:appjamat', (_event, lastUsedSince) => this.history.appJamat(lastUsedSince))
    this.register('historic-sessions:project', (_event, categoryId, projectName, lastUsedSince) =>
      this.history.project(categoryId, projectName, lastUsedSince))
    this.assertComplete(ServiceHistoricSessionsIpc.channelsConst)
  }
}
