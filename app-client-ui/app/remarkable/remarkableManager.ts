import type { SessionWorkingContextResult } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  RemarkableDependencyStatus,
  RemarkableErrorCode,
  RemarkableOpenDocumentPages,
  RemarkablePagePreview,
  RemarkableRenderedPage,
  RemarkableRenderTarget,
  RemarkableResult,
  RemarkableStartedOperation,
} from '../../shared/remarkableApi.types'
import { RemarkableSettings, type RemarkableSettingsValue } from '../../shared/remarkableSettings'
import type { RemarkableStorageSettingsValue } from '../../shared/remarkableStorageSettings'
import type { RemarkableCli, RemarkableCliRender } from './sidecar/remarkableCli'
import type { RemarkableSidecarInstaller } from './sidecar/remarkableSidecarInstaller'
import type { RemarkableCredentialStore } from './storage/remarkableCredentialStore'
import {
  RemarkableImportTarget,
  type RemarkableImportDestination,
  type RemarkableImportPlacement,
  type RemarkableImportResolution,
} from './storage/remarkableImportTarget'
import type {
  RemarkableAttempt,
  RemarkableRun,
  RemarkableRunStore,
} from './storage/remarkableRunStore'

export interface RemarkableManagerOptions {
  readSettings: () => RemarkableSettingsValue
  readStorage: () => RemarkableStorageSettingsValue
  /**
   * The session manager, narrowed to the one question this feature asks it. The renderer names a
   * session; where that session runs is answered here, so the window never names a directory.
   */
  workingContext: (sessionId: string) => Promise<SessionWorkingContextResult>
  credentialStore: Pick<RemarkableCredentialStore, 'passwordFor'>
  installer: Pick<RemarkableSidecarInstaller, 'install' | 'status'>
  cli: Pick<RemarkableCli,
    'currentDocument' | 'detectFingerprint' | 'listPages' | 'renderArchive' | 'status'>
  runStore: Pick<
    RemarkableRunStore,
    'createAttempt' | 'createRun' | 'forgetImport' | 'promoteOutput' | 'readOutput' | 'release'
  >
}

interface RemarkableOperationIdentity {
  id: string
  ownerId: string
  run: RemarkableRun
  /**
   * Resolved when the operation starts and never again. A session that ends between the download
   * and the import must not move the file, and a fallback the user was already told about must
   * not silently become something else on the next page.
   */
  destination: RemarkableImportDestination
}

type RemarkableActiveOperation = RemarkableOperationIdentity & {
  abort: AbortController
  /**
   * Set by a failure that trying again cannot fix, and never by one that can. A sleeping tablet or
   * a held device lock is a state outside this app that changes while the card is open, and every
   * attempt is a click the user made, so refusing the next one only makes them close the card and
   * open it again to get the same operation back.
   */
  unrecoverable: boolean
} & (
  | { state: 'open' }
  | {
    state: 'listed'
    documentId: string
    documentName: string
    /** The page the tablet had open when this snapshot was taken. Null together with the number. */
    currentPageId: string | null
    currentPageNumber: number | null
    archivePath: string
    pages: RemarkableOpenDocumentPages['pages']
  }
)

type RemarkableOperation =
  | RemarkableActiveOperation
  | RemarkableOperationIdentity & { state: 'finished'; outputPath: string }
  | RemarkableOperationIdentity & { state: 'released'; cleanup: Promise<void> | null }

type RemarkableFailure = Extract<RemarkableResult<unknown>, { ok: false }>

interface RemarkableQueuedAction {
  ownerId: string | null
  run(): Promise<void>
  cancel(): void
}

export class RemarkableManager {
  static readonly operationsGlobalMaxConst = 8
  static readonly operationsPerOwnerMaxConst = 2
  static readonly actionsGlobalMaxConst = 16
  static readonly actionsPerOwnerMaxConst = 4
  /** Wide enough to read the page, small enough to travel over IPC as bytes. */
  private static readonly previewWidthConst = 360
  private static readonly previewBytesMaxConst = 4 * 1024 * 1024

