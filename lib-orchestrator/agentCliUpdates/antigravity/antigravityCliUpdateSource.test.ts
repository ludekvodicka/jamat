import { describe, expect, it, vi } from 'vitest'

import { AntigravityCliUpdateSource } from './antigravityCliUpdateSource'
import type { CliUpdateCommand } from '../shared/cliUpdateCommand'
import type { ReleaseFeed } from '../shared/releaseFeed'

describe('lib-orchestrator/agentCliUpdates/antigravity/antigravityCliUpdateSource', () => {
  it('builds the release manifest URL for supported platforms and rejects unsupported ones', () => {
    expect(AntigravityCliUpdateSource.manifestUrl('win32', 'x64'))
      .toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json')
    expect(AntigravityCliUpdateSource.manifestUrl('win32', 'arm64'))
      .toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_arm64.json')
    expect(AntigravityCliUpdateSource.manifestUrl('darwin', 'arm64'))
      .toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json')
    expect(AntigravityCliUpdateSource.manifestUrl('linux', 'x64'))
      .toBe('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json')
    expect(() => AntigravityCliUpdateSource.manifestUrl('freebsd', 'x64')).toThrow(/Unsupported Antigravity CLI platform/)
    expect(() => AntigravityCliUpdateSource.manifestUrl('win32', 'ia32')).toThrow(/Unsupported Antigravity CLI architecture/)
  })

  it('inspects agy, fetches the manifest feed and delegates update to agy update', async () => {
    const installation = {
      command: { path: '/bin/agy', command: '/bin/agy', prefixArgs: [] },
      version: '1.5.15',
      channel: 'latest',
      updateSupported: true,
    }
    const commands = {
      inspect: vi.fn(async () => installation),
      update: vi.fn(async () => undefined),
    } as unknown as CliUpdateCommand
    const feed = {
      text: vi.fn(async () => JSON.stringify({
        version: '1.5.16',
        url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16/windows-x64/cli_windows_x64.exe',
        sha512: 'deadbeef',
      })),
    } as unknown as ReleaseFeed
    const source = new AntigravityCliUpdateSource(commands, feed, 'win32', 'x64')
    const signal = new AbortController().signal

    expect(await source.inspect(signal)).toEqual(installation)
    expect(commands.inspect).toHaveBeenCalledWith('agy', 'latest', /^(\S+)$/, signal)
    expect(await source.latest(installation, signal)).toBe('1.5.16')
    expect(feed.text).toHaveBeenCalledWith(
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json',
      signal,
    )
    const out = vi.fn()
    await source.update(installation, signal, out)
    expect(commands.update).toHaveBeenCalledWith(installation, signal, out)
  })

  it('rejects a manifest without a valid version string', async () => {
    const installation = {
      command: { path: '/bin/agy', command: '/bin/agy', prefixArgs: [] },
      version: '1.5.15',
      channel: 'latest',
      updateSupported: true,
    }
    const commands = {} as CliUpdateCommand
    const missingVersionFeed = { text: vi.fn(async () => '{}') } as unknown as ReleaseFeed
    const invalidVersionFeed = { text: vi.fn(async () => '{"version":"not-a-version"}') } as unknown as ReleaseFeed
    const signal = new AbortController().signal

    await expect(new AntigravityCliUpdateSource(commands, missingVersionFeed, 'win32', 'x64').latest(installation, signal))
      .rejects.toThrow(/no CLI version/)
    await expect(new AntigravityCliUpdateSource(commands, invalidVersionFeed, 'win32', 'x64').latest(installation, signal))
      .rejects.toThrow(/Unrecognized CLI version/)
  })
})
