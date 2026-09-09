import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionWorkingContextResult } from '../../../lib-orchestrator/sessionManager/sessionManager'

import type {
  RemarkableDependencyStatus,
  RemarkablePageChoice,
  RemarkableResult,
} from '../../shared/remarkableApi.types'
import type { RemarkableSettingsValue } from '../../shared/remarkableSettings'
import type { RemarkableStorageSettingsValue } from '../../shared/remarkableStorageSettings'
import type {
  RemarkableAuth,
  RemarkableCliCurrentDocument,
  RemarkableCliPageList,
  RemarkableCliRender,
} from './sidecar/remarkableCli'
import type {
  RemarkableAttempt,
  RemarkableRun,
} from './storage/remarkableRunStore'
import { RemarkableRunStore } from './storage/remarkableRunStore'
import { RemarkableManager } from './remarkableManager'

interface FakeCliCall {
  kind: 'currentDocument' | 'detectFingerprint' | 'listPages' | 'renderArchive' | 'status'
  documentId?: string
  pageId?: string
  archivePath?: string
  outputPath?: string
  backupDirectory?: string
  width?: number
  signal: AbortSignal
}

interface FakeCliBehavior {
  currentDocument?: (
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ) => Promise<RemarkableResult<RemarkableCliCurrentDocument>>
  detectFingerprint?: (
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ) => Promise<RemarkableResult<{ host: string; fingerprint: string }>>
  listPages?: (
    documentId: string,
    backupDirectory: string,
    auth: RemarkableAuth,
    signal: AbortSignal,
  ) => Promise<RemarkableResult<RemarkableCliPageList>>
  renderArchive?: (
    documentId: string,
    pageId: string,
    archivePath: string,
    outputPath: string,
    signal: AbortSignal,
    width?: number,
  ) => Promise<RemarkableResult<RemarkableCliRender>>

  status?: (
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ) => Promise<RemarkableResult>
}

class Deferred<T> {
  readonly promise: Promise<T>
  private resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolvePromise = resolve })
  }

  resolve(value: T): void {
    if (this.resolvePromise === null) throw new Error('Deferred was already resolved')
    const resolve = this.resolvePromise
    this.resolvePromise = null
    resolve(value)
  }
}

class FakeCli {
  readonly calls: FakeCliCall[] = []
  maxConcurrency = 0
  private concurrency = 0

  constructor(private readonly behavior: FakeCliBehavior) {}

