import type {
  RemoteControlDescriptor,
  RemoteControlHelloDto,
  RemoteControlRequest,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlClient } from '../../lib-orchestrator/remoteControl/remoteControlClient'
import {
  RemoteControlCandidate,
  RemoteControlDescriptorDiscovery,
  type RemoteControlDiscoveredInstance,
  type RemoteControlRejectedRegistration,
} from '../../lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlCapabilities, RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type {
  ConfigIdentityDocument,
  RuntimeChannel,
} from '../../lib-orchestrator/shared/configIdentity.types'
import { ConfigIdentityStore } from '../../lib-orchestrator/shared/configIdentityStore'

export interface LocalInstanceSelection {
  configDir?: string
  configIdentity?: string
  channel?: RuntimeChannel
}

/** Why a candidate was not selected, in safe identity facts only: never a token, port or path. */
export interface LocalInstanceRejection {
  instanceId: string
  configIdentity: string
  runtimeChannel: RuntimeChannel
  reason: 'filtered' | 'descriptor' | 'not-alive' | 'mismatch' | 'refused' | 'hello-timeout'
  /** What the probe answered, for `refused`; the seconds it had, for `hello-timeout`. */
  detail?: string
}

export interface LocalInstanceResolverDeps {
  candidates(rejected: (registration: RemoteControlRejectedRegistration) => void): readonly RemoteControlDiscoveredInstance[]
  strictDescriptor(
    configIdentity: string,
    channel: RuntimeChannel,
  ): RemoteControlStepResult<RemoteControlDescriptor>
  identity(configDir: string, channel?: RuntimeChannel): ConfigIdentityDocument | null
  probe(
    descriptor: RemoteControlDescriptor,
    signal: AbortSignal,
    timeoutMilliseconds: number,
  ): Promise<RemoteControlStepResult<RemoteControlHelloDto>>
}

export class LocalInstanceResolver {
  private static readonly probeTimeoutMillisecondsConst = 1_500
  private static readonly discoveryTimeoutMillisecondsConst = 5_000
  private static readonly probeConcurrencyConst = 16
  private static readonly candidatesMaximumConst =
    RemoteControlInstanceRegistry.entriesMaximumConst * 2
  private readonly deps: LocalInstanceResolverDeps

  constructor(deps?: Partial<LocalInstanceResolverDeps>) {
    this.deps = {
      candidates: deps?.candidates
        ?? ((rejected) => RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates(undefined, undefined, rejected)),
      strictDescriptor: deps?.strictDescriptor
        ?? ((configIdentity, channel) => RemoteControlDescriptorDiscovery.read(configIdentity, channel)),
      identity: deps?.identity ?? ((configDir, channel) => channel === undefined
        ? ConfigIdentityStore.readExisting(configDir)
        : ConfigIdentityStore.loadExisting(configDir, channel)),
      probe: deps?.probe ?? ((descriptor, signal, timeoutMilliseconds) =>
        LocalInstanceResolver.probe(descriptor, signal, timeoutMilliseconds)),
    }
  }

