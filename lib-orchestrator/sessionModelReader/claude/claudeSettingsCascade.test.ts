import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeSettingsCascade } from './claudeSettingsCascade'

describe('lib-orchestrator/sessionModelReader/claude/claudeSettingsCascade', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function directory(prefix: string): string {
    const made = mkdtempSync(join(tmpdir(), prefix))
    created.push(made)
    return made
  }

  function writeSettings(root: string, name: string, body: unknown): void {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', name),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8',
    )
  }

  function writeHome(home: string, body: unknown): void {
    writeFileSync(join(home, 'settings.json'), JSON.stringify(body), 'utf8')
  }

  it('takes the most specific file: local over project, project over home', async () => {
    const cwd = directory('jamat-settings-cwd-')
    const home = directory('jamat-settings-home-')
    writeHome(home, { effortLevel: 'low', model: 'sonnet' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'low', model: 'sonnet' })

    writeSettings(cwd, 'settings.json', { effortLevel: 'medium', model: 'opus' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'medium', model: 'opus' })

    writeSettings(cwd, 'settings.local.json', { effortLevel: 'high', model: 'opus[1m]' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'high', model: 'opus[1m]' })
  })

  // The precedence is per key, the way Claude Code merges settings: the file that names one of them
  // answers that one and nothing else, or a project `model` would hide the home file's effort.
  it('resolves the two keys independently down the cascade', async () => {
    const cwd = directory('jamat-settings-cwd-')
    const home = directory('jamat-settings-home-')
    writeSettings(cwd, 'settings.local.json', { model: 'claude-opus-5[1m]' })
    writeHome(home, { effortLevel: 'xhigh', model: 'sonnet' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'xhigh', model: 'claude-opus-5[1m]' })
  })

  it('walks past an empty string rather than taking it as an answer', async () => {
    const cwd = directory('jamat-settings-cwd-')
    const home = directory('jamat-settings-home-')
    writeSettings(cwd, 'settings.local.json', { effortLevel: '', model: '' })
    writeSettings(cwd, 'settings.json', { effortLevel: '', model: '' })
    writeHome(home, { effortLevel: 'high', model: 'opus[1m]' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'high', model: 'opus[1m]' })
  })

  it('walks past a file it cannot read and past a file that does not say', async () => {
    const cwd = directory('jamat-settings-cwd-')
    const home = directory('jamat-settings-home-')
    writeSettings(cwd, 'settings.local.json', '{ not json at all')
    writeSettings(cwd, 'settings.json', { permissions: { allow: [] } })
    writeHome(home, { effortLevel: 'max', model: 'fable[1m]' })
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: 'max', model: 'fable[1m]' })
  })

  it('answers both null when no file in the cascade exists', async () => {
    const cwd = directory('jamat-settings-cwd-')
    const home = directory('jamat-settings-home-')
    expect(await ClaudeSettingsCascade.readingOf(cwd, home))
      .toEqual({ effortLevel: null, model: null })
  })
})
