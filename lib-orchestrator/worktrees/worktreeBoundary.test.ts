import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const moduleRoot = dirname(fileURLToPath(import.meta.url))
const library = dirname(moduleRoot)
const repository = dirname(library)

async function sources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const groups = await Promise.all(entries.filter((entry) => !entry.name.startsWith('.')
    && !['node_modules', 'out', 'dist', 'resources', 'coverage', 'fixtures'].includes(entry.name)).map(async (entry) => {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return sources(path)
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  }))
  return groups.flat()
}

it('keeps production consumers on worktree facades and session services on public adapters', async () => {
  const roots = ['lib-orchestrator', 'app-client-ui/app', 'app-client-ui/shared', 'app-client-ui/preload',
    'app-client-ui/renderer', 'app-client-cli/app', 'app-relay/app', 'app-relay/web', 'scripts']
  const files = (await Promise.all(roots.map((root) => sources(join(repository, root))))).flat()
  const failures: string[] = []
  let consumers = 0
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const inside = file.startsWith(moduleRoot + sep)
    function visit(node: ts.Node): void {
      const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
      if (spec !== undefined && ts.isStringLiteral(spec) && spec.text.startsWith('.')) {
        const target = resolve(dirname(file), spec.text)
        if (!inside && target.startsWith(moduleRoot + sep)) {
          consumers++
          if (relative(moduleRoot, target).includes(sep)) failures.push(`${relative(repository, file)} imports ${spec.text}`)
        }
        if (inside && target.startsWith(join(library, 'sessionManager') + sep)
          && relative(join(library, 'sessionManager'), target).includes(sep))
          failures.push(`${relative(repository, file)} reaches a private session service: ${spec.text}`)
        if (inside && !target.startsWith(library + sep))
          failures.push(`${relative(repository, file)} depends on a process package: ${spec.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(consumers).toBeGreaterThan(50)
  expect(failures).toEqual([])
}, 30_000)
