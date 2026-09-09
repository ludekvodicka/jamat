import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  CommandInvocation,
  CommandOutcome,
} from '../../../../lib-orchestrator/shared/commandInvoker.types'
import type { RemarkableSettingsValue } from '../../../shared/remarkableSettings'
import { RemarkableCli } from './remarkableCli'

describe('app-client-ui/app/remarkable/sidecar/remarkableCli', () => {
  const settings: RemarkableSettingsValue = {
    host: '10.0.0.2',
    fingerprint: `SHA256:${'A'.repeat(43)}`,
    timeoutMilliseconds: 180_000,
  }

  it('puts device credentials on the two device calls and none on the local render', async () => {
    const backup = join(process.cwd(), 'scratch')
    const output = join(backup, 'page.png')
    const archive = join(backup, 'document.rmdoc')
    const fake = new FakeInvoker(
      success({
        documentId: 'document-1', name: 'Notebook', pageId: 'page-2', pageNumber: 2,
        pageIndex: 1, pageCount: 3, pageSource: 'content',
        observedAt: '2026-08-27T09:00:00.000Z',
      }),
      success({
        documentId: 'document-1', archivePath: archive, downloaded: true,
        pages: [{
          id: 'page-2', number: 2, index: 1, idx: '1', template: null,
          modifiedMs: 1_725_000_000_000, modified: '2024-08-29T08:00:00.000Z',
        }],
      }),
      success(renderResult(archive, output)),
    )
    const signal = new AbortController().signal
    const auth = { settings, password: 'secret-value' }
    const cli = current(fake)
    expect((await cli.currentDocument(settings, 'secret-value', signal)).ok).toBe(true)
    expect((await cli.listPages('document-1', backup, auth, signal)).ok).toBe(true)
    expect((await cli.renderArchive('document-1', 'page-2', archive, output, signal)).ok).toBe(true)

    expect(fake.calls).toHaveLength(3)
    expect(fake.calls.map((call) => call.args)).toEqual([
      [join(process.cwd(), 'sidecar', 'cli.js'), 'documents', 'current', '--json'],
      [
        join(process.cwd(), 'sidecar', 'cli.js'), 'pages', 'list', 'document-1',
        '--backup-dir', backup, '--json',
      ],
      [
        join(process.cwd(), 'sidecar', 'cli.js'), 'pages', 'render', 'document-1', 'page-2',
        '--archive', archive, '--output', output, '--json',
      ],
    ])
    for (const call of fake.calls.slice(0, 2)) {
      expect(call.command).toBe(join(process.cwd(), 'sidecar', 'node.exe'))
      expect(JSON.stringify(call.args)).not.toContain('secret-value')
      expect(JSON.stringify(call.args)).not.toContain(settings.fingerprint)
      expect(Object.keys(call.env).filter((key) => key.startsWith('RMCLI_')).sort()).toEqual([
        'RMCLI_FINGERPRINT', 'RMCLI_HOST', 'RMCLI_PASSWORD', 'RMCLI_TIMEOUT_MS',
      ])
      expect(call.env).toMatchObject({
        RMCLI_HOST: settings.host,
        RMCLI_FINGERPRINT: settings.fingerprint,
        RMCLI_PASSWORD: 'secret-value',
        RMCLI_TIMEOUT_MS: '180000',
      })
      expect(call.env).not.toHaveProperty('RMCLI_PASSWORD_COMMAND')
      expect(call.env).not.toHaveProperty('NODE_OPTIONS')
      expect(call.env).not.toHaveProperty('NODE_PATH')
      expect(call.signal).toBe(signal)
    }
    const localRmcli = Object.fromEntries(Object.entries(fake.calls[2]?.env ?? {})
      .filter(([key]) => key.startsWith('RMCLI_')))
    expect(localRmcli).toEqual({ RMCLI_HOST: 'jamat-local-archive' })
    expect(fake.calls[2]?.signal).toBe(signal)
  })

  it('tests the connection through one Web Interface document-list command', async () => {
    const fake = new FakeInvoker(success([
      {
        id: 'document-1', name: 'Notebook', type: 'document', fileType: 'notebook',
        parentId: 'folder-1', bookmarked: false, currentPageNumber: 2,
        modifiedMs: 1_725_000_000_000, modified: '2024-08-29T08:00:00.000Z',
      },
      {
        id: 'folder-1', name: 'Folder', type: 'folder', fileType: null,
        parentId: null, bookmarked: true, currentPageNumber: 1,
        modifiedMs: 1_725_000_000_001, modified: '2024-08-29T08:00:00.001Z',
      },
    ]))
    const result = await current(fake).status(
      settings, 'secret-value', new AbortController().signal,
    )

    expect(result).toEqual({ ok: true, value: undefined })
    expect(fake.calls[0]?.args).toEqual([
      join(process.cwd(), 'sidecar', 'cli.js'), 'documents', 'list', '--json',
    ])
  })

  it('renders an archive by page ID without device credentials', async () => {
    const archive = join(process.cwd(), 'scratch', 'document.rmdoc')
    const output = join(process.cwd(), 'scratch', 'page.png')
    const fake = new FakeInvoker(success(renderResult(archive, output, 'opaque-page-id')))
    const result = await current(fake).renderArchive(
      'document-1', 'opaque-page-id', archive, output, new AbortController().signal,
    )

    expect(result.ok).toBe(true)
    expect(fake.calls[0]?.args).toEqual([
      join(process.cwd(), 'sidecar', 'cli.js'),
      'pages', 'render', 'document-1', 'opaque-page-id',
      '--archive', archive, '--output', output, '--json',
    ])
    const rmcli = Object.fromEntries(Object.entries(fake.calls[0]?.env ?? {})
      .filter(([key]) => key.startsWith('RMCLI_')))
    expect(rmcli).toEqual({ RMCLI_HOST: 'jamat-local-archive' })
    expect(JSON.stringify(fake.calls[0]?.args)).not.toContain('RMCLI_')
  })

  it('detects a fingerprint with password authentication but without a pin or password command', async () => {
    const fake = new FakeInvoker(success({
      host: settings.host,
      fingerprint: settings.fingerprint,
    }))
    const result = await current(fake).detectFingerprint(
      { host: settings.host, timeoutMilliseconds: settings.timeoutMilliseconds },
      'secret-value',
      new AbortController().signal,
    )

    expect(result).toEqual({
      ok: true,
      value: { host: settings.host, fingerprint: settings.fingerprint },
    })
    const rmcli = Object.fromEntries(Object.entries(fake.calls[0]?.env ?? {})
      .filter(([key]) => key.startsWith('RMCLI_')))
    expect(rmcli).toEqual({
      RMCLI_HOST: settings.host,
      RMCLI_PASSWORD: 'secret-value',
      RMCLI_TIMEOUT_MS: '180000',
    })
    expect(rmcli).not.toHaveProperty('RMCLI_FINGERPRINT')
    expect(rmcli).not.toHaveProperty('RMCLI_PASSWORD_COMMAND')
  })

  /**
   * The working directory of every command is a real directory, and the password is only ever an
   * environment value. Detect once passed the password itself where the cwd belongs, which no fake
   * invoker notices and a real spawn refuses: every fingerprint detection came back as a damaged
   * sidecar, so the tablet could never be pinned from the settings tab.
   */
  it('runs every command from a directory, never from a credential', async () => {
    const sidecar = join(process.cwd(), 'sidecar')
    const backup = join(process.cwd(), 'scratch')
    const output = join(backup, 'page.png')
    const archive = join(backup, 'document.rmdoc')
    const signal = new AbortController().signal
    const fake = new FakeInvoker(
      success({ host: settings.host, fingerprint: settings.fingerprint }),
      success([]),
      success({
        documentId: 'document-1', name: 'Notebook', pageId: 'page-1', pageNumber: 1,
        pageIndex: 0, pageCount: 1, pageSource: 'content',
        observedAt: '2026-08-27T09:00:00.000Z',
      }),
      success({
        documentId: 'document-1', archivePath: archive, downloaded: true,
        pages: [{
          id: 'page-1', number: 1, index: 0, idx: '1', template: null,
          modifiedMs: 1_725_000_000_000, modified: '2024-08-29T08:00:00.000Z',
        }],
      }),
      success(renderResult(archive, output, 'page-1')),
    )
    const cli = current(fake)
    await cli.detectFingerprint(
      { host: settings.host, timeoutMilliseconds: settings.timeoutMilliseconds }, 'secret-value', signal,
    )
    await cli.status(settings, 'secret-value', signal)
    await cli.currentDocument(settings, 'secret-value', signal)
    await cli.listPages('document-1', backup, { settings, password: 'secret-value' }, signal)
    await cli.renderArchive('document-1', 'page-1', archive, output, signal)

    expect(fake.calls.map((call) => call.cwd)).toEqual([sidecar, sidecar, sidecar, backup, backup])
    for (const call of fake.calls) {
      expect(call.cwd).not.toBe('secret-value')
      expect(JSON.stringify({ command: call.command, args: call.args, cwd: call.cwd }))
        .not.toContain('secret-value')
    }
  })

  it('uses the document ID when the tablet returns a nullable document name', async () => {
    const fake = new FakeInvoker(success({
      documentId: 'document-1', name: null, pageId: 'page-2', pageNumber: 2,
      pageIndex: 1, pageCount: 3, pageSource: 'metadata',
      observedAt: '2026-08-27T09:00:00.000Z',
    }))
    const result = await current(fake).currentDocument(
      settings, 'secret-value', new AbortController().signal,
    )

    expect(result).toEqual({
      ok: true,
      value: { documentId: 'document-1', name: 'document-1', pageId: 'page-2', pageNumber: 2 },
    })
  })

  /**
   * A document no step of the ladder answers for is a real state, not broken output: the four page
   * fields go null together and the document still lists and renders. Reading that as invalid output
   * told the user the tools were broken while the tablet was merely in a state nobody described.
   */
  it('reads an open document whose page no source answers for', async () => {
    const fake = new FakeInvoker(success({
      documentId: 'document-1', name: 'Notebook', pageId: null, pageNumber: null,
      pageIndex: null, pageCount: 4, pageSource: null,
      observedAt: '2026-08-27T09:00:00.000Z',
    }))
    const result = await current(fake).currentDocument(
      settings, 'secret-value', new AbortController().signal,
    )

    expect(result).toEqual({
      ok: true,
      value: { documentId: 'document-1', name: 'Notebook', pageId: null, pageNumber: null },
    })
  })

  it('still rejects half an identified page', async () => {
    const halves = [
      { pageId: 'page-2', pageNumber: null, pageIndex: null, pageSource: null },
      { pageId: '', pageNumber: 2, pageIndex: 1, pageSource: 'content' },
      { pageId: 'page-2', pageNumber: 2, pageIndex: null, pageSource: 'content' },
      { pageId: null, pageNumber: null, pageIndex: 1, pageSource: null },
      { pageId: '', pageNumber: null, pageIndex: null, pageSource: null },
      { pageId: 'page-2', pageNumber: 2, pageIndex: 1, pageSource: null },
      { pageId: 'page-2', pageNumber: 2, pageIndex: 1, pageSource: 'guess' },
      { pageId: null, pageNumber: null, pageIndex: null, pageSource: 'content' },
    ]

    for (const half of halves) {
      const fake = new FakeInvoker(success({
        documentId: 'document-1', name: 'Notebook', pageCount: 3,
        observedAt: '2026-08-27T09:00:00.000Z', ...half,
      }))
      const result = await current(fake).currentDocument(
        settings, 'secret-value', new AbortController().signal,
      )
      expect(result, JSON.stringify(half)).toMatchObject({ ok: false, code: 'invalid-cli-output' })
    }
  })

  it('rejects trailing JSON, unexpected shapes and a mismatched output path', async () => {
    const archive = join(process.cwd(), 'scratch', 'document.rmdoc')
    const output = join(process.cwd(), 'scratch', 'page.png')
    const cases = [
      outcome(0, '{}\ntrailing', ''),
      success({ documentId: 'document-1' }),
      success(renderResult(archive, join(process.cwd(), 'other.png'))),
    ]

    for (const value of cases) {
      const result = await current(new FakeInvoker(value)).renderArchive(
        'document-1', 'page-2', archive, output, new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: false, code: 'invalid-cli-output' })
    }
  })

  it.each([
    ['Another rmcli run (PID 123) holds the lock for 10.0.0.2. Wait for it to finish.', 'device-busy'],
    ['Host key for 10.0.0.2 changed from SHA256:old to SHA256:new', 'host-key-changed'],
    ['Nothing is open on the tablet; it is showing the library list', 'nothing-open'],
    ['CommunicationError: SSH connection timed out while connecting', 'device-sleeping'],
    ['CommunicationError: Cannot connect to 10.0.0.2: connect ETIMEDOUT 10.0.0.2:22', 'device-sleeping'],
    ['CommunicationError: Cannot connect to 10.0.0.2: connect EHOSTUNREACH 10.0.0.2:22', 'device-sleeping'],
    ['CommunicationError: Cannot connect to 10.0.0.2: connect ENETUNREACH 10.0.0.2:22', 'device-sleeping'],
    ['Device 10.0.0.2 is offline or its WiFi SSH tunnel is unavailable', 'web-interface-unavailable'],
    ['unrecognized future failure secret-value', 'cli-failed'],
  ])('maps pinned stderr %s', async (stderr, code) => {
    const result = await current(new FakeInvoker(outcome(1, '', stderr))).status(
      settings, 'secret-value', new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, code })
    if (!result.ok) expect(result.detail).not.toContain('secret-value')
  })

  it('redacts a password before truncating stderr across the detail limit', async () => {
    const password = 'secret-crossing-the-limit'
    const stderr = `${'x'.repeat(1_995)}${password} trailing text`
    const result = await current(new FakeInvoker(outcome(1, '', stderr))).status(
      settings,
      password,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: false, code: 'cli-failed' })
    if (!result.ok) {
      expect(result.detail).not.toContain(password)
      expect(result.detail).not.toContain(password.slice(0, 5))
    }
  })

  it.each([
    ['timeout', 'timeout'],
    ['aborted', 'cancelled'],
    ['output-limit', 'invalid-cli-output'],
    ['spawn-failed', 'sidecar-damaged'],
  ] as const)('maps command failure %s exhaustively', async (failure, code) => {
    const result = await current(new FakeInvoker({ ...outcome(-1, '', ''), failure })).status(
      settings, 'secret-value', new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, code })
  })

  function current(fake: FakeInvoker): RemarkableCli {
    return new RemarkableCli({
      executable: {
        executable: async () => ({
          ok: true,
          value: {
            bundleId: 'win32-x64-bundle',
            node: join(process.cwd(), 'sidecar', 'node.exe'),
            entry: join(process.cwd(), 'sidecar', 'cli.js'),
          },
        }),
      },
      invoker: fake,
    })
  }

  function renderResult(archivePath: string, outputPath: string, pageId = 'page-2'): unknown {
    return {
      documentId: 'document-1', pageId, pageNumber: 2, template: null,
      revision: 'revision-1', svg: { width: 1404, height: 1872 },
      png: { width: 1404, height: 1872 }, templateWarnings: [],
      archivePath, outputPath, outputBytes: 123,
    }
  }
})

class FakeInvoker {
  readonly calls: CommandInvocation[] = []
  private readonly outcomes: CommandOutcome[]

  constructor(...outcomes: CommandOutcome[]) {
    this.outcomes = outcomes
  }

  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation)
    const next = this.outcomes.shift()
    if (next === undefined) throw new Error('No fake CommandOutcome remains')
    return next
  }
}

function success(value: unknown): CommandOutcome {
  return outcome(0, JSON.stringify(value), '')
}

function outcome(code: number, stdout: string, stderr: string): CommandOutcome {
  return { code, stdout, stderr, failure: null }
}