  async currentDocument(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult<RemarkableCliCurrentDocument>> {
    return await this.invoke({ kind: 'currentDocument', signal }, async () =>
      this.behavior.currentDocument !== undefined
        ? await this.behavior.currentDocument(settings, password, signal)
        : {
          ok: true,
          value: { documentId: 'document-1', name: 'Notebook', pageId: 'page-1', pageNumber: 1 },
        })
  }

  async detectFingerprint(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult<{ host: string; fingerprint: string }>> {
    return await this.invoke({ kind: 'detectFingerprint', signal }, async () =>
      this.behavior.detectFingerprint !== undefined
        ? await this.behavior.detectFingerprint(settings, password, signal)
        : {
          ok: true,
          value: { host: settings.host ?? '', fingerprint: `SHA256:${'B'.repeat(43)}` },
        })
  }

  async listPages(
    documentId: string,
    backupDirectory: string,
    auth: RemarkableAuth,
    signal: AbortSignal,
  ): Promise<RemarkableResult<RemarkableCliPageList>> {
    return await this.invoke({ kind: 'listPages', documentId, backupDirectory, signal }, async () =>
      this.behavior.listPages !== undefined
        ? await this.behavior.listPages(documentId, backupDirectory, auth, signal)
        : {
          ok: true,
          value: {
            documentId,
            archivePath: join(backupDirectory, `${documentId}.rmdoc`),
            downloaded: true,
            pages: [{ pageId: 'page-1', number: 1, template: null, modified: false }],
          },
        })
  }

  async renderArchive(
    documentId: string,
    pageId: string,
    archivePath: string,
    outputPath: string,
    signal: AbortSignal,
    width?: number,
  ): Promise<RemarkableResult<RemarkableCliRender>> {
    return await this.invoke({
      kind: 'renderArchive', documentId, pageId, archivePath, outputPath, width, signal,
    }, async () => this.behavior.renderArchive !== undefined
      ? await this.behavior.renderArchive(documentId, pageId, archivePath, outputPath, signal, width)
      : FakeCli.rendered(documentId, pageId, archivePath, outputPath, 1))
  }


  async status(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult> {
    return await this.invoke({ kind: 'status', signal }, async () =>
      this.behavior.status !== undefined
        ? await this.behavior.status(settings, password, signal)
        : { ok: true, value: undefined })
  }

  private async invoke<T>(
    call: FakeCliCall,
    action: () => Promise<RemarkableResult<T>>,
  ): Promise<RemarkableResult<T>> {
    this.calls.push(call)
    this.concurrency += 1
    this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency)
    try { return await action() }
    finally { this.concurrency -= 1 }
  }

  private static rendered(
    documentId: string,
    pageId: string,
    archivePath: string,
    outputPath: string,
    pageNumber: number,
  ): RemarkableResult<RemarkableCliRender> {
    const bytes = Buffer.from([137, 80, 78, 71])
    writeFileSync(outputPath, bytes)
    return {
      ok: true,
      value: {
        documentId,
        pageId,
        archivePath,
        outputPath,
        outputBytes: bytes.length,
        pageNumber,
        png: { width: 360, height: 480 },
      },
    }
  }
}

class FakeInstaller {
  readonly calls: string[] = []
  readonly signals: AbortSignal[] = []
  gate: Deferred<void> | null = null

  async status(): Promise<RemarkableDependencyStatus> {
    this.calls.push('status')
    return FakeInstaller.ready()
  }

  async install(
    signal: AbortSignal,
  ): Promise<RemarkableResult<Extract<RemarkableDependencyStatus, { kind: 'ready' }>>> {
    this.calls.push('install')
    this.signals.push(signal)
    if (this.gate !== null) await this.gate.promise
    if (signal.aborted)
      return { ok: false, code: 'cancelled', detail: 'cancelled', retryable: false }
    return { ok: true, value: FakeInstaller.ready() }
  }

  private static ready(): Extract<RemarkableDependencyStatus, { kind: 'ready' }> {
    return { kind: 'ready', bundleId: 'bundle-1', nodeVersion: '22.23.2', cliVersion: '0.3.0' }
  }
}

class TestRunStore {
  readonly releases: string[] = []
  readonly forgotten: string[] = []
  createRunFailure: Error | null = null
  private readonly inner: RemarkableRunStore
  private promotionPause: { reached: Deferred<void>; proceed: Deferred<void> } | null = null

  constructor(
    private readonly root: string,
    id: () => string,
  ) {
    this.inner = new RemarkableRunStore({
      runsDirectory: join(root, 'runs'),
      importsDirectory: join(root, 'imports'),
      id,
    })
  }

  async createRun(): Promise<RemarkableRun> {
    if (this.createRunFailure !== null) throw this.createRunFailure
    return await this.inner.createRun()
  }

  async createAttempt(run: RemarkableRun): Promise<RemarkableAttempt> {
    return await this.inner.createAttempt(run)
  }

  async readOutput(
    attempt: RemarkableAttempt,
    outputPath: string,
    outputBytes: number,
    maximumBytes: number,
  ): Promise<RemarkableResult<Buffer>> {
    return await this.inner.readOutput(attempt, outputPath, outputBytes, maximumBytes)
  }

  async forgetImport(path: string): Promise<void> {
    this.forgotten.push(path)
    await this.inner.forgetImport(path)
  }

  async promoteOutput(
    attempt: RemarkableAttempt,
    outputPath: string,
    outputBytes: number,
  ): Promise<RemarkableResult<string>> {
    const result = await this.inner.promoteOutput(attempt, outputPath, outputBytes)
    if (this.promotionPause !== null) {
      this.promotionPause.reached.resolve(undefined)
      await this.promotionPause.proceed.promise
      this.promotionPause = null
    }
    return result
  }

  async release(run: RemarkableRun): Promise<void> {
    this.releases.push(run.id)
    await this.inner.release(run)
  }

  pauseAfterPromotion(): { reached: Promise<void>; proceed: () => void } {
    if (this.promotionPause !== null) throw new Error('A promotion pause is already active')
    const reached = new Deferred<void>()
    const proceed = new Deferred<void>()
    this.promotionPause = { reached, proceed }
    return { reached: reached.promise, proceed: () => proceed.resolve(undefined) }
  }

  runExists(operationId: string): boolean {
    return existsSync(join(this.root, 'runs', operationId))
  }

  imports(): string[] {
    const directory = join(this.root, 'imports')
    return existsSync(directory) ? readdirSync(directory).map((file) => join(directory, file)) : []
  }
}

describe('app-client-ui/app/remarkable/remarkableManager', () => {
  let root: string
  let managers: RemarkableManager[]

  beforeEach(() => {
    // This subsystem proves a path by realpath(p) === p, and os.tmpdir() is an 8.3 short
    // name on the Windows CI runner. Only the NATIVE call expands one, so a plain
    // realpathSync here would leave the root short and every such proof would refuse.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-remarkable-manager-')))
    managers = []
  })

  afterEach(async () => {
    for (const manager of managers) await manager.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes install, fingerprint, test and two windows in FIFO order with concurrency one', async () => {
    const behavior: FakeCliBehavior = {}
    const current = fixture(behavior)
    const firstOperation = await start(current.manager, 'window-a')
    const secondOperation = await start(current.manager, 'window-b')
    const installGate = new Deferred<void>()
    current.installer.gate = installGate
    const renderGates = [new Deferred<void>(), new Deferred<void>()]
    const renderEntered = [new Deferred<void>(), new Deferred<void>()]
    let renderIndex = 0
    behavior.renderArchive = async (documentId, pageId, archivePath, outputPath, signal) => {
      const index = renderIndex++
      const gate = renderGates[index]
      const entered = renderEntered[index]
      if (gate === undefined || entered === undefined) throw new Error('Unexpected render call')
      entered.resolve(undefined)
      await gate.promise
      return signal.aborted
        ? failure('cancelled', false)
        : rendered(outputPath, archivePath, documentId, pageId, 1)
    }

    const installing = current.manager.installDependencies('window-a')
    const detecting = current.manager.detectFingerprint('window-a')
    const testing = current.manager.testConnection('window-a')
    const first = current.manager.render('window-a', firstOperation, { kind: 'current' })
    const second = current.manager.render('window-b', secondOperation, { kind: 'current' })
    await waitFor(() => current.installer.calls.length === 1)
    expect(current.cli.calls).toEqual([])

    installGate.resolve(undefined)
    await installing
    expect((await detecting).ok).toBe(true)
    expect((await testing).ok).toBe(true)
    await renderEntered[0]?.promise
    expect(current.cli.calls.map((call) => call.kind)).toEqual([
      'detectFingerprint', 'status', 'currentDocument', 'listPages', 'renderArchive',
    ])
    expect(current.cli.maxConcurrency).toBe(1)

    renderGates[0]?.resolve(undefined)
    expect((await first).ok).toBe(true)
    await renderEntered[1]?.promise
    expect(current.cli.calls.map((call) => call.kind)).toEqual([
      'detectFingerprint', 'status', 'currentDocument', 'listPages', 'renderArchive',
      'currentDocument', 'listPages', 'renderArchive',
    ])
    expect(current.cli.maxConcurrency).toBe(1)
    renderGates[1]?.resolve(undefined)
    expect((await second).ok).toBe(true)
  })

  it('bounds queued actions per owner and globally, then releases capacity', async () => {
    const current = fixture({})
    const gate = new Deferred<void>()
    current.installer.gate = gate
    const admitted = [
      ...Array.from(
        { length: RemarkableManager.actionsPerOwnerMaxConst },
        () => current.manager.installDependencies('window-a'),
      ),
      ...Array.from(
        { length: RemarkableManager.actionsGlobalMaxConst
          - RemarkableManager.actionsPerOwnerMaxConst },
        (_, index) => current.manager.installDependencies(`window-${index + 2}`),
      ),
    ]
    await waitFor(() => current.installer.calls.length === 1)

    expect(await current.manager.installDependencies('window-a'))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(await current.manager.installDependencies('window-extra'))
      .toMatchObject({ ok: false, code: 'invalid-operation' })

    gate.resolve(undefined)
    await expect(Promise.all(admitted)).resolves.toHaveLength(RemarkableManager.actionsGlobalMaxConst)
    expect((await current.manager.installDependencies('window-a')).ok).toBe(true)
  })

  it('bounds open operations per owner and globally, then releases capacity', async () => {
    const current = fixture({})
    const opened: { ownerId: string; operationId: string }[] = []
    for (let index = 0; index < RemarkableManager.operationsGlobalMaxConst; index += 1) {
      const ownerId = index < RemarkableManager.operationsPerOwnerMaxConst
        ? 'window-a'
        : `window-${index}`
      const started = await current.manager.startOperation(ownerId, `session-${index}`)
      expect(started.ok).toBe(true)
      if (started.ok) opened.push({ ownerId, operationId: started.value.operationId })
    }
    expect(await current.manager.startOperation('window-a', 'owner-overflow'))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(await current.manager.startOperation('window-extra', 'global-overflow'))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(readdirSync(join(root, 'runs'))).toHaveLength(RemarkableManager.operationsGlobalMaxConst)

    await current.manager.release(opened[0]!.ownerId, opened[0]!.operationId)
    expect((await current.manager.startOperation('window-extra', 'recovered')).ok).toBe(true)
  })

  it('binds list, render and release to the owner that started the operation', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')

    expect(await current.manager.listOpenDocument('window-b', operationId))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(await current.manager.render('window-b', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    await current.manager.release('window-b', operationId)
    expect(current.runStore.runExists(operationId)).toBe(true)
    expect(current.cli.calls).toEqual([])

    expect((await current.manager.listOpenDocument('window-a', operationId)).ok).toBe(true)
    await current.manager.release('window-a', operationId)
    expect(current.runStore.runExists(operationId)).toBe(false)
    expect(current.runStore.releases).toEqual([operationId])
  })

  it('cancels an owner start that was still waiting in the queue when its renderer disappeared', async () => {
    const current = fixture({})
    const copy = new Deferred<void>()
    current.installer.gate = copy
    const installing = current.manager.installDependencies('window-b')
    await waitFor(() => current.installer.calls.length === 1)
    const starting = current.manager.startOperation('window-a', 's-1')
    const releasing = current.manager.releaseOwner('window-a')

    copy.resolve(undefined)
    expect((await installing).ok).toBe(true)
    expect(await starting).toMatchObject({ ok: false, code: 'cancelled' })
    await releasing
    expect(existsSync(join(root, 'runs'))).toBe(false)
  })

  it('aborts a running action and cancels that owner\'s queued actions on renderer release', async () => {
    const current = fixture({})
    const copy = new Deferred<void>()
    current.installer.gate = copy
    const installing = current.manager.installDependencies('window-a')
    const detecting = current.manager.detectFingerprint('window-a')
    await waitFor(() => current.installer.calls.length === 1)

    const releasing = current.manager.releaseOwner('window-a')
    expect(current.installer.signals[0]?.aborted).toBe(true)
    copy.resolve(undefined)

    expect(await installing).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await detecting).toMatchObject({ ok: false, code: 'cancelled' })
    await releasing
    expect(current.cli.calls).toEqual([])
  })

  it('returns nothing-open without listing pages', async () => {
    const current = fixture({
      currentDocument: async () => failure('nothing-open', false),
    })
    const operationId = await start(current.manager, 'window-a')

    expect(await current.manager.listOpenDocument('window-a', operationId))
      .toMatchObject({ ok: false, code: 'nothing-open' })
    expect(current.cli.calls.map((call) => call.kind)).toEqual(['currentDocument'])
  })

  it('lists an open document whose page the tablet does not name', async () => {
    const current = fixture({
      currentDocument: async () => ({
        ok: true,
        value: { documentId: 'document-1', name: 'Notebook', pageId: null, pageNumber: null },
      }),
    })
    const operationId = await start(current.manager, 'window-a')

    const listed = await current.manager.listOpenDocument('window-a', operationId)
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.detail)
    expect(listed.value.currentPageNumber).toBeNull()
    expect(listed.value.documentName).toBe('Notebook')
    expect(listed.value.pages.length).toBeGreaterThan(0)
  })

  /**
   * The card answers no-open-page by listing the document instead, which it can only do while the
   * operation lives. Counting it as a spent attempt answered that fallback with "the retry was
   * already used", so a Current page import ended in a dialog that said nothing about the cause.
   */
  it('keeps the operation usable after the tablet names no open page', async () => {
    const current = fixture({
      currentDocument: async () => ({
        ok: true,
        value: { documentId: 'document-1', name: 'Notebook', pageId: null, pageNumber: null },
      }),
    })
    const operationId = await start(current.manager, 'window-a')

    expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'no-open-page' })

    const listed = await current.manager.listOpenDocument('window-a', operationId)
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error(listed.detail)
    const page = listed.value.pages[0]
    if (page === undefined) throw new Error('The fixture lists no page')
    expect(await current.manager.render('window-a', operationId, {
      kind: 'listed-page',
      pageId: page.pageId,
    })).toMatchObject({ ok: true })
  })

