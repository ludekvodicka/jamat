import type { UsageAccount } from '../../../lib-orchestrator/rateMonitor/usageApi.types'

export class UsageWindowModel {
  static readonly agentLabels = { claude: 'Claude', codex: 'Codex' }
  static measurement(account: UsageAccount): string {
    if (account.estimated) {
      const minutes = Math.floor(account.estimated.ageMilliseconds / 60_000)
      return `estimate from ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`} ago`
    }
    const state = account.state
    if (state.kind === 'ok') return 'measured'
    else if (state.kind === 'stale' || state.kind === 'unconfigured') return state.reason
    else if (state.kind === 'never-read') return 'No reading yet'
    else throw new Error(`Unknown rate state: ${JSON.stringify(state)}`)
  }

  static reset(at: string | number | null): string {
    return at === null ? 'Unknown' : new Date(at).toLocaleString()
  }
}