  private readonly operations = new Map<string, RemarkableOperation>()
  private readonly ownerRevisions = new Map<string, number>()
  private readonly actionAborts = new Map<string, Set<AbortController>>()
  private readonly actionCounts = new Map<string, number>()
  private readonly queue: RemarkableQueuedAction[] = []
  private activeAction: RemarkableQueuedAction | null = null
  private ownedActionCount = 0
  private stopping = false
  private stopPromise: Promise<void> | null = null

  constructor(private readonly options: RemarkableManagerOptions) {}

  async dependenciesStatus(): Promise<RemarkableDependencyStatus> {
    return await this.options.installer.status()
  }

  async installDependencies(ownerId: string): Promise<RemarkableResult<RemarkableDependencyStatus>> {
    return await this.enqueueAbortable(ownerId, async (signal) =>
      await this.options.installer.install(signal))
  }

  async detectFingerprint(ownerId: string): Promise<RemarkableResult<{ host: string; fingerprint: string }>> {
    return await this.enqueueAbortable(ownerId, async (signal) => {
      const settings = { ...this.options.readSettings() }
      if (!RemarkableSettings.isValid(settings)
        || !RemarkableSettings.isValidHost(settings.host))
        return RemarkableManager.failure(
          'settings-incomplete',
          'Save a valid reMarkable host before detecting its fingerprint',
        )
      const password = await this.options.credentialStore.passwordFor(settings.host)
      if (signal.aborted) return RemarkableManager.cancelled()
      if (!password.ok) return password
      return await this.options.cli.detectFingerprint(settings, password.value, signal)
    })
  }

  async testConnection(ownerId: string): Promise<RemarkableResult> {
    return await this.enqueueAbortable(ownerId, async (signal) => {
      const auth = await this.auth(signal)
      if (!auth.ok) return auth
      if (signal.aborted) return RemarkableManager.cancelled()
      return await this.options.cli.status(auth.value.settings, auth.value.password, signal)
    })
  }

  async startOperation(
    ownerId: string,
    sessionId: string,
  ): Promise<RemarkableResult<RemarkableStartedOperation>> {
    if (!ownerId) return RemarkableManager.invalidOperation('A reMarkable operation owner is required')
    if (!sessionId) return RemarkableManager.invalidOperation('A reMarkable operation session is required')
    if (this.stopping) return RemarkableManager.cancelled()
    const ownerRevision = this.ownerRevision(ownerId)
    return await this.enqueueOwned(ownerId, async () => {
      if (this.stopping || this.ownerRevision(ownerId) !== ownerRevision)
        return RemarkableManager.cancelled()
      if (this.operations.size >= RemarkableManager.operationsGlobalMaxConst)
        return RemarkableManager.invalidOperation('Too many reMarkable operations are open')
      if (this.ownerOperations(ownerId) >= RemarkableManager.operationsPerOwnerMaxConst)
        return RemarkableManager.invalidOperation('This window has too many reMarkable operations open')
      const resolution = await this.destination(sessionId)
      if (!resolution.ok) return resolution
      let run: RemarkableRun
      try { run = await this.options.runStore.createRun() }
      catch {
        return RemarkableManager.invalidOperation('The reMarkable operation workspace could not be created')
      }
      if (this.stopping || this.ownerRevision(ownerId) !== ownerRevision) {
        await this.options.runStore.release(run)
        return RemarkableManager.cancelled()
      }
      const operation: RemarkableActiveOperation = {
        state: 'open',
        id: run.id,
        ownerId,
        run,
        destination: resolution.value.destination,
        abort: new AbortController(),
        unrecoverable: false,
      }
      this.operations.set(operation.id, operation)
      return { ok: true, value: {
        operationId: operation.id,
        storageNote: resolution.value.note,
      } }
    })
  }