  it('previews a listed page as bytes, imports nothing and leaves the operation usable', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')
    expect((await current.manager.listOpenDocument('window-a', operationId)).ok).toBe(true)

    const preview = await current.manager.preview('window-a', operationId, {
      kind: 'listed-page',
      pageId: 'page-1',
    })

    expect(preview.ok).toBe(true)
    if (!preview.ok) throw new Error(preview.detail)
    expect(preview.value).toMatchObject({
      pngBase64: Buffer.from([137, 80, 78, 71]).toString('base64'),
      width: 360,
      height: 480,
      pageNumber: 1,
    })
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')
      .map((call) => call.width)).toEqual([360])
    expect(existsSync(join(root, 'imports'))).toBe(false)

    expect(await current.manager.render('window-a', operationId, {
      kind: 'listed-page',
      pageId: 'page-1',
    })).toMatchObject({ ok: true })
  })

  /** A preview is a picture the user asked to look at; failing to draw it decides nothing. */
  it('spends no attempt on previews, however many of them fail', async () => {
    const current = fixture({
      renderArchive: async (documentId, pageId, archivePath, outputPath, _signal, width) =>
        width === undefined
          ? rendered(outputPath, archivePath, documentId, pageId, 1)
          : failure('device-sleeping', true),
    })
    const operationId = await start(current.manager, 'window-a')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await current.manager.preview('window-a', operationId, { kind: 'current' }))
        .toMatchObject({ ok: false, code: 'device-sleeping' })
    }

    expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: true })
  })

  it('does not create an operation when createRun retention cleanup fails', async () => {
    const current = fixture({})
    current.runStore.createRunFailure = new Error('retention cleanup failed')

    expect(await current.manager.startOperation('window-a', 's-1'))
      .toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(existsSync(join(root, 'runs'))).toBe(false)
    expect(current.cli.calls).toEqual([])
    expect(current.runStore.releases).toEqual([])

    current.runStore.createRunFailure = null
    const operationId = await start(current.manager, 'window-a')
    expect(current.runStore.runExists(operationId)).toBe(true)
  })

  it('keeps the listed document ID, archive and page IDs stable after the tablet changes', async () => {
    const pages: RemarkablePageChoice[] = [
      { pageId: 'listed-page', number: 4, template: 'Grid', modified: true },
    ]
    const behavior: FakeCliBehavior = {
      currentDocument: async () => ({
        ok: true,
        value: {
          documentId: 'document-snapshot', name: 'Stable notebook', pageId: 'page-4', pageNumber: 4,
        },
      }),
      listPages: async (documentId, backupDirectory) => ({
        ok: true,
        value: {
          documentId,
          archivePath: join(backupDirectory, 'snapshot.rmdoc'),
          downloaded: true,
          pages,
        },
      }),
      renderArchive: async (documentId, pageId, archivePath, outputPath) =>
        rendered(outputPath, archivePath, documentId, pageId, 4),
    }
    const current = fixture(behavior)
    const operationId = await start(current.manager, 'window-a')
    const listed = await current.manager.listOpenDocument('window-a', operationId)
    expect(listed).toMatchObject({
      ok: true,
      value: { documentName: 'Stable notebook', currentPageNumber: 4 },
    })
    const listCall = current.cli.calls.find((call) => call.kind === 'listPages')
    expect(listCall?.documentId).toBe('document-snapshot')
    const archivePath = listCall?.backupDirectory === undefined
      ? ''
      : join(listCall.backupDirectory, 'snapshot.rmdoc')

    pages[0] = { pageId: 'tablet-changed-page', number: 8, template: null, modified: false }
    behavior.currentDocument = async () => ({
      ok: true,
      value: { documentId: 'different-document', name: 'Different', pageId: 'page-1', pageNumber: 1 },
    })
    const renderedPage = await current.manager.render(
      'window-a',
      operationId,
      { kind: 'listed-page', pageId: 'listed-page' },
    )

    expect(renderedPage).toMatchObject({
      ok: true,
      value: { documentName: 'Stable notebook', pageNumber: 4 },
    })
    const renderCall = current.cli.calls.find((call) => call.kind === 'renderArchive')
    expect(renderCall).toMatchObject({
      documentId: 'document-snapshot',
      pageId: 'listed-page',
      archivePath,
    })
    expect(current.cli.calls.filter((call) => call.kind === 'currentDocument')).toHaveLength(1)
  })

  /**
   * The tablet is asked what is open, and the document downloaded, ONCE per operation. Measured on
   * a real device those two calls are ~3.6 s of the ~4.5 s a current-page preview took, and the
   * insert right after it paid them again for a document that had not moved.
   */
  it('asks the tablet once, however many times the current page is drawn', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')

    expect((await current.manager.preview('window-a', operationId, { kind: 'current' })).ok)
      .toBe(true)
    expect((await current.manager.preview('window-a', operationId, { kind: 'current' })).ok)
      .toBe(true)
    expect((await current.manager.render('window-a', operationId, { kind: 'current' })).ok)
      .toBe(true)

    expect(current.cli.calls.map((call) => call.kind)).toEqual([
      'currentDocument', 'listPages', 'renderArchive', 'renderArchive', 'renderArchive',
    ])
    // The preview asks for a width and the import does not; all three read one archive.
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive').map((call) => call.width))
      .toEqual([360, 360, undefined])
  })

  /**
   * Required rather than tidy: after a current-page render the operation is already listed, and the
   * card answers `no-open-page` by asking for exactly these pages. Refusing the second call left
   * that fallback with nothing to show.
   */
  it('answers a second listing with the snapshot it already holds', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')

    const first = await current.manager.listOpenDocument('window-a', operationId)
    const second = await current.manager.listOpenDocument('window-a', operationId)

    expect(second).toEqual(first)
    expect(current.cli.calls.filter((call) => call.kind === 'currentDocument')).toHaveLength(1)
    expect(current.cli.calls.filter((call) => call.kind === 'listPages')).toHaveLength(1)
  })

  /**
   * A page id the archive does not hold would render nothing, so it is not carried as the open page.
   * The document still lists, which is what the card offers next.
   */
  it('refuses an open page the downloaded document does not contain', async () => {
    const current = fixture({
      currentDocument: async () => ({
        ok: true,
        value: { documentId: 'document-1', name: 'Notebook', pageId: 'ghost-page', pageNumber: 3 },
      }),
    })
    const operationId = await start(current.manager, 'window-a')

    expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'no-open-page' })
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')).toEqual([])
    const listed = await current.manager.listOpenDocument('window-a', operationId)
    expect(listed).toMatchObject({ ok: true, value: { currentPageNumber: 3 } })
  })
  it('refuses a page ID outside the stored list without calling the renderer', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')
    expect((await current.manager.listOpenDocument('window-a', operationId)).ok).toBe(true)

    expect(await current.manager.render(
      'window-a',
      operationId,
      { kind: 'listed-page', pageId: 'forged-page' },
    )).toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')).toEqual([])
  })

  it('cancels one operation during its child and another before its queued child starts', async () => {
    const entered = new Deferred<void>()
    const settled = new Deferred<void>()
    const current = fixture({
      renderArchive: async (_documentId, _pageId, _archivePath, _outputPath, signal) => {
        entered.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await settled.promise
        return failure('cancelled', false)
      },
    })
    const firstOperation = await start(current.manager, 'window-a')
    const secondOperation = await start(current.manager, 'window-b')
    const first = current.manager.render('window-a', firstOperation, { kind: 'current' })
    await entered.promise
    const second = current.manager.render('window-b', secondOperation, { kind: 'current' })
    const releaseSecond = current.manager.release('window-b', secondOperation)
    const releaseFirst = current.manager.release('window-a', firstOperation)
    settled.resolve(undefined)

    expect(await first).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await second).toMatchObject({ ok: false, code: 'cancelled' })
    await Promise.all([releaseFirst, releaseSecond])
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')).toHaveLength(1)
  })

  it('does not return a late output after release but keeps an already verified PNG import', async () => {
    const current = fixture({})
    const operationId = await start(current.manager, 'window-a')
    const pause = current.runStore.pauseAfterPromotion()
    const rendering = current.manager.render('window-a', operationId, { kind: 'current' })
    await pause.reached
    const releasing = current.manager.release('window-a', operationId)
    pause.proceed()

    expect(await rendering).toMatchObject({ ok: false, code: 'cancelled' })
    await releasing
    const imports = current.runStore.imports()
    expect(imports).toHaveLength(1)
    expect(existsSync(imports[0] ?? '')).toBe(true)
    expect(current.runStore.runExists(operationId)).toBe(false)
  })

  /**
   * The window names a session, never a directory: what turns that session into a folder is the
   * session manager and the saved relative path, neither of which the renderer can reach.
   */
  it('stores a page in the project and answers a path relative to the session', async () => {
    const project = join(root, "project")
    const current = fixture({}, {
      storage: { scope: 'project', projectDirectory: '.aidocs/remarkable' },
    })
    const operationId = await start(current.manager, 'window-a')

    const result = await current.manager.render('window-a', operationId, { kind: 'current' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.value.insertText).toMatch(/^\.aidocs[/\\]remarkable[/\\]remarkable-.+\.png$/)
    expect(result.value.outputPath).toBe(join(project, result.value.insertText))
    expect(existsSync(result.value.outputPath)).toBe(true)
    // One page still means one file: the machine-local copy is dropped once the project has it.
    expect(current.runStore.forgotten).toHaveLength(1)
    expect(current.runStore.imports()).toEqual([])
  })

  it('refuses project storage when the session no longer has a working context', async () => {
    const current = fixture({}, {
      storage: { scope: 'project', projectDirectory: '.aidocs/remarkable' },
      workingContext: () => ({ ok: false, code: 'unknown-session', detail: 'gone' }),
    })

    const started = await current.manager.startOperation('window-a', 's-1')
    expect(started).toMatchObject({ ok: false, code: 'invalid-operation' })
    expect(existsSync(join(root, 'runs'))).toBe(false)
  })
  /**
   * A sleeping tablet is a state outside this app that the user fixes by waking it, and every
   * attempt is a click. Counting these made the card refuse the third one and tell the user to
   * close it and open it again, which starts the very same operation over.
   */
  it('stays usable however many times the tablet refuses it', async () => {
    const current = fixture({
      renderArchive: async () => failure('device-busy', true),
    })
    const operationId = await start(current.manager, 'window-a')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
        .toMatchObject({ ok: false, code: 'device-busy', retryable: true })
    }
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')).toHaveLength(5)
  })

  /**
   * The other half of the same rule: a failure trying again cannot fix stops the operation on the
   * spot, so the card says what is wrong instead of asking the tablet four more times.
   */
  it('stops the operation on a failure that trying again cannot fix', async () => {
    const current = fixture({
      renderArchive: async () => failure('invalid-cli-output', false),
    })
    const operationId = await start(current.manager, 'window-a')

    expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })
    expect(await current.manager.render('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'invalid-operation', retryable: false })
    expect(await current.manager.preview('window-a', operationId, { kind: 'current' }))
      .toMatchObject({ ok: false, code: 'invalid-operation', retryable: false })
    expect(current.cli.calls.filter((call) => call.kind === 'renderArchive')).toHaveLength(1)
  })

  it('aborts a live child, waits for it to settle and releases every run during stop', async () => {
    const entered = new Deferred<void>()
    const abortSeen = new Deferred<void>()
    const settle = new Deferred<void>()
    const current = fixture({
      renderArchive: async (_documentId, _pageId, _archivePath, _outputPath, signal) => {
        entered.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        abortSeen.resolve(undefined)
        await settle.promise
        return failure('cancelled', false)
      },
    })
    const operationId = await start(current.manager, 'window-a')
    const rendering = current.manager.render('window-a', operationId, { kind: 'current' })
    await entered.promise
    let stopped = false
    const stopping = current.manager.stop().then(() => { stopped = true })
    await abortSeen.promise
    await Promise.resolve()
    expect(stopped).toBe(false)

    settle.resolve(undefined)
    expect(await rendering).toMatchObject({ ok: false, code: 'cancelled' })
    await stopping
    expect(stopped).toBe(true)
    expect(current.runStore.runExists(operationId)).toBe(false)
    expect(current.runStore.releases).toEqual([operationId])
  })

  it('aborts install publication but waits for its atomic copy before stop settles', async () => {
    const current = fixture({})
    const copy = new Deferred<void>()
    current.installer.gate = copy
    const installing = current.manager.installDependencies('window-a')
    await waitFor(() => current.installer.calls.length === 1)
    let stopped = false
    const stopping = current.manager.stop().then(() => { stopped = true })

    expect(current.installer.signals[0]?.aborted).toBe(true)
    await Promise.resolve()
    expect(stopped).toBe(false)
    copy.resolve(undefined)
    expect(await installing).toMatchObject({ ok: false, code: 'cancelled' })
    await stopping
    expect(stopped).toBe(true)
  })

  interface FixtureOptions {
    storage?: RemarkableStorageSettingsValue
    workingContext?: (sessionId: string) => SessionWorkingContextResult
  }

  function fixture(behavior: FakeCliBehavior, options?: FixtureOptions): {
    manager: RemarkableManager
    cli: FakeCli
    installer: FakeInstaller
    runStore: TestRunStore
  } {
    let sequence = 0
    const cli = new FakeCli(behavior)
    const installer = new FakeInstaller()
    const runStore = new TestRunStore(root, () => `id-${++sequence}`)
    const settings: RemarkableSettingsValue = {
      host: '10.0.0.2',
      fingerprint: `SHA256:${'A'.repeat(43)}`,
      timeoutMilliseconds: 180_000,
    }
    const storage: RemarkableStorageSettingsValue = options?.storage
      ?? { scope: 'global', projectDirectory: '.remarkable' }
    const workingContext = options?.workingContext
      ?? ((sessionId: string): SessionWorkingContextResult =>
        ({
          ok: true,
          value: { sessionId, cwd: join(root, 'project'), agent: null, worktree: null },
        }))
    const manager = new RemarkableManager({
      readSettings: () => settings,
      readStorage: () => storage,
      workingContext: async (sessionId) => workingContext(sessionId),
      credentialStore: {
        passwordFor: async () => ({ ok: true, value: 'secret-value' }),
      },
      installer,
      cli,
      runStore,
    })
    managers.push(manager)
    return { manager, cli, installer, runStore }
  }

  async function start(manager: RemarkableManager, ownerId: string): Promise<string> {
    const result = await manager.startOperation(ownerId, 's-1')
    if (!result.ok) throw new Error(result.detail)
    return result.value.operationId
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error('Timed out waiting for the manager test condition')
  }

  function rendered(
    outputPath: string,
    archivePath: string,
    documentId: string,
    pageId: string,
    pageNumber: number,
  ): RemarkableResult<RemarkableCliRender> {
    const bytes = Buffer.from([137, 80, 78, 71])
    writeFileSync(outputPath, bytes)
    return {
      ok: true,
      value: {
        documentId,
        pageId,
        archivePath,
        outputPath,
        outputBytes: bytes.length,
        pageNumber,
        png: { width: 360, height: 480 },
      },
    }
  }

  function failure(
    code: 'cancelled' | 'device-busy' | 'device-sleeping' | 'invalid-cli-output' | 'no-open-page'
      | 'nothing-open',
    retryable: boolean,
  ): RemarkableResult<never> {
    return { ok: false, code, detail: code, retryable }
  }
})
