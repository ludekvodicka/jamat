import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { ProviderTranscriptView } from './providerTranscriptView'

describe('lib-orchestrator/projectManager/providerTranscriptView', () => {
  const created: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
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

  it('lists the Claude sub-agent files of one session, workflow agents included, with their metas', async () => {
    const claudeHome = directory('jamat-subagents-claude-')
    const cwd = 'Q:/Projects/AppFixture'
    const subagents = join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(cwd),
      'session-one',
      'subagents',
    )
    const workflow = join(subagents, 'workflows', 'wf_a39acbe7-b93')
    mkdirSync(workflow, { recursive: true })
    writeFileSync(join(subagents, 'agent-a01.jsonl'), '{}\n', 'utf8')
    writeFileSync(join(subagents, 'agent-a01.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_01' }), 'utf8')
    writeFileSync(join(subagents, 'agent-a02.jsonl'), '{}\n{}\n', 'utf8')
    writeFileSync(join(subagents, 'agent-a02.meta.json'), '{"agentType":', 'utf8')
    writeFileSync(join(subagents, 'agent-..evil.jsonl'), '{}\n', 'utf8')
    writeFileSync(join(subagents, 'notes.txt'), 'x', 'utf8')
    writeFileSync(join(workflow, 'agent-a03.jsonl'), '{}\n', 'utf8')
    const view = new ProviderTranscriptView({ claudeHome, codexHome: directory('empty-codex-') })

    const files = await view.subagentFiles({ agentId: 'claude', cwd, nativeSessionId: 'session-one', since: 0 })

    expect([...files].sort((a, b) => a.subagentId.localeCompare(b.subagentId))).toEqual([
      expect.objectContaining({
        subagentId: 'a01',
        file: join(subagents, 'agent-a01.jsonl'),
        size: 3,
        metaFile: join(subagents, 'agent-a01.meta.json'),
        spawnKey: 'toolu_01',
        workflowId: null,
      }),
      expect.objectContaining({ subagentId: 'a02', size: 6, spawnKey: null, workflowId: null }),
      expect.objectContaining({
        subagentId: 'a03',
        file: join(workflow, 'agent-a03.jsonl'),
        metaFile: null,
        workflowId: 'a39acbe7-b93',
      }),
    ])
    expect(await view.subagentFiles({ agentId: 'claude', cwd, nativeSessionId: 'session-two', since: 0 })).toEqual([])
    expect(await view.subagentFiles({ agentId: 'claude', cwd, nativeSessionId: '../session-one', since: 0 })).toEqual([])
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
  describe('claudeShellOutputFile', () => {
    const cwd = 'Q:/Projects/AppFixture'
    const sessionId = '4fe1fc81-0413-4b4e-9587-23be8cd35f2d'

    function view(): ProviderTranscriptView {
      return new ProviderTranscriptView({ claudeHome: directory('empty-claude-'), codexHome: directory('empty-codex-') })
    }

    /** A temp root holding the output file where Claude Code computes it. */
    function computedRoot(): { root: string; file: string } {
      const root = realpathSync(directory('jamat-claude-tmp-'))
      const tasks = join(root, 'claude', 'Q--Projects-AppFixture', sessionId, 'tasks')
      mkdirSync(tasks, { recursive: true })
      const file = join(tasks, 'b1.output')
      writeFileSync(file, 'out\n', 'utf8')
      return { root, file }
    }

    it('uses a stated path of the right shape', async () => {
      const tasks = join(directory('jamat-stated-'), 'elsewhere', sessionId, 'tasks')
      mkdirSync(tasks, { recursive: true })
      const file = join(tasks, 'b1.output')
      writeFileSync(file, 'abc', 'utf8')
      vi.stubEnv('CLAUDE_CODE_TMPDIR', computedRoot().root)

      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'b1', statedPath: file }))
        .toEqual(expect.objectContaining({ file, size: 3 }))
    })

    it('falls back to the computed path for a stated path of another name, another session or a relative one', async () => {
      const { root, file } = computedRoot()
      vi.stubEnv('CLAUDE_CODE_TMPDIR', root)
      const tasks = join(root, 'claude', 'Q--Projects-AppFixture', sessionId, 'tasks')
      writeFileSync(join(tasks, 'b2.output'), 'other', 'utf8')

      for (const statedPath of [
        join(tasks, 'b2.output'),
        join(tasks, 'b1.log'),
        join(root, 'claude', 'Q--Projects-AppFixture', 'another-session', 'tasks', 'b1.output'),
        join('claude', sessionId, 'tasks', 'b1.output'),
        null,
      ])
        expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'b1', statedPath }))
          .toEqual(expect.objectContaining({ file }))
    })

    it('computes the root from CLAUDE_CODE_TMPDIR when set and from the OS temp when unset', async () => {
      const fromVariable = computedRoot()
      const fromTemp = computedRoot()
      vi.stubEnv('TEMP', fromTemp.root)
      vi.stubEnv('TMP', fromTemp.root)
      vi.stubEnv('TMPDIR', fromTemp.root)

      vi.stubEnv('CLAUDE_CODE_TMPDIR', fromVariable.root)
      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'b1', statedPath: null }))
        .toEqual(expect.objectContaining({ file: fromVariable.file }))
      vi.stubEnv('CLAUDE_CODE_TMPDIR', '')
      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'b1', statedPath: null }))
        .toEqual(expect.objectContaining({ file: fromTemp.file }))
    })

    it('answers nothing for a missing file, a sub-agent output and an id that is no plain id', async () => {
      const { root } = computedRoot()
      vi.stubEnv('CLAUDE_CODE_TMPDIR', root)
      const tasks = join(root, 'claude', 'Q--Projects-AppFixture', sessionId, 'tasks')
      writeFileSync(join(tasks, 'a1.output'), 'agent', 'utf8')

      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'b9', statedPath: null })).toBeNull()
      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: 'a1', statedPath: join(tasks, 'a1.output') }))
        .toBeNull()
      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: sessionId, shellId: '../b1', statedPath: null })).toBeNull()
      expect(await view().claudeShellOutputFile({ cwd, nativeSessionId: '../x', shellId: 'b1', statedPath: null })).toBeNull()
    })

    it('cuts a long encoded cwd at 200 characters and appends the hash Claude Code computes', () => {
      expect(ProviderTranscriptView.claudeTempSlugOf('Q:/Projects/AppFixture')).toBe('Q--Projects-AppFixture')
      expect(ProviderTranscriptView.claudeTempSlugOf(`C:/${'a'.repeat(250)}`)).toBe(`C--${'a'.repeat(197)}-bpfzvc`)
    })
  })
})
