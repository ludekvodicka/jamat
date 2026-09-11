import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  RemoteControlComputerDto,
  RemoteControlComputersDto,
  RemoteControlDescriptor,
  RemoteControlError,
  RemoteControlErrorCode,
  RemoteControlLocalOperation,
  RemoteControlLocalRequest,
  RemoteControlLocalRequestUnion,
  RemoteControlLocalResponse,
  RemoteControlOperation,
  RemoteControlRequest,
  RemoteControlRequestUnion,
  RemoteControlResponse,
  RemoteControlSessionSelector,
  RemoteControlSocketResponse,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import {
  RemoteControlCapabilities,
  RemoteControlConst,
} from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlClient } from '../../lib-orchestrator/remoteControl/remoteControlClient'
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing'
import type { RemoteControlPeerPairingBundle } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { SessionCreateSpec } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsSnapshotValidation } from '../../lib-orchestrator/sessionManager/sessionsSnapshotValidation'
import { SessionWorkingDirectory } from '../../lib-orchestrator/sessionManager/sessionWorkingDirectory'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { AppClientCliError } from './appClientCliError'
import { AppConfig } from './appConfig'
import { CliArguments } from './cliArguments'
import { CliJsonFile } from './cliJsonFile'
import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'
import { LocalInstanceResolver } from './localInstanceResolver'
import { SessionSelectorResolver } from './sessionSelectorResolver'
import { SelfSession } from './selfSession'
import { CommitMessageFile } from './commitMessageFile'
import { CommitAsideLauncher, type CommitAsideRequest } from './commitAsideLauncher'
import { CommitStatusReader } from './commitStatusReader'

export interface AppClientCliClientPort {
  execute(request: RemoteControlRequestUnion): Promise<RemoteControlResponse>
  executeLocal(request: RemoteControlLocalRequestUnion): Promise<RemoteControlLocalResponse>
  executeRemote(
    remoteEndpointId: string,
    request: RemoteControlRequestUnion,
  ): Promise<RemoteControlResponse>
  watchEvents(options: {
    afterRevision?: number
    signal?: AbortSignal
    onMessage(message: Exclude<RemoteControlSocketResponse, { type: 'terminal.frame' }>): void
  }): Promise<RemoteControlStepResult<void>>
}

export interface AppClientCliDeps {
  env: NodeJS.ProcessEnv
  cwd(): string
  readMessage(file: string): string
  writeMessageFile(text: string): Promise<string>
  aside: Pick<CommitAsideLauncher, 'open'>
  loadConfig(args: CliArguments): AppConfig
  discover(config: AppConfig): Promise<RemoteControlStepResult<RemoteControlDescriptor>>
    | RemoteControlStepResult<RemoteControlDescriptor>
  client(descriptor: RemoteControlDescriptor): AppClientCliClientPort
  operationId(): string
  requestId(): string
  write(value: string): void
  readJson(file: string): unknown
  signal?: AbortSignal
  now(): number
  pause(milliseconds: number, signal?: AbortSignal): Promise<void>
}

type AppClientCliPlan =
  | CommitPlan
  | { kind: 'commit-status'; id: string; wait: boolean; timeoutMs: number }
  | {
      kind: 'request'
      request: RemoteControlRequestUnion
      computer: string | null
      workingDirectory: string | null
    }
  | { kind: 'local'; request: RemoteControlLocalRequestUnion }
  | { kind: 'events'; afterRevision?: number }

interface CommitPlan {
  kind: 'commit'
  args: CliArguments
  vcs: 'svn' | 'git'
  selector: RemoteControlSessionSelector | null
  scope: string | null
  workingDirectory: string | null
  message: string | null
  messageFile: string | null
  fallback: 'tortoise' | 'report'
  wait: boolean
  timeoutMs: number
  requestId: string
  operationId: string
}

export class AppClientCli {
  private readonly deps: AppClientCliDeps

