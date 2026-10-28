import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexCliUpdateSource } from './codex/codexCliUpdateSource'
import { ClaudeCliUpdateSource } from './claude/claudeCliUpdateSource'
import { CliUpdateCommand } from './shared/cliUpdateCommand'
import { ReleaseFeed } from './shared/releaseFeed'
import { AgentCommandView } from '../sessionManager/agentCommandView'
import type { CommandInvoker } from '../shared/commandInvoker'
import type { CommandInvocation } from '../shared/commandInvoker.types'

afterEach(() => vi.restoreAllMocks())

describe('agent CLI providers', () => {
  function commands(version: string, help: string) {
    const run = vi.fn(async (invocation: CommandInvocation) => ({ code: 0, failure: null,
      stdout: invocation.args.includes('--version') ? version : help, stderr: '' })) satisfies Pick<CommandInvoker, 'run'>['run']
    vi.spyOn(AgentCommandView, 'resolve').mockResolvedValue({ path: '/bin/agent', command: '/bin/agent', prefixArgs: [] })
    return { commands: new CliUpdateCommand({}, { run }), run }
  }

  it('uses the Codex npm feed and the exact resolved CLI for manual updates', async () => {
    const { commands: command, run } = commands('codex-cli 0.165.0\n', '  update  Update Codex\n')
    const feed = new ReleaseFeed()
    const read = vi.spyOn(feed, 'text').mockResolvedValue('{"version":"0.166.0"}')
    const source = new CodexCliUpdateSource(command, feed)
    const signal = new AbortController().signal
    const installed = (await source.inspect(signal))!
    expect(installed).toMatchObject({ version: '0.165.0', updateSupported: true })
    expect(await source.latest(installed, signal)).toBe('0.166.0')
    expect(read).toHaveBeenCalledWith('https://registry.npmjs.org/@openai%2Fcodex/latest', signal)
    const output = vi.fn()
    await source.update(installed, signal, output)
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ command: '/bin/agent', args: ['update'],
      signal, onStdout: output, onStderr: output, timeoutMs: 600_000 }))
  })

  it('reads Claude stable policy and never changes it to latest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jamat-cli-update-'))
    try {
      const file = join(directory, 'settings.json')
      await writeFile(file, '{"autoUpdatesChannel":"stable"}')
      const { commands: command } = commands('2.1.312 (Claude Code)\n', '  update|upgrade  Update\n')
      const feed = new ReleaseFeed()
      const read = vi.spyOn(feed, 'text').mockResolvedValue('2.1.300')
      const source = new ClaudeCliUpdateSource(command, feed, file)
      const signal = new AbortController().signal
      const installed = (await source.inspect(signal))!
      expect(installed).toMatchObject({ version: '2.1.312', channel: 'stable', updateSupported: true })
      expect(await source.latest(installed, signal)).toBe('2.1.300')
      expect(read).toHaveBeenCalledWith('https://downloads.claude.ai/claude-code-releases/stable', signal)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not hide updater failures and retains the failure text', async () => {
    const { commands: command, run } = commands('codex-cli 0.165.0', '  update Update\n')
    const source = new CodexCliUpdateSource(command, new ReleaseFeed())
    const signal = new AbortController().signal
    const installed = (await source.inspect(signal))!
    run.mockResolvedValue({ code: 1, failure: null, stdout: '', stderr: 'Executable is locked' })
    await expect(source.update(installed, signal, () => {})).rejects.toThrow('Executable is locked')
  })
})
