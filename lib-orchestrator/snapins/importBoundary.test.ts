import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const root = dirname(fileURLToPath(import.meta.url))
function forbidden(file: string, source: string): boolean {
  const imports: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      imports.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
  return imports.some((specifier) => {
    if (!specifier.startsWith('.')) return false
    const target = relative(root, resolve(dirname(file), specifier)).replace(/\\/g, '/')
    const owner = relative(root, file).replace(/\\/g, '/')
    const area = target.split('/')[0]
    return target.includes('/') && area !== '..' && area !== 'shared'
      && !owner.startsWith(`${area}/`) && owner !== 'builtInSnapinsView.ts'
  })
}

describe('snap-in import boundary', () => {
  it('refuses a generic file importing a concrete definition', () => {
    expect(forbidden(join(root, 'shared', 'test.ts'), "import { A } from '../reviewTodos/a'")).toBe(true)
    expect(forbidden(join(root, 'builtInSnapinsView.ts'), "import { A } from './reviewTodos/a'")).toBe(false)
  })
  it('keeps concrete definitions behind the built-in registry', async () => {
    const files = await readdir(root, { recursive: true })
    for (const name of files.filter((name) => name.endsWith('.ts'))) {
      const file = join(root, name)
      expect(forbidden(file, await readFile(file, 'utf8')), name).toBe(false)
    }
  })
})
