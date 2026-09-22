import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WindowsCommand } from './windowsCommand'

describe('lib-orchestrator/sessionManager/launch/windowsCommand', () => {
  let root = ''
  let first = ''
  let second = ''

  function environment(directories: string[], pathExt?: string): NodeJS.ProcessEnv {
    return { PATH: directories.join(';'), ...(pathExt === undefined ? {} : { PATHEXT: pathExt }) }
  }

  function put(directory: string, name: string): string {
    const path = join(directory, name)
    writeFileSync(path, '', 'utf8')
    return path
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-windows-command-'))
    first = join(root, 'first')
    second = join(root, 'second')
    for (const directory of [first, second])
      mkdirSync(directory)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers the executable a bare name would start', () => {
    const image = put(first, 'claude.exe')
    expect(WindowsCommand.imageOf('claude', environment([first]))).toBe(image)
  })

  // The whole point of the class: a shim is cmd.exe, so for its caller it is the same as nothing.
  it('answers null for a name that only a cmd.exe shim answers', () => {
    put(first, 'codex.cmd')
    expect(WindowsCommand.imageOf('codex', environment([first]))).toBeNull()
  })

  it('answers null for a name nothing on the path answers', () => {
    expect(WindowsCommand.imageOf('absent', environment([first, second]))).toBeNull()
  })

  /*
   * cmd.exe stops at the first directory that answers, so a shim found in an earlier one is what
   * runs and a later executable is a program it would never have reached. Returning that later
   * executable would spawn something other than what the wrap spawns.
   */
  it('lets an earlier shim end the search rather than reaching a later executable', () => {
    put(first, 'both.cmd')
    put(second, 'both.exe')
    expect(WindowsCommand.imageOf('both', environment([first, second]))).toBeNull()
    expect(WindowsCommand.imageOf('both', environment([second, first])))
      .toBe(join(second, 'both.exe'))
  })

  // Within ONE directory the order is PATHEXT's, which puts .COM and .EXE ahead of .CMD.
  it('prefers the extension PATHEXT names first inside one directory', () => {
    put(first, 'mixed.cmd')
    const image = put(first, 'mixed.exe')
    expect(WindowsCommand.imageOf('mixed', environment([first]))).toBe(image)
    expect(WindowsCommand.imageOf('mixed', environment([first], '.CMD;.EXE'))).toBeNull()
  })

  it('reads a quoted path entry and ignores an empty one', () => {
    const image = put(second, 'quoted.exe')
    expect(WindowsCommand.imageOf('quoted', environment(['', `"${second}"`, '']))).toBe(image)
  })

  it('answers null rather than throwing when the environment names no path at all', () => {
    expect(WindowsCommand.imageOf('claude', {})).toBeNull()
  })

  /*
   * npm and pnpm write `<name>.ps1` beside every `<name>.cmd`, and that one calls `node.exe`
   * directly, so it is the same program with no cmd.exe in the chain. It is the installer's own
   * file rather than a guess at the shim's format.
   */
  it('answers the PowerShell script an installer wrote beside a shim', () => {
    put(first, 'codexps.cmd')
    const script = put(first, 'codexps.ps1')
    expect(WindowsCommand.powershellScriptOf('codexps', environment([first]))).toBe(script)
  })

  it('answers null for a shim standing on its own, because there is nothing to run instead', () => {
    put(second, 'lonely.cmd')
    expect(WindowsCommand.powershellScriptOf('lonely', environment([second]))).toBeNull()
  })

  // An image needs no script: its caller already has the launch that keeps an argument whole.
  it('answers null for a name an executable answers, script beside it or not', () => {
    put(second, 'imaged.exe')
    put(second, 'imaged.ps1')
    expect(WindowsCommand.powershellScriptOf('imaged', environment([second]))).toBeNull()
  })

  it('answers null for a name nothing on the path answers', () => {
    expect(WindowsCommand.powershellScriptOf('absent', environment([first, second]))).toBeNull()
  })

  // The same first-hit rule the image question follows: an earlier shim is what would run.
  it('reads the script of the shim that would run, not of a later one', () => {
    put(first, 'twice.cmd')
    const script = put(first, 'twice.ps1')
    put(second, 'twice.cmd')
    put(second, 'twice.ps1')
    expect(WindowsCommand.powershellScriptOf('twice', environment([first, second]))).toBe(script)
  })
})
