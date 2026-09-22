import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PowerShellHost } from './powershellHost'

describe('lib-orchestrator/sessionManager/launch/powershellHost', () => {
  let root = ''

  /*
   * A directory of its own per case, because the answer is cached against the resolved host and two
   * cases that shared a path would share the first one's answer.
   */
  function machine(name: string, host?: 'pwsh' | 'powershell'): NodeJS.ProcessEnv {
    const directory = join(root, name)
    mkdirSync(directory)
    if (host !== undefined) writeFileSync(join(directory, `${host}.exe`), '', 'utf8')
    return { PATH: directory }
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-powershell-host-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('takes a host that hands a native command its arguments one by one', () => {
    const environment = machine('standard', 'pwsh')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => 'Standard'))
      .toBe(join(root, 'standard', 'pwsh.exe'))
  })

  // What 7.6.6 answers on Windows: Standard for everything but a few interpreters node.exe is none of.
  it('takes the Windows mode as well, which is what the installed 7.x answers', () => {
    const environment = machine('windows', 'pwsh')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => 'Windows'))
      .toBe(join(root, 'windows', 'pwsh.exe'))
  })

  /*
   * Legacy rebuilds one command line out of the argument array, which is what ate the quotes of
   * `say "hello there"` under Windows PowerShell 5.1. A host that says so is refused rather than
   * used, because a corrupted instruction is the failure this route exists to avoid.
   */
  it('refuses a host that rebuilds a command line out of the arguments', () => {
    const environment = machine('legacy', 'pwsh')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => 'Legacy')).toBeNull()
  })

  // 5.1 has no such setting at all, so it prints an empty line and cannot be trusted with one.
  it('refuses a host that has no such setting to print', () => {
    const environment = machine('unset', 'pwsh')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => '')).toBeNull()
  })

  it('refuses a host that could not be asked', () => {
    const environment = machine('unanswered', 'pwsh')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => null)).toBeNull()
  })

  /*
   * `powershell.exe` is deliberately not looked for. It is the one host that is always there and the
   * one that corrupts a quoted argument, so a machine without `pwsh` has no route at all.
   */
  it('looks for pwsh alone, never for the Windows PowerShell beside it', () => {
    const environment = machine('windows-powershell', 'powershell')
    expect(PowerShellHost.exactArgumentHostOf(environment, () => 'Standard')).toBeNull()
  })

  it('answers null when nothing on the path is a PowerShell', () => {
    expect(PowerShellHost.exactArgumentHostOf(machine('empty'), () => 'Standard')).toBeNull()
  })

  // The answer is a property of an installation, so the second launch of a session pays nothing.
  it('asks one installation once', () => {
    const environment = machine('cached', 'pwsh')
    let asked = 0
    const probe = (): string => {
      asked += 1
      return 'Standard'
    }
    const first = PowerShellHost.exactArgumentHostOf(environment, probe)
    expect(PowerShellHost.exactArgumentHostOf(environment, probe)).toBe(first)
    expect(asked).toBe(1)
  })
})
