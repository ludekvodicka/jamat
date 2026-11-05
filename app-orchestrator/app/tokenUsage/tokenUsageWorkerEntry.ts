import { parentPort } from 'node:worker_threads'
import { ClaudeUsageParser } from '../../../lib-orchestrator/tokenUsage/claudeUsageParser'
import { CodexUsageParser } from '../../../lib-orchestrator/tokenUsage/codexUsageParser'
import { TokenUsageScanner } from '../../../lib-orchestrator/tokenUsage/tokenUsageScanner'
import type { TokenAccountResolver } from '../../../lib-orchestrator/tokenUsage/tokenUsageSource'
import { TokenUsageProjectsView } from '../../../lib-orchestrator/projectManager/tokenUsageProjectsView'
import { ClaudeUsageDirectories } from '../../../lib-orchestrator/projectManager/claudeUsageDirectories'
import type { TokenUsageWorkerRequest, TokenUsageWorkerResponse } from './tokenUsageWorker.types'

/** What one request knows about sessions, accounts and projects; the scanner outlives it. */
interface Attribution {
  projects: TokenUsageProjectsView
  directories: ClaudeUsageDirectories
  accounts: { claude: TokenAccountResolver; codex: TokenAccountResolver }
}

const port = parentPort
if (!port) throw new Error('The token usage worker has no parent port')
const post = (response: TokenUsageWorkerResponse): void => port.postMessage(response)
let attribution: Attribution | null = null
let scanner: TokenUsageScanner | null = null
let scannerKey = ''
let lastProgressAt = 0

function scannerFor(request: TokenUsageWorkerRequest): TokenUsageScanner {
  const current = () => {
    if (attribution === null) throw new Error('The token usage worker scanned without a request')
    return attribution
  }
  const claude = ClaudeUsageParser.source(request.claudeHome), initial = claude.initial
  claude.initial = file => ({ ...initial(file), cwd: current().directories.fallbackCwd(file) })
  return new TokenUsageScanner({ sources: [claude, CodexUsageParser.source(request.codexHome)], cacheFile: request.cacheFile,
    resolveAccount: (agentId, ...args) => current().accounts[agentId](...args), resolveProject: (...args) => current().projects.project(...args),
    progress: progress => {
      if (!progress.running || Date.now() - lastProgressAt >= 200) {
        lastProgressAt = Date.now()
        post({ kind: 'progress', progress })
      }
    } })
}

port.on('message', (request: TokenUsageWorkerRequest) => {
  if (request.kind !== 'scan') throw new Error(`Unknown token worker request: ${JSON.stringify(request)}`)
  void (async () => {
    const projects = new TokenUsageProjectsView(request.configDir, request.records)
    const directories = new ClaudeUsageDirectories(request.claudeHome)
    await directories.prepare(request.records.filter(record => record.agentId === 'claude').map(record => record.cwd))
    attribution = { projects, directories,
      accounts: { claude: ClaudeUsageParser.accountResolver(request.records), codex: CodexUsageParser.accountResolver(request.accounts) } }
    const key = JSON.stringify([request.cacheFile, request.claudeHome, request.codexHome])
    if (scanner === null || key !== scannerKey) {
      scanner = scannerFor(request)
      scannerKey = key
    }
    const buckets = await scanner.scan(request.rescan)
    post({ kind: 'result', buckets, accountLabels: CodexUsageParser.accountLabels,
      labels: Object.fromEntries([...new Set(buckets.map(bucket => bucket.projectKey))].map(key => [key, projects.label(key)])) })
  })().catch(error => post({ kind: 'error', detail: String(error) }))
})
post({ kind: 'ready' })
