import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { ProviderTranscriptView } from './providerTranscriptView'

describe('lib-orchestrator/projectManager/providerTranscriptView', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function directory(prefix: string): string {
    const value = mkdtempSync(join(tmpdir(), prefix))
    created.push(value)
    return value
  }

  it('resolves only the exact Claude transcript inside the project store', async () => {
    const claudeHome = directory('jamat-transcript-claude-')
    const cwd = 'Q:/Projects/AppFixture'
    const projectStore = join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(cwd),
    )
    mkdirSync(projectStore, { recursive: true })
    const file = join(projectStore, 'session-one.jsonl')
    writeFileSync(file, '{}\n', 'utf8')
    const view = new ProviderTranscriptView({ claudeHome, codexHome: directory('empty-codex-') })

    expect(await view.resolve({ agentId: 'claude', cwd, nativeSessionId: 'session-one' }))
      .toEqual(expect.objectContaining({ file, size: 3 }))
    expect(await view.resolve({ agentId: 'claude', cwd, nativeSessionId: '../session-one' }))
      .toBeNull()
  })

  it('resolves the exact Codex rollout recorded for the cwd', async () => {
    const codexHome = directory('jamat-transcript-codex-')
    const cwd = 'Q:/Projects/AppFixture'
    const sessionId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
    const day = join(codexHome, 'sessions', '2026', '08', '14')
    mkdirSync(day, { recursive: true })
    const file = join(day, `rollout-2026-08-14T10-20-30-${sessionId}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n', 'utf8')
    const view = new ProviderTranscriptView({
      claudeHome: directory('empty-claude-'),
      codexHome,
      report: () => undefined,
    })

    expect(await view.resolve({ agentId: 'codex', cwd, nativeSessionId: sessionId }))
      .toEqual(expect.objectContaining({ file }))
    expect(await view.resolve({ agentId: 'codex', cwd: 'Q:/Other', nativeSessionId: sessionId }))
      .toBeNull()
  })
})