  /**
   * A selection that names a config identity (the session pair or `--config-identity`) and leaves one
   * candidate gives that candidate's hello the whole discovery budget, since nothing else waits on it.
   */
  async resolve(
    selection: LocalInstanceSelection,
  ): Promise<RemoteControlStepResult<RemoteControlDescriptor>> {
    if (selection.configDir !== undefined)
      return this.resolveStrictConfigDirectory(selection)
    const deadline = Date.now() + LocalInstanceResolver.discoveryTimeoutMillisecondsConst
    const abort = new AbortController()
    const deadlineTimer = setTimeout(
      () => abort.abort(),
      LocalInstanceResolver.discoveryTimeoutMillisecondsConst,
    )
    deadlineTimer.unref?.()
    const rejections: LocalInstanceRejection[] = []
    try {
      const selected = (identity: { configIdentity: string; runtimeChannel: RuntimeChannel }): boolean =>
        (selection.configIdentity === undefined || identity.configIdentity === selection.configIdentity)
        && (selection.channel === undefined || identity.runtimeChannel === selection.channel)
      const found = this.deps.candidates((registration) => {
        if (selected(registration)) rejections.push({ ...registration })
      })
      for (const { descriptor } of found)
        if (!selected(descriptor)) rejections.push(LocalInstanceResolver.rejectionOf(descriptor, 'filtered'))
      const candidates = found.filter(({ descriptor }) => selected(descriptor))
        .slice(0, LocalInstanceResolver.candidatesMaximumConst)
      if (abort.signal.aborted || Date.now() >= deadline)
        return LocalInstanceResolver.discoveryTimeout(selection, rejections)
      const probeTimeout = selection.configIdentity !== undefined && candidates.length === 1
        ? deadline - Date.now()
        : LocalInstanceResolver.probeTimeoutMillisecondsConst
      const live: RemoteControlDiscoveredInstance[] = []
      for (
        let index = 0;
        index < candidates.length;
        index += LocalInstanceResolver.probeConcurrencyConst
      ) {
        const remaining = deadline - Date.now()
        if (remaining <= 0 || abort.signal.aborted)
          return LocalInstanceResolver.discoveryTimeout(selection, rejections)
        const asked = candidates.slice(index, index + LocalInstanceResolver.probeConcurrencyConst)
        const batch = Promise.all(asked.map(async (candidate) => ({
          candidate,
          hello: await this.probe(candidate.descriptor, abort.signal, probeTimeout),
        })))
        const result = await LocalInstanceResolver.beforeDeadline(batch, remaining)
        if (result === null || abort.signal.aborted || Date.now() >= deadline) {
          for (const { descriptor } of asked)
            rejections.push(LocalInstanceResolver.rejectionOf(descriptor, 'hello-timeout', LocalInstanceResolver.secondsOf(probeTimeout)))
          return LocalInstanceResolver.discoveryTimeout(selection, rejections)
        }
        for (const { candidate, hello } of result) {
          const rejection = LocalInstanceResolver.helloRejectionOf(candidate.descriptor, hello, probeTimeout)
          if (rejection === null) live.push(candidate)
          else rejections.push(rejection)
        }
      }
      if (live.length === 1) return { ok: true, value: live[0]!.descriptor }
      if (live.length === 0)
        return LocalInstanceResolver.rejected('unavailable', `No matching running AppClientUI instance was found${
          LocalInstanceResolver.selectionText(selection)}`, rejections)
      return {
        ok: false,
        error: {
          code: 'conflict',
          detail: 'Several matching AppClientUI instances are running',
          data: {
            candidates: live.map(({ descriptor }) => RemoteControlCandidate.safeOf(descriptor)),
          },
        },
      }
    } finally {
      clearTimeout(deadlineTimer)
      abort.abort()
    }
  }

