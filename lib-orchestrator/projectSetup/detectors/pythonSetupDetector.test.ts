import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PythonSetupDetector } from './pythonSetupDetector'

describe('lib-orchestrator/projectSetup/detectors/pythonSetupDetector', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-python-setup-'))
    created.push(root)
    return root
  }

  function project(files: Record<string, string>): string {
    const root = temporaryRoot()
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
    }
    return root
  }

  const detector = new PythonSetupDetector()

  it('reads uv from its lockfile and from its section alike', async () => {
    const lock = project({ 'uv.lock': 'version = 1\n' })
    const section = project({ 'pyproject.toml': '[project]\nname = "x"\n\n[tool.uv]\n' })
    expect(await detector.detect(lock)).toEqual({ kind: 'tool', toolId: 'python-uv' })
    expect(await detector.detect(section)).toEqual({ kind: 'tool', toolId: 'python-uv' })
  })

  it('reads poetry from its lockfile and from its section alike', async () => {
    const lock = project({ 'poetry.lock': '' })
    const section = project({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n' })
    expect(await detector.detect(lock)).toEqual({ kind: 'tool', toolId: 'python-poetry' })
    expect(await detector.detect(section)).toEqual({ kind: 'tool', toolId: 'python-poetry' })
  })

  // A subsection configures its parent, so it is the parent's signal.
  it('counts a subsection as the tool it configures', async () => {
    const root = project({ 'pyproject.toml': '[tool.uv.sources]\nfoo = { path = "../foo" }\n' })
    expect(await detector.detect(root)).toEqual({ kind: 'tool', toolId: 'python-uv' })
  })

  it('reads no signal out of a section that merely starts alike', async () => {
    const root = project({ 'pyproject.toml': '[tool.uvicorn]\nport = 8000\n' })
    expect(await detector.detect(root)).toBeNull()
  })

  // Half a migration installs into two different environments depending on who picks.
  it('refuses a project that declares both installers', async () => {
    const root = project({ 'poetry.lock': '', 'pyproject.toml': '[tool.uv]\n' })
    const detection = await detector.detect(root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('.worktree.json') })
  })

  it('has nothing to say about a pyproject.toml naming neither', async () => {
    const root = project({ 'pyproject.toml': '[project]\nname = "x"\n[build-system]\n' })
    expect(await detector.detect(root)).toBeNull()
  })

  it('has nothing to say about a directory holding neither', async () => {
    expect(await detector.detect(temporaryRoot())).toBeNull()
  })

  it('ignores a directory that carries a lockfile name', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'uv.lock'))
    expect(await detector.detect(root)).toBeNull()
  })

  // Saying "no python project here" about a directory that plainly has one sends the resolution off
  // to another family; a directory in the file's place is the read failure every platform can stage.
  it('refuses a pyproject.toml it cannot read instead of passing it by', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'pyproject.toml'))
    const detection = await detector.detect(root)
    expect(detection?.kind).toBe('ambiguous')
    expect(detection).toMatchObject({ reason: expect.stringContaining('could not be read') })
    expect(detection).toMatchObject({ reason: expect.stringContaining('.worktree.json') })
  })
})
