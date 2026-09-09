import { randomUUID } from 'node:crypto'

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
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { AppClientCliError } from './appClientCliError'
import { AppConfig } from './appConfig'
import { CliArguments } from './cliArguments'
import { CliJsonFile } from './cliJsonFile'
import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'
import { LocalInstanceResolver } from './localInstanceResolver'
import { SessionSelectorResolver } from './sessionSelectorResolver'

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
  loadConfig(args: CliArguments): AppConfig
  discover(config: AppConfig): Promise<RemoteControlStepResult<RemoteControlDescriptor>>
    | RemoteControlStepResult<RemoteControlDescriptor>
  client(descriptor: RemoteControlDescriptor): AppClientCliClientPort
  operationId(): string
  requestId(): string
  write(value: string): void
  readJson(file: string): unknown
  signal?: AbortSignal
}

type AppClientCliPlan =
  | {
      kind: 'request'
      request: RemoteControlRequestUnion
      computer: string | null
      workingDirectory: string | null
    }
  | { kind: 'local'; request: RemoteControlLocalRequestUnion }
  | { kind: 'events'; afterRevision?: number }

export class AppClientCli {
  private readonly deps: AppClientCliDeps

  constructor(
    private readonly argv: readonly string[],
    deps?: Partial<AppClientCliDeps>,
  ) {
    this.deps = {
      loadConfig: deps?.loadConfig ?? ((args) => AppConfig.load(args)),
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
      ...(deps?.signal === undefined ? {} : { signal: deps.signal }),
    }
  }

  async run(): Promise<number> {
    let plan: AppClientCliPlan | null = null
    try {
      const args = CliArguments.parse(this.argv)
      plan = this.plan(args)
      const config = this.deps.loadConfig(args)
      const descriptor = await this.deps.discover(config)
      if (!descriptor.ok)
        return this.finishFailure(plan, descriptor.error)
      const client = this.deps.client(descriptor.value)
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
      requestId: request?.requestId ?? null,
      operation: request?.operation ?? null,
      operationId: request?.operationId ?? null,
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
