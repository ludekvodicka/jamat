import { describe, expect, it, vi } from 'vitest'

import { AntigravityCliUpdateSource } from './antigravityCliUpdateSource'
import type { CliUpdateCommand } from '../shared/cliUpdateCommand'
import type { ReleaseFeed } from '../shared/releaseFeed'

describe('lib-orchestrator/agentCliUpdates/antigravity/antigravityCliUpdateSource', () => {
  it('parses the newest semver under the Antigravity CLI heading', () => {
    const changelog = [
      '## Antigravity App',
      '### 2.9.0',
      '- Desktop improvements',
      '',
      '## Antigravity CLI',
      '### 1.5.14',
      '- Added feature',
      '### 1.5.13',
      '- Bug fix',
      '',
      '## Antigravity SDK',
      '### 0.4.0',
    ].join('\n')
    expect(AntigravityCliUpdateSource.parseLatestFromChangelog(changelog)).toBe('1.5.14')
  })

  it('rejects a changelog without an Antigravity CLI section or version', () => {
    expect(() => AntigravityCliUpdateSource.parseLatestFromChangelog('## Antigravity App\n### 2.0.0'))
      .toThrow(/no Antigravity CLI section/)
    expect(() => AntigravityCliUpdateSource.parseLatestFromChangelog('## Antigravity CLI\n- Notes only'))
      .toThrow(/no CLI version/)
  })

  it('inspects agy, fetches the changelog feed and delegates update to agy update', async () => {
    const installation = {
      command: { path: '/bin/agy', command: '/bin/agy', prefixArgs: [] },
      version: '1.5.13',
      channel: 'latest',
      updateSupported: true,
    }
    const commands = {
      inspect: vi.fn(async () => installation),
      update: vi.fn(async () => undefined),
    } as unknown as CliUpdateCommand
    const feed = {
      text: vi.fn(async () => '## Antigravity CLI\n### v1.5.14\n- Fixed bug'),
    } as unknown as ReleaseFeed
    const source = new AntigravityCliUpdateSource(commands, feed)
    const signal = new AbortController().signal

    expect(await source.inspect(signal)).toEqual(installation)
    expect(commands.inspect).toHaveBeenCalledWith('agy', 'latest', /^(\S+)$/, signal)
    expect(await source.latest(installation, signal)).toBe('1.5.14')
    const out = vi.fn()
    await source.update(installation, signal, out)
    expect(commands.update).toHaveBeenCalledWith(installation, signal, out)
  })
})
