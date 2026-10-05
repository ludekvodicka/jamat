import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RuntimeLaunchSpec } from '../../../app-host/app/wire/hostWire.js'
import type { CodexSessionIdentity, CodexSessionLaunch } from '../codexSessionIdentity'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { LaunchPlanOptions } from './launchPlanner'
import { WindowsCommand } from './windowsCommand'

export class CodexSessionFiles {
  private readonly directory: string
  private readonly applicationRoot: string
  private readonly resourcesRoot: string | null
  private readonly report: (message: string) => void
  private readonly reported = new Set<string>()

  constructor(options: {
    directory: string; applicationRoot: string; resourcesRoot: string | null
    report: (message: string) => void
  }) {
    this.directory = options.directory
    this.applicationRoot = options.applicationRoot
    this.resourcesRoot = options.resourcesRoot
    this.report = options.report
  }

  launch(record: SessionRecord, native: RuntimeLaunchSpec, agentArgs: string[], options: LaunchPlanOptions): RuntimeLaunchSpec {
    const agent = record.agent
    if (agent?.agentId !== 'codex' || !agent.identityLaunchId)
      throw new Error('Codex launch has no persisted identity generation')
    const prefixArgs = native.args.slice(0, native.args.length - agentArgs.length)
    const root = this.rootOf(record)
    mkdirSync(root, {recursive: true})
    const launchFile = join(root, `${agent.identityLaunchId}.launch.json`)
    const overrides: string[] = []
    if (options.model !== undefined) overrides.push('-c', `model=${JSON.stringify(options.model)}`)
    if (options.effort !== undefined) overrides.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`)
    if (options.yolo) overrides.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
      '-c', `projects={${JSON.stringify(native.cwd)}={trust_level="trusted"}}`)
    const launch: CodexSessionLaunch = {
      schemaVersion: 1,
      jamatSessionId: record.sessionId, launchId: agent.identityLaunchId,
      mode: record.pendingOperationKind === 'reopen' ? 'resume' : agent.launchMode,
      nativeSessionId: agent.nativeSessionId, forkParentId: agent.forkParentId,
      cwd: native.cwd, receiptFile: this.receiptFile(record),
      yolo: options.yolo === true,
      client: {command: native.command, prefixArgs, args: agentArgs},
      server: {command: native.command, prefixArgs, args: [...overrides, 'app-server', '--listen', 'stdio://']},
    }
    writeFileSync(launchFile, JSON.stringify(launch), {encoding: 'utf8', mode: 0o600})
    const bundle = this.resourcesRoot === null ? null : join(this.resourcesRoot, 'codex', 'start.cjs')
    let args: string[]
    if (bundle !== null && existsSync(bundle)) args = [bundle, launchFile]
    else {
      const entry = join(this.applicationRoot, 'app-codex', 'start.ts')
      if (!existsSync(entry)) throw new Error('The Jamat Codex identity bridge is missing')
      const require = createRequire(join(this.applicationRoot, 'package.json'))
      args = ['--import', pathToFileURL(require.resolve('tsx')).href, entry, launchFile]
    }
    return {...native, command: this.runtimeOf(native.env), args}
  }

  private runtimeOf(environment: NodeJS.ProcessEnv): string {
    // Electron's Windows GUI executable cannot provide inherited console handles inside ConPTY.
    if (this.resourcesRoot !== null) {
      const executable = join(this.resourcesRoot, 'launcher', process.platform === 'win32' ? 'node.exe' : 'bin/node')
      if (!existsSync(executable)) throw new Error('The packaged Node runtime for the Codex bridge is missing')
      return executable
    }
    if (!process.versions.electron) return process.execPath
    if (process.platform === 'win32') {
      const executable = WindowsCommand.imageOf('node', environment)
      if (executable !== null) return executable
      throw new Error('The development Codex bridge requires a Node executable on PATH')
    } else if (process.platform === 'darwin' || process.platform === 'linux') return 'node'
    else throw new Error(`Unsupported Codex bridge platform: ${process.platform}`)
  }

  identity(record: SessionRecord): CodexSessionIdentity | null {
    if (!CodexSessionFiles.tracked(record)) return null
    try {
      const file = this.receiptFile(record)
      if (!existsSync(file)) return null
      if (statSync(file).size > 8192) throw new Error('Identity receipt exceeds 8 KiB')
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as Partial<CodexSessionIdentity> | null
      if (receipt?.schemaVersion !== 1 || receipt.jamatSessionId !== record.sessionId
        || receipt.launchId !== record.agent!.identityLaunchId
        || typeof receipt.nativeSessionId !== 'string'
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(receipt.nativeSessionId)
        || !Number.isSafeInteger(receipt.sequence) || receipt.sequence! < 1)
        throw new Error('Identity receipt does not match this Codex launch')
      return receipt as CodexSessionIdentity
    } catch (error) {
      const key = `${record.sessionId}/${record.agent?.identityLaunchId}`
      if (!this.reported.has(key)) {
        this.reported.add(key)
        this.report(`Session ${record.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return null
    }
  }

  static tracked(record: SessionRecord): boolean {
    return record.agent?.agentId === 'codex' && record.agent.identityLaunchId !== undefined
      && record.endedReason === undefined
  }

  private receiptFile(record: SessionRecord): string {
    return join(this.rootOf(record), `${record.agent!.identityLaunchId}.identity.json`)
  }

  private rootOf(record: SessionRecord): string {
    for (const id of [record.sessionId, record.agent?.identityLaunchId])
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid Codex launch path identity')
    return join(this.directory, record.sessionId)
  }
}