  private async resolveStrictConfigDirectory(
    selection: LocalInstanceSelection,
  ): Promise<RemoteControlStepResult<RemoteControlDescriptor>> {
    try {
      const identity = this.deps.identity(selection.configDir!, selection.channel)
      if (identity === null)
        return LocalInstanceResolver.error(
          'unavailable',
          'The selected config directory has no AppClientUI identity',
        )
      const descriptor = this.deps.strictDescriptor(
        identity.configIdentity,
        identity.runtimeChannel,
      )
      if (!descriptor.ok) return descriptor
      const hello = await this.probe(
        descriptor.value,
        AbortSignal.timeout(LocalInstanceResolver.probeTimeoutMillisecondsConst),
        LocalInstanceResolver.probeTimeoutMillisecondsConst,
      )
      const rejection = LocalInstanceResolver.helloRejectionOf(descriptor.value, hello, LocalInstanceResolver.probeTimeoutMillisecondsConst)
      if (rejection !== null)
        return LocalInstanceResolver.rejected('unavailable', 'The selected AppClientUI instance did not confirm its identity', [rejection])
      return descriptor
    } catch (error) {
      return LocalInstanceResolver.error(
        'operation-failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private static async probe(
    descriptor: RemoteControlDescriptor,
    signal: AbortSignal,
    timeoutMilliseconds: number,
  ): Promise<RemoteControlStepResult<RemoteControlHelloDto>> {
    const request: RemoteControlRequest<'system.hello'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'local-instance-probe',
      operation: 'system.hello',
      body: {},
    }
    const answer = await new RemoteControlClient(descriptor, { timeoutMilliseconds }).execute(request, signal)
    return answer.ok
      ? { ok: true, value: answer.value }
      : { ok: false, error: answer.error }
  }

  private async probe(
    descriptor: RemoteControlDescriptor,
    signal: AbortSignal,
    timeoutMilliseconds: number,
  ): Promise<RemoteControlStepResult<RemoteControlHelloDto>> {
    try { return await this.deps.probe(descriptor, signal, timeoutMilliseconds) }
    catch {
      return LocalInstanceResolver.error(
        'unavailable',
        'The AppClientUI identity probe failed',
      )
    }
  }

  /** Null when the hello confirms the descriptor's identity. */
  private static helloRejectionOf(
    descriptor: RemoteControlDescriptor,
    hello: RemoteControlStepResult<RemoteControlHelloDto>,
    timeoutMilliseconds: number,
  ): LocalInstanceRejection | null {
    if (hello.ok)
      return LocalInstanceResolver.matches(descriptor, hello.value) ? null : LocalInstanceResolver.rejectionOf(descriptor, 'mismatch')
    const code = hello.error.code
    switch (code) {
      case 'timeout':
        return LocalInstanceResolver.rejectionOf(descriptor, 'hello-timeout', LocalInstanceResolver.secondsOf(timeoutMilliseconds))
      case 'invalid-request': case 'protocol-mismatch': case 'forbidden': case 'not-found': case 'conflict':
      case 'unavailable': case 'operation-failed':
        return LocalInstanceResolver.rejectionOf(descriptor, 'refused', hello.error.detail)
      default: throw new Error(`Unknown control error code: ${JSON.stringify(code satisfies never)}`)
    }
  }

  private static rejectionOf(
    descriptor: RemoteControlDescriptor,
    reason: LocalInstanceRejection['reason'],
    detail?: string,
  ): LocalInstanceRejection {
    return {
      instanceId: descriptor.instanceId,
      configIdentity: descriptor.configIdentity,
      runtimeChannel: descriptor.runtimeChannel,
      reason,
      ...detail === undefined ? {} : { detail },
    }
  }

  private static secondsOf(milliseconds: number): string {
    return String(Math.round(milliseconds / 100) / 10)
  }

  private static selectionText(selection: LocalInstanceSelection): string {
    if (selection.configIdentity !== undefined)
      return ` for ${selection.configIdentity.slice(0, 8)}${selection.channel === undefined ? '' : ` (${selection.channel})`}`
    return selection.channel === undefined ? '' : ` for ${selection.channel}`
  }

  /** The detail lists each candidate, e.g. `37045054 (408862fc, development): did not answer system.hello within 5 s`. */
  private static rejected(
    code: 'unavailable' | 'timeout',
    detail: string,
    rejections: readonly LocalInstanceRejection[],
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    if (rejections.length === 0) return LocalInstanceResolver.error(code, detail)
    const listed = rejections.map((rejection) => `${rejection.instanceId.slice(0, 8)} (${
      rejection.configIdentity.slice(0, 8)}, ${rejection.runtimeChannel}): ${LocalInstanceResolver.wordsOf(rejection)}`)
    return { ok: false, error: { code, detail: `${detail}; ${listed.join('; ')}`, data: { rejections } } }
  }

  private static wordsOf(rejection: LocalInstanceRejection): string {
    const reason = rejection.reason
    switch (reason) {
      case 'filtered': return 'not the selected controller'
      case 'descriptor': return 'its control descriptor could not be read'
      case 'not-alive': return 'its process is gone'
      case 'mismatch': return 'answered system.hello with another identity'
      case 'refused': return `refused system.hello (${rejection.detail ?? 'no answer'})`
      case 'hello-timeout': return `did not answer system.hello within ${rejection.detail ?? '?'} s`
      default: throw new Error(`Unknown rejection reason: ${JSON.stringify(reason satisfies never)}`)
    }
  }

  private static matches(
    descriptor: RemoteControlDescriptor,
    hello: unknown,
  ): boolean {
    if (typeof hello !== 'object' || hello === null || Array.isArray(hello)) return false
    const value = hello as Partial<RemoteControlHelloDto>
    return value.protocol === descriptor.protocol
      && value.configIdentity === descriptor.configIdentity
      && value.runtimeChannel === descriptor.runtimeChannel
      && value.instanceId === descriptor.instanceId
      && value.startedAt === descriptor.startedAt
      && value.applicationVersion === descriptor.applicationVersion
      && Array.isArray(value.operations)
      && (value.optionalOperations === undefined || Array.isArray(value.optionalOperations))
      && LocalInstanceResolver.same(value.operations, descriptor.operations)
      // Compared as this build knows them: the descriptor was read the same way.
      && LocalInstanceResolver.same(
        RemoteControlCapabilities.known(value.optionalOperations ?? []),
        RemoteControlCapabilities.known(descriptor.optionalOperations ?? []),
      )
  }

  private static same(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  private static beforeDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T | null> {
    if (milliseconds <= 0) {
      void work.catch(() => undefined)
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        resolve(null)
      }, milliseconds)
      void work.then(
        (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(null)
        },
      )
    })
  }

  private static error(
    code: 'unavailable' | 'timeout' | 'operation-failed',
    detail: string,
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    return { ok: false, error: { code, detail } }
  }

  private static discoveryTimeout(
    selection: LocalInstanceSelection,
    rejections: readonly LocalInstanceRejection[],
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    return LocalInstanceResolver.rejected('timeout', `AppClientUI instance discovery exceeded its time limit${
      LocalInstanceResolver.selectionText(selection)}`, rejections)
  }
}
