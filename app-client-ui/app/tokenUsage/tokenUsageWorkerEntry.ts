import { parentPort } from 'node:worker_threads'
import { ClaudeUsageParser } from '../../../lib-orchestrator/tokenUsage/claudeUsageParser'
import { CodexUsageParser } from '../../../lib-orchestrator/tokenUsage/codexUsageParser'
import { TokenUsageScanner } from '../../../lib-orchestrator/tokenUsage/tokenUsageScanner'
import { TokenUsageProjectsView } from '../../../lib-orchestrator/projectManager/tokenUsageProjectsView'
import { ClaudeUsageDirectories } from '../../../lib-orchestrator/projectManager/claudeUsageDirectories'
import type { TokenUsageWorkerRequest, TokenUsageWorkerResponse } from './tokenUsageWorker.types'

const port = parentPort
if (!port) throw new Error('The token usage worker has no parent port')
port.on('message', (request: TokenUsageWorkerRequest) => {
  if (request.kind !== 'scan') throw new Error(`Unknown token worker request: ${JSON.stringify(request)}`)
  const post = (response: TokenUsageWorkerResponse): void => port.postMessage(response)
  void (async () => {
    const projects = new TokenUsageProjectsView(request.configDir, request.records)
    const directories = new ClaudeUsageDirectories(request.claudeHome)
    await directories.prepare(request.records.filter(record => record.agentId === 'claude').map(record => record.cwd))
    const accountResolvers = { claude: ClaudeUsageParser.accountResolver(request.records), codex: CodexUsageParser.accountResolver(request.accounts) }
    const claude = ClaudeUsageParser.source(request.claudeHome), initial = claude.initial
    claude.initial = file => ({ ...initial(file), cwd: directories.fallbackCwd(file) })
    let lastProgressAt = 0
    const scanner = new TokenUsageScanner({ sources: [claude, CodexUsageParser.source(request.codexHome)], cacheFile: request.cacheFile,
      resolveAccount: (agentId, ...args) => accountResolvers[agentId](...args), resolveProject: (...args) => projects.project(...args),
      progress: progress => {
        if (!progress.running || Date.now() - lastProgressAt >= 200) {
          lastProgressAt = Date.now()
          post({ kind: 'progress', progress })
        }
      } })
    const buckets = await scanner.scan(request.rescan)
    post({ kind: 'result', buckets, accountLabels: CodexUsageParser.accountLabels,
      labels: Object.fromEntries([...new Set(buckets.map(bucket => bucket.projectKey))].map(key => [key, projects.label(key)])) })
  })().catch(error => post({ kind: 'error', detail: String(error) }))
})
