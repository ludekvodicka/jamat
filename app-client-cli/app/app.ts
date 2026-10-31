import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { PassInbox, type PassEvent } from '../../lib-orchestrator/snapins/passInboxView'

import type {
  RemoteControlCatalogEntryDto,
  RemoteControlCommitPath,
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
  RemoteControlDeliverConst,
} from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlClient } from '../../lib-orchestrator/remoteControl/remoteControlClient'
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing'
import type { RemoteControlPeerPairingBundle } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { SessionTitle } from '../../lib-orchestrator/sessionManager/records/sessionTitle'
import { SessionColors } from '../../lib-orchestrator/sessionManager/sessionColors'
import { SessionGroups } from '../../lib-orchestrator/sessionManager/sessionGroups'
import type {
  SessionColorName,
  SessionCreateSpec,
  SessionGroup,
  SessionParentKind,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsSnapshotValidation } from '../../lib-orchestrator/sessionManager/sessionsSnapshotValidation'
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
import { ScriptRunReader } from './scriptRunReader'

export interface AppClientCliClientPort {
  execute(request: RemoteControlRequestUnion, signal?: AbortSignal): Promise<RemoteControlResponse>
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
  client(descriptor: RemoteControlDescriptor, options?: { timeoutMilliseconds?: number }): AppClientCliClientPort
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
  | { kind: 'pass'; directory: string; event?: PassEvent }
  | { kind: 'commit-status'; id: string; wait: boolean; timeoutMs: number }
  | {
      kind: 'request'
      request: RemoteControlRequestUnion
      computer: string | null
      workingDirectory: string | null
      clientTimeoutMs?: number
      /** `sessions scripts run --wait`: how long to wait for the run's verdict. */
      scriptWaitMs?: number
    }
  | { kind: 'local'; request: RemoteControlLocalRequestUnion }
  | { kind: 'events'; afterRevision?: number }
  | { kind: 'operation'; request: RemoteControlRequest<'system.operations'>; name: string }
  | { kind: 'call'; operation: string; body: unknown; requestId: string; operationId: string | null }

interface CommitPlan {
  kind: 'commit'
  args: CliArguments
  vcs: 'svn' | 'git'
  selector: RemoteControlSessionSelector | null
  scope: string | null
  paths?: readonly RemoteControlCommitPath[]
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
      client: deps?.client ?? ((descriptor, options) => new RemoteControlClient(descriptor, options)),
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
      const help = CliArguments.helpOf(this.argv)
      if (help !== null) {
        this.write({ ok: true, value: help })
        return 0
      }
      const args = CliArguments.parse(this.argv)
      plan = this.plan(args)
      if (plan.kind === 'pass') return await this.runPass(plan)
      if (plan.kind === 'commit') return await this.runCommit(plan)
      const config = this.deps.loadConfig(args)
      const descriptor = await this.deps.discover(config)
      if (!descriptor.ok)
        return this.finishFailure(plan, descriptor.error)
      const client = plan.kind === 'request' && plan.clientTimeoutMs !== undefined
        ? this.deps.client(descriptor.value, { timeoutMilliseconds: plan.clientTimeoutMs })
        : this.deps.client(descriptor.value)
      if (plan.kind === 'commit-status') {
        if (!RemoteControlCapabilities.of(descriptor.value).includes('tabs.commitStatus'))
          return this.finishFailure(plan, { code: 'unavailable', detail: 'tabs.commitStatus is not exposed by this AppClientUI' })
        return await this.readCommitStatus(client, plan.id, plan.wait, plan.timeoutMs, config)
      }
      if (plan.kind === 'request') {
        if (AppClientCli.capabilityGatedConst.includes(plan.request.operation)
          && !RemoteControlCapabilities.of(descriptor.value).includes(plan.request.operation))
          return this.finishFailure(plan, {
            code: 'unavailable',
            detail: `${plan.request.operation} is not exposed by this AppClientUI`,
          })
        const feature = AppClientCli.featureOf(plan.request)
        if (feature !== null && !RemoteControlCapabilities.of(descriptor.value).includes(feature.operation))
          return this.finishFailure(plan, {
            code: 'unavailable',
            detail: `${feature.option} needs ${feature.operation}, which this AppClientUI does not expose; update AppJamatV3`,
          })
        let remoteEndpointId: string | null = null
        if (plan.computer !== null) {
          const endpoint = await this.remoteEndpoint(client, plan.computer)
          if (!endpoint.ok) return this.finishFailure(plan, endpoint.error)
          remoteEndpointId = endpoint.value.remoteEndpointId
          const required = [...new Set([plan.request.operation, ...(feature ? [feature.operation] : [])])]
            .filter((operation) => RemoteControlConst.optionalOperations.some((optional) => optional === operation))
          if (required.length > 0) {
            let offered: readonly string[] | null = endpoint.value.optionalOperations
            if (offered === null) {
              const hello = await client.executeRemote(remoteEndpointId, this.request('system.hello', {}, this.deps.requestId()))
              if (!hello.ok) return this.finishFailure(plan, hello.error)
              offered = 'optionalOperations' in hello.value && Array.isArray(hello.value.optionalOperations)
                ? hello.value.optionalOperations.filter((operation): operation is string => typeof operation === 'string') : []
            }
            const missing = required.find((operation) => !offered.includes(operation))
            if (missing) return this.finishFailure(plan, { code: 'unavailable', detail: `${missing} is not exposed by ${endpoint.value.displayName}; update the source AppJamatV3` })
          }
        }
        if (plan.request.operation === 'sessions.create' && args.option('--account') !== null) {
          const selected = args.option('--account')!
          const requestedAgent = plan.request.body.spec.agent
          if (!requestedAgent) throw new AppClientCliError('invalid-request', '--account requires --agent')
          const listing = this.request('accounts.list', {}, this.deps.requestId())
          const response = remoteEndpointId === null ? await client.execute(listing) : await client.executeRemote(remoteEndpointId, listing)
          if (response.ok) {
            if (!Array.isArray(response.value)) throw new AppClientCliError('invalid-request', 'Invalid accounts response')
            const candidates = response.value.filter((value: unknown) => JsonShape.isRecord(value)
              && value.agentId === requestedAgent.agentId && (value.accountId === selected || value.label === selected))
            const exact = candidates.filter(value => value.accountId === selected)
            const match = exact.length === 1 ? exact : candidates
            if (match.length !== 1 || typeof match[0].accountId !== 'string')
              throw new AppClientCliError('invalid-request', `Account not found or ambiguous: ${selected}`)
            requestedAgent.accountId = match[0].accountId
          } else if (remoteEndpointId === null || response.error.code !== 'forbidden')
            return this.finishFailure(plan, response.error)
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
        if (plan.scriptWaitMs !== undefined && response.ok)
          return await this.waitScriptRun(client, response, plan.scriptWaitMs)
        if (plan.request.operation === 'tabs.cancelCommit' && response.ok
          && !AppClientCli.closedCancel(response.value, plan.request.body.commitSessionId)) {
          if (!RemoteControlCapabilities.of(descriptor.value).includes('tabs.commitStatus'))
            return this.finishFailure(plan, { code: 'operation-failed', detail: 'The response did not confirm a closed, cancelled review; check the same review before reopening' })
          return await this.confirmCancel(client, plan, response, plan.request.body.commitSessionId)
        }
        const worktree = (plan.request.operation === 'sessions.worktree' || plan.request.operation === 'sessions.finishWorktree') && response.ok ? JsonShape.record(response.value) : null
        const view = JsonShape.record(worktree?.worktreeView)
        this.write(worktree !== null && typeof view?.summary === 'string'
          ? { ...response, value: { ...worktree, lifecycle: view.summary } } : response)
        return AppClientCli.exitCode(response.ok ? null : response.error.code)
      } else if (plan.kind === 'local') {
        const response = await client.executeLocal(plan.request)
        this.write(response)
        return AppClientCli.exitCode(response.ok ? null : response.error.code)
      } else if (plan.kind === 'operation') {
        const catalog = await this.catalog(client, descriptor.value, plan.request)
        if (!catalog.ok) return this.finishFailure(plan, catalog.error)
        const name = plan.name
        const entry = catalog.value.find((candidate) => candidate.name === name)
        if (entry === undefined)
          return this.finishFailure(plan, { code: 'not-found', detail: `No operation ${JSON.stringify(plan.name)}` })
        this.write({ ...AppClientCli.answerIds(plan.request), ok: true, value: entry })
        return 0
      } else if (plan.kind === 'call') {
        const catalog = await this.catalog(client, descriptor.value, this.request('system.operations', {}, this.deps.requestId()))
        if (!catalog.ok) return this.finishFailure(plan, catalog.error)
        const operation = plan.operation
        const entry = catalog.value.find((candidate) => candidate.name === operation)
        if (entry === undefined)
          return this.finishFailure(plan, { code: 'not-found', detail: `No operation ${JSON.stringify(plan.operation)}` })
        if (entry.kind === 'read' && plan.operationId !== null)
          return this.finishFailure(plan, { code: 'invalid-request', detail: `${plan.operation} reads; --operation-id is for a write` })
        const request = {
          protocol: RemoteControlConst.protocol,
          requestId: plan.requestId,
          operation: plan.operation,
          ...(entry.kind === 'write' ? { operationId: plan.operationId ?? this.deps.operationId() } : {}),
          body: plan.body,
        } as RemoteControlRequestUnion
        const response = await client.execute(request)
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

  private passPlan(args: CliArguments): AppClientCliPlan {
    const directory = args.required('--pass')
    const kind = args.required('--kind')
    const allowed: Record<string, string[]> = { started: ['--agent', '--pp-version', '--trail'], working: [],
      note: ['--note-file'], done: ['--outcome', '--waiting', '--detail-file', '--note-file', '--report-file'] }
    if (!Object.hasOwn(allowed, kind)) throw new AppClientCliError('invalid-request', `Unknown event kind ${kind}`)
    for (const flag of ['--agent', '--pp-version', '--trail', '--outcome', '--waiting', '--detail-file', '--note-file', '--report-file'])
      if (args.option(flag) !== null && !allowed[kind]!.includes(flag))
        throw new AppClientCliError('invalid-request', `${flag} is not valid for ${kind}`)
    const file = (flag: string, required: boolean): string | undefined => {
      const path = required ? args.required(flag) : args.option(flag)
      if (path === null) return undefined
      try {
        if (statSync(path).size > 65_536) throw new Error(`${flag} exceeds 64 KiB`)
        return readFileSync(path, 'utf8')
      } catch (error) { throw new AppClientCliError('invalid-request', ErrorText.of(error)) }
    }
    let event: unknown
    if (kind === 'started') event = { kind, at: this.deps.now(), agent: args.option('--agent') ?? undefined,
      ppVersion: args.option('--pp-version') ?? undefined, trail: args.option('--trail') ?? undefined }
    else if (kind === 'working') event = { kind, at: this.deps.now() }
    else if (kind === 'note') event = { kind, at: this.deps.now(), note: file('--note-file', true) }
    else if (kind === 'done') event = { kind, at: this.deps.now(), outcome: args.required('--outcome'),
      waiting: args.option('--waiting') ?? undefined, detail: file('--detail-file', true),
      note: file('--note-file', false), report: file('--report-file', false) }
    else throw new Error(`Unknown event kind ${kind}`)
    try { return { kind: 'pass', directory, event: PassInbox.validateEvent(event) } }
    catch (error) { throw new AppClientCliError('invalid-request', ErrorText.of(error)) }
  }

  private async runPass(plan: Extract<AppClientCliPlan, { kind: 'pass' }>): Promise<number> {
    let inbox: PassInbox
    try { inbox = await PassInbox.open(plan.directory) }
    catch (error) {
      this.write({ ok: false, error: { code: 'pass-refused', detail: ErrorText.of(error) } })
      return 3
    }
    if (!plan.event) {
      this.write({ ok: true, value: await inbox.brief() })
      return 0
    }
    let stored: number
    try { stored = await inbox.append(plan.event) }
    catch (error) {
      this.write({ ok: false, error: { code: 'write-failed', detail: ErrorText.of(error) } })
      return 5
    }
    let delivered = false
    try {
      const descriptor = await this.deps.discover({ configDir: null, identity: null,
        configIdentity: inbox.identity, runtimeChannel: inbox.channel })
      if (descriptor.ok && descriptor.value.configIdentity === inbox.identity && descriptor.value.runtimeChannel === inbox.channel) {
        const operation: string = 'snapins.passWake'
        const answer = await this.deps.client(descriptor.value).execute({ protocol: RemoteControlConst.protocol,
          requestId: this.deps.requestId(), operationId: this.deps.operationId(), operation,
          body: { passDirectory: inbox.directory } } as unknown as RemoteControlRequestUnion)
        delivered = answer.ok
      }
    } catch { delivered = false }
    this.write({ ok: true, value: { stored, delivered } })
    return 0
  }

  private plan(args: CliArguments): AppClientCliPlan {
    if (args.command === 'snapins pass brief') return { kind: 'pass', directory: args.required('--pass') }
    if (args.command === 'snapins pass event') return this.passPlan(args)
    if (args.command === 'commit-svn-jamat') return this.commitPlan(args, 'svn')
    else if (args.command === 'commit-git-jamat') return this.commitPlan(args, 'git')
    else if (args.command === 'commit status') {
      const id = this.commitId(args)
      return { kind: 'commit-status', id, wait: args.has('--wait'), timeoutMs: this.commitTimeout(args) }
    }
    if (args.command === 'operations get')
      return {
        kind: 'operation',
        request: this.request('system.operations', {}, this.deps.requestId()),
        name: args.required('--operation'),
      }
    if (args.command === 'call') {
      const bodyText = args.option('--body')
      const bodyFile = args.option('--body-file')
      let body: unknown = {}
      if (bodyText !== null)
        try { body = JSON.parse(bodyText) } catch (error) {
          throw new AppClientCliError('invalid-request', `--body is not JSON: ${ErrorText.of(error)}`)
        }
      else if (bodyFile !== null) body = this.deps.readJson(bodyFile)
      return {
        kind: 'call',
        operation: args.required('--operation'),
        body,
        requestId: this.deps.requestId(),
        operationId: args.option('--operation-id'),
      }
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
    else if (args.command === 'operations list')
      return this.requestPlan(args, this.request('system.operations', {}, requestId))
    else if (args.command === 'calls list')
      return this.requestPlan(args, this.request('system.calls', {}, requestId))
    else if (args.command === 'events poll') {
      const after = args.integer('--after', 0, Number.MAX_SAFE_INTEGER)
      const waitMs = args.integer('--wait-ms', 0, 30_000)
      return this.requestPlan(args, this.request('system.events', {
        ...(after === undefined ? {} : { after }),
        ...(waitMs === undefined ? {} : { waitMs }),
      }, requestId))
    }
    else if (args.command === 'projects list') {
      const categoryId = args.option('--category-id')
      const sort = args.option('--sort')
      if (sort !== null && sort !== 'alpha' && sort !== 'recent')
        throw new AppClientCliError('invalid-request', '--sort must be alpha or recent')
      return this.requestPlan(args, this.request('projects.list', {
          ...(categoryId === null ? {} : { categoryId }),
          ...(sort === null ? {} : { sort }),
        }, requestId))
    } else if (args.command === 'accounts list')
      return this.requestPlan(args, this.request('accounts.list', {}, requestId))
    else if (args.command === 'sessions list')
      return this.requestPlan(args, this.request('sessions.list', {}, requestId))
    else if (args.command === 'sessions create') {
      const group = AppClientCli.groupOf(args.option('--group'))
      return this.requestPlan(args, this.request(
          'sessions.create',
          {
            spec: this.sessionSpec(args),
            ...(args.has('--open-tab') ? { openTab: true } : {}),
            ...(group === null ? {} : { group }),
          },
          requestId,
          this.operationId(args),
        ))
    } else if (args.command === 'sessions reopen')
      return this.requestPlan(args, this.request(
          'sessions.reopen',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions finalize') {
      const expect = args.option('--expect')
      if (expect !== null && expect !== 'stop')
        throw new AppClientCliError('invalid-request', '--expect must be stop')
      const acknowledgeSetup = args.option('--acknowledge-setup')
      return this.requestPlan(args, this.request(
          'sessions.finalize',
          {
            session: this.selector(args),
            ...(expect === null ? {} : { expect }),
            ...(acknowledgeSetup === null ? {} : { acknowledgeSetup }),
          },
          requestId,
          this.operationId(args),
        ))
    } else if (args.command === 'sessions worktree')
      return this.requestPlan(args, this.request(
          'sessions.worktree',
          { session: this.selfOrSelector(args) },
          requestId,
        ))
    else if (args.command === 'sessions sync')
      return this.requestPlan(args, this.request('sessions.sync', { session: this.selfOrSelector(args) }, requestId, this.operationId(args)))
    else if (args.command === 'sessions conflicts')
      return this.requestPlan(args, this.request('sessions.conflicts', { session: this.selfOrSelector(args) }, requestId))
    else if (args.command === 'sessions resolve-conflict') {
      const option = args.required('--option')
      if (option !== 'merged' && option !== 'take-incoming' && option !== 'keep-mine' && option !== 'keep-both' && option !== 'union')
        throw new AppClientCliError('invalid-request', '--option must be merged, take-incoming, keep-mine, keep-both or union')
      const kind = args.option('--kind')
      if (kind !== null && kind !== 'text' && kind !== 'property' && kind !== 'tree' && kind !== 'diverged')
        throw new AppClientCliError('invalid-request', '--kind must be text, property, tree or diverged')
      return this.requestPlan(args, this.request(
          'sessions.resolveConflict',
          { session: this.selfOrSelector(args), path: args.required('--path'), ...kind === null ? {} : { kind }, option },
          requestId,
          this.operationId(args),
        ))
    }
    else if (args.command === 'sessions back-to-work')
      return this.requestPlan(args, this.request('sessions.backToWork', { session: this.selfOrSelector(args) }, requestId, this.operationId(args)))
    else if (args.command === 'sessions solve-with-agent')
      return this.requestPlan(args, this.request('sessions.solveWithAgent', { session: this.selector(args) }, requestId, this.operationId(args)))
    else if (args.command === 'sessions remove')
      return this.requestPlan(args, this.request(
          'sessions.remove',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions discard-worktree')
      return this.requestPlan(args, this.request(
          'sessions.discardWorktree',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions retry-setup') {
      const acknowledgeSetup = args.option('--acknowledge-setup')
      return this.requestPlan(args, this.request(
          'sessions.retrySetup',
          { session: this.selector(args), ...(acknowledgeSetup === null ? {} : { acknowledgeSetup }) },
          requestId,
          this.operationId(args),
        ))
    } else if (args.command === 'sessions finish-worktree') {
      const choice = args.required('--choice')
      if (choice !== 'commit' && choice !== 'discard' && choice !== 'keep')
        throw new AppClientCliError('invalid-request', '--choice must be commit, discard or keep')
      if (args.has('--agent') && choice !== 'commit')
        throw new AppClientCliError('invalid-request', '--agent goes with --choice commit: it starts the merger for the conflicts that are left')
      if (args.has('--refresh-preparation') && (choice !== 'commit' || args.has('--agent')))
        throw new AppClientCliError('invalid-request', '--refresh-preparation goes with --choice commit and does not start a conflict resolver')
      const acknowledgeSetup = args.option('--acknowledge-setup')
      return this.requestPlan(args, this.request(
          'sessions.finishWorktree',
          {
            session: this.selfOrSelector(args),
            choice,
            ...(acknowledgeSetup === null ? {} : { acknowledgeSetup }),
            ...(args.has('--confirm-working') ? { confirmWorking: true as const } : {}),
            ...(args.has('--refresh-preparation') ? { refreshPreparation: true as const } : {}),
            ...(args.has('--agent') ? { agent: true as const } : {}),
          },
          requestId,
          this.operationId(args),
        ))
    } else if (args.command === 'sessions update-main') {
      const confirmLive = args.option('--confirm-live')
      return this.requestPlan(args, this.request(
          'sessions.updateMain',
          {
            session: this.selfOrSelector(args),
            ...(confirmLive === null ? {} : { confirmLive: confirmLive.split(',').map((id) => id.trim()).filter((id) => id !== '') }),
          },
          requestId,
          this.operationId(args),
        ))
    } else if (args.command === 'sessions notifies') {
      const sessionId = args.option('--session-id')
      return this.requestPlan(args, this.request('sessions.notifies', {
        ...(sessionId === null ? {} : { sessionId }),
      }, requestId))
    } else if (args.command === 'sessions children')
      return this.requestPlan(args, this.request('sessions.children', { sessionId: args.required('--session-id') }, requestId))
    else if (args.command === 'sessions worktree-results') {
      const tag = args.option('--tag')
      const sessionId = args.option('--session-id')
      return this.requestPlan(args, this.request(
          'sessions.worktreeResults',
          {
            ...(tag === null ? {} : { tag }),
            ...(sessionId === null ? {} : { sessionId }),
            ...(args.has('--unacknowledged') ? { unacknowledged: true as const } : {}),
          },
          requestId,
        ))
    } else if (args.command === 'sessions acknowledge-worktree-result')
      return this.requestPlan(args, this.request(
          'sessions.acknowledgeWorktreeResult',
          { actionId: args.required('--action-id') },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions cleanup-worktree')
      return this.requestPlan(args, this.request(
          'sessions.cleanupWorktree',
          { session: this.selector(args) },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions color')
      return this.requestPlan(args, this.request(
          'sessions.color',
          {
            session: this.selector(args),
            color: AppClientCli.colorNamed(args.required('--color')),
          },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions group')
      return this.requestPlan(args, this.request(
          'sessions.group',
          {
            session: this.selector(args),
            group: AppClientCli.groupNamed(args.required('--group')),
          },
          requestId,
          this.operationId(args),
        ))
    else if (args.command === 'sessions note') {
      const note = args.option('--note')
      const clear = args.has('--clear')
      if (note !== null && clear)
        throw new AppClientCliError('invalid-request', '--note and --clear cannot be used together')
      if (note === null && !clear)
        return this.requestPlan(args, this.request(
          'sessions.note',
          { session: this.selfOrSelector(args) },
          requestId,
        ))
      return this.requestPlan(args, this.request(
        'sessions.setNote',
        { session: this.selfOrSelector(args), note: clear ? null : note },
        requestId,
        this.operationId(args),
      ))
    }
    else if (args.command === 'sessions transcript')
      return this.requestPlan(args, this.request(
          'sessions.transcript',
          { session: this.selector(args) },
          requestId,
        ))
    else if (args.command === 'sessions scripts') {
      const runId = args.option('--run-id')
      return this.requestPlan(args, this.request(
          'sessions.scripts',
          { session: this.selfOrSelector(args), ...(runId === null ? {} : { runId }) },
          requestId,
        ))
    } else if (args.command === 'sessions scripts run') {
      const wait = args.has('--wait')
      if (args.option('--timeout-ms') !== null && !wait)
        throw new AppClientCliError('invalid-request', '--timeout-ms requires --wait for sessions scripts run')
      const timeoutMs = args.integer('--timeout-ms', 1, ScriptRunReader.timeoutMaximumMillisecondsConst)
        ?? ScriptRunReader.timeoutMillisecondsConst
      const cwd = args.option('--cwd')
      const title = args.option('--title')
      return {
        ...this.requestPlan(args, this.request(
          'sessions.runScript',
          {
            session: this.selfOrSelector(args),
            command: args.required('--command'),
            ...(cwd === null ? {} : { cwd }),
            ...(title === null ? {} : { title }),
          },
          requestId,
          this.operationId(args),
        )),
        ...(wait ? { scriptWaitMs: timeoutMs } : {}),
      }
    } else if (args.command === 'commit cancel')
      return this.requestPlan(args, this.request('tabs.cancelCommit',
        { commitSessionId: this.commitId(args) }, requestId, this.operationId(args)))
    else if (args.command === 'commit propose') {
      if (!args.has('--self'))
        throw new AppClientCliError('invalid-request', 'commit propose is the command of a worker and needs --self')
      const messageFile = args.option('--message-file')
      const message = messageFile === null ? args.option('--message') : this.deps.readMessage(messageFile)
      if (message === null) throw new AppClientCliError('invalid-request', 'commit propose needs --message or --message-file')
      if (!message.trim()) throw new AppClientCliError('invalid-request', 'The proposed commit message is empty')
      return this.requestPlan(args, this.request(
          'sessions.proposeCommit',
          { session: this.selfOrSelector(args), message: CommitMessageFile.validate(message), ...(args.option('--directory') === null ? {} : { directory: args.option('--directory')! }) },
          requestId,
          this.operationId(args),
        ))
    }
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
          { session: this.selfOrSelector(args), path: args.required('--path') },
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
    } else if (args.command === 'terminal deliver') {
      const readyTimeoutMs = args.integer(
        '--ready-timeout-ms',
        RemoteControlDeliverConst.readyTimeoutMinimumMillisecondsConst,
        RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst,
      ) ?? RemoteControlDeliverConst.readyTimeoutMillisecondsConst
      const submitTimeoutMs = args.integer(
        '--submit-timeout-ms',
        RemoteControlDeliverConst.submitTimeoutMinimumMillisecondsConst,
        RemoteControlDeliverConst.submitTimeoutMaximumMillisecondsConst,
      ) ?? RemoteControlDeliverConst.submitTimeoutMillisecondsConst
      return {
        ...this.requestPlan(args, this.request('terminal.deliver', {
          session: this.selector(args),
          text: args.required('--text'),
          ...(args.has('--typed') ? { input: 'typed' as const } : {}),
          readyTimeoutMs,
          submitTimeoutMs,
          ...(args.has('--queue') ? { queue: true } : {}),
        }, requestId, this.operationId(args))),
        // The host may spend ready + compose + submit before it answers, which can outlast the
        // client's 65 s default; 5 s covers the round trip itself.
        clientTimeoutMs: readyTimeoutMs + RemoteControlDeliverConst.composeTimeoutMillisecondsConst
          + submitTimeoutMs + AppClientCli.deliverMarginMillisecondsConst,
      }
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
    const pathsFile = args.option('--paths-file')
    let paths: RemoteControlCommitPath[] | undefined
    if (pathsFile !== null) {
      const input = this.deps.readJson(pathsFile)
      if (scope !== null || !Array.isArray(input) || input.length === 0 || input.length > 2_000)
        throw new AppClientCliError('invalid-request', '--paths-file must contain a JSON array of 1 to 2000 paths and cannot be combined with --path')
      paths = input.map((entry: unknown) => {
        const target = JsonShape.record(entry)
        const path = typeof entry === 'string' ? entry : target?.path
        // Exact keys: a misspelled depth must never fall back to a whole directory.
        if (typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path)
          || (typeof entry !== 'string' && (target === null || Object.keys(target).length !== 2
            || (target.depth !== 'empty' && target.depth !== 'infinity'))))
          throw new AppClientCliError('invalid-request', '--paths-file entries must be literal paths or { "path": "...", "depth": "empty" | "infinity" }')
        const absolute = resolve(this.deps.cwd(), path)
        return typeof entry === 'string' ? absolute : { path: absolute, depth: target?.depth as 'empty' | 'infinity' }
      })
    }
    const fallback = args.option('--fallback') ?? 'tortoise'
    if (fallback !== 'tortoise' && fallback !== 'report') throw new AppClientCliError('invalid-request', '--fallback must be tortoise or report')
    return { kind: 'commit', args, vcs, selector, scope, workingDirectory: args.option('--working-directory'), message, messageFile, fallback,
      ...(paths === undefined ? {} : { paths }),
      wait: args.has('--wait'), timeoutMs: this.commitTimeout(args),
      requestId: this.deps.requestId(), operationId: this.operationId(args) }
  }

  private commitId(args: CliArguments): string {
    const id = args.required('--commit-session-id')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new AppClientCliError('invalid-request', '--commit-session-id must be a UUID')
    return id
  }

  private async runCommit(plan: CommitPlan): Promise<number> {
    const config = this.deps.loadConfig(plan.args)
    const descriptor = await this.deps.discover(config)
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
    if (plan.wait && !RemoteControlCapabilities.of(descriptor.value).includes('tabs.commitStatus'))
      return this.finishFailure(plan, { code: 'unavailable', detail: 'tabs.commitStatus is not exposed by this AppClientUI; update Jamat before waiting for native review' })
    const response = await client.execute(this.request('tabs.openCommit', {
      session: canonical.value, vcs: plan.vcs,
      ...(plan.scope === null ? {} : { scope: plan.scope }), ...(plan.message === null ? {} : { message: plan.message }),
      ...(plan.paths === undefined ? {} : { paths: plan.paths }),
    }, plan.requestId, plan.operationId))
    if (response.ok && plan.wait) {
      const opened = JsonShape.record(response.value)
      if (opened?.kind !== 'commit-opened' || typeof opened.commitSessionId !== 'string')
        return this.finishFailure(plan, { code: 'operation-failed', detail: 'The commit opened without a trackable UUID; its outcome is unknown' })
      return this.readCommitStatus(client, opened.commitSessionId, true, plan.timeoutMs, config)
    }
    this.write(response)
    return AppClientCli.exitCode(response.ok ? null : response.error.code)
  }

  private commitTimeout(args: CliArguments): number {
    if (args.option('--timeout-ms') !== null && !args.has('--wait'))
      throw new AppClientCliError('invalid-request', '--timeout-ms requires --wait for commit commands')
    return args.integer('--timeout-ms', 1, CommitStatusReader.timeoutMillisecondsConst) ?? CommitStatusReader.timeoutMillisecondsConst
  }

  private static closedCancel(value: unknown, id: string): boolean {
    return CommitStatusReader.valid(value, id) && value.state === 'cancelled' && value.closed
  }

  /**
   * The cancel answer can carry the review as it was before its window closed, and the closed,
   * cancelled state follows a moment later. Read the same review until it closes, within a bound,
   * instead of reporting a cancel that did happen as failed.
   */
  private async confirmCancel(client: AppClientCliClientPort, plan: Extract<AppClientCliPlan, { kind: 'request' }>,
    answer: RemoteControlResponse, id: string): Promise<number> {
    const reader = new CommitStatusReader({
      read: signal => client.execute(this.request('tabs.commitStatus', { commitSessionId: id }, this.deps.requestId()), signal),
      now: this.deps.now, pause: this.deps.pause,
    })
    let status: RemoteControlResponse
    try {
      status = await reader.read(id, true, AppClientCli.cancelCloseWaitMsConst, this.deps.signal)
    } catch (error) {
      return this.finishFailure(plan, { code: 'operation-failed',
        detail: `The review did not close as cancelled within ${AppClientCli.cancelCloseWaitMsConst / 1_000} s; check it with commit status before reopening: ${ErrorText.of(error)}` })
    }
    if (!status.ok) return this.finishFailure(plan, status.error)
    if (AppClientCli.closedCancel(status.value, id)) {
      this.write({ ...answer, value: status.value })
      return 0
    }
    const state = CommitStatusReader.valid(status.value, id) ? status.value.state : 'unknown'
    return this.finishFailure(plan, { code: 'operation-failed',
      detail: `The review closed as ${state}, not cancelled; check it with commit status before reopening` })
  }

  /**
   * A restarted client listens on a new port with a new token, so an `unavailable` answer discovers it
   * again; the review it restores keeps its UUID, and the next read reaches it there.
   */
  private async readCommitStatus(client: AppClientCliClientPort, id: string, wait: boolean, timeoutMs: number, config: AppConfig): Promise<number> {
    let current = client
    const reader = new CommitStatusReader({
      read: async (signal) => {
        const answer = await current.execute(this.request('tabs.commitStatus', { commitSessionId: id }, this.deps.requestId()), signal)
        if (answer.ok || answer.error.code !== 'unavailable') return answer
        const descriptor = await this.deps.discover(config)
        if (descriptor.ok) current = this.deps.client(descriptor.value)
        return answer
      },
      now: this.deps.now, pause: this.deps.pause,
    })
    const response = await reader.read(id, wait, timeoutMs, this.deps.signal)
    this.write(response)
    return AppClientCli.exitCode(response.ok ? null : response.error.code)
  }

  private async finishAside(plan: CommitPlan, reason: CommitAsideRequest['reason'], scope = resolve(this.deps.cwd(), plan.scope ?? '.')): Promise<number> {
    if (plan.fallback === 'report') {
      this.write({ ok: true, value: { kind: 'fallback-required', reason, scope,
        ...(plan.paths === undefined ? {} : { paths: plan.paths }) } })
      return 0
    } else if (plan.fallback !== 'tortoise') throw new Error(`Unknown commit fallback: ${JSON.stringify(plan.fallback)}`)
    // Tortoise has no depth per target, so it would open the directory with its subtree.
    if (plan.paths?.some((path) => typeof path !== 'string' && path.depth === 'empty'))
      return this.finishFailure(plan, { code: 'invalid-request', detail: 'Tortoise cannot keep a directory to its own node; open this review in Jamat' })
    const messageFile = plan.messageFile === null
      ? plan.message === null ? null : await this.deps.writeMessageFile(plan.message)
      : resolve(this.deps.cwd(), plan.messageFile)
    const result = await this.deps.aside.open({ vcs: plan.vcs, scope, messageFile, reason,
      ...(plan.paths === undefined ? {} : { paths: plan.paths.map((path) => typeof path === 'string' ? path : path.path) }) })
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
    if (computer !== null && request.operation === 'sessions.create' && request.body.spec.notify !== undefined)
      throw new AppClientCliError('invalid-request', '--notify-* options are local only and cannot be used with --computer')
    if (computer !== null && args.has('--self'))
      throw new AppClientCliError('invalid-request', '--self belongs to this computer; name the source session explicitly with --session-id')
    if (computer !== null && (args.option('--acknowledge-setup') !== null || args.has('--confirm-working') || args.option('--confirm-live') !== null))
      throw new AppClientCliError('invalid-request', 'Human agreements must be confirmed in the source Session actions view')
    if (computer !== null
      && request.operation === 'sessions.create'
      && args.has('--open-tab'))
      throw new AppClientCliError(
        'invalid-request',
        '--open-tab is a local UI option and cannot be used with --computer',
      )
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
      && [mode, nativeSessionId, forkParentId, initialPrompt, args.option('--account')].some((value) => value !== null))
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
    const owner = args.option('--worktree-owner')
    if (owner !== null && worktree === null)
      throw new AppClientCliError('invalid-request', '--worktree-owner requires --worktree')
    if (owner !== null && !owner.trim())
      throw new AppClientCliError('invalid-request', '--worktree-owner cannot be empty')
    const removeWhenEnded = args.has('--worktree-remove-when-ended')
    if (removeWhenEnded && worktree === null)
      throw new AppClientCliError('invalid-request', '--worktree-remove-when-ended requires --worktree')
    const tag = args.option('--worktree-tag')
    if (tag !== null && worktree === null)
      throw new AppClientCliError('invalid-request', '--worktree-tag requires --worktree')
    const notifySession = args.option('--worktree-notify-session')
    const notifyText = args.option('--worktree-notify-text')
    if ((notifySession === null) !== (notifyText === null))
      throw new AppClientCliError('invalid-request', '--worktree-notify-session and --worktree-notify-text must be provided together')
    if (notifySession !== null && worktree === null)
      throw new AppClientCliError('invalid-request', '--worktree-notify-session requires --worktree')
    const sessionNotifyTarget = args.option('--notify-session')
    const sessionNotifyText = args.option('--notify-text')
    const sessionNotifyGroups = args.option('--notify-on-group')
    if ((sessionNotifyTarget === null) !== (sessionNotifyText === null))
      throw new AppClientCliError('invalid-request', '--notify-session and --notify-text must be provided together')
    if (sessionNotifyGroups !== null && sessionNotifyTarget === null)
      throw new AppClientCliError('invalid-request', '--notify-on-group requires --notify-session and --notify-text')
    const parentSession = args.option('--parent-session')
    const parentKind = args.option('--parent-kind')
    if ((parentSession === null) !== (parentKind === null))
      throw new AppClientCliError('invalid-request', '--parent-session and --parent-kind must be provided together')
    const title = args.option('--title')
    const number = AppClientCli.customNumberOf(args.option('--number'))
    const color = AppClientCli.colorOf(args.option('--color'))
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
        worktree: {
          slug: worktree,
          ...(baseRef === null ? {} : { baseRef }),
          ...(owner === null ? {} : { owner: resolve(this.deps.cwd(), owner) }),
          ...(removeWhenEnded ? { removeWhenEnded: true as const } : {}),
          ...(tag === null ? {} : { tag }),
          ...(notifySession === null || notifyText === null ? {} : { notify: { sessionId: notifySession, text: notifyText } }),
        },
      }),
      ...(sessionNotifyTarget === null || sessionNotifyText === null ? {} : {
        notify: {
          sessionId: sessionNotifyTarget,
          text: sessionNotifyText,
          onGroups: sessionNotifyGroups === null ? [] : sessionNotifyGroups.split(',').map((id) => id.trim()),
        },
      }),
      ...(parentSession === null || parentKind === null ? {} : {
        parent: { sessionId: parentSession, kind: AppClientCli.parentKindOf(parentKind) },
      }),
      ...(title === null ? {} : { title }),
      ...(number === null ? {} : { number }),
      ...(color === null ? {} : { color }),
      ...(flowId === null ? {} : { flowId }),
      ...(acknowledgeSetup === null ? {} : { acknowledgeSetup }),
    }
  }

  /**
   * Refused here as well as at the target, for the reason `--agent` and `--mode` are: the spec this
   * method returns is TYPED, so a name that reached it unproven would be a cast. The list is the
   * library's own, so the local refusal and the remote one can never name different colours.
   */
  private static colorOf(value: string | null): SessionColorName | null {
    return value === null ? null : AppClientCli.colorNamed(value)
  }

  /**
   * The number a create may BRING, which is not the number a selector says: `--number` picks a
   * session everywhere else and names one here, and the two grammars differ on purpose. Selecting
   * matches whatever is in the slot, including the `014` the answering computer handed out;
   * bringing one may only be the custom shape, because an allocated number is that computer's to
   * give. Refused here as well as at the target, for the reason `--color` is: the spec this
   * method feeds is TYPED, and a shape that reached it unproven would be a cast.
   */
  private static customNumberOf(value: string | null): string | null {
    if (value === null) return null
    if (!SessionTitle.isCustomNumber(value))
      throw new AppClientCliError(
        'invalid-request',
        '--number on a create must be one to three letters then up to six digits, such as i34. '
        + "A session's own number is given by the computer that keeps the project's count",
      )
    return value
  }

  /** The same list where the colour is the whole request rather than one field of a create. */
  private static colorNamed(value: string): SessionColorName {
    if (!SessionColors.isName(value))
      throw new AppClientCliError(
        'invalid-request',
        `--color must be one of ${SessionColors.namesConst.join(', ')}`,
      )
    return value
  }

  private static readonly parentKindsConst: readonly SessionParentKind[] = ['worktree', 'ticket', 'worker']

  private static parentKindOf(value: string): SessionParentKind {
    const kind = AppClientCli.parentKindsConst.find((known) => known === value)
    if (kind === undefined)
      throw new AppClientCliError('invalid-request', `--parent-kind must be one of ${AppClientCli.parentKindsConst.join(', ')}`)
    return kind
  }

  /**
   * Only the SHAPE, unlike `colorOf` above, and the difference is the whole of what changed on
   * 2026-09-22. The palette is fixed, so this parser can name every colour it will take. The groups
   * are sections a person made on the computer that will answer, and that computer may not be this
   * one, so a parser listing groups here would be listing somebody else's. A well-formed id that the
   * target does not have comes back as `invalid-request` naming the groups it does have.
   */
  private static groupOf(value: string | null): SessionGroup | null {
    return value === null ? null : AppClientCli.groupNamed(value)
  }

  private static groupNamed(value: string): SessionGroup {
    if (!SessionGroups.isId(value))
      throw new AppClientCliError('invalid-request', `--group is invalid: ${SessionGroups.idRuleConst}`)
    return value
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
    if (number !== null && SessionTitle.isSelectorNumber(number)) return { kind: 'number', number }
    throw new AppClientCliError(
      'invalid-request',
      '--number must be a session number such as 014, a custom number such as i34, or two such '
      + 'parts separated by a hyphen',
    )
  }

  /** `--self` is the session whose terminal runs this CLI, named by the variable Jamat gave it. */
  private selfOrSelector(args: CliArguments): RemoteControlSessionSelector {
    if (!args.has('--self')) return this.selector(args)
    const self = SelfSession.of(this.deps.env)
    if (self === null)
      throw new AppClientCliError('invalid-request', `--self needs JAMAT_V3_SESSION_ID, which only a Jamat session's terminal has; name the session for ${args.command}`)
    return { kind: 'sessionId', sessionId: self.sessionId }
  }

  private async waitScriptRun(
    client: AppClientCliClientPort,
    started: Extract<RemoteControlResponse, { ok: true }>,
    timeoutMs: number,
  ): Promise<number> {
    const value = JsonShape.record(started.value)
    const sessionId = value?.sessionId
    const runId = value?.runId
    if (typeof sessionId !== 'string' || typeof runId !== 'string')
      throw new AppClientCliError('operation-failed', 'The run started without a run id; read sessions scripts for its outcome')
    const verdict = await new ScriptRunReader({
      read: () => client.execute(this.request('sessions.scripts', {
        session: { kind: 'sessionId', sessionId },
        runId,
      }, this.deps.requestId())),
      now: this.deps.now,
      pause: this.deps.pause,
    }).read(runId, timeoutMs, this.deps.signal)
    const ids = {
      protocol: started.protocol,
      requestId: started.requestId,
      operation: started.operation,
      operationId: started.operationId,
    }
    this.write(verdict.ok ? { ...ids, ok: true, value: verdict.value } : { ...ids, ok: false, error: verdict.error })
    return AppClientCli.exitCode(verdict.ok ? null : verdict.error.code)
  }

  private async canonicalRequest(
    client: AppClientCliClientPort,
    remoteEndpointId: string | null,
    request: RemoteControlRequestUnion,
    workingDirectory: string | null,
  ): Promise<RemoteControlStepResult<RemoteControlRequestUnion>> {
    if (request.operation === 'sessions.reopen'
      || request.operation === 'sessions.finalize'
      || request.operation === 'sessions.worktree'
      || request.operation === 'sessions.sync'
      || request.operation === 'sessions.conflicts'
      || request.operation === 'sessions.resolveConflict'
      || request.operation === 'sessions.solveWithAgent'
      || request.operation === 'sessions.backToWork'
      || request.operation === 'sessions.remove'
      || request.operation === 'sessions.discardWorktree'
      || request.operation === 'sessions.retrySetup'
      || request.operation === 'sessions.cleanupWorktree'
      || request.operation === 'sessions.finishWorktree'
      || request.operation === 'sessions.updateMain'
      || request.operation === 'sessions.worktreeReview'
      || request.operation === 'sessions.proposeCommit'
      || request.operation === 'sessions.color'
      || request.operation === 'sessions.group'
      || request.operation === 'sessions.note'
      || request.operation === 'sessions.setNote'
      || request.operation === 'sessions.transcript'
      || request.operation === 'sessions.scripts'
      || request.operation === 'sessions.runScript'
      || request.operation === 'tabs.open'
      || request.operation === 'tabs.openFile'
      || request.operation === 'tabs.openCommit'
      || request.operation === 'terminal.peek'
      || request.operation === 'terminal.send'
      || request.operation === 'terminal.deliver') {
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
      || request.operation === 'accounts.list'
      || request.operation === 'system.status'
      || request.operation === 'system.operations'
      || request.operation === 'system.calls'
      || request.operation === 'system.events'
      || request.operation === 'projects.list'
      || request.operation === 'sessions.list'
      || request.operation === 'sessions.create'
      || request.operation === 'sessions.worktreeResults'
      || request.operation === 'sessions.notifies'
      || request.operation === 'sessions.children'
      || request.operation === 'sessions.acknowledgeWorktreeResult'
      || request.operation === 'tabs.list'
      || request.operation === 'tabs.cancelCommit'
      || request.operation === 'tabs.focus'
      || request.operation === 'tabs.close')
      return { ok: true, value: request }
    else
      throw new Error(`Unknown control request: ${JSON.stringify(request)}`)
  }

  /**
   * An option an older AppClientUI would refuse, and the operation whose capability marks a build
   * that takes it. Such a build validates the body with exact keys and refuses the whole request over
   * one it does not know, so the option is refused here by name and nothing is sent.
   */
  private static featureOf(
    request: RemoteControlRequestUnion,
  ): { option: string; operation: RemoteControlOperation } | null {
    if (request.operation === 'sessions.create' && request.body.spec.parent !== undefined)
      return { option: '--parent-session', operation: 'sessions.children' }
    if (request.operation === 'sessions.create' && request.body.spec.notify !== undefined)
      return { option: '--notify-*', operation: 'sessions.notifies' }
    if (request.operation === 'sessions.scripts') return { option: 'sessions scripts', operation: 'sessions.scripts' }
    if (request.operation === 'sessions.runScript') return { option: 'sessions scripts run', operation: 'sessions.scripts' }
    // Before `--expect`: a build that offers sessions.scripts also offers sessions.worktree.
    if (request.operation === 'sessions.finalize' && request.body.acknowledgeSetup !== undefined)
      return { option: '--acknowledge-setup', operation: 'sessions.scripts' }
    if (request.operation === 'sessions.create' && request.body.spec.worktree?.owner !== undefined)
      return { option: '--worktree-owner', operation: 'sessions.worktree' }
    if (request.operation === 'sessions.create' && request.body.spec.worktree?.removeWhenEnded !== undefined)
      return { option: '--worktree-remove-when-ended', operation: 'sessions.worktree' }
    if (request.operation === 'sessions.finalize' && request.body.expect !== undefined)
      return { option: '--expect', operation: 'sessions.worktree' }
    if (request.operation === 'sessions.create' && request.body.spec.worktree?.tag !== undefined)
      return { option: '--worktree-tag', operation: 'sessions.worktreeResults' }
    if (request.operation === 'sessions.create' && request.body.spec.worktree?.notify !== undefined)
      return { option: '--worktree-notify-session', operation: 'sessions.worktreeResults' }
    // The merger came with the conflict list: a build without `sessions.conflicts` refuses the key.
    if (request.operation === 'sessions.finishWorktree' && request.body.agent !== undefined)
      return { option: '--agent', operation: 'sessions.conflicts' }
    return null
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

  /** The catalog the call is checked against, from a target that offers it. */
  private async catalog(
    client: AppClientCliClientPort,
    descriptor: RemoteControlDescriptor,
    request: RemoteControlRequest<'system.operations'>,
  ): Promise<RemoteControlStepResult<readonly RemoteControlCatalogEntryDto[]>> {
    if (!RemoteControlCapabilities.of(descriptor).includes('system.operations'))
      return { ok: false, error: { code: 'unavailable', detail: 'system.operations is not exposed by this AppClientUI; update AppJamatV3' } }
    const response = await client.execute(request)
    if (!response.ok) return { ok: false, error: response.error }
    return { ok: true, value: (response.value as { operations: readonly RemoteControlCatalogEntryDto[] }).operations }
  }

  private static answerIds(request: { requestId: string; operation: string; operationId?: string }): {
    protocol: typeof RemoteControlConst.protocol
    requestId: string
    operation: string
    operationId: string | null
  } {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: request.requestId,
      operation: request.operation,
      operationId: request.operationId ?? null,
    }
  }

  private finishFailure(
    plan: AppClientCliPlan | null,
    error: RemoteControlError,
  ): number {
    if (plan?.kind === 'call' || plan?.kind === 'operation') {
      const ids = plan.kind === 'call'
        ? { requestId: plan.requestId, operation: plan.operation, operationId: plan.operationId }
        : AppClientCli.answerIds(plan.request)
      this.write({ protocol: RemoteControlConst.protocol, ...ids, ok: false, error })
      return AppClientCli.exitCode(error.code)
    }
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
  /**
   * The optional operations this CLI refuses BEFORE the round trip, so a Jamat that predates one
   * answers with a sentence naming it rather than a 404 the caller has to interpret. The wrapper is
   * a junction into the repository while the Jamat it talks to may be an installed older build, so
   * the two disagreeing is the ordinary case rather than the strange one.
   */
  private static readonly capabilityGatedConst: readonly RemoteControlOperation[] = [
    'system.operations',
    'system.calls',
    'system.events',
    'sessions.transcript',
    'tabs.cancelCommit',
    'sessions.color',
    'sessions.group',
    'sessions.note',
    'sessions.setNote',
    'terminal.deliver',
    'sessions.remove',
    'sessions.worktree',
    'sessions.discardWorktree',
    'sessions.retrySetup',
    'sessions.cleanupWorktree',
    'sessions.finishWorktree',
    'sessions.updateMain',
    'sessions.worktreeResults',
    'sessions.notifies',
    'sessions.children',
    'sessions.acknowledgeWorktreeResult',
    'sessions.proposeCommit',
    'sessions.sync',
    'sessions.conflicts',
    'sessions.resolveConflict',
    'sessions.solveWithAgent',
    'sessions.backToWork',
  ]

  private static readonly deliverMarginMillisecondsConst = 5_000

  /** How long `commit cancel` reads a review it cancelled before it reports that the window did not close. */
  private static readonly cancelCloseWaitMsConst = 10_000

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
