import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeUsageDirectories } from './claudeUsageDirectories'
import { TokenUsageProjectsView } from './tokenUsageProjectsView'
import { ClaudeProjectsLocator } from './providers/claude/claudeProjectsLocator'
import { PathCompare } from '../shared/pathCompare'
import { ClaudeUsageParser } from '../tokenUsage/claudeUsageParser'
import { TokenUsageScanner } from '../tokenUsage/tokenUsageScanner'

describe('TokenUsageProjectsView', () => {
  it('uses actual cwd, worktree ownership and catalog labels without reversing ambiguous slugs', async () => {
    const parent = join(import.meta.dirname, '../../.aidocs/temp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'token-project-test-'))
    try {
      const home = join(root, 'claude'), owner = join(root, 'apps/Jamat'), worktree = join(owner, '.worktrees/one')
      await writeFile(join(root, 'config.json'), JSON.stringify({ schemaVersion: 1, categories: [{ id: 'apps', label: 'Apps', path: join(root, 'apps') }] }))
      const records = [{ agentId: 'claude' as const, nativeSessionId: 'native', cwd: worktree, ownerPath: owner, accountSegments: [] }]
      const directory = join(home, 'projects', ClaudeProjectsLocator.encodeProjectDir(worktree))
      await mkdir(directory, { recursive: true })
      const view = new TokenUsageProjectsView(root, records)
      const directories = new ClaudeUsageDirectories(home)
      await directories.prepare(records.map(record => record.cwd))
      expect(view.project(worktree, 'native', 'claude')).toBe(PathCompare.comparable(owner))
      expect(view.label(PathCompare.normalized(owner))).toBe('Jamat')
      expect(directories.fallbackCwd(join(directory, 'native.jsonl'))).toBe(worktree)
      expect(directories.fallbackCwd(join(home, 'projects', 'ambiguous-slug', 'unknown.jsonl'))).toBe('')
      expect(view.project('', 'unknown', 'claude')).toBe('unknown')
      const external = join(root, 'outside')
      expect(view.project(external, 'outside', 'codex')).toBe(PathCompare.comparable(external))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('reaggregates cached cwd spellings by platform identity while retaining the preferred display path', async () => {
    const parent = join(import.meta.dirname, '../../.aidocs/temp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'token-project-test-'))
    try {
      const project = join(root, 'OutsideProject'), lower = project.toLowerCase()
      const home = join(root, 'claude'), directory = join(home, 'projects/fixture'), cacheFile = join(root, 'cache.json')
      await mkdir(directory, { recursive: true })
      const line = (cwd: string, id: string, input: number) => JSON.stringify({ type: 'assistant', sessionId: 'native', cwd,
        timestamp: '2026-10-26T12:00:00Z', requestId: 'request', message: { id, model: 'opus', usage: { input_tokens: input } } }) + '\n'
      await writeFile(join(directory, 'native.jsonl'), line(project, 'first', 7) + line(lower, 'second', 11))
      const source = ClaudeUsageParser.source(home)
      const options = { sources: [source], cacheFile, resolveAccount: () => 'main' }
      expect(await new TokenUsageScanner({ ...options, resolveProject: cwd => PathCompare.normalized(cwd) }).scan()).toHaveLength(2)
      source.parse = () => { throw new Error('Unchanged transcripts must not be read again') }
      const projects = new TokenUsageProjectsView(root, [])
      const buckets = await new TokenUsageScanner({ ...options, resolveProject: (...args) => projects.project(...args) }).scan()
      if (process.platform === 'win32') {
        expect(buckets).toMatchObject([{ projectKey: PathCompare.comparable(project), input: 18 }])
        expect(projects.label(buckets[0].projectKey)).toBe(PathCompare.normalized(project))
      } else {
        expect(buckets.map(bucket => [bucket.projectKey, bucket.input])).toEqual([[PathCompare.normalized(project), 7], [PathCompare.normalized(lower), 11]])
        expect(projects.label(buckets[0].projectKey)).toBe(PathCompare.normalized(project))
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
