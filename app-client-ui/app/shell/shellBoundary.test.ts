import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('shell boundaries', () => {
  it('lists the remaining native value importers outside shell, transport and protocol', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const importers = files(root).filter(path => {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      return source.statements.some(statement => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
          || statement.moduleSpecifier.text !== 'electron') return false
        const clause = statement.importClause
        if (!clause) return true
        if (clause.isTypeOnly) return false
        if (clause.name) return true
        const bindings = clause.namedBindings
        return bindings !== undefined && (ts.isNamespaceImport(bindings) || bindings.elements.some(element => !element.isTypeOnly))
      })
    }).map(path => relative(root, path).replaceAll('\\', '/'))
      .filter(path => !path.startsWith('shell/') && path !== 'shared/ipcServiceTransport.ts' && path !== 'fileViewer/fileViewerProtocol.ts')
    expect(importers.sort()).toEqual([
      'app.ts', 'appContext.ts', 'appHub.ts', 'processes/windowPorts.ts', 'shared/clipboardAccess.ts', 'terminals/externalOpener.ts',
    ])
  })

  it('keeps shell and tab contracts type-only and independent of UI and Electron', () => {
    for (const name of ['shellPort.types.ts', 'tabRequestPort.types.ts']) {
      const path = fileURLToPath(new URL(`../../../lib-orchestrator/shared/${name}`, import.meta.url))
      const text = readFileSync(path, 'utf8')
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      for (const statement of source.statements)
        if (ts.isImportDeclaration(statement)) expect(statement.importClause?.isTypeOnly).toBe(true)
      expect(text).not.toMatch(/app-client-ui|from ['"]electron['"]|\bWebContents\b|\bBrowserWindow\b|\bBuffer\b/)
    }
  })
})
