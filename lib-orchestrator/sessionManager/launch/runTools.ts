import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { SessionRecordProcess } from '../records/sessionRecord.types'
import { WindowsCommand } from './windowsCommand'

export interface RunToolsDeps {
  /** Electron's `process.resourcesPath` in a packaged client, null in every other composer. */
  resourcesRoot: string | null
  /** The repository root, where `app-client-cli/start.ts` stands in development. */
  applicationRoot: string
  environment: NodeJS.ProcessEnv
  /** Injected by tests, for the reason `LaunchPlanOptions.platform` is. */
  platform?: NodeJS.Platform
}

/** A tool as this machine starts it: the executable, what goes before the run's own arguments, and what it adds to the environment. */
export type RunToolResolution =
  | { ok: true; command: string; prefixArgs: string[]; env: Record<string, string> }
  | { ok: false; detail: string }

/**
 * The executables a direct-process run starts, resolved on this machine at every launch rather than
 * written into the record: a run replayed after the client was updated finds the current bundle.
 * A tool that is not there is answered as a reason, never as a shell that might find something else.
 */
export class RunTools {
  private readonly resourcesRoot: string | null
  private readonly applicationRoot: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform

  constructor(deps: RunToolsDeps) {
    this.resourcesRoot = deps.resourcesRoot
    this.applicationRoot = deps.applicationRoot
    this.environment = deps.environment
    this.platform = deps.platform ?? process.platform
  }

  resolve(tool: SessionRecordProcess['tool']): RunToolResolution {
    if (tool === 'svn') return this.svn()
    else if (tool === 'jamat-cli') return this.jamatCli()
    else throw new Error(`Unknown run tool: ${JSON.stringify(tool satisfies never)}`)
  }

  private svn(): RunToolResolution {
    if (this.platform !== 'win32') {
      for (const directory of (this.environment.PATH ?? '').split(delimiter)) {
        if (!directory) continue
        const command = resolve(directory, 'svn')
        try { accessSync(command, constants.X_OK); return { ok: true, command, prefixArgs: [], env: { LC_ALL: 'C', LANG: 'C' } } }
        catch { continue }
      }
      return { ok: false, detail: 'svn was not found on PATH; install the Subversion command-line client' }
    }
    const image = WindowsCommand.imageOf('svn', this.environment)
    return image === null
      ? { ok: false, detail: 'svn.exe was not found on PATH; install the Subversion command-line client' }
      : { ok: true, command: image, prefixArgs: [], env: { LC_ALL: 'C', LANG: 'C' } }
  }

  /**
   * The Node runtime a Jamat helper script runs under: the packaged one beside the client, or in
   * development the one the client itself would run a script with.
   */
  node(): { ok: true; command: string } | { ok: false; detail: string } {
    if (this.resourcesRoot === null) return this.developmentNode()
    const node = join(this.resourcesRoot, 'launcher', this.platform === 'win32' ? 'node.exe' : 'bin/node')
    return existsSync(node) ? { ok: true, command: node } : { ok: false, detail: `The packaged Node runtime is missing: ${node}` }
  }

  /**
   * The line an agent writes to run THIS client's Jamat CLI: the `appjamat-v3` wrapper this client
   * ships (`skills/claude/...` in the repository and beside the packaged `resources/cli` bundle),
   * which finds its CLI relative to itself. The person's `~/.claude/skills` link can belong to another
   * installation, and a merger that used it reached the wrong instance (UA1-J14-9). Calls still
   * select the instance with `--self`. `node` and the quoted forward-slash path are the shape the
   * merger's permission rules were probed with (Claude Code 2.1.296).
   */
  agentCli(): { ok: true; command: string } | { ok: false; detail: string } {
    const wrapper = join(this.applicationRoot, 'skills', 'claude', 'appjamat-v3', 'scripts', 'jamat-v3.mjs')
    if (!existsSync(wrapper)) return { ok: false, detail: `The Jamat CLI wrapper is missing: ${wrapper}` }
    return { ok: true, command: `node "${wrapper.replaceAll('\\', '/')}"` }
  }

  private jamatCli(): RunToolResolution {
    const node = this.node()
    if (!node.ok) return node
    if (this.resourcesRoot !== null) {
      const bundle = join(this.resourcesRoot, 'cli', 'jamat-v3.cjs')
      if (!existsSync(bundle)) return { ok: false, detail: `The packaged Jamat CLI is missing: ${bundle}` }
      return { ok: true, command: node.command, prefixArgs: [bundle], env: {} }
    }
    const root = join(this.applicationRoot, 'app-client-cli')
    const entry = join(root, 'start.ts')
    if (!existsSync(entry)) return { ok: false, detail: `The development Jamat CLI is missing: ${entry}` }
    let tsx: string
    try {
      tsx = createRequire(join(root, 'package.json')).resolve('tsx')
    } catch {
      return { ok: false, detail: `tsx is not installed for the development Jamat CLI in ${root}` }
    }
    // tsx otherwise reads the tsconfig.json of the run's working directory, a foreign project whose
    // `paths` can send an import of the CLI to that project's files.
    return {
      ok: true,
      command: node.command,
      prefixArgs: ['--import', pathToFileURL(tsx).href, entry],
      env: { TSX_TSCONFIG_PATH: join(root, 'tsconfig.json') },
    }
  }

  /** As `CodexSessionFiles.runtimeOf`: Electron's Windows GUI executable cannot hold a console inside ConPTY. */
  private developmentNode(): { ok: true; command: string } | { ok: false; detail: string } {
    if (!process.versions.electron) return { ok: true, command: process.execPath }
    if (this.platform === 'win32') {
      const image = WindowsCommand.imageOf('node', this.environment)
      return image === null
        ? { ok: false, detail: 'The development Jamat CLI needs node.exe on PATH' }
        : { ok: true, command: image }
    }
    else if (this.platform === 'darwin' || this.platform === 'linux') return { ok: true, command: 'node' }
    else throw new Error(`Unsupported Jamat CLI platform: ${this.platform}`)
  }
}
