import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ServiceChannels } from '../../lib-orchestrator/clientApi/serviceChannels'
import { SessionEvents } from './sessions/sessionEvents'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('orchestration composition boundary', () => {
  it('keeps every orchestration runtime import independent of the UI package', () => {
    const root = fileURLToPath(new URL('./', import.meta.url))
    const arrows: string[] = []
    for (const file of sourceFiles(root)) {
      const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const spec = statement.moduleSpecifier.text
        expect(spec).not.toBe('electron')
        if (spec.includes('app-client-ui/')) arrows.push(`${relative(root, file).replaceAll('\\', '/')} -> ${spec}`)
      }
    }
    expect(arrows.sort()).toEqual([])
  })

  it('leaves native owners and perf glue in UI without remaining domain owners', () => {
    const root = fileURLToPath(new URL('../../app-client-ui/app/', import.meta.url))
    const paths = sourceFiles(root).map(file => relative(root, file).replaceAll('\\', '/'))
    const domainDirectories = new Set(['accounts', 'agents', 'agentCliUpdates', 'attention', 'contextCompaction', 'directoryNotes',
      'rateMonitor', 'sessionGroups', 'sessionModel', 'sessions', 'sessionTasks', 'sessionTranscript', 'skills', 'snapins', 'uiSettings'])
    expect(paths.filter(path => domainDirectories.has(path.split('/')[0]!))).toEqual([])
    for (const path of ['clientState/clientStateStore.ts', 'shared/configSectionsCache.ts', 'shared/ipcServiceTransport.ts',
      'debug/serviceDebugIpc.ts', 'autolauncher/serviceAutolauncherIpc.ts', 'perf/machineLoadSampler.ts'])
      expect(paths).toContain(path)
    for (const path of ['perf/workerPerfSampler.ts', 'fileChanges/diff/fileDiffWorker.ts', 'fileChanges/diff/fileDiffWorkerEntry.ts',
      'tokenUsage/tokenUsageWorker.ts', 'tokenUsage/tokenUsageWorkerEntry.ts', 'worktrees/svnAssemblyWorker.ts', 'worktrees/svnAssemblyWorkerEntry.ts']) {
      expect(paths).not.toContain(path)
      expect(existsSync(new URL(path, import.meta.url))).toBe(true)
    }
    expect(existsSync(join(root, 'projects'))).toBe(false)
  })

  it('keeps MainHub library value imports limited to performance and private wire transport', () => {
    const source = readFileSync(new URL('../../app-client-ui/app/appHub.ts', import.meta.url), 'utf8')
    const tree = ts.createSourceFile('appHub.ts', source, ts.ScriptTarget.Latest, true)
    const values = tree.statements.filter(ts.isImportDeclaration).filter(statement => {
      const clause = statement.importClause
      return clause && !clause.isTypeOnly && (clause.name || (clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.some(element => !element.isTypeOnly)))
    }).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text).filter(value => value.includes('lib-orchestrator/'))
    expect(values.sort()).toEqual([
      '../../lib-orchestrator/perfMonitor/perfMonitor', '../../lib-orchestrator/perfMonitor/perfNames',
      '../../lib-orchestrator/perfMonitor/perfProfiler', '../../lib-orchestrator/shared/processCalls',
    ])
    expect(source).not.toContain('ConfigStore')
    expect(source).not.toContain('new SessionManager')
  })

  it('has one configuration owner and named E4 logic owners in the actual composition', () => {
    const source = readFileSync(new URL('./appHub.ts', import.meta.url), 'utf8')
    expect(source.match(/ConfigStore\.load\(/g)).toHaveLength(1)
    for (const name of ['ChangedPathHints', 'SessionSharedItems', 'RemoteSessionContent', 'PairingImport', 'SessionEvents', 'SessionNotices', 'SessionAttention'])
      expect(source).toContain(`new ${name}(`)
    expect(source).not.toMatch(/from ['"]electron['"]|from ['"].*workspaceWindows['"]|from ['"].*clientStateStore['"]/)
  })

  it('rejects duplicates both within and across owner tables', () => {
    const native = ServiceChannels.merge([{ 'native:one': true }] as const)
    const orchestration = ServiceChannels.merge([{ 'orchestration:one': true }] as const)
    expect(Object.keys(ServiceChannels.merge([native, orchestration] as const))).toEqual(['native:one', 'orchestration:one'])
    expect(() => ServiceChannels.merge([native, native])).toThrow('Two IPC services claim the same channel: native:one')
    expect(() => ServiceChannels.merge([orchestration, orchestration])).toThrow('Two IPC services claim the same channel: orchestration:one')
  })

  it('keeps the ordered session fan-out running after an optional observer fails', () => {
    const calls: string[] = []
    const events = new SessionEvents({
      refreshCommits: () => { calls.push('commits'); throw new Error('fixture') },
      wakeSnapins: () => { calls.push('snapins') }, noticeWaits: () => { calls.push('notices') },
      attentionSeen: () => { calls.push('attention') }, publishSessions: () => { calls.push('windows') },
      publishControl: () => { calls.push('control') }, publishInbound: () => { calls.push('inbound') },
      publishActivity: () => { calls.push('activity') }, titleOf: () => null,
      scriptRunCollapsed: () => {}, report: message => { calls.push(message) },
    })
    events.changed()
    expect(calls).toEqual(['commits', 'Commit review marks could not be refreshed: fixture', 'snapins', 'notices', 'attention', 'windows', 'control', 'inbound', 'activity'])
  })
})