  constructor(
    private readonly argv: readonly string[],
    deps?: Partial<AppClientCliDeps>,
  ) {
    this.deps = {
      env: deps?.env ?? process.env,
      cwd: deps?.cwd ?? (() => process.cwd()),
      readMessage: deps?.readMessage ?? CommitMessageFile.read,
      writeMessageFile: deps?.writeMessageFile ?? CommitMessageFile.write,
      aside: deps?.aside ?? new CommitAsideLauncher(),
      loadConfig: deps?.loadConfig ?? ((args) => AppConfig.load(args, deps?.env ?? process.env)),
      discover: deps?.discover ?? ((config) => new LocalInstanceResolver().resolve({
        ...(config.configDir === null ? {} : { configDir: config.configDir }),
        ...(config.configIdentity === null ? {} : { configIdentity: config.configIdentity }),
        ...(config.runtimeChannel === null ? {} : { channel: config.runtimeChannel }),
      })),
      client: deps?.client ?? ((descriptor) => new RemoteControlClient(descriptor)),
      operationId: deps?.operationId ?? randomUUID,
      requestId: deps?.requestId ?? randomUUID,
      write: deps?.write ?? ((value) => process.stdout.write(`${value}\n`)),
      readJson: deps?.readJson ?? CliJsonFile.read,
      now: deps?.now ?? Date.now,
      pause: deps?.pause ?? CommitStatusReader.pause,
      ...(deps?.signal === undefined ? {} : { signal: deps.signal }),
    }
  }

  async run(): Promise<number> {
    let plan: AppClientCliPlan | null = null
    try {
      const args = CliArguments.parse(this.argv)
      plan = this.plan(args)
      if (plan.kind === 'commit') return await this.runCommit(plan)
      const config = this.deps.loadConfig(args)
      const descriptor = await this.deps.discover(config)
      if (!descriptor.ok)
        return this.finishFailure(plan, descriptor.error)
      const client = this.deps.client(descriptor.value)
      if (plan.kind === 'commit-status') {
        if (!RemoteControlCapabilities.of(descriptor.value).includes('tabs.commitStatus'))
          return this.finishFailure(plan, { code: 'unavailable', detail: 'tabs.commitStatus is not exposed by this AppClientUI' })
        return await this.readCommitStatus(client, plan.id, plan.wait, plan.timeoutMs)
      }
      if (plan.kind === 'request') {
        if (plan.request.operation === 'sessions.transcript'
          && !RemoteControlCapabilities.of(descriptor.value).includes('sessions.transcript'))
          return this.finishFailure(plan, {
            code: 'unavailable',
            detail: 'sessions.transcript is not exposed by this AppClientUI',
          })
        let remoteEndpointId: string | null = null
        if (plan.computer !== null) {
          const endpoint = await this.remoteEndpoint(client, plan.computer)
          if (!endpoint.ok) return this.finishFailure(plan, endpoint.error)
          remoteEndpointId = endpoint.value.remoteEndpointId
        }
        const canonical = await this.canonicalRequest(
          client,
          remoteEndpointId,
          plan.request,
          plan.workingDirectory,
        )
        if (!canonical.ok) return this.finishFailure(plan, canonical.error)
        const response: RemoteControlResponse = remoteEndpointId === null
          ? await client.execute(canonical.value)
          : await client.executeRemote(remoteEndpointId, canonical.value)
        this.write(response)
        return AppClientCli.exitCode(response.ok ? null : response.error.code)
      } else if (plan.kind === 'local') {
        const response = await client.executeLocal(plan.request)
        this.write(response)
        return AppClientCli.exitCode(response.ok ? null : response.error.code)
      } else if (plan.kind === 'events') {
        const watched = await client.watchEvents({
          ...(plan.afterRevision === undefined ? {} : { afterRevision: plan.afterRevision }),
          ...(this.deps.signal === undefined ? {} : { signal: this.deps.signal }),
          onMessage: (message) => this.write(message),
        })
        if (watched.ok) return 0
        return this.finishFailure(plan, watched.error)
      } else
        throw new Error(`Unknown CLI plan: ${JSON.stringify(plan)}`)
    } catch (error) {
      const failure = error instanceof AppClientCliError
        ? { code: error.code, detail: error.message }
        : { code: 'operation-failed' as const, detail: ErrorText.of(error) }
      return this.finishFailure(plan, failure)
    }
  }

