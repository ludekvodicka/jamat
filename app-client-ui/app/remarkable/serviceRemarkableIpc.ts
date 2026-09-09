import type { WebContents } from 'electron'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  RemarkableErrorCode,
  RemarkableOpenedOperation,
  RemarkableResult,
  RemarkableSettingsSnapshot,
} from '../../shared/remarkableApi.types'
import type { RemarkableImportSettingsValue } from '../../shared/remarkableImportSettings'
import { RemarkableSettings, type RemarkableSettingsValue } from '../../shared/remarkableSettings'
import type { RemarkableStorageSettingsValue } from '../../shared/remarkableStorageSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { RemarkableManager } from './remarkableManager'
import { RemarkableImportSection } from './settings/remarkableImportSection'
import { RemarkableSettingsSection } from './settings/remarkableSettingsSection'
import { RemarkableStorageSection } from './settings/remarkableStorageSection'
import type { RemarkableCredentialStore } from './storage/remarkableCredentialStore'

export class ServiceRemarkableIpc extends ServiceIpcBase<
  typeof ServiceRemarkableIpc.channelsConst
> {
  static readonly channelsConst = {
    'remarkable:settings-get': true,
    'remarkable:settings-save': true,
    'remarkable:storage-get': true,
    'remarkable:storage-save': true,
    'remarkable:import-save': true,
    'remarkable:password-set': true,
    'remarkable:password-clear': true,
    'remarkable:fingerprint-detect': true,
    'remarkable:connection-test': true,
    'remarkable:dependencies-status': true,
    'remarkable:dependencies-install': true,
    'remarkable:operation-start': true,
    'remarkable:operation-pages': true,
    'remarkable:operation-render': true,
    'remarkable:operation-preview': true,
    'remarkable:operation-release': true,
  } as const

  constructor(
    private readonly manager: RemarkableManager,
    private readonly configStore: Pick<ConfigStore, 'readSection' | 'saveSection'>,
    private readonly credentialStore: Pick<
      RemarkableCredentialStore,
      'clear' | 'configuredFor' | 'replace'
    >,
    private readonly ownerIdOf: (sender: WebContents) => string | null,
  ) {
    super()
  }

  initialize(): void {
    this.register('remarkable:settings-get', (event) => {
      this.ownerId(event.sender)
      return this.settings()
    })
    this.register('remarkable:settings-save', (event, value) => {
      this.ownerId(event.sender)
      return this.saveSettings(value)
    })
    this.register('remarkable:storage-get', (event) => {
      this.ownerId(event.sender)
      return this.configStore.readSection(RemarkableStorageSection.spec)
    })
    this.register('remarkable:storage-save', (event, value) => {
      this.ownerId(event.sender)
      return this.saveStorage(value)
    })
    this.register('remarkable:import-save', (event, value) => {
      this.ownerId(event.sender)
      return this.saveImport(value)
    })
    this.register('remarkable:password-set', (event, expectedHost, password) => {
      this.ownerId(event.sender)
      return this.setPassword(expectedHost, password)
    })
    this.register('remarkable:password-clear', (event, expectedHost) => {
      this.ownerId(event.sender)
      return this.clearPassword(expectedHost)
    })
    this.register('remarkable:fingerprint-detect', (event) => {
      return this.manager.detectFingerprint(this.ownerId(event.sender))
    })
    this.register('remarkable:connection-test', (event) => {
      return this.manager.testConnection(this.ownerId(event.sender))
    })
    this.register('remarkable:dependencies-status', (event) => {
      this.ownerId(event.sender)
      return this.manager.dependenciesStatus()
    })
    this.register('remarkable:dependencies-install', (event) => {
      return this.manager.installDependencies(this.ownerId(event.sender))
    })
    this.register('remarkable:operation-start', (event, sessionId) =>
      this.startOperation(event.sender, sessionId))
    this.register('remarkable:operation-pages', (event, operationId) =>
      this.manager.listOpenDocument(this.ownerId(event.sender), operationId))
    this.register('remarkable:operation-render', (event, operationId, target) =>
      this.manager.render(this.ownerId(event.sender), operationId, target))
    this.register('remarkable:operation-preview', (event, operationId, target) =>
      this.manager.preview(this.ownerId(event.sender), operationId, target))
    this.register('remarkable:operation-release', (event, operationId) =>
      this.manager.release(this.ownerId(event.sender), operationId))
    this.assertComplete(ServiceRemarkableIpc.channelsConst)
  }

  private settings(): RemarkableSettingsSnapshot {
    const value = this.configStore.readSection(RemarkableSettingsSection.spec)
    return { value, passwordConfigured: this.credentialStore.configuredFor(value.host) }
  }

  private saveSettings(value: RemarkableSettingsValue): RemarkableResult {
    const saved = this.configStore.saveSection(RemarkableSettingsSection.spec, value)
    if (saved.ok) return ServiceRemarkableIpc.success()
    else if (saved.code === 'config-latched')
      return ServiceRemarkableIpc.failure('invalid-operation', saved.detail)
    else if (saved.code === 'section-damaged')
      return ServiceRemarkableIpc.failure('invalid-operation', saved.detail)
    else if (saved.code === 'invalid-section')
      return ServiceRemarkableIpc.failure('settings-incomplete', saved.detail)
    else throw new Error(`Unexpected reMarkable settings save result: ${JSON.stringify(saved)}`)
  }

  private saveImport(value: RemarkableImportSettingsValue): RemarkableResult {
    const saved = this.configStore.saveSection(RemarkableImportSection.spec, value)
    if (saved.ok) return ServiceRemarkableIpc.success()
    else if (saved.code === 'config-latched' || saved.code === 'section-damaged')
      return ServiceRemarkableIpc.failure('invalid-operation', saved.detail)
    else if (saved.code === 'invalid-section')
      return ServiceRemarkableIpc.failure('settings-incomplete', saved.detail)
    else throw new Error(`Unexpected reMarkable import save result: ${JSON.stringify(saved)}`)
  }

  private saveStorage(value: RemarkableStorageSettingsValue): RemarkableResult {
    const saved = this.configStore.saveSection(RemarkableStorageSection.spec, value)
    if (saved.ok) return ServiceRemarkableIpc.success()
    else if (saved.code === 'config-latched' || saved.code === 'section-damaged')
      return ServiceRemarkableIpc.failure('invalid-operation', saved.detail)
    else if (saved.code === 'invalid-section')
      return ServiceRemarkableIpc.failure('settings-incomplete', saved.detail)
    else throw new Error(`Unexpected reMarkable storage save result: ${JSON.stringify(saved)}`)
  }

  private async setPassword(expectedHost: string, password: string): Promise<RemarkableResult> {
    const settings = this.configStore.readSection(RemarkableSettingsSection.spec)
    if (!RemarkableSettings.isValidHost(settings.host))
      return ServiceRemarkableIpc.failure(
        'settings-incomplete',
        'Save a valid reMarkable host before storing its password',
      )
    if (settings.host !== expectedHost)
      return ServiceRemarkableIpc.failure(
        'invalid-operation',
        'The saved reMarkable host changed; reload the settings before changing its password',
      )
    return await this.credentialStore.replace(expectedHost, password)
  }

  private async clearPassword(expectedHost: string): Promise<RemarkableResult> {
    const settings = this.configStore.readSection(RemarkableSettingsSection.spec)
    if (!RemarkableSettings.isValidHost(settings.host) || settings.host !== expectedHost)
      return ServiceRemarkableIpc.failure(
        'invalid-operation',
        'The saved reMarkable host changed; reload the settings before changing its password',
      )
    return await this.credentialStore.clear(expectedHost)
  }

  /**
   * The card asks for one thing and gets two, because it cannot act on either alone: the operation
   * it will render from, and whether it may render without being asked. Reading the preference here
   * keeps the manager unaware of it - an auto preview is the same preview, asked sooner.
   */
  private async startOperation(
    sender: WebContents,
    sessionId: string,
  ): Promise<RemarkableResult<RemarkableOpenedOperation>> {
    const ownerId = this.ownerId(sender)
    const started = await this.manager.startOperation(ownerId, sessionId)
    if (!started.ok) return started
    const settings = this.configStore.readSection(RemarkableImportSection.spec)
    return { ok: true, value: { ...started.value, autoPreviewOnOpen: settings.autoPreviewOnOpen } }
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('reMarkable request came from an unknown workspace')
    this.watchSender(sender, () => { void this.manager.releaseOwner(ownerId) })
    return ownerId
  }

  private static success(): RemarkableResult {
    return { ok: true, value: undefined }
  }

  private static failure(code: RemarkableErrorCode, detail: string): RemarkableResult {
    return { ok: false, code, detail, retryable: false }
  }
}
