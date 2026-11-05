export interface PerfBuild { version: string; inputHash: string; builtAt: string }
export type PerfWorkerName = 'tokenUsage' | 'fileDiff' | 'svnAssembly'
export type PerfProcess = 'main' | 'gateway' | 'orchestrator' | 'renderer' | 'host' | 'machine' | `worker:${PerfWorkerName}`
export type PerfSpanName = 'sessions.recompose' | 'records.commit' | 'finish.commit' | 'finish.sync'
  | 'snapins.tick' | 'fileChanges.poll' | 'rate.pass' | 'gateway.frame'
export type PerfName = PerfSpanName | `ipc:${string}` | `op:${string}` | `svn:${string}` | `git:${string}` | 'other' | 'unattributed'
export interface PerfBase { v: 1; at: number; process: PerfProcess; pid: number; build: PerfBuild }
export type PerfRecord = PerfBase & (
  | { kind: 'sample'; elu: number | null; loopP50: number | null; loopP99: number | null; loopMax: number | null; heapMb: number | null }
  | { kind: 'stall'; ms: number; covered: PerfName[] }
  | { kind: 'span'; name: PerfName; ms: number; selfMs: number; depth: number; blocking: boolean }
  | { kind: 'unresponsive' | 'hang'; target: PerfProcess; ms: number }
  | { kind: 'inputToFrame'; p50: number; p99: number; count: number }
  | { kind: 'profile'; profileId: string; trigger: 'elu' | 'stall' }
  | { kind: 'machine'; cpu: number; jamatCpu: number | null }
  | { kind: 'external'; top: { image: string; cores: number; session: string | null; sessionKind: 'agent' | 'script' | 'shell' | null }[] }
  | { kind: 'runaway'; image: string; cores: number; minutes: number; session: string; sessionKind: 'agent' | 'script' | 'shell' }
  | { kind: 'suspend' | 'resume' | 'truncated' }
)
export type PerfEvent = PerfRecord extends infer R ? R extends PerfBase ? Omit<R, keyof PerfBase> : never : never
