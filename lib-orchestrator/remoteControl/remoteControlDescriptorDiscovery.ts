import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RuntimeChannel } from '../shared/configIdentity.types'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import type {
  RemoteControlDescriptor,
  RemoteControlDescriptorOperation,
  RemoteControlLocalOperation,
  RemoteControlOptionalOperation,
  RemoteControlStepResult,
  RemoteControlSystemIdentity,
} from './remoteControlApi.types'
import {
  RemoteControlInstanceRegistry,
  type RemoteControlInstanceRegistration,
} from './remoteControlInstanceRegistry'
import { RemoteControlConst, RemoteControlLocalConst } from './remoteControlProtocol'

export interface RemoteControlDiscoveredInstance {
  descriptor: RemoteControlDescriptor
  registration: RemoteControlInstanceRegistration | null
}

export interface RemoteControlCandidate extends RemoteControlSystemIdentity {}

export class RemoteControlCandidate {
  static safeOf(identity: RemoteControlSystemIdentity): RemoteControlCandidate {
    return {
      configIdentity: identity.configIdentity,
      runtimeChannel: identity.runtimeChannel,
      instanceId: identity.instanceId,
      startedAt: identity.startedAt,
      applicationVersion: identity.applicationVersion,
    }
  }
}

export class RemoteControlDescriptorDiscovery {
  private static readonly scopeNameConst = 'client-ui'
  private static readonly descriptorFileNameConst = 'remote-control.json'
  private static readonly instanceDescriptorsDirectoryNameConst = 'control-descriptors'
  private static readonly maximumBytesConst = 65_536

