import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorktreeConfig, type WorktreeConfigSectionRead } from '../../projectSetup/worktreeConfig'
import { DeclaredScripts, type DeclaredScriptsValue } from './declaredScripts'
import { ScriptChain } from './scriptChain'

describe('lib-orchestrator/sessionManager/scripts/declaredScripts', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function project(document: unknown): { projectRoot: string; configFile: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'jamat-v3-declared-scripts-'))
    created.push(projectRoot)
    const configFile = join(projectRoot, '.worktree.json')
    writeFileSync(configFile, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
    return { projectRoot, configFile }
  }

  async function scriptsOf(projectRoot: string): Promise<WorktreeConfigSectionRead<DeclaredScriptsValue>> {
    return WorktreeConfig.sectionOf(await WorktreeConfig.load(projectRoot), 'scripts', DeclaredScripts.coerce)
  }

  async function refusalOf(scripts: unknown): Promise<{ problem: string; configFile: string }> {
    const { projectRoot, configFile } = project({ scripts })
    const read = await scriptsOf(projectRoot)
    if (read.ok) throw new Error(`Expected a refusal, read ${JSON.stringify(read.value)}`)
    return { problem: read.problem, configFile }
  }

  describe('read', () => {
    it('gives both phases in file order', async () => {
      const { projectRoot } = project({
        setup: ['pnpm install'],
        scripts: {
          before: [{ name: 'codegen', command: 'pnpm codegen' }],
          after: [
            { name: 'lint', command: 'pnpm lint' },
            { name: 'tests', command: 'pnpm test', cwd: 'packages/app' },
          ],
        },
      })
      expect(await scriptsOf(projectRoot)).toEqual({
        ok: true,
        value: {
          before: [{ name: 'codegen', command: 'pnpm codegen', cwd: '' }],
          after: [
            { name: 'lint', command: 'pnpm lint', cwd: '' },
            { name: 'tests', command: 'pnpm test', cwd: 'packages/app' },
          ],
        },
      })
    })

    it('reads an absent key as null and an absent phase as an empty list', async () => {
      expect(await scriptsOf(project({ setup: [] }).projectRoot)).toEqual({ ok: true, value: null })
      expect(await scriptsOf(project({ scripts: { after: [] } }).projectRoot))
        .toEqual({ ok: true, value: { before: [], after: [] } })
    })

    it('spells a directory one way: normalized, no trailing slash, the project as an empty string', async () => {
      const { projectRoot } = project({
        scripts: {
          before: [
            { name: 'a', command: 'x', cwd: './packages//app/' },
            { name: 'b', command: 'x', cwd: '.' },
            { name: 'c', command: 'x', cwd: 'packages/../tools' },
          ],
        },
      })
      const read = await scriptsOf(projectRoot)
      expect(read.ok && read.value?.before.map((script) => script.cwd)).toEqual(['packages/app', '', 'tools'])
    })

    // The file is the custodian's to judge, so its words are the custodian's, not this owner's.
    it('leaves broken JSON to the custodian', async () => {
      const { projectRoot, configFile } = project('{ "scripts": [')
      const read = await scriptsOf(projectRoot)
      expect(read).toEqual({ ok: false, problem: expect.stringContaining(`${configFile} is not valid JSON`) })
    })
  })

  describe('coerce refuses with a message naming the file', () => {
    const entry = (name: string) => ({ name, command: `run ${name}` })

    it.each([
      ['an unknown phase key', { befor: [entry('a')] }, '"scripts" has an unknown key "befor"'],
      ['an unknown entry key', { after: [{ name: 'tests', comand: 'pnpm test' }] }, '"scripts.after[0]" has an unknown key "comand"'],
      ['a duplicate name ignoring case', { after: [entry('Tests'), entry('tests')] }, '"scripts.after" names "tests" more than once'],
      ['nine entries', { before: Array.from({ length: 9 }, (_, index) => entry(`step ${index}`)) }, 'at most 8 scripts'],
      ['a 4097-character command', { after: [{ name: 'long', command: 'x'.repeat(4097) }] }, 'at most 4096 characters'],
      ['a climbing cwd', { after: [{ ...entry('up'), cwd: '../x' }] }, '"scripts.after[0].cwd" "../x" climbs out of the project'],
      ['a cwd that climbs after descending', { after: [{ ...entry('up'), cwd: 'a/../../x' }] }, 'climbs out of the project'],
      ['a drive-absolute cwd', { after: [{ ...entry('abs'), cwd: 'C:/x' }] }, '"scripts.after[0].cwd" "C:/x" must be relative to the project'],
      ['a drive-relative cwd', { after: [{ ...entry('abs'), cwd: 'C:x' }] }, 'must be relative to the project'],
      ['a rooted cwd', { after: [{ ...entry('abs'), cwd: '/x' }] }, 'must be relative to the project'],
      ['a backslashed cwd', { after: [{ ...entry('win'), cwd: 'packages\\app' }] }, 'must use forward slashes'],
      ['a cwd that is not a string', { after: [{ ...entry('n'), cwd: 7 }] }, '"scripts.after[0].cwd" must be a directory path'],
      ['scripts that are not an object', [entry('a')], '"scripts" must be an object'],
      ['a phase that is not a list', { before: entry('a') }, '"scripts.before" must be an array'],
      ['an entry that is not an object', { before: ['pnpm codegen'] }, '"scripts.before[0]" must be an object'],
      ['an empty name', { before: [entry('')] }, '"scripts.before[0].name" must be 1 to 40'],
      ['a 41-character name', { before: [entry('n'.repeat(41))] }, '"scripts.before[0].name" must be 1 to 40'],
      ['a name starting with a dot', { before: [entry('.hidden')] }, '"scripts.before[0].name"'],
      ['a name with a slash', { before: [entry('a/b')] }, '"scripts.before[0].name"'],
      ['a blank command', { before: [{ name: 'blank', command: '   ' }] }, '"scripts.before[0].command" must be a non-empty'],
      ['a missing command', { before: [{ name: 'none' }] }, '"scripts.before[0].command" must be a non-empty'],
      ['a command with a line feed', { after: [{ name: 'tests', command: 'pnpm test\ntrue' }] }, '"scripts.after[0].command" must be one line, without NUL, CR or LF'],
      ['a command with a carriage return', { after: [{ name: 'tests', command: 'pnpm test\rtrue' }] }, 'must be one line'],
      ['a command with a NUL', { before: [{ name: 'gen', command: 'pnpm gen\u0000x' }] }, 'must be one line'],
    ])('%s', async (_label, scripts, words) => {
      const { problem, configFile } = await refusalOf(scripts)
      expect(problem.startsWith(`${configFile}: `)).toBe(true)
      expect(problem).toContain(words)
    })

    it('accepts the limits themselves', async () => {
      const { projectRoot } = project({
        scripts: {
          before: Array.from({ length: 8 }, (_, index) => entry(`step ${index}`)),
          after: [{ name: 'A1 ._-'.padEnd(40, 'x'), command: 'x'.repeat(4096) }],
        },
      })
      expect((await scriptsOf(projectRoot)).ok).toBe(true)
    })

    it('compares names per phase, so one name may appear in both', async () => {
      const { projectRoot } = project({ scripts: { before: [entry('tests')], after: [entry('Tests')] } })
      expect((await scriptsOf(projectRoot)).ok).toBe(true)
    })
  })

  describe('stepsOf', () => {
    const scripts = [
      { name: 'lint', command: 'pnpm lint', cwd: '' },
      { name: 'tests', command: 'pnpm test', cwd: 'packages/app' },
    ]
    const repositoryRoot = join(tmpdir(), 'repo')
    const worktreePath = join(tmpdir(), 'worktrees', 'i12-fix')

    function expectInsideWorktree(cwd: string): void {
      expect(isAbsolute(cwd)).toBe(true)
      const inside = relative(worktreePath, cwd)
      expect(inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))).toBe(true)
    }

    it('maps a Git project below its repository root into the same place in the worktree', () => {
      const projectRoot = join(repositoryRoot, 'services', 'api')
      const result = DeclaredScripts.stepsOf(scripts, { projectRoot, repositoryRoot, worktreePath })
      if (!result.ok) throw new Error(result.problem)
      expect(result.steps.map((step) => step.commands)).toEqual([
        [{ command: 'pnpm lint', cwd: join(worktreePath, 'services', 'api') }],
        [{ command: 'pnpm test', cwd: join(worktreePath, 'services', 'api', 'packages', 'app') }],
      ])
      for (const step of result.steps) expectInsideWorktree(step.commands[0].cwd)
      expect(result.steps.map((step) => [step.scriptId, step.name])).toEqual([['declared', 'lint'], ['declared', 'tests']])
      for (const step of result.steps) expect(step.key).toBe(ScriptChain.keyOf(step))
    })

    // An SVN worktree checks out its owner, which is both the project and the repository root here.
    it('maps an SVN owner onto the worktree root', () => {
      const result = DeclaredScripts.stepsOf(scripts, { projectRoot: repositoryRoot, repositoryRoot, worktreePath })
      if (!result.ok) throw new Error(result.problem)
      expect(result.steps.map((step) => step.commands[0].cwd))
        .toEqual([join(worktreePath), join(worktreePath, 'packages', 'app')])
      for (const step of result.steps) expectInsideWorktree(step.commands[0].cwd)
    })

    it('refuses a project outside the repository its worktree was cut from', () => {
      const result = DeclaredScripts.stepsOf(scripts, {
        projectRoot: join(tmpdir(), 'elsewhere'), repositoryRoot, worktreePath,
      })
      expect(result).toEqual({ ok: false, problem: expect.stringContaining('is not inside the repository') })
    })

    it('refuses a step whose directory did not come through coerce and escapes', () => {
      const result = DeclaredScripts.stepsOf(
        [{ name: 'up', command: 'x', cwd: '../../etc' }],
        { projectRoot: repositoryRoot, repositoryRoot, worktreePath },
      )
      expect(result).toEqual({ ok: false, problem: expect.stringContaining('climbs out of the project') })
    })

    it('gives no steps for no scripts', () => {
      expect(DeclaredScripts.stepsOf([], { projectRoot: repositoryRoot, repositoryRoot, worktreePath }))
        .toEqual({ ok: true, steps: [] })
    })
  })
})