  private plan(args: CliArguments): AppClientCliPlan {
    if (args.command === 'commit-svn-jamat') return this.commitPlan(args, 'svn')
    else if (args.command === 'commit-git-jamat') return this.commitPlan(args, 'git')
    else if (args.command === 'commit status') {
      const id = args.required('--commit-session-id')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        throw new AppClientCliError('invalid-request', '--commit-session-id must be a UUID')
      return { kind: 'commit-status', id, wait: args.has('--wait'), timeoutMs: this.commitTimeout(args) }
    }
    if (args.command === 'events watch') {
      const afterRevision = args.integer('--after-revision', 0, Number.MAX_SAFE_INTEGER)
      return { kind: 'events', ...(afterRevision === undefined ? {} : { afterRevision }) }
    }
    const requestId = this.deps.requestId()
    if (args.command === 'remote computers list')
      return {
        kind: 'local',
        request: this.localRequest('remote.computers.list', {}, requestId),
      }
    else if (args.command === 'remote pairing export')
      return {
        kind: 'local',
        request: this.localRequest('remote.pairing.export', {}, requestId),
      }
    else if (args.command === 'remote pairing import') {
      const bundle = this.pairingBundle(this.deps.readJson(args.required('--file')))
      return {
        kind: 'local',
        request: this.localRequest(
          'remote.pairing.import',
          { bundle },
          requestId,
          this.operationId(args),
        ),
      }
    } else if (args.command === 'status')
      return this.requestPlan(args, this.request('system.status', {}, requestId))
    else if (args.command === 'projects list') {
      const categoryId = args.option('--category-id')
      const sort = args.option('--sort')
      if (sort !== null && sort !== 'alpha' && sort !== 'recent')
        throw new AppClientCliError('invalid-request', '--sort must be alpha or recent')
      return this.requestPlan(args, this.request('projects.list', {
          ...(categoryId === null ? {} : { categoryId }),
          ...(sort === null ? {} : { sort }),
        }, requestId))
    } else if (args.command === 'sessions list')
      return this.requestPlan(args, this.request('sessions.list', {}, requestId))
    else if (args.command === 'sessions create')
      return this.requestPlan(args, this.request(
          'sessions.create',
          { spec: this.sessionSpec(args), ...(args.has('--open-tab') ? { openTab: true } : {}) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions reopen')
      return this.requestPlan(args, this.request(
          'sessions.reopen',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions finalize')
      return this.requestPlan(args, this.request(
          'sessions.finalize',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions transcript')
      return this.requestPlan(args, this.request(
          'sessions.transcript',
          { session: this.selector(args) },
          requestId,
        ))
    else if (args.command === 'tabs list')
      return this.requestPlan(args, this.request('tabs.list', {}, requestId))
    else if (args.command === 'tabs open')
      return this.requestPlan(args, this.request(
          'tabs.open',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'tabs open-file')
      return this.requestPlan(args, this.request(
          'tabs.openFile',
          { session: this.selector(args), path: args.required('--path') },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'tabs focus')
      return this.requestPlan(args, this.request(
          'tabs.focus',
          { panelId: args.required('--panel-id') },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'tabs close')
      return this.requestPlan(args, this.request(
          'tabs.close',
          { panelId: args.required('--panel-id') },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'terminal peek') {
      const cols = args.integer('--cols', 2, 1_000)
      const rows = args.integer('--rows', 1, 500)
      if ((cols === undefined) !== (rows === undefined))
        throw new AppClientCliError(
          'invalid-request',
          '--cols and --rows must be provided together',
        )
      const timeoutMs = args.integer('--timeout-ms', 50, 60_000)
      return this.requestPlan(args, this.request('terminal.peek', {
          session: this.selector(args),
          ...(cols === undefined ? {} : { cols }),
          ...(rows === undefined ? {} : { rows }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }, requestId))
    } else if (args.command === 'terminal send') {
      const timeoutMs = args.integer('--timeout-ms', 50, 60_000)
      return this.requestPlan(args, this.request('terminal.send', {
          session: this.selector(args),
          text: args.required('--text'),
          ...(args.has('--enter') ? { enter: true } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }, requestId, this.operationId(args)))
    } else
      throw new Error(`Unknown parsed CLI command: ${JSON.stringify(args.command)}`)
  }

  private commitPlan(args: CliArguments, vcs: 'svn' | 'git'): CommitPlan {
    const self = args.has('--self') ? SelfSession.of(this.deps.env) : null
    const selector = args.has('--self') ? self === null ? null : { kind: 'sessionId' as const, sessionId: self.sessionId } : this.selector(args)
    const messageFile = args.option('--message-file')
    const message = messageFile === null ? args.option('--message') : this.deps.readMessage(messageFile)
    if (message !== null) CommitMessageFile.validate(message)
    const scope = args.option('--path')
    if (scope !== null && !scope.trim()) throw new AppClientCliError('invalid-request', '--path cannot be empty')
    const fallback = args.option('--fallback') ?? 'tortoise'
    if (fallback !== 'tortoise' && fallback !== 'report') throw new AppClientCliError('invalid-request', '--fallback must be tortoise or report')
    return { kind: 'commit', args, vcs, selector, scope, workingDirectory: args.option('--working-directory'), message, messageFile, fallback,
      wait: args.has('--wait'), timeoutMs: this.commitTimeout(args),
      requestId: this.deps.requestId(), operationId: this.operationId(args) }
  }

  private async runCommit(plan: CommitPlan): Promise<number> {
    const descriptor = await this.deps.discover(this.deps.loadConfig(plan.args))
    if (!descriptor.ok) return descriptor.error.code === 'unavailable'
      ? this.finishAside(plan, 'jamat-unavailable') : this.finishFailure(plan, descriptor.error)
    if (!RemoteControlCapabilities.of(descriptor.value).includes('tabs.openCommit'))
      return this.finishFailure(plan, { code: 'unavailable', detail: 'tabs.openCommit is not exposed by this AppClientUI' })
    if (plan.selector === null) return this.finishAside(plan, 'session-not-open')
    const client = this.deps.client(descriptor.value)
    const listed = await client.execute(this.request('sessions.list', {}, this.deps.requestId()))
    if (!listed.ok) return this.finishFailure(plan, listed.error)
    const snapshot = SessionsSnapshotValidation.parse(listed.value)
    if (snapshot === null) return this.finishFailure(plan, { code: 'operation-failed', detail: 'AppClientUI returned an invalid sessions snapshot' })
    const canonical = await new SessionSelectorResolver({ list: async () => ({ ok: true, value: snapshot }) })
      .canonical(plan.selector, plan.workingDirectory ?? undefined)
    if (!canonical.ok) return canonical.error.code === 'not-found'
      ? this.finishAside(plan, 'session-not-open') : this.finishFailure(plan, canonical.error)
    const session = snapshot.sessions.find((info) => info.sessionId === canonical.value.sessionId)
    if (session?.life !== 'live') return this.finishAside(plan, 'session-not-open')
    const cwd = SessionWorkingDirectory.of(session)
    if (cwd !== null && plan.scope !== null) {
      const scope = resolve(cwd, plan.scope)
      if (!PathCompare.isInside(cwd, scope)) return this.finishAside(plan, 'outside-session', scope)
    }
    if (plan.wait && !RemoteControlCapabilities.of(descriptor.value).includes('tabs.commitStatus'))
      return this.finishFailure(plan, { code: 'unavailable', detail: 'tabs.commitStatus is not exposed by this AppClientUI; update Jamat before waiting for native review' })
    const response = await client.execute(this.request('tabs.openCommit', {
      session: canonical.value, vcs: plan.vcs,
      ...(plan.scope === null ? {} : { scope: plan.scope }), ...(plan.message === null ? {} : { message: plan.message }),
    }, plan.requestId, plan.operationId))
    if (response.ok && plan.wait) {
      const opened = JsonShape.record(response.value)
      if (opened?.kind !== 'commit-opened' || typeof opened.commitSessionId !== 'string')
        return this.finishFailure(plan, { code: 'operation-failed', detail: 'The commit opened without a trackable UUID; its outcome is unknown' })
      return this.readCommitStatus(client, opened.commitSessionId, true, plan.timeoutMs)
    }
    this.write(response)
    return AppClientCli.exitCode(response.ok ? null : response.error.code)
  }

  private commitTimeout(args: CliArguments): number {
    if (args.option('--timeout-ms') !== null && !args.has('--wait'))
      throw new AppClientCliError('invalid-request', '--timeout-ms requires --wait for commit commands')
    return args.integer('--timeout-ms', 1, CommitStatusReader.timeoutMillisecondsConst) ?? CommitStatusReader.timeoutMillisecondsConst
  }

  private async readCommitStatus(client: AppClientCliClientPort, id: string, wait: boolean, timeoutMs: number): Promise<number> {
    const reader = new CommitStatusReader({
      read: () => client.execute(this.request('tabs.commitStatus', { commitSessionId: id }, this.deps.requestId())),
      now: this.deps.now, pause: this.deps.pause,
    })
    const response = await reader.read(id, wait, timeoutMs, this.deps.signal)
    this.write(response)
    return AppClientCli.exitCode(response.ok ? null : response.error.code)
  }

  private async finishAside(plan: CommitPlan, reason: CommitAsideRequest['reason'], scope = resolve(this.deps.cwd(), plan.scope ?? '.')): Promise<number> {
    if (plan.fallback === 'report') {
      this.write({ ok: true, value: { kind: 'fallback-required', reason, scope } })
      return 0
    } else if (plan.fallback !== 'tortoise') throw new Error(`Unknown commit fallback: ${JSON.stringify(plan.fallback)}`)
    const messageFile = plan.messageFile === null
      ? plan.message === null ? null : await this.deps.writeMessageFile(plan.message)
      : resolve(this.deps.cwd(), plan.messageFile)
    const result = await this.deps.aside.open({ vcs: plan.vcs, scope, messageFile, reason })
    this.write(result)
    return AppClientCli.exitCode(result.ok ? null : result.error.code)
  }

  private requestPlan(
    args: CliArguments,
    request: RemoteControlRequestUnion,
  ): Extract<AppClientCliPlan, { kind: 'request' }> {
    const computer = args.option('--computer')
    if (computer !== null && computer.trim().length === 0)
      throw new AppClientCliError('invalid-request', '--computer must not be empty')
    if (computer !== null
      && request.operation === 'sessions.create'
      && (args.has('--open-tab') || args.has('--plain')))
      throw new AppClientCliError(
        'invalid-request',
        '--open-tab and --plain are local UI options and cannot be used with --computer',
      )
    // A session of the tab is drawn by that tab alone, so one without a tab is invisible and stays
    // behind. The library refuses it either way; this says so before the round trip.
    if (request.operation === 'sessions.create'
      && args.has('--plain')
      && !args.has('--open-tab'))
      throw new AppClientCliError('invalid-request', '--plain requires --open-tab')
    return {
      kind: 'request',
      request,
      computer,
      workingDirectory: args.option('--working-directory'),
    }
  }

  private sessionSpec(args: CliArguments): SessionCreateSpec {
    const directory = args.option('--directory')
    const categoryId = args.option('--category-id')
    const projectPath = args.option('--project-path')
    if (directory !== null && (categoryId !== null || projectPath !== null))
      throw new AppClientCliError(
        'invalid-request',
        '--directory cannot be combined with --category-id or --project-path',
      )
    if ((categoryId === null) !== (projectPath === null))
      throw new AppClientCliError(
        'invalid-request',
        '--category-id and --project-path must be provided together',
      )
    const directorySpec: SessionCreateSpec['directory'] = directory !== null
      ? { mode: 'adHoc', path: directory }
      : categoryId !== null && projectPath !== null
        ? { mode: 'project', categoryId, projectPath }
        : { mode: 'default' }
    const agentId = args.option('--agent')
    const mode = args.option('--mode')
    const nativeSessionId = args.option('--native-session-id')
    const forkParentId = args.option('--fork-parent-id')
    const initialPrompt = args.option('--prompt')
    if (agentId === null
      && [mode, nativeSessionId, forkParentId, initialPrompt].some((value) => value !== null))
      throw new AppClientCliError('invalid-request', 'Agent options require --agent')
    if (agentId !== null && agentId !== 'claude' && agentId !== 'codex')
      throw new AppClientCliError('invalid-request', '--agent must be claude or codex')
    if (mode !== null && mode !== 'new' && mode !== 'continue' && mode !== 'resume' && mode !== 'fork')
      throw new AppClientCliError(
        'invalid-request',
        '--mode must be new, continue, resume or fork',
      )
    const worktree = args.option('--worktree')
    const baseRef = args.option('--base-ref')
    if (baseRef !== null && worktree === null)
      throw new AppClientCliError('invalid-request', '--base-ref requires --worktree')
    const title = args.option('--title')
    const flowId = args.option('--flow-id')
    const acknowledgeSetup = args.option('--acknowledge-setup')
    return {
      kind: agentId === null ? 'shell' : 'agent',
      directory: directorySpec,
      ...(agentId === null ? {} : {
        agent: {
          agentId,
          mode: mode ?? 'new',
          ...(nativeSessionId === null ? {} : { nativeSessionId }),
          ...(forkParentId === null ? {} : { forkParentId }),
          ...(initialPrompt === null ? {} : { initialPrompt }),
        },
      }),
      ...(worktree === null ? {} : {
        worktree: { slug: worktree, ...(baseRef === null ? {} : { baseRef }) },
      }),
      ...(title === null ? {} : { title }),
      ...(flowId === null ? {} : { flowId }),
      ...(args.has('--plain') ? { presentation: 'tab' as const } : {}),
      ...(acknowledgeSetup === null ? {} : { acknowledgeSetup }),
    }
  }

  private selector(args: CliArguments): RemoteControlSessionSelector {
    const sessionId = args.option('--session-id')
    const number = args.option('--number')
    const workingDirectory = args.option('--working-directory')
    if ((sessionId === null) === (number === null))
      throw new AppClientCliError(
        'invalid-request',
        `Exactly one of --session-id or --number is required for ${args.command}`,
      )
    if (workingDirectory !== null && workingDirectory.trim().length === 0)
      throw new AppClientCliError('invalid-request', '--working-directory cannot be empty')
    if (sessionId !== null) {
      if (workingDirectory !== null)
        throw new AppClientCliError(
          'invalid-request',
          '--working-directory cannot be combined with --session-id',
        )
      return { kind: 'sessionId', sessionId }
    }
    if (number !== null && /^\d{3}(?:-\d{3})?$/.test(number)) return { kind: 'number', number }
    throw new AppClientCliError(
      'invalid-request',
      '--number must contain three digits or two three-digit parts separated by a hyphen',
    )
  }

  private async canonicalRequest(
    client: AppClientCliClientPort,
    remoteEndpointId: string | null,
    request: RemoteControlRequestUnion,
    workingDirectory: string | null,
  ): Promise<RemoteControlStepResult<RemoteControlRequestUnion>> {
    if (request.operation === 'sessions.reopen'
      || request.operation === 'sessions.finalize'
      || request.operation === 'sessions.transcript'
      || request.operation === 'tabs.open'
      || request.operation === 'tabs.openFile'
      || request.operation === 'tabs.openCommit'
      || request.operation === 'terminal.peek'
      || request.operation === 'terminal.send') {
      const resolver = new SessionSelectorResolver({
        list: async () => {
          const listRequest = this.request('sessions.list', {}, this.deps.requestId())
          const response = remoteEndpointId === null
            ? await client.execute(listRequest)
            : await client.executeRemote(remoteEndpointId, listRequest)
          return response.ok
            ? { ok: true, value: response.value }
            : { ok: false, error: response.error }
        },
      })
      const canonical = await resolver.canonical(
        request.body.session,
        workingDirectory ?? undefined,
      )
      if (!canonical.ok) return canonical
      return {
        ok: true,
        value: {
          ...request,
          body: { ...request.body, session: canonical.value },
        } as RemoteControlRequestUnion,
      }
    } else if (request.operation === 'system.hello'
      || request.operation === 'system.status'
      || request.operation === 'projects.list'
      || request.operation === 'sessions.list'
      || request.operation === 'sessions.create'
      || request.operation === 'tabs.list'
      || request.operation === 'tabs.focus'
      || request.operation === 'tabs.close')
      return { ok: true, value: request }
    else
      throw new Error(`Unknown control request: ${JSON.stringify(request)}`)
  }

  private operationId(args: CliArguments): string {
    return args.option('--operation-id') ?? this.deps.operationId()
  }

  private async remoteEndpoint(
    client: AppClientCliClientPort,
    selector: string,
  ): Promise<RemoteControlStepResult<RemoteControlComputerDto>> {
    const listed = await client.executeLocal(this.localRequest(
      'remote.computers.list',
      {},
      this.deps.requestId(),
    ))
    if (!listed.ok) return { ok: false, error: listed.error }
    const computers = listed.value as RemoteControlComputersDto
    const matches = computers.computers.filter((computer) =>
      computer.profileId === selector
      || computer.remoteComputerId === selector
      || computer.remoteEndpointId === selector
      || computer.displayName === selector)
    if (matches.length === 1) return { ok: true, value: matches[0] }
    if (matches.length === 0)
      return {
        ok: false,
        error: {
          code: 'not-found',
          detail: `No remote computer matches ${JSON.stringify(selector)}`,
        },
      }
    return {
      ok: false,
      error: {
        code: 'conflict',
        detail: `Remote computer ${JSON.stringify(selector)} is ambiguous`,
        data: {
          candidates: matches.map((computer) => ({
            profileId: computer.profileId,
            remoteComputerId: computer.remoteComputerId,
            remoteEndpointId: computer.remoteEndpointId,
            configIdentity: computer.configIdentity,
            runtimeChannel: computer.runtimeChannel,
            displayName: computer.displayName,
            status: computer.status,
          })),
        },
      },
    }
  }

  private pairingBundle(input: unknown): RemoteControlPeerPairingBundle {
    const value = JsonShape.record(input)
    const candidate = value?.protocol === RemoteControlConst.protocol
      && value.operation === 'remote.pairing.export'
      && value.ok === true
      ? value.value
      : input
    try { return RemoteControlPairing.parse(candidate) }
    catch (error) {
      throw new AppClientCliError(
        'invalid-request',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private request<K extends RemoteControlOperation>(
    operation: K,
    body: RemoteControlRequest<K>['body'],
    requestId: string,
    operationId?: string,
  ): RemoteControlRequest<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId,
      operation,
      ...(operationId === undefined ? {} : { operationId }),
      body,
    } as RemoteControlRequest<K>
  }

  private localRequest<K extends RemoteControlLocalOperation>(
    operation: K,
    body: RemoteControlLocalRequest<K>['body'],
    requestId: string,
    operationId?: string,
  ): RemoteControlLocalRequest<K> {
    return {
      protocol: RemoteControlConst.protocol,
      requestId,
      operation,
      ...(operationId === undefined ? {} : { operationId }),
      body,
    } as RemoteControlLocalRequest<K>
  }

  private finishFailure(
    plan: AppClientCliPlan | null,
    error: RemoteControlError,
  ): number {
    const request = plan?.kind === 'request' || plan?.kind === 'local' ? plan.request : null
    this.write({
      protocol: RemoteControlConst.protocol,
      requestId: plan?.kind === 'commit' ? plan.requestId : request?.requestId ?? null,
      operation: plan?.kind === 'commit' ? 'tabs.openCommit' : request?.operation ?? null,
      operationId: plan?.kind === 'commit' ? plan.operationId : request?.operationId ?? null,
      ok: false,
      error,
    })
    return AppClientCli.exitCode(error.code)
  }

  private write(value: unknown): void {
    this.deps.write(JSON.stringify(value))
  }

  /**
   * The stable exit codes the reference promises. A `Record` keyed by the error type, so a code
   * added to the protocol stops this file from compiling until somebody decides what it exits with.
   */
  private static readonly exitCodesConst: Record<RemoteControlErrorCode, number> = {
    'invalid-request': 2,
    'not-found': 3,
    conflict: 4,
    timeout: 5,
    unavailable: 6,
    'protocol-mismatch': 7,
    forbidden: 7,
    'operation-failed': 7,
  }

  private static exitCode(code: RemoteControlErrorCode | null): number {
    return code === null ? 0 : AppClientCli.exitCodesConst[code]
  }
}
