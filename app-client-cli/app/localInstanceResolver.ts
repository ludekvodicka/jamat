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
} from '../../lib-orchestrator/remoteControl/remoteControlDescriptorDiscovery'
import { RemoteControlInstanceRegistry } from '../../lib-orchestrator/remoteControl/remoteControlInstanceRegistry'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
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

export interface LocalInstanceResolverDeps {
  candidates(): readonly RemoteControlDiscoveredInstance[]
  strictDescriptor(
    configIdentity: string,
    channel: RuntimeChannel,
  ): RemoteControlStepResult<RemoteControlDescriptor>
  identity(configDir: string, channel?: RuntimeChannel): ConfigIdentityDocument | null
  probe(
    descriptor: RemoteControlDescriptor,
    signal: AbortSignal,
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
        ?? (() => RemoteControlDescriptorDiscovery.registeredAndDefaultRootCandidates()),
      strictDescriptor: deps?.strictDescriptor
        ?? ((configIdentity, channel) => RemoteControlDescriptorDiscovery.read(configIdentity, channel)),
      identity: deps?.identity ?? ((configDir, channel) => channel === undefined
        ? ConfigIdentityStore.readExisting(configDir)
        : ConfigIdentityStore.loadExisting(configDir, channel)),
      probe: deps?.probe ?? ((descriptor, signal) =>
        LocalInstanceResolver.probe(descriptor, signal)),
    }
  }

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
    try {
      const candidates = this.deps.candidates()
        .filter((candidate) =>
          (selection.configIdentity === undefined
            || candidate.descriptor.configIdentity === selection.configIdentity)
          && (selection.channel === undefined
            || candidate.descriptor.runtimeChannel === selection.channel))
        .slice(0, LocalInstanceResolver.candidatesMaximumConst)
      if (abort.signal.aborted || Date.now() >= deadline)
        return LocalInstanceResolver.discoveryTimeout()
      const probed: {
        candidate: RemoteControlDiscoveredInstance
        hello: RemoteControlStepResult<RemoteControlHelloDto>
      }[] = []
      for (
        let index = 0;
        index < candidates.length;
        index += LocalInstanceResolver.probeConcurrencyConst
      ) {
        const remaining = deadline - Date.now()
        if (remaining <= 0 || abort.signal.aborted)
          return LocalInstanceResolver.discoveryTimeout()
        const batch = Promise.all(
          candidates
            .slice(index, index + LocalInstanceResolver.probeConcurrencyConst)
            .map(async (candidate) => ({
              candidate,
              hello: await this.probe(candidate.descriptor, abort.signal),
            })),
        )
        const result = await LocalInstanceResolver.beforeDeadline(batch, remaining)
        if (result === null || abort.signal.aborted || Date.now() >= deadline)
          return LocalInstanceResolver.discoveryTimeout()
        probed.push(...result)
      }
      const live = probed
        .filter((value) => value.hello.ok
          && LocalInstanceResolver.matches(value.candidate.descriptor, value.hello.value))
        .map((value) => value.candidate)
      if (live.length === 1) return { ok: true, value: live[0]!.descriptor }
      if (live.length === 0)
        return LocalInstanceResolver.error(
          'unavailable',
          'No matching running AppClientUI instance was found',
        )
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
      )
      if (!hello.ok || !LocalInstanceResolver.matches(descriptor.value, hello.value))
        return LocalInstanceResolver.error(
          'unavailable',
          'The selected AppClientUI instance did not confirm its identity',
        )
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
  ): Promise<RemoteControlStepResult<RemoteControlHelloDto>> {
    const request: RemoteControlRequest<'system.hello'> = {
      protocol: RemoteControlConst.protocol,
      requestId: 'local-instance-probe',
      operation: 'system.hello',
      body: {},
    }
    const answer = await new RemoteControlClient(descriptor, {
      timeoutMilliseconds: LocalInstanceResolver.probeTimeoutMillisecondsConst,
    }).execute(request, signal)
    return answer.ok
      ? { ok: true, value: answer.value }
      : { ok: false, error: answer.error }
  }

  private async probe(
    descriptor: RemoteControlDescriptor,
    signal: AbortSignal,
  ): Promise<RemoteControlStepResult<RemoteControlHelloDto>> {
    try { return await this.deps.probe(descriptor, signal) }
    catch {
      return LocalInstanceResolver.error(
        'unavailable',
        'The AppClientUI identity probe failed',
      )
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
      && LocalInstanceResolver.same(
        value.optionalOperations ?? [],
        descriptor.optionalOperations ?? [],
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

  private static discoveryTimeout(): RemoteControlStepResult<RemoteControlDescriptor> {
    return LocalInstanceResolver.error(
      'timeout',
      'AppClientUI instance discovery exceeded its time limit',
    )
  }
}