  /**
   * Global storage needs no session directory. Project storage does, and resolves it before scratch
   * is created so an expired or foreign session cannot silently redirect an import to global state.
   */
  private async destination(
    sessionId: string,
  ): Promise<RemarkableResult<RemarkableImportResolution>> {
    try {
      const storage = this.options.readStorage()
      if (storage.scope === 'global')
        return { ok: true, value: { destination: { kind: 'global' }, note: null } }
      const context = await this.options.workingContext(sessionId)
      if (!context.ok)
        return RemarkableManager.invalidOperation(
          `Project reMarkable storage requires a live session context: ${context.detail}`,
        )
      const resolution = await RemarkableImportTarget.resolve(storage, context)
      if (resolution.destination.kind !== 'project')
        return RemarkableManager.invalidOperation(
          resolution.note ?? 'Project reMarkable storage requires a project directory',
        )
      return { ok: true, value: resolution }
    } catch {
      return RemarkableManager.invalidOperation(
        'The reMarkable storage destination could not be resolved',
      )
    }
  }

  async listOpenDocument(
    ownerId: string,
    operationId: string,
  ): Promise<RemarkableResult<RemarkableOpenDocumentPages>> {
    if (this.stopping) return RemarkableManager.cancelled()
    return await this.enqueueOwned(ownerId, async () => {
      const owned = this.activeOperation(ownerId, operationId)
      if (!owned.ok) return owned
      const listed = await this.ensureListed(owned.value)
      if (!listed.ok) return listed
      return {
        ok: true,
        value: {
          operationId: listed.value.id,
          documentName: listed.value.documentName,
          currentPageNumber: listed.value.currentPageNumber,
          pages: listed.value.pages.map((page) => ({ ...page })),
        },
      }
    })
  }

