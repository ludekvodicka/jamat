import { isAbsolute, relative, resolve, sep } from 'node:path'

import { CommandInvoker } from '../../../../lib-orchestrator/shared/commandInvoker'
import type {
  CommandFailure,
  CommandInvocation,
  CommandOutcome,
} from '../../../../lib-orchestrator/shared/commandInvoker.types'
import { JsonShape } from '../../../../lib-orchestrator/shared/jsonShape'
import type {
  RemarkableErrorCode,
  RemarkablePageChoice,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import { RemarkableSettings, type RemarkableSettingsValue } from '../../../shared/remarkableSettings'
import type { RemarkableSidecarExecutable } from './remarkableSidecarInstaller'

export interface RemarkableAuth {
  settings: RemarkableSettingsValue
  password: string
}

export interface RemarkableCliCurrentDocument {
  documentId: string
  name: string
  pageId: string | null
  pageNumber: number | null
}

export interface RemarkableCliPageList {
  documentId: string
  archivePath: string
  downloaded: boolean
  pages: readonly RemarkablePageChoice[]
}

export interface RemarkableCliRender {
  documentId: string
  pageId: string
  pageNumber: number
  archivePath: string
  outputPath: string
  outputBytes: number
  /** Kept rather than only validated: a preview draws the image and needs its size. */
  png: { width: number; height: number }
}

export interface RemarkableCliOptions {
  executable: { executable(): Promise<RemarkableResult<RemarkableSidecarExecutable>> }
  invoker?: { run(invocation: CommandInvocation): Promise<CommandOutcome> }
}

type RemarkableCliSymptom =
  | 'busy'
  | 'host-key-changed'
  | 'nothing-open'
  | 'unreachable'
  | 'unknown'
  | 'web-interface'

export class RemarkableCli {
  private readonly invoker: { run(invocation: CommandInvocation): Promise<CommandOutcome> }

  constructor(private readonly options: RemarkableCliOptions) {
    this.invoker = options.invoker ?? new CommandInvoker()
  }

  async detectFingerprint(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult<{ host: string; fingerprint: string }>> {
    if (!RemarkableSettings.isValidHost(settings.host)
      || !RemarkableSettings.isValidTimeout(settings.timeoutMilliseconds))
      return RemarkableCli.failure('settings-incomplete', 'A reMarkable host and timeout are required')
    if (!password) return RemarkableCli.failure('password-missing', 'A reMarkable password is required')
    const outcome = await this.execute(
      ['device', 'fingerprint', '--json'],
      RemarkableCli.cleanEnvironment({
        RMCLI_HOST: settings.host,
        RMCLI_PASSWORD: password,
        RMCLI_TIMEOUT_MS: String(settings.timeoutMilliseconds),
      }),
      undefined,
      signal,
    )
    if (!outcome.ok) return outcome
    try {
      const value = RemarkableCli.record(outcome.value, 'fingerprint', ['fingerprint', 'host'])
      if (value['host'] !== settings.host || !RemarkableSettings.isValidFingerprint(value['fingerprint']))
        throw new Error('The fingerprint result does not match the requested host')
      return { ok: true, value: { host: value['host'], fingerprint: value['fingerprint'] } }
    } catch { return RemarkableCli.invalidOutput() }
  }

  async status(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult> {
    const env = RemarkableCli.deviceEnvironment(settings, password)
    if (!env.ok) return env
    const outcome = await this.execute(['documents', 'list', '--json'], env.value, undefined, signal)
    if (!outcome.ok) return outcome
    try {
      if (!Array.isArray(outcome.value)) throw new Error('The document listing is not an array')
      outcome.value.forEach((document, index) => RemarkableCli.documentOf(document, index))
      return { ok: true, value: undefined }
    } catch { return RemarkableCli.invalidOutput() }
  }

  async currentDocument(
    settings: RemarkableSettingsValue,
    password: string,
    signal: AbortSignal,
  ): Promise<RemarkableResult<RemarkableCliCurrentDocument>> {
    const env = RemarkableCli.deviceEnvironment(settings, password)
    if (!env.ok) return env
    const outcome = await this.execute(['documents', 'current', '--json'], env.value, undefined, signal)
    if (!outcome.ok) return outcome
    try {
      const value = RemarkableCli.record(outcome.value, 'current document', [
        'documentId', 'name', 'observedAt', 'pageCount', 'pageId', 'pageIndex', 'pageNumber',
        'pageSource',
      ])
      if (value['documentId'] === null)
        return RemarkableCli.failure('nothing-open', 'Nothing is open on the reMarkable tablet')
      if (!RemarkableCli.nonempty(value['documentId'])
        || !(value['name'] === null || RemarkableCli.nonempty(value['name']))
        || !RemarkableCli.positive(value['pageCount'])
        || !RemarkableCli.nonempty(value['observedAt']))
        throw new Error('The current document shape is invalid')
      return {
        ok: true,
        value: {
          documentId: value['documentId'],
          name: value['name'] ?? value['documentId'],
          ...RemarkableCli.openPageOf(value),
        },
      }
    } catch { return RemarkableCli.invalidOutput() }
  }

  async listPages(
    documentId: string,
    backupDirectory: string,
    auth: RemarkableAuth,
    signal: AbortSignal,
  ): Promise<RemarkableResult<RemarkableCliPageList>> {
    const env = RemarkableCli.deviceEnvironment(auth.settings, auth.password)
    if (!env.ok) return env
    if (!RemarkableCli.nonempty(documentId) || !isAbsolute(backupDirectory))
      return RemarkableCli.failure('invalid-operation', 'The reMarkable page-list request is invalid')
    const outcome = await this.execute(
      ['pages', 'list', documentId, '--backup-dir', backupDirectory, '--json'],
      env.value,
      backupDirectory,
      signal,
    )
    if (!outcome.ok) return outcome
    try {
      const value = RemarkableCli.record(outcome.value, 'page list', [
        'archivePath', 'documentId', 'downloaded', 'pages',
      ])
      if (value['documentId'] !== documentId
        || typeof value['downloaded'] !== 'boolean'
        || !RemarkableCli.contained(backupDirectory, value['archivePath'])
        || !String(value['archivePath']).toLowerCase().endsWith('.rmdoc')
        || !Array.isArray(value['pages']))
        throw new Error('The page-list shape is invalid')
      const pages = value['pages'].map((page, index) => RemarkableCli.pageOf(page, index))
      if (pages.length === 0
        || new Set(pages.map((page) => page.pageId)).size !== pages.length
        || new Set(pages.map((page) => page.number)).size !== pages.length)
        throw new Error('The page-list entries are invalid')
      return {
        ok: true,
        value: {
          documentId,
          archivePath: value['archivePath'],
          downloaded: value['downloaded'],
          pages,
        },
      }
    } catch { return RemarkableCli.invalidOutput() }
  }

  async renderArchive(
    documentId: string,
    pageId: string,
    archive: string,
    output: string,
    signal: AbortSignal,
    width?: number,
  ): Promise<RemarkableResult<RemarkableCliRender>> {
    if (![documentId, pageId, archive, output].every((value) => RemarkableCli.nonempty(value))
      || !isAbsolute(archive)
      || !isAbsolute(output)
      || width !== undefined && !RemarkableCli.isRenderWidth(width))
      return RemarkableCli.failure('invalid-operation', 'The local reMarkable render request is invalid')
    const outcome = await this.execute(
      [
        'pages', 'render', documentId, pageId, '--archive', archive, '--output', output,
        ...(width === undefined ? [] : ['--width', String(width)]),
        '--json',
      ],
      RemarkableCli.cleanEnvironment({ RMCLI_HOST: 'jamat-local-archive' }),
      resolve(output, '..'),
      signal,
    )
    if (!outcome.ok) return outcome
    const rendered = RemarkableCli.renderOf(outcome.value, output)
    if (!rendered.ok) return rendered
    return rendered.value.documentId === documentId
      && rendered.value.pageId === pageId
      && rendered.value.archivePath === archive
      ? rendered
      : RemarkableCli.invalidOutput()
  }

  private async execute(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<RemarkableResult<unknown>> {
    const installed = await this.options.executable.executable()
    if (!installed.ok) return installed
    if (!isAbsolute(installed.value.node) || !isAbsolute(installed.value.entry))
      return RemarkableCli.failure('sidecar-damaged', 'The installed reMarkable executable paths are invalid')
    const outcome = await this.invoker.run({
      command: installed.value.node,
      args: [installed.value.entry, ...args],
      cwd: cwd ?? resolve(installed.value.node, '..'),
      env,
      signal,
    })
    if (outcome.failure !== null) return RemarkableCli.commandFailure(outcome.failure)
    if (outcome.code !== 0) return RemarkableCli.cliFailure(outcome.stderr, env['RMCLI_PASSWORD'])
    try {
      if (!outcome.stdout.trim()) throw new Error('empty')
      return { ok: true, value: JSON.parse(outcome.stdout) as unknown }
    } catch { return RemarkableCli.invalidOutput() }
  }

  private static renderOf(value: unknown, output: string): RemarkableResult<RemarkableCliRender> {
    try {
      const root = RemarkableCli.record(value, 'render result', [
        'archivePath', 'documentId', 'outputBytes', 'outputPath', 'pageId', 'pageNumber', 'png',
        'revision', 'svg', 'template', 'templateWarnings',
      ])
      const svg = RemarkableCli.record(root['svg'], 'render SVG', ['height', 'width'])
      const png = RemarkableCli.record(root['png'], 'render PNG', ['height', 'width'])
      if (!RemarkableCli.nonempty(root['documentId'])
        || !RemarkableCli.nonempty(root['pageId'])
        || !RemarkableCli.positive(root['pageNumber'])
        || !(root['template'] === null || typeof root['template'] === 'string')
        || !RemarkableCli.nonempty(root['revision'])
        || !RemarkableCli.nonempty(root['archivePath'])
        || !isAbsolute(root['archivePath'])
        || root['outputPath'] !== output
        || !RemarkableCli.positive(root['outputBytes'])
        || !RemarkableCli.positive(svg['width'])
        || !RemarkableCli.positive(svg['height'])
        || !RemarkableCli.positive(png['width'])
        || !RemarkableCli.positive(png['height'])
        || !Array.isArray(root['templateWarnings'])
        || !root['templateWarnings'].every((warning) => typeof warning === 'string'))
        throw new Error('The render shape is invalid')
      return {
        ok: true,
        value: {
          documentId: root['documentId'],
          pageId: root['pageId'],
          pageNumber: root['pageNumber'],
          archivePath: root['archivePath'],
          outputPath: root['outputPath'],
          outputBytes: root['outputBytes'],
          png: { width: png['width'], height: png['height'] },
        },
      }
    } catch { return RemarkableCli.invalidOutput() }
  }

  /**
   * Since rmcommunication-ts 0.2.3 the open page is resolved down a ladder - the live pointer in
   * `cPages.lastOpened`, then the page saved in the document metadata, then the single page of a
   * one-page document - and `pageSource` names the step that answered. The four fields answer
   * together: a named page carries the source that named it, and a document no step answers for
   * carries four nulls. That last state is real rather than broken output, so the caller is told
   * the page is unknown instead of being told the CLI failed. Any other mixture stays invalid:
   * half an identified page is an answer nobody can act on.
   */
  private static openPageOf(
    value: Record<string, unknown>,
  ): Pick<RemarkableCliCurrentDocument, 'pageId' | 'pageNumber'> {
    const pageId = value['pageId']
    const pageNumber = value['pageNumber']
    const pageIndex = value['pageIndex']
    const pageSource = value['pageSource']
    if (RemarkableCli.nonempty(pageId)
      && RemarkableCli.positive(pageNumber)
      && RemarkableCli.nonnegative(pageIndex)
      && RemarkableCli.pageSource(pageSource))
      return { pageId, pageNumber }
    if (pageId === null && pageNumber === null && pageIndex === null && pageSource === null)
      return { pageId: null, pageNumber: null }
    throw new Error('The current document page shape is invalid')
  }

  private static pageSource(value: unknown): boolean {
    return value === 'content' || value === 'metadata' || value === 'only-page'
  }

  private static pageOf(value: unknown, index: number): RemarkablePageChoice {
    const page = RemarkableCli.record(value, `page ${index}`, [
      'id', 'idx', 'index', 'modified', 'modifiedMs', 'number', 'template',
    ])
    if (!RemarkableCli.nonempty(page['id'])
      || !RemarkableCli.positive(page['number'])
      || !RemarkableCli.nonnegative(page['index'])
      || !(page['idx'] === null || typeof page['idx'] === 'string')
      || !(page['template'] === null || typeof page['template'] === 'string')
      || !(page['modifiedMs'] === null || RemarkableCli.nonnegative(page['modifiedMs']))
      || !(page['modified'] === null || typeof page['modified'] === 'string'))
      throw new Error('The page shape is invalid')
    return {
      pageId: page['id'],
      number: page['number'],
      template: page['template'],
      modified: page['modified'] !== null,
    }
  }

  private static documentOf(value: unknown, index: number): void {
    const document = RemarkableCli.record(value, `document ${index}`, [
      'bookmarked', 'currentPageNumber', 'fileType', 'id', 'modified', 'modifiedMs', 'name',
      'parentId', 'type',
    ])
    if (!RemarkableCli.nonempty(document['id'])
      || !RemarkableCli.nonempty(document['name'])
      || !['document', 'folder'].includes(String(document['type']))
      || !(document['fileType'] === null || RemarkableCli.nonempty(document['fileType']))
      || !(document['parentId'] === null || RemarkableCli.nonempty(document['parentId']))
      || typeof document['bookmarked'] !== 'boolean'
      || !(document['currentPageNumber'] === null || RemarkableCli.positive(document['currentPageNumber']))
      || !(document['modifiedMs'] === null || RemarkableCli.nonnegative(document['modifiedMs']))
      || !(document['modified'] === null || RemarkableCli.nonempty(document['modified'])))
      throw new Error('The document-list entry is invalid')
  }

  private static deviceEnvironment(
    settings: RemarkableSettingsValue,
    password: string,
  ): RemarkableResult<NodeJS.ProcessEnv> {
    if (!RemarkableSettings.isValid(settings)
      || !RemarkableSettings.isValidHost(settings.host)
      || !RemarkableSettings.isValidFingerprint(settings.fingerprint))
      return RemarkableCli.failure('settings-incomplete', 'Complete the reMarkable host and fingerprint settings')
    if (!password) return RemarkableCli.failure('password-missing', 'No reMarkable password is configured')
    return {
      ok: true,
      value: RemarkableCli.cleanEnvironment({
        RMCLI_HOST: settings.host,
        RMCLI_FINGERPRINT: settings.fingerprint,
        RMCLI_PASSWORD: password,
        RMCLI_TIMEOUT_MS: String(settings.timeoutMilliseconds),
      }),
    }
  }

  private static cleanEnvironment(values: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      const name = key.toUpperCase()
      if (!name.startsWith('RMCLI_')
        && name !== 'NODE_OPTIONS'
        && name !== 'NODE_PATH'
        && name !== 'PATH') env[key] = value
    }
    env.PATH = ''
    for (const [key, value] of Object.entries(values)) env[key] = value
    return env
  }

  private static commandFailure(failure: CommandFailure): RemarkableResult<never> {
    if (failure === 'aborted') return RemarkableCli.failure('cancelled', 'The reMarkable operation was cancelled')
    else if (failure === 'timeout') return RemarkableCli.failure('timeout', 'The reMarkable operation timed out')
    else if (failure === 'output-limit') return RemarkableCli.invalidOutput()
    else if (failure === 'command-missing'
      || failure === 'cwd-missing'
      || failure === 'spawn-failed')
      return RemarkableCli.failure('sidecar-damaged', 'The reMarkable sidecar could not be started')
    else {
      const unhandled: never = failure
      throw new Error(`Unknown command failure: ${JSON.stringify(unhandled)}`)
    }
  }

  private static cliFailure(stderr: string, password: string | undefined): RemarkableResult<never> {
    const detail = RemarkableCli.sanitize(stderr, password)
    const symptom = RemarkableCli.symptomOf(detail)
    try {
      if (symptom === 'busy') return RemarkableCli.failure('device-busy', detail, true)
      else if (symptom === 'host-key-changed') return RemarkableCli.failure('host-key-changed', detail)
      else if (symptom === 'nothing-open') return RemarkableCli.failure('nothing-open', detail)
      else if (symptom === 'unreachable') return RemarkableCli.failure('device-unreachable', detail, true)
      else if (symptom === 'web-interface')
        return RemarkableCli.failure('web-interface-unavailable', detail)
      else if (symptom === 'unknown') throw new Error('Unknown remarkable-cli stderr')
      else {
        const unhandled: never = symptom
        throw new Error(`Unknown reMarkable CLI symptom: ${JSON.stringify(unhandled)}`)
      }
    } catch {
      return RemarkableCli.failure('cli-failed', detail || 'The reMarkable CLI failed')
    }
  }

  private static symptomOf(detail: string): RemarkableCliSymptom {
    if (/Another rmcli run(?: \(PID \d+\))? holds the lock/.test(detail)) return 'busy'
    if (/Host key for .+ changed from SHA256:.+ to SHA256:/.test(detail)) return 'host-key-changed'
    if (detail.includes('Nothing is open on the tablet')) return 'nothing-open'
    // Connection failures cannot distinguish sleep from a changed IP or an unavailable network.
    if (detail.includes('SSH connection timed out')
      || /Cannot connect to .+(?:timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENOTFOUND|ECONNRESET)/i
        .test(detail)) return 'unreachable'
    if (detail.includes('Web Interface')
      || /Device .+ is offline or its WiFi SSH tunnel is unavailable/.test(detail)) return 'web-interface'
    return 'unknown'
  }

  private static record(
    value: unknown,
    label: string,
    keys: readonly string[],
  ): Record<string, unknown> {
    if (!JsonShape.isRecord(value)) throw new Error(`The reMarkable CLI ${label} is not an object`)
    const actual = Object.keys(value).sort((left, right) => left.localeCompare(right))
    const expected = [...keys].sort((left, right) => left.localeCompare(right))
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
      throw new Error(`The reMarkable CLI ${label} has unexpected fields`)
    return value
  }

  private static contained(root: string, value: unknown): value is string {
    if (typeof value !== 'string' || !isAbsolute(value)) return false
    const child = relative(resolve(root), resolve(value))
    return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }

  private static nonempty(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
  }

  private static positive(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  }

  private static nonnegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  }

  /** Only a plain pixel count reaches `--width`, so no caller can put a flag in that argument. */
  private static isRenderWidth(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 64 && value <= 4_096
  }

  private static sanitize(stderr: string, password: string | undefined): string {
    const redacted = password ? stderr.replaceAll(password, '[redacted]') : stderr
    return redacted.trim().slice(0, 2_000)
  }

  private static invalidOutput<T>(): RemarkableResult<T> {
    return RemarkableCli.failure('invalid-cli-output', 'The reMarkable CLI returned invalid output')
  }

  private static failure<T>(
    code: RemarkableErrorCode,
    detail: string,
    retryable = false,
  ): RemarkableResult<T> {
    return { ok: false, code, detail, retryable }
  }
}
