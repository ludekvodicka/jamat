import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('neutral client API', () => {
  it('has no application implementation dependency in any contract', () => {
    const root = fileURLToPath(new URL('./', import.meta.url))
    const files = readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const source = readFileSync(join(root, name), 'utf8')
      expect(source).not.toMatch(/(?:app-client-ui|app-orchestrator|app-gateway)\//)
      expect(source).not.toMatch(/from ['"]electron['"]|\bWebContents\b|\bBrowserWindow\b/)
    }
  })

  it('keeps every public DTO and codec runtime dependency browser-safe', () => {
    const root = fileURLToPath(new URL('./', import.meta.url))
    const pending = readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => join(root, name))
    const visited = new Set<string>()
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)
      const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue
        const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause
        if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.every(element => element.isTypeOnly)) continue
        const spec = statement.moduleSpecifier.text
        expect(spec).not.toMatch(/^(node:|electron$)|app-client-ui\/|app-orchestrator\/|app-gateway\//)
        if (spec.startsWith('.')) pending.push(resolve(dirname(file), `${spec}.ts`))
        else expect(spec).toBe('zod')
      }
    }
    expect(visited.size).toBeGreaterThan(0)
  })
})
