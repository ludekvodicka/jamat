import type { AccountView } from '../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { SessionUsageRecord } from '../../../lib-orchestrator/sessionManager/sessionUsageView'
import type { TokenBucket, TokenScanProgress, TokenSessionBucket } from '../../../lib-orchestrator/tokenUsage/tokenUsageApi.types'

export interface TokenUsageWorkerRequest {
  kind: 'scan'
  cacheFile: string
  configDir: string
  claudeHome: string
  codexHome: string
  antigravityHome: string
  records: readonly SessionUsageRecord[]
  accounts: readonly AccountView[]
  rescan: boolean
}
export type TokenUsageWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'progress'; progress: TokenScanProgress }
  | {
      kind: 'result'
      buckets: TokenBucket[]
      sessionBuckets: TokenSessionBucket[]
      labels: Record<string, string>
      accountLabels: Record<string, string>
      sessionLabels: Record<string, string>
    }
  | { kind: 'error'; detail: string }
