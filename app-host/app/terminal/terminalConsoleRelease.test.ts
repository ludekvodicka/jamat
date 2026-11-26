import { execFileSync } from 'node:child_process'
import { spawn } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { ProcessStartIdentity } from '../shared/processStartIdentity'
import { ConsoleReaper } from './consoleReaper'
import { TerminalInstance } from './terminalInstance'

/** The headless consoles this test process owns. */
function consoles(): number {
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='conhost.exe'" | Where-Object { $_.CommandLine -like '*--headless*' }).Count`],
  { encoding: 'utf8', windowsHide: true }).trim())
}

const options = TerminalInstance.ptyOptionsOf({ cols: 80, rows: 24, cwd: process.cwd(), env: { ...process.env } as Record<string, string> })

describe.runIf(process.platform === 'win32')('app-host/app/terminal console release (real ConPTY)', () => {
  it('ends the consoles of 10 runs that ended by themselves and keeps the console of a live shell', async () => {
    const before = consoles()
    for (let run = 0; run < 10; run++)
      await new Promise<void>(resolve => {
        const child = spawn('cmd.exe', ['/d', '/c', 'exit 0'], options)
        child.onExit(() => { try { child.kill() } catch {} resolve() })
      })
    // A console started within the pairing window before a live terminal is kept on purpose.
    await new Promise(resolve => setTimeout(resolve, ConsoleReaper.pairingMsConst + 1_000))
    const shell = spawn('cmd.exe', ['/d'], options)
    const exited = new Promise<void>(resolve => shell.onExit(() => resolve()))
    // node-pty exposes the PID only once its agent connected, as `TerminalInstance.ready` waits for.
    let identity = await ProcessStartIdentity.probeAsync(shell.pid)
    for (let attempt = 0; attempt < 40 && identity.state !== 'alive'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (shell.pid > 0) identity = await ProcessStartIdentity.probeAsync(shell.pid)
    }
    if (identity.state !== 'alive') throw new Error(`The live shell has no start identity: ${JSON.stringify(identity)}`)
    expect(consoles()).toBe(before + 11)

    // Every console counts as old enough; only the live shell's start can keep one.
    const reaper = new ConsoleReaper(() => [{ alive: true, processStartedAt: identity.processStartedAt }],
      { now: () => Date.now() + ConsoleReaper.minimumAgeMsConst, report: message => { throw new Error(message) } })
    await reaper.sweep()
    expect(consoles()).toBe(before + 1)

    let echoed = ''
    shell.onData(data => { echoed += data })
    shell.write('echo still-here\r')
    await expect.poll(() => echoed.includes('still-here'), { timeout: 10_000 }).toBe(true)
    shell.kill()
    await exited
  }, 120_000)
})
