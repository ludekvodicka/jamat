import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { RuntimeChannel } from '../shared/configIdentity.types'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import type {
  RemoteControlDescriptor,
  RemoteControlSystemIdentity,
} from './remoteControlApi.types'

export interface RemoteControlInstanceRegistration extends RemoteControlSystemIdentity {
  schemaVersion: 1
  pid: number
  descriptorFile: string
}

export class RemoteControlInstanceRegistration {
  private static readonly keysConst = [
    'schemaVersion',
    'configIdentity',
    'runtimeChannel',
    'instanceId',
    'startedAt',
    'applicationVersion',
    'pid',
    'descriptorFile',
  ] as const

  static of(
    descriptor: RemoteControlDescriptor,
    descriptorFile: string,
  ): RemoteControlInstanceRegistration {
    if (!isAbsolute(descriptorFile))
      throw new Error('Remote control descriptor file must be absolute')
    return {
      schemaVersion: 1,
      configIdentity: descriptor.configIdentity,
      runtimeChannel: descriptor.runtimeChannel,
      instanceId: descriptor.instanceId,
      startedAt: descriptor.startedAt,
      applicationVersion: descriptor.applicationVersion,
      pid: descriptor.pid,
      descriptorFile,
    }
  }

  /** Total because registry content is untrusted local input: invalid values become null. */
  static validate(input: unknown): RemoteControlInstanceRegistration | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
    const value = input as Record<string, unknown>
    const keys = Object.keys(value).sort()
    const expected = [...RemoteControlInstanceRegistration.keysConst].sort()
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
      return null
    if (value.schemaVersion !== 1
      || !RemoteControlInstanceRegistration.text(value.configIdentity)
      || !RemoteControlInstanceRegistration.channel(value.runtimeChannel)
      || !RemoteControlInstanceRegistration.text(value.instanceId)
      || !RemoteControlInstanceRegistration.integer(value.startedAt, 0)
      || !RemoteControlInstanceRegistration.text(value.applicationVersion)
      || !RemoteControlInstanceRegistration.integer(value.pid, 1)
      || !RemoteControlInstanceRegistration.text(value.descriptorFile, 32_768)
      || !isAbsolute(value.descriptorFile))
      return null
    return value as unknown as RemoteControlInstanceRegistration
  }

  private static channel(input: unknown): input is RuntimeChannel {
    return input === 'production' || input === 'development'
  }

  private static text(input: unknown, maximum = 512): input is string {
    return typeof input === 'string' && input.length >= 1 && input.length <= maximum
  }

  private static integer(input: unknown, minimum: number): input is number {
    return typeof input === 'number'
      && Number.isSafeInteger(input)
      && input >= minimum
  }
}

export class RemoteControlInstanceRegistry {
  static readonly entriesMaximumConst = 256
  static readonly entryBytesMaximumConst = 65_536
  private static readonly directoryNameConst = 'control-registry'

  static directory(): string {
    return join(
      OrchestratorPaths.defaultMachineRoot(),
      RemoteControlInstanceRegistry.directoryNameConst,
    )
  }

  static fileOf(
    configIdentity: string,
    channel: RuntimeChannel,
    instanceId: string,
    startedAt: number,
  ): string {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0)
      throw new Error('Remote control instance start time is invalid')
    const newestFirst = String(Number.MAX_SAFE_INTEGER - startedAt).padStart(16, '0')
    return join(
      RemoteControlInstanceRegistry.directory(),
      `${newestFirst}-${encodeURIComponent(configIdentity)}-${channel}-${encodeURIComponent(instanceId)}.json`,
    )
  }

  static read(
    directory = RemoteControlInstanceRegistry.directory(),
  ): readonly RemoteControlInstanceRegistration[] {
    try {
      const root = lstatSync(directory)
      if (!root.isDirectory() || root.isSymbolicLink()) return []
      const registrations: RemoteControlInstanceRegistration[] = []
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, RemoteControlInstanceRegistry.entriesMaximumConst)
      for (const entry of entries) {
        const registration = RemoteControlInstanceRegistry.readFile(join(directory, entry.name))
        if (registration) registrations.push(registration)
      }
      return registrations
    } catch {
      return []
    }
  }

  private static readFile(file: string): RemoteControlInstanceRegistration | null {
    try {
      const stats = lstatSync(file)
      if (!stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > RemoteControlInstanceRegistry.entryBytesMaximumConst)
        return null
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return RemoteControlInstanceRegistration.validate(parsed)
    } catch {
      return null
    }
  }
}
