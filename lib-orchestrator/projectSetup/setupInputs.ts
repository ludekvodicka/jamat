import { createHash } from 'node:crypto'

/** Dependency declarations whose changes make an earlier install insufficient evidence. */
export class SetupInputs {
  private static readonly names = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'yarn.lock', '.npmrc', '.yarnrc.yml', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt',
    'uv.lock', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', '.worktree.json',
    '.pnpmfile.cjs', 'bun.lock', 'bun.lockb', '.nvmrc', '.node-version', '.python-version'])

  /** `hashes`: each input's content hash, so a later read can name only the inputs that changed. */
  static of(nodes: readonly { path: string; content: string }[]): { digest: string; paths: string[]; hashes: Record<string, string> } {
    const inputs = nodes.filter((node) => node.content !== '' && (SetupInputs.names.has(node.path.split('/').at(-1)!)
      || /^requirements-.+\.txt$/.test(node.path.split('/').at(-1)!)))
      .map(({ path, content }) => [path, content]).sort(([a], [b]) => a.localeCompare(b))
    return { digest: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), paths: inputs.map(([path]) => path),
      hashes: Object.fromEntries(inputs) }
  }

  /**
   * The inputs that differ from an earlier read, a removed one too; every input when the earlier read
   * kept no hashes (a record from before they were kept), so nothing changed goes unnamed.
   */
  static changed(current: { paths: readonly string[]; hashes: Readonly<Record<string, string>> }, previous: Readonly<Record<string, string>> | undefined): string[] {
    if (previous === undefined) return [...current.paths]
    return [...new Set([...current.paths, ...Object.keys(previous)])].filter((path) => current.hashes[path] !== previous[path]).sort((a, b) => a.localeCompare(b))
  }

  static commands(steps: readonly { scriptId?: string; name: string; commands: readonly { command: string; cwd: string }[] }[]): string | undefined {
    const setup = steps.filter((step) => step.scriptId !== 'svn' && step.scriptId !== 'checks')
      .map(({ name, commands }) => ({ name, commands }))
    return setup.length === 0 ? undefined : createHash('sha256').update(JSON.stringify(setup)).digest('hex')
  }
}
