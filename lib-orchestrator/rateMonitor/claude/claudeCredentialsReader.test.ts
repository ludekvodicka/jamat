import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeCredentialsReader } from './claudeCredentialsReader'

describe('lib-orchestrator/rateMonitor/claude/claudeCredentialsReader', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function home(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-claude-credentials-'))
    created.push(directory)
    return directory
  }

  function write(directory: string, content: string): string {
    writeFileSync(join(directory, '.credentials.json'), content, 'utf8')
    return directory
  }

  function writeLogin(directory: string, oauth: Record<string, unknown>): string {
    return write(directory, JSON.stringify({ claudeAiOauth: oauth }))
  }

  it('reads the access token and its expiry', async () => {
    const directory = writeLogin(home(), {
      accessToken: 'sk-ant-oat-token',
      expiresAt: 1_700_000_000_000,
    })

    expect(await new ClaudeCredentialsReader(directory).read()).toEqual({
      kind: 'ok',
      accessToken: 'sk-ant-oat-token',
      expiresAt: 1_700_000_000_000,
    })
  })

  // The whole point of the reader: what the file holds beside those two fields stays in the file.
  it('answers with those two fields and nothing else the file happened to hold', async () => {
    const directory = writeLogin(home(), {
      accessToken: 'sk-ant-oat-token',
      refreshToken: 'sk-ant-ort-refresh',
      expiresAt: 1_700_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const reading = await new ClaudeCredentialsReader(directory).read()
    expect(Object.keys(reading).sort()).toEqual(['accessToken', 'expiresAt', 'kind'])
  })

  it('treats an expiry it cannot read as no expiry', async () => {
    const directory = writeLogin(home(), { accessToken: 'sk-ant-oat-token', expiresAt: 'soon' })

    expect(await new ClaudeCredentialsReader(directory).read()).toEqual({
      kind: 'ok',
      accessToken: 'sk-ant-oat-token',
      expiresAt: null,
    })
  })

  it('reports a machine that never logged in, naming the file it looked for', async () => {
    const directory = home()

    expect(await new ClaudeCredentialsReader(directory).read()).toEqual({
      kind: 'missing',
      reason: expect.stringContaining(join(directory, '.credentials.json')),
    })
  })

  // An API-key login writes the file without that section, and it is a different thing to be told.
  it('separates an API-key login from a missing file', async () => {
    const directory = write(home(), JSON.stringify({ apiKeyHelper: 'echo a-key' }))

    expect(await new ClaudeCredentialsReader(directory).read()).toEqual({
      kind: 'missing',
      reason: expect.stringContaining('claudeAiOauth'),
    })
  })

  it('treats a damaged file as no login rather than as a failure', async () => {
    const directory = write(home(), '{ "claudeAiOauth": ')

    expect((await new ClaudeCredentialsReader(directory).read()).kind).toBe('missing')
  })

  /**
   * The one demonstrated way a token could leave this subsystem. `fetch` refuses a header value
   * holding a CR or a NUL BEFORE it sends anything, and the error it throws quotes the whole value -
   * which `ErrorText.of` keeps whole, and a tooltip then draws. A token that cannot be spent is
   * refused where it is read, and the value itself is never part of the answer.
   */
  it('refuses a token that is not visible ASCII, without quoting it', async () => {
    const injected = 'sk-ant-oat01-SECRET\r\nX-Injected: 1'
    const directory = writeLogin(home(), { accessToken: injected, expiresAt: 1_700_000_000_000 })

    const reading = await new ClaudeCredentialsReader(directory).read()

    expect(reading.kind).toBe('missing')
    expect(JSON.stringify(reading)).not.toContain('SECRET')
    if (reading.kind !== 'missing') throw new Error('a corrupt token was read as a login')
    expect(reading.reason).toContain('corrupt')
  })

  it('accepts a token holding the punctuation a real one carries', async () => {
    const directory = writeLogin(home(), { accessToken: 'sk-ant-oat01-Ab_9.x/y+z=', expiresAt: 1 })

    expect((await new ClaudeCredentialsReader(directory).read()).kind).toBe('ok')
  })

  it('treats a section without an access token as no login', async () => {
    const directory = writeLogin(home(), { refreshToken: 'sk-ant-ort-refresh', expiresAt: 1 })

    expect(await new ClaudeCredentialsReader(directory).read()).toEqual({
      kind: 'missing',
      reason: expect.stringContaining('no OAuth access token'),
    })
  })
})
