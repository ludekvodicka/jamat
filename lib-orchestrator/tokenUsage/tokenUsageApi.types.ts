export type TokenAgentId = 'claude' | 'codex' | 'antigravity'
export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface TokenBucketKey { day: string; hour: number; projectKey: string; agentId: TokenAgentId; accountId: string; model: string }
export interface TokenBucket extends TokenBucketKey, TokenCounts {}
export interface TokenSessionBucket extends TokenCounts { day: string; agentId: TokenAgentId; nativeId: string; projectKey: string }
/** `jamat`: the transcripts of sessions; `thirdParty`: the runs that account broker callers reported. */
export type TokenOrigin = 'jamat' | 'thirdParty'
/** Without `origin` both are counted. */
export interface TokenUsageQuery { from: string; to: string; groupBy: 'day' | 'project' | 'hour' | 'account' | 'session'; agentId?: TokenAgentId; origin?: TokenOrigin }
export interface TokenUsageRow extends TokenCounts { key: string; label: string; agentId: TokenAgentId }
export interface TokenScanProgress { running: boolean; completed: number; total: number; error: string | null; scannedAt: number | null }
export interface TokenUsageResult { rows: readonly TokenUsageRow[]; progress: TokenScanProgress }
