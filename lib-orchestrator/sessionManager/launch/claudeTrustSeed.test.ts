import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClaudeTrustSeed } from './claudeTrustSeed'

describe('lib-orchestrator/sessionManager/launch/claudeTrustSeed', () => {
  const trustedConst = {
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  }
  let directory = ''
  let file = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jamat-v3-trust-seed-'))
    file = join(directory, '.claude.json')
  })

  afterEach(() => {
    try { chmodSync(file, 0o666) } catch { /* absent or already writable */ }
    try { chmodSync(directory, 0o777) } catch { /* not a POSIX directory */ }
    rmSync(directory, { recursive: true, force: true })
  })

  function stored(): Record<string, unknown> {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  }

  function projects(): Record<string, Record<string, unknown>> {
    return (stored() as { projects: Record<string, Record<string, unknown>> }).projects
  }

  // Claude writes this file itself on its first run; inventing one here would be state nobody asked
  // for, and the launch simply meets the dialog it would have met anyway.
  it('says nothing and creates nothing when the file is not there', () => {
    expect(ClaudeTrustSeed.seed('D:\\work', file)).toEqual({ changed: false, problem: null })
    expect(existsSync(file)).toBe(false)
  })

  it('leaves a document it cannot read exactly as it found it', () => {
    for (const content of ['{ "projects": ', '[]', 'null', '"a string"']) {
      writeFileSync(file, content, 'utf-8')
      expect(ClaudeTrustSeed.seed('D:\\work', file)).toEqual({ changed: false, problem: null })
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })

  it('answers all three dialogs under the key Claude writes', () => {
    writeFileSync(file, JSON.stringify({ numStartups: 3 }), 'utf-8')

    expect(ClaudeTrustSeed.seed('D:\\work\\one', file)).toEqual({ changed: true, problem: null })

    expect(projects()['D:/work/one']).toEqual(trustedConst)
    expect((stored() as { numStartups: number }).numStartups).toBe(3)
  })

  it('answers every key already there that names the same directory', () => {
    writeFileSync(file, JSON.stringify({
      projects: {
        'd:/WORK/one': { hasCompletedProjectOnboarding: true },
        'D:\\work\\one\\': {},
        'D:/work/other': { hasTrustDialogAccepted: false },
      },
    }), 'utf-8')

    expect(ClaudeTrustSeed.seed('D:\\work\\one', file).changed).toBe(true)

    expect(projects()['d:/WORK/one'])
      .toEqual({ hasCompletedProjectOnboarding: true, ...trustedConst })
    expect(projects()['D:\\work\\one\\']).toEqual(trustedConst)
    expect(projects()['D:/work/one']).toEqual(trustedConst)
    // A directory that only looks similar keeps its own answer.
    expect(projects()['D:/work/other']).toEqual({ hasTrustDialogAccepted: false })
  })

  it('does not touch the file when every answer is already there', () => {
    writeFileSync(file, JSON.stringify({ projects: { 'D:/work': { ...trustedConst } } }), 'utf-8')
    const before = statSync(file).mtimeMs
    const text = readFileSync(file, 'utf8')

    expect(ClaudeTrustSeed.seed('D:\\work', file)).toEqual({ changed: false, problem: null })

    expect(statSync(file).mtimeMs).toBe(before)
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('reports a write it could not finish instead of throwing it at the launch', () => {
    writeFileSync(file, JSON.stringify({ projects: {} }), 'utf-8')
    // Windows refuses the rename over a read-only file; POSIX decides by the directory instead.
    if (process.platform === 'win32') chmodSync(file, 0o444)
    else chmodSync(directory, 0o555)

    const seeded = ClaudeTrustSeed.seed('D:\\work', file)

    expect(seeded.changed).toBe(false)
    expect(seeded.problem).not.toBeNull()
  })

  it('aims at the file the launched Claude will actually read', () => {
    expect(ClaudeTrustSeed.defaultPath({})).toBe(join(homedir(), '.claude.json'))
    expect(ClaudeTrustSeed.defaultPath({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }))
      .toBe(join('D:\\cfg', '.claude.json'))
    expect(ClaudeTrustSeed.defaultPath({ CLAUDE_CONFIG_DIR: '' }))
      .toBe(join(homedir(), '.claude.json'))
  })
})