  /**
   * The one place the tablet is asked what is open and the document is downloaded, and it is asked
   * once per operation. Both sources go through it: the page list needs the pages, and the current
   * page needs the archive to render from, which are the same two device calls.
   *
   * An operation that is already listed answers its stored snapshot rather than reading again. That
   * is not a shortcut but the contract: the pages, the archive and the open page are deliberately
   * stable for the life of one operation, so a card that renders the current page and then falls
   * back to the page list shows the document it just downloaded, not a second reading of a tablet
   * the user may have touched in between.
   */
  private async ensureListed(
    operation: RemarkableActiveOperation,
  ): Promise<RemarkableResult<Extract<RemarkableActiveOperation, { state: 'listed' }>>> {
    if (operation.state === 'listed') return { ok: true, value: operation }
    else if (operation.state !== 'open') {
      const unhandled: never = operation
      throw new Error(`Unknown active reMarkable operation: ${JSON.stringify(unhandled)}`)
    }
    if (!this.canAttempt(operation)) return RemarkableManager.operationStopped()

    const auth = await this.auth(operation.abort.signal)
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!auth.ok) return this.recordFailure(operation, auth)
    const current = await this.options.cli.currentDocument(
      auth.value.settings,
      auth.value.password,
      operation.abort.signal,
    )
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!current.ok) return this.recordFailure(operation, current)
    const attempt = await this.createAttempt(operation)
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!attempt.ok) return attempt
    const listed = await this.options.cli.listPages(
      current.value.documentId,
      attempt.value.backupDirectory,
      auth.value,
      operation.abort.signal,
    )
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!listed.ok) return this.recordFailure(operation, listed)
    if (listed.value.documentId !== current.value.documentId)
      return this.recordFailure(operation, RemarkableManager.failure(
        'invalid-cli-output',
        'The reMarkable CLI returned pages for another document',
      ))
    // The open page is trusted only when the download confirms it: a page id the archive does not
    // hold would render nothing, and the card can still offer the list.
    const openPageId = listed.value.pages.some((page) => page.pageId === current.value.pageId)
      ? current.value.pageId
      : null
    const snapshot: Extract<RemarkableActiveOperation, { state: 'listed' }> = {
      state: 'listed',
      id: operation.id,
      ownerId: operation.ownerId,
      run: operation.run,
      destination: operation.destination,
      abort: operation.abort,
      unrecoverable: operation.unrecoverable,
      documentId: current.value.documentId,
      documentName: current.value.name,
      currentPageId: openPageId,
      // The NUMBER stays whatever the tablet reported, even when the id did not survive the check:
      // it only preselects a row in the page list, and the list is what the card offers next.
      currentPageNumber: current.value.pageNumber,
      archivePath: listed.value.archivePath,
      pages: listed.value.pages.map((page) => ({ ...page })),
    }
    this.operations.set(operation.id, snapshot)
    return { ok: true, value: snapshot }
  }

  async render(
    ownerId: string,
    operationId: string,
    target: RemarkableRenderTarget,
  ): Promise<RemarkableResult<RemarkableRenderedPage>> {
    if (this.stopping) return RemarkableManager.cancelled()
    return await this.enqueueOwned(ownerId, async () => {
      const owned = this.activeOperation(ownerId, operationId)
      if (!owned.ok) return owned
      const operation = owned.value
      if (!this.canAttempt(operation)) return RemarkableManager.operationStopped()
      if (target.kind === 'current') return await this.renderCurrent(operation)
      else if (target.kind === 'listed-page') return await this.renderListed(operation, target.pageId)
      else {
        const unhandled: never = target
        throw new Error(`Unknown reMarkable render target: ${JSON.stringify(unhandled)}`)
      }
    })
  }

  /**
   * A picture, not an import: the render is read out of its attempt and never promoted, so a
   * preview leaves the operation exactly as it found it. A preview that failed changes nothing
   * about the page the user may still insert, and one that failed on the tablet costs the operation
   * nothing at all. Only a failure trying again cannot fix stops the operation, and that stops it
   * for every caller, whoever hit it first.
   */
  async preview(
    ownerId: string,
    operationId: string,
    target: RemarkableRenderTarget,
  ): Promise<RemarkableResult<RemarkablePagePreview>> {
    if (this.stopping) return RemarkableManager.cancelled()
    return await this.enqueueOwned(ownerId, async () => {
      const owned = this.activeOperation(ownerId, operationId)
      if (!owned.ok) return owned
      const operation = owned.value
      if (!this.canAttempt(operation)) return RemarkableManager.operationStopped()
      const attempt = await this.createAttempt(operation)
      if (!this.isActive(operation)) return RemarkableManager.cancelled()
      if (!attempt.ok) return attempt
      const rendered = await this.previewRender(operation, attempt.value, target)
      if (!this.isActive(operation)) return RemarkableManager.cancelled()
      if (!rendered.ok) return rendered
      const bytes = await this.options.runStore.readOutput(
        attempt.value,
        rendered.value.outputPath,
        rendered.value.outputBytes,
        RemarkableManager.previewBytesMaxConst,
      )
      if (!this.isActive(operation)) return RemarkableManager.cancelled()
      if (!bytes.ok) return bytes
      return {
        ok: true,
        value: {
          pngBase64: bytes.value.toString('base64'),
          width: rendered.value.png.width,
          height: rendered.value.png.height,
          pageNumber: rendered.value.pageNumber,
        },
      }
    })
  }

  async release(ownerId: string, operationId: string): Promise<void> {
    const operation = this.operations.get(operationId)
    if (operation === undefined || operation.ownerId !== ownerId) return
    const released = this.close(operation)
    if (this.stopPromise !== null) {
      await this.stopPromise
      return
    }
    await this.scheduleRelease(released)
  }

  async releaseOwner(ownerId: string): Promise<void> {
    this.ownerRevisions.set(ownerId, this.ownerRevision(ownerId) + 1)
    this.cancelQueuedOwner(ownerId)
    for (const abort of this.actionAborts.get(ownerId) ?? []) abort.abort()
    const released: Extract<RemarkableOperation, { state: 'released' }>[] = []
    for (const operation of this.operations.values()) {
      if (operation.ownerId === ownerId) released.push(this.close(operation))
    }
    if (this.stopPromise !== null) {
      await this.stopPromise
      return
    }
    if (released.length === 0) {
      await this.enqueue(async () => undefined)
      return
    }
    await Promise.all(released.map(async (operation) => await this.scheduleRelease(operation)))
  }

  beginStop(): void {
    if (this.stopping) return
    this.stopping = true
    this.cancelQueuedOwned()
    for (const aborts of this.actionAborts.values())
      for (const abort of aborts) abort.abort()
    for (const operation of [...this.operations.values()]) this.close(operation)
  }

  async stop(): Promise<void> {
    this.beginStop()
    if (this.stopPromise === null) {
      this.stopPromise = this.enqueue(async () => {
        const operations = [...this.operations.values()]
        let failure: unknown
        for (const operation of operations) {
          try { await this.options.runStore.release(operation.run) }
          catch (error) { failure ??= error }
          finally {
            if (this.operations.get(operation.id) === operation) this.operations.delete(operation.id)
          }
        }
        if (failure !== undefined) throw failure
      })
    }
    await this.stopPromise
  }

  private async renderCurrent(
    operation: RemarkableActiveOperation,
  ): Promise<RemarkableResult<RemarkableRenderedPage>> {
    const listed = await this.ensureListed(operation)
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!listed.ok) return listed
    const openPageId = listed.value.currentPageId
    // Deliberately not through recordFailure: an unnamed page spends no attempt, because the card
    // answers it by offering the page list, and that needs the operation alive.
    if (openPageId === null)
      return RemarkableManager.failure(
        'no-open-page',
        `The tablet names no open page in "${listed.value.documentName}"`,
      )
    return await this.renderListed(listed.value, openPageId)
  }

  private async renderListed(
    operation: RemarkableActiveOperation,
    pageId: string,
  ): Promise<RemarkableResult<RemarkableRenderedPage>> {
    if (operation.state === 'open')
      return RemarkableManager.invalidOperation('List the open reMarkable document before choosing a page')
    else if (operation.state !== 'listed') {
      const unhandled: never = operation
      throw new Error(`Unknown active reMarkable operation: ${JSON.stringify(unhandled)}`)
    }
    if (!operation.pages.some((page) => page.pageId === pageId))
      return RemarkableManager.invalidOperation('The selected reMarkable page is not in this operation')
    const attempt = await this.createAttempt(operation)
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!attempt.ok) return attempt
    const rendered = await this.options.cli.renderArchive(
      operation.documentId,
      pageId,
      operation.archivePath,
      attempt.value.outputPath,
      operation.abort.signal,
    )
    return await this.finishRender(operation, attempt.value, rendered, operation.documentName)
  }

  private async previewRender(
    operation: RemarkableActiveOperation,
    attempt: RemarkableAttempt,
    target: RemarkableRenderTarget,
  ): Promise<RemarkableResult<RemarkableCliRender>> {
    if (target.kind === 'current') {
      const listed = await this.ensureListed(operation)
      if (!this.isActive(operation)) return RemarkableManager.cancelled()
      if (!listed.ok) return listed
      if (listed.value.currentPageId === null)
        return RemarkableManager.failure(
          'no-open-page',
          `The tablet names no open page in "${listed.value.documentName}"`,
        )
      return await this.options.cli.renderArchive(
        listed.value.documentId,
        listed.value.currentPageId,
        listed.value.archivePath,
        attempt.outputPath,
        operation.abort.signal,
        RemarkableManager.previewWidthConst,
      )
    } else if (target.kind === 'listed-page') {
      if (operation.state === 'open')
        return RemarkableManager.invalidOperation('List the open reMarkable document before previewing a page')
      else if (operation.state !== 'listed') {
        const unhandled: never = operation
        throw new Error(`Unknown active reMarkable operation: ${JSON.stringify(unhandled)}`)
      }
      if (!operation.pages.some((page) => page.pageId === target.pageId))
        return RemarkableManager.invalidOperation('The selected reMarkable page is not in this operation')
      return await this.options.cli.renderArchive(
        operation.documentId,
        target.pageId,
        operation.archivePath,
        attempt.outputPath,
        operation.abort.signal,
        RemarkableManager.previewWidthConst,
      )
    } else {
      const unhandled: never = target
      throw new Error(`Unknown reMarkable render target: ${JSON.stringify(unhandled)}`)
    }
  }

  private async finishRender(
    operation: RemarkableActiveOperation,
    attempt: RemarkableAttempt,
    rendered: RemarkableResult<RemarkableCliRender>,
    documentName: string | null,
  ): Promise<RemarkableResult<RemarkableRenderedPage>> {
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!rendered.ok) return this.recordFailure(operation, rendered)
    let promoted: RemarkableResult<string>
    try {
      promoted = await this.options.runStore.promoteOutput(
        attempt,
        rendered.value.outputPath,
        rendered.value.outputBytes,
      )
    } catch {
      promoted = RemarkableManager.failure(
        'invalid-cli-output',
        'The rendered reMarkable page could not be verified',
      )
    }
    if (!this.isActive(operation)) return RemarkableManager.cancelled()
    if (!promoted.ok) return this.recordFailure(operation, promoted)
    const placed = await this.place(promoted.value, operation.destination)
    if (!placed.ok) return this.recordFailure(operation, placed)
    const finished: RemarkableOperation = {
      state: 'finished',
      id: operation.id,
      ownerId: operation.ownerId,
      run: operation.run,
      destination: operation.destination,
      outputPath: placed.value.outputPath,
    }
    this.operations.set(operation.id, finished)
    return {
      ok: true,
      value: {
        outputPath: placed.value.outputPath,
        insertText: placed.value.insertText,
        pageNumber: rendered.value.pageNumber,
        documentName,
      },
    }
  }

  /**
   * The promoted file is verified where the run store put it; a project destination gets a copy of
   * it and the machine-local one is dropped, so one page still means one file. The drop is the
   * last step: a page that failed to copy is still in the store to be found.
   */
  private async place(
    promotedPath: string,
    destination: RemarkableImportDestination,
  ): Promise<RemarkableResult<RemarkableImportPlacement>> {
    let placed: RemarkableResult<RemarkableImportPlacement>
    try { placed = await RemarkableImportTarget.place(promotedPath, destination) }
    catch {
      return RemarkableManager.failure(
        'import-failed',
        'The rendered reMarkable page could not be stored',
      )
    }
    if (placed.ok && placed.value.outputPath !== promotedPath)
      await this.options.runStore.forgetImport(promotedPath)
    return placed
  }

  private async auth(
    signal: AbortSignal,
  ): Promise<RemarkableResult<{ settings: RemarkableSettingsValue; password: string }>> {
    if (signal.aborted) return RemarkableManager.cancelled()
    const settings = { ...this.options.readSettings() }
    if (!RemarkableSettings.isValid(settings)
      || !RemarkableSettings.isValidHost(settings.host)
      || !RemarkableSettings.isValidFingerprint(settings.fingerprint))
      return RemarkableManager.failure(
        'settings-incomplete',
        'Complete the reMarkable host and fingerprint settings',
      )
    const password = await this.options.credentialStore.passwordFor(settings.host)
    if (signal.aborted) return RemarkableManager.cancelled()
    return password.ok
      ? { ok: true, value: { settings, password: password.value } }
      : password
  }

  private async createAttempt(
    operation: RemarkableActiveOperation,
  ): Promise<RemarkableResult<RemarkableAttempt>> {
    try { return { ok: true, value: await this.options.runStore.createAttempt(operation.run) } }
    catch {
      return this.recordFailure(operation, RemarkableManager.failure(
        'invalid-operation',
        'The reMarkable operation workspace is unavailable',
      ))
    }
  }

  private activeOperation(
    ownerId: string,
    operationId: string,
  ): RemarkableResult<RemarkableActiveOperation> {
    const operation = this.operations.get(operationId)
    if (operation === undefined || operation.ownerId !== ownerId)
      return RemarkableManager.invalidOperation('The reMarkable operation is unavailable')
    if (operation.state === 'open' || operation.state === 'listed')
      return { ok: true, value: operation }
    else if (operation.state === 'finished')
      return RemarkableManager.invalidOperation('The reMarkable operation is already finished')
    else if (operation.state === 'released') return RemarkableManager.cancelled()
    else {
      const unhandled: never = operation
      throw new Error(`Unknown reMarkable operation: ${JSON.stringify(unhandled)}`)
    }
  }

  private close(
    operation: RemarkableOperation,
  ): Extract<RemarkableOperation, { state: 'released' }> {
    if (operation.state === 'open' || operation.state === 'listed') operation.abort.abort()
    else if (operation.state === 'finished') { /* The promoted import outlives its scratch run. */ }
    else if (operation.state === 'released') return operation
    else {
      const unhandled: never = operation
      throw new Error(`Unknown reMarkable operation: ${JSON.stringify(unhandled)}`)
    }
    const released: Extract<RemarkableOperation, { state: 'released' }> = {
      state: 'released',
      id: operation.id,
      ownerId: operation.ownerId,
      run: operation.run,
      destination: operation.destination,
      cleanup: null,
    }
    this.operations.set(operation.id, released)
    return released
  }

  private scheduleRelease(
    operation: Extract<RemarkableOperation, { state: 'released' }>,
  ): Promise<void> {
    if (operation.cleanup !== null) return operation.cleanup
    const cleanup = this.enqueue(async () => {
      try { await this.options.runStore.release(operation.run) }
      finally {
        if (this.operations.get(operation.id) === operation) this.operations.delete(operation.id)
      }
    })
    operation.cleanup = cleanup
    return cleanup
  }

  private recordFailure<T>(
    operation: RemarkableActiveOperation,
    failure: RemarkableFailure,
  ): RemarkableResult<T> {
    // An answer about the tablet rather than a failed attempt: `documents current` worked and said
    // no page is open. The card answers it by moving to the page list, which needs this operation
    // alive - spending it here made that fallback reply "the retry was already used" instead.
    if (failure.code === 'no-open-page') return failure
    // A retryable failure is the tablet's state, not the operation's: it can be true now and false
    // in ten seconds, so it leaves the operation exactly as it was and the user may click again.
    if (failure.retryable) return failure
    if (this.isActive(operation)) operation.unrecoverable = true
    return failure
  }

  private canAttempt(operation: RemarkableActiveOperation): boolean {
    return !operation.unrecoverable
  }

  /**
   * Whether the operation this caller is holding is still the live one.
   *
   * By id and state rather than by object identity, because listing REPLACES the record with its
   * snapshot: a caller that listed and then rendered would otherwise be told its own operation was
   * cancelled. The abort controller is shared by both records, so either reference answers for it.
   */
  private isActive(operation: RemarkableActiveOperation): boolean {
    const held = this.operations.get(operation.id)
    if (held === undefined || operation.abort.signal.aborted) return false
    return held.state === 'open' || held.state === 'listed'
  }

  private ownerRevision(ownerId: string): number {
    return this.ownerRevisions.get(ownerId) ?? 0
  }

  private enqueueAbortable<T>(
    ownerId: string,
    action: (signal: AbortSignal) => Promise<RemarkableResult<T>>,
  ): Promise<RemarkableResult<T>> {
    if (!ownerId) return Promise.resolve(RemarkableManager.invalidOperation(
      'A reMarkable action owner is required',
    ))
    if (this.stopping) return Promise.resolve(RemarkableManager.cancelled())
    const capacity = this.reserveAction(ownerId)
    if (capacity !== null) return Promise.resolve(capacity)
    const ownerRevision = this.ownerRevision(ownerId)
    const abort = new AbortController()
    const aborts = this.actionAborts.get(ownerId) ?? new Set<AbortController>()
    aborts.add(abort)
    this.actionAborts.set(ownerId, aborts)
    const result = this.enqueue(async () => {
      if (this.stopping
        || abort.signal.aborted
        || this.ownerRevision(ownerId) !== ownerRevision)
        return RemarkableManager.cancelled<T>()
      return await action(abort.signal)
    }, ownerId, () => RemarkableManager.cancelled<T>())
    return result.finally(() => {
      aborts.delete(abort)
      if (aborts.size === 0 && this.actionAborts.get(ownerId) === aborts)
        this.actionAborts.delete(ownerId)
      this.releaseAction(ownerId)
    })
  }

  private enqueueOwned<T>(
    ownerId: string,
    action: () => Promise<RemarkableResult<T>>,
  ): Promise<RemarkableResult<T>> {
    if (!ownerId)
      return Promise.resolve(RemarkableManager.invalidOperation(
        'A reMarkable action owner is required',
      ))
    if (this.stopping) return Promise.resolve(RemarkableManager.cancelled())
    const capacity = this.reserveAction(ownerId)
    if (capacity !== null) return Promise.resolve(capacity)
    return this.enqueue(action, ownerId, () => RemarkableManager.cancelled<T>())
      .finally(() => this.releaseAction(ownerId))
  }

  private enqueue<T>(
    action: () => Promise<T>,
    ownerId: string | null = null,
    cancelled?: () => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const job: RemarkableQueuedAction = {
        ownerId,
        run: async () => {
          if (settled) return
          try { resolve(await action()) }
          catch (error) { reject(error) }
          finally { settled = true }
        },
        cancel: () => {
          if (settled || cancelled === undefined) return
          settled = true
          resolve(cancelled())
        },
      }
      this.queue.push(job)
      this.pump()
    })
  }

  private pump(): void {
    if (this.activeAction !== null) return
    const job = this.queue.shift()
    if (job === undefined) return
    this.activeAction = job
    void job.run().finally(() => {
      if (this.activeAction === job) this.activeAction = null
      this.pump()
    })
  }

  private reserveAction(ownerId: string): RemarkableFailure | null {
    if (this.ownedActionCount >= RemarkableManager.actionsGlobalMaxConst)
      return RemarkableManager.failure(
        'invalid-operation',
        'Too many reMarkable actions are queued',
      )
    const owned = this.actionCounts.get(ownerId) ?? 0
    if (owned >= RemarkableManager.actionsPerOwnerMaxConst)
      return RemarkableManager.failure(
        'invalid-operation',
        'This window has too many reMarkable actions queued',
      )
    this.ownedActionCount += 1
    this.actionCounts.set(ownerId, owned + 1)
    return null
  }

  private releaseAction(ownerId: string): void {
    this.ownedActionCount -= 1
    const owned = this.actionCounts.get(ownerId)
    if (owned === undefined || owned <= 1) this.actionCounts.delete(ownerId)
    else this.actionCounts.set(ownerId, owned - 1)
  }

  private cancelQueuedOwner(ownerId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]
      if (job?.ownerId !== ownerId) continue
      this.queue.splice(index, 1)
      job.cancel()
    }
  }

  private cancelQueuedOwned(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]
      if (job?.ownerId === null) continue
      this.queue.splice(index, 1)
      job.cancel()
    }
  }

  private ownerOperations(ownerId: string): number {
    return [...this.operations.values()].filter((operation) => operation.ownerId === ownerId).length
  }

  private static operationStopped<T>(): RemarkableResult<T> {
    return RemarkableManager.invalidOperation(
      'The reMarkable operation stopped on a failure that trying again cannot fix',
    )
  }

  private static invalidOperation<T>(detail: string): RemarkableResult<T> {
    return RemarkableManager.failure('invalid-operation', detail)
  }

  private static cancelled<T>(): RemarkableResult<T> {
    return RemarkableManager.failure('cancelled', 'The reMarkable operation was cancelled')
  }

  private static failure(
    code: RemarkableErrorCode,
    detail: string,
    retryable = false,
  ): RemarkableFailure {
    return { ok: false, code, detail, retryable }
  }
}
