import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentMemory } from './agentMemory'

describe('lib-orchestrator/agentMemory/agentMemory', () => {
  const id = '00a3124e-a257-411c-8d8e-3f4cb8ab223b'
  let root: string
  let claudeHome: string
  let memoryDirectory: string
  let memory: AgentMemory
  const query = { agentId: 'claude' as const, projectPath: 'Q:\\Apps\\My_App', nativeSessionId: id }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-agent-memory-'))
    claudeHome = join(root, '.claude')
    // The folder keeps the case it was created with; the project path asks in another one.
    memoryDirectory = join(claudeHome, 'projects', 'q--Apps-My-App', 'memory')
    mkdirSync(memoryDirectory, { recursive: true })
    writeFileSync(join(memoryDirectory, 'MEMORY.md'), '- [Private](private.md) - fact\n- [Other](other.md) - kept\n')
    writeFileSync(join(memoryDirectory, 'private.md'), 'secret')
    writeFileSync(join(memoryDirectory, 'other.md'), 'kept')
    writeFileSync(join(claudeHome, 'projects', 'q--Apps-My-App', `${id}.jsonl`), JSON.stringify({ message: { content: [
      { type: 'tool_use', name: 'Write', input: { file_path: join(memoryDirectory, 'private.md'), content: 'secret' } },
    ] } }))
    memory = new AgentMemory({ claudeHome, codexHome: join(root, '.codex') })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists the index first and marks the files the conversation wrote', async () => {
    const listed = await memory.list(query)

    expect(listed.ok && listed.value.directory).toBe(memoryDirectory)
    expect(listed.ok && listed.value.files.map((file) => [file.name, file.writtenByConversation]))
      .toEqual([['MEMORY.md', false], ['other.md', false], ['private.md', true]])
  })

  it('writes only the version that was read', async () => {
    const read = await memory.read(query, 'other.md')
    if (!read.ok) throw new Error(read.detail)

    expect(await memory.write(query, 'other.md', 'changed', read.value.modifiedAt - 1)).toMatchObject({ ok: false, code: 'conflict' })
    expect(await memory.write(query, 'other.md', 'changed', read.value.modifiedAt)).toMatchObject({ ok: true })
    expect(readFileSync(join(memoryDirectory, 'other.md'), 'utf8')).toBe('changed')
  })

  it('deletes a file with the index lines that link to it', async () => {
    expect(await memory.remove(query, 'private.md')).toEqual({ ok: true, value: { indexLinesRemoved: 1 } })

    expect(existsSync(join(memoryDirectory, 'private.md'))).toBe(false)
    expect(readFileSync(join(memoryDirectory, 'MEMORY.md'), 'utf8')).toBe('- [Other](other.md) - kept\n')
  })

  it.each(['../x.md', '..', 'a/../../x.md', '/abs.md', 'C:x.md', 'a\\b.md', ''])('refuses the name %j', async (name) => {
    expect(await memory.read(query, name)).toMatchObject({ ok: false, code: 'invalid' })
    expect(await memory.remove(query, name)).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('reads the shared Codex memory folder', async () => {
    mkdirSync(join(root, '.codex', 'memories', 'notes'), { recursive: true })
    writeFileSync(join(root, '.codex', 'memories', 'notes', 'a.md'), 'codex')

    const listed = await memory.list({ agentId: 'codex', projectPath: 'Q:\\Apps\\My_App' })

    expect(listed).toMatchObject({ ok: true, value: { scope: 'global', files: [{ name: 'notes/a.md', writtenByConversation: false }] } })
    expect(statSync(join(root, '.codex', 'memories', 'notes', 'a.md')).isFile()).toBe(true)
  })

  it('lists, edits and bounds the user-level files of each agent', async () => {
    writeFileSync(join(claudeHome, 'CLAUDE.md'), 'rules')
    writeFileSync(join(claudeHome, 'settings.json'), '{}')
    mkdirSync(join(claudeHome, 'rules'))
    writeFileSync(join(claudeHome, 'rules', 'style.md'), 'style')
    mkdirSync(join(root, '.codex', 'memories'), { recursive: true })
    writeFileSync(join(root, '.codex', 'AGENTS.md'), 'agents')
    writeFileSync(join(root, '.codex', 'memories', 'm.md'), 'memo')
    const claude = { scope: 'user' as const, agentId: 'claude' as const }

    expect(await memory.list(claude)).toMatchObject({ ok: true, value: { scope: 'user', directory: claudeHome,
      files: [{ name: 'CLAUDE.md' }, { name: 'rules/style.md' }] } })
    const codex = await memory.list({ scope: 'user', agentId: 'codex' })
    expect(codex.ok && codex.value.files.map((file) => file.name)).toEqual(['AGENTS.md', 'memories/m.md'])
    const read = await memory.read(claude, 'CLAUDE.md')
    if (!read.ok) throw new Error(read.detail)
    expect(await memory.write(claude, 'CLAUDE.md', 'changed', read.value.modifiedAt)).toMatchObject({ ok: true })
    expect(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8')).toBe('changed')
    for (const name of ['settings.json', 'rules', 'CLAUDE.md/x', 'projects/q--Apps-My-App/memory/other.md'])
      expect(await memory.read(claude, name)).toMatchObject({ ok: false, code: 'invalid' })
  })
})