  static descriptorFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.machineRoot(),
      RemoteControlDescriptorDiscovery.scopeNameConst,
      configIdentity,
      channel,
      RemoteControlDescriptorDiscovery.descriptorFileNameConst,
    )
  }

  static instanceDescriptorFile(
    configIdentity: string,
    channel: RuntimeChannel,
    instanceId: string,
    startedAt: number,
  ): string {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0)
      throw new Error('Remote control instance start time is invalid')
    return join(
      OrchestratorPaths.machineRoot(),
      RemoteControlDescriptorDiscovery.scopeNameConst,
      configIdentity,
      channel,
      RemoteControlDescriptorDiscovery.instanceDescriptorsDirectoryNameConst,
      `${startedAt}-${encodeURIComponent(instanceId)}.json`,
    )
  }

  static read(
    configIdentity: string,
    channel: RuntimeChannel,
    file = RemoteControlDescriptorDiscovery.descriptorFile(configIdentity, channel),
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    if (!existsSync(file))
      return RemoteControlDescriptorDiscovery.error(
        'unavailable',
        'No running AppClientUI control descriptor is published',
      )
    try {
      const stats = lstatSync(file)
      if (!stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > RemoteControlDescriptorDiscovery.maximumBytesConst)
        return RemoteControlDescriptorDiscovery.error(
          'unavailable',
          'The AppClientUI control descriptor is invalid',
        )
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return RemoteControlDescriptorDiscovery.validate(parsed, configIdentity, channel)
    } catch {
      return RemoteControlDescriptorDiscovery.error(
        'unavailable',
        'The AppClientUI control descriptor could not be read',
      )
    }
  }

  static registeredAndDefaultRootCandidates(
    registryDirectory = RemoteControlInstanceRegistry.directory(),
    defaultMachineRoot = OrchestratorPaths.defaultMachineRoot(),
  ): readonly RemoteControlDiscoveredInstance[] {
    const candidates: RemoteControlDiscoveredInstance[] = []
    for (const registration of RemoteControlInstanceRegistry.read(registryDirectory)) {
      const answer = RemoteControlDescriptorDiscovery.read(
        registration.configIdentity,
        registration.runtimeChannel,
        registration.descriptorFile,
      )
      if (!answer.ok || !RemoteControlDescriptorDiscovery.matches(answer.value, registration))
        continue
      candidates.push({ descriptor: answer.value, registration })
    }
    candidates.push(...RemoteControlDescriptorDiscovery.defaultRootCandidates(defaultMachineRoot))
    const unique = new Map<string, RemoteControlDiscoveredInstance>()
    for (const candidate of candidates) {
      const identity = candidate.descriptor
      const key = JSON.stringify([
        identity.configIdentity,
        identity.runtimeChannel,
        identity.instanceId,
      ])
      if (!unique.has(key)) unique.set(key, candidate)
    }
    return [...unique.values()]
  }

  private static defaultRootCandidates(
    machineRoot: string,
  ): readonly RemoteControlDiscoveredInstance[] {
    const scope = join(machineRoot, RemoteControlDescriptorDiscovery.scopeNameConst)
    try {
      const root = lstatSync(scope)
      if (!root.isDirectory() || root.isSymbolicLink()) return []
      const candidates: RemoteControlDiscoveredInstance[] = []
      const identities = readdirSync(scope, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, RemoteControlInstanceRegistry.entriesMaximumConst)
      for (const identity of identities) {
        for (const channel of ['development', 'production'] as const) {
          if (candidates.length >= RemoteControlInstanceRegistry.entriesMaximumConst)
            return candidates
          const channelDirectory = join(scope, identity.name, channel)
          if (!RemoteControlDescriptorDiscovery.realDirectory(channelDirectory)) continue
          const answer = RemoteControlDescriptorDiscovery.read(
            identity.name,
            channel,
            join(channelDirectory, RemoteControlDescriptorDiscovery.descriptorFileNameConst),
          )
          if (answer.ok) candidates.push({ descriptor: answer.value, registration: null })
        }
      }
      return candidates
    } catch {
      return []
    }
  }

  private static realDirectory(directory: string): boolean {
    try {
      const stats = lstatSync(directory)
      return stats.isDirectory() && !stats.isSymbolicLink()
    } catch {
      return false
    }
  }

  private static matches(
    descriptor: RemoteControlDescriptor,
    registration: RemoteControlInstanceRegistration,
  ): boolean {
    return descriptor.configIdentity === registration.configIdentity
      && descriptor.runtimeChannel === registration.runtimeChannel
      && descriptor.instanceId === registration.instanceId
      && descriptor.startedAt === registration.startedAt
      && descriptor.applicationVersion === registration.applicationVersion
      && descriptor.pid === registration.pid
  }

  private static validate(
    input: unknown,
    configIdentity: string,
    channel: RuntimeChannel,
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return RemoteControlDescriptorDiscovery.invalid()
    const value = input as Partial<RemoteControlDescriptor>
    if (value.schemaVersion !== 1 || value.protocol !== RemoteControlConst.protocol)
      return {
        ok: false,
        error: {
          code: 'protocol-mismatch',
          detail: 'The AppClientUI control descriptor uses another protocol',
        },
      }
    if (value.address !== '127.0.0.1'
      || value.websocket !== true
      || value.configIdentity !== configIdentity
      || value.runtimeChannel !== channel
      || !RemoteControlDescriptorDiscovery.integer(value.port, 1, 65_535)
      || !RemoteControlDescriptorDiscovery.integer(value.pid, 1, Number.MAX_SAFE_INTEGER)
      || !RemoteControlDescriptorDiscovery.integer(value.startedAt, 0, Number.MAX_SAFE_INTEGER)
      || !RemoteControlDescriptorDiscovery.text(value.instanceId, 512)
      || !RemoteControlDescriptorDiscovery.text(value.applicationVersion, 512)
      || !RemoteControlDescriptorDiscovery.text(value.token, 512, 32)
      || !RemoteControlDescriptorDiscovery.operations(value.operations)
      || (value.optionalOperations !== undefined
        && !RemoteControlDescriptorDiscovery.optionalOperations(value.optionalOperations))
      || (value.localOperations !== undefined
        && !RemoteControlDescriptorDiscovery.localOperations(value.localOperations)))
      return RemoteControlDescriptorDiscovery.invalid()
    if (!RemoteControlDescriptorDiscovery.alive(value.pid))
      return RemoteControlDescriptorDiscovery.error(
        'unavailable',
        'The AppClientUI that published this control descriptor is gone',
      )
    return { ok: true, value: value as RemoteControlDescriptor }
  }

  /**
   * A descriptor outlives the process that wrote it whenever that one is killed rather than stopped,
   * and this file carries a BEARER TOKEN. Handing it to whatever answers on that port next is worth
   * one syscall to avoid. Signal 0 asks only "does this pid exist"; `EPERM` means it exists and
   * belongs to somebody else, which still counts. It cannot tell that a pid was reused, and it is
   * not asked to: what it catches is the ordinary case, a stale file after a crash.
   */
  private static alive(pid: unknown): boolean {
    if (typeof pid !== 'number') return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private static operations(input: unknown): input is readonly RemoteControlDescriptorOperation[] {
    return Array.isArray(input)
      && input.length === RemoteControlConst.descriptorOperations.length
      && input.every((value, index) => value === RemoteControlConst.descriptorOperations[index])
  }

  private static optionalOperations(
    input: unknown,
  ): input is readonly RemoteControlOptionalOperation[] {
    return Array.isArray(input)
      && input.length <= RemoteControlConst.optionalOperations.length
      && new Set(input).size === input.length
      && input.every((value) => (RemoteControlConst.optionalOperations as readonly unknown[])
        .includes(value))
  }

  private static localOperations(input: unknown): input is readonly RemoteControlLocalOperation[] {
    return Array.isArray(input)
      && input.length === RemoteControlLocalConst.operations.length
      && input.every((value, index) => value === RemoteControlLocalConst.operations[index])
  }

  private static text(input: unknown, maximum: number, minimum = 1): input is string {
    return typeof input === 'string' && input.length >= minimum && input.length <= maximum
  }

  private static integer(
    input: unknown,
    minimum: number,
    maximum: number,
  ): input is number {
    return typeof input === 'number'
      && Number.isSafeInteger(input)
      && input >= minimum
      && input <= maximum
  }

  private static invalid(): RemoteControlStepResult<RemoteControlDescriptor> {
    return RemoteControlDescriptorDiscovery.error(
      'unavailable',
      'The AppClientUI control descriptor is invalid',
    )
  }

  private static error(
    code: 'unavailable',
    detail: string,
  ): RemoteControlStepResult<RemoteControlDescriptor> {
    return { ok: false, error: { code, detail } }
  }
}
