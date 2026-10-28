import { execFile } from 'node:child_process'

export interface TerminalDescendant { pid: number; startedAt: number }

export class TerminalDescendants {
  // A PowerShell start plus one CIM query takes about 2 s on an idle PC and passed 5 s under a test load.
  private static readonly queryTimeoutMsConst = 10_000

  static async capture(pid: number, startedAt: number | null): Promise<TerminalDescendant[]> {
    if (process.platform !== 'win32' || startedAt === null) return []
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'
    const output = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    const parsed = JSON.parse(output)
    const rows: Array<TerminalDescendant & { parent: number }> = Array.isArray(parsed) ? parsed : [parsed]
    if (!Array.isArray(rows) || rows.some((row) => !Number.isInteger(row.pid) || !Number.isInteger(row.parent) || !Number.isFinite(row.startedAt)))
      throw new Error('Cannot identify the terminal process tree')
    const root = rows.find((row) => row.pid === pid)
    if (root === undefined) {
      const uncertain = rows.filter((row) => row.parent === pid).map((row) => row.pid)
      if (uncertain.length > 0) throw new Error(`Terminal root exited before inspection; surviving processes require inspection: ${uncertain.join(', ')}`)
      throw new Error(`Terminal root PID ${pid} exited during inspection; its full descendant tree cannot be proven`)
    }
    if (Math.abs(root.startedAt - startedAt) > 1) throw new Error('Terminal PID was reused before descendant inspection')
    const owned = new Map([[pid, root]])
    for (let changed = true; changed;) {
      changed = false
      for (const row of rows)
        if (!owned.has(row.pid) && owned.has(row.parent) && row.startedAt >= owned.get(row.parent)!.startedAt) {
          owned.set(row.pid, row)
          changed = true
        }
    }
    return [...owned.values()].filter((row) => row.pid !== pid)
  }

  static async stop(children: readonly TerminalDescendant[]): Promise<void> {
    if (process.platform !== 'win32' || children.length === 0) return
    if (children.some((child) => !Number.isSafeInteger(child.pid) || child.pid <= 0 || !Number.isSafeInteger(child.startedAt)))
      throw new Error('Invalid owned process identity')
    const identities = [...children].reverse().map((child) => `@{ pid=${child.pid}; born=${child.startedAt} }`).join(',')
    // CIM, the source of the captured identity, also reads the start of a protected process, where Get-Process answers null.
    await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $failures=@(); try { $owned=@(${identities}); $born=@{}; `
      + `Get-CimInstance Win32_Process -Filter (($owned | ForEach-Object { "ProcessId=$($_.pid)" }) -join ' OR ') | `
      + `ForEach-Object { $born[[int]$_.ProcessId]=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; `
      + `foreach ($item in $owned) { try { `
      + `if (!$born.ContainsKey($item.pid) -or [Math]::Abs($born[$item.pid]-$item.born) -gt 1) { continue }; `
      + `$p=Get-Process -Id $item.pid -ErrorAction SilentlyContinue; if ($null -eq $p) { continue }; `
      + `try { $p.Kill(); if (!$p.WaitForExit(1000)) { throw "Owned child $($item.pid) has not exited" } } `
      + `catch { if (!$p.HasExited) { throw } } } catch { $failures += "PID $($item.pid): $($_.Exception.Message)" } } } `
      + `catch { $failures += "Owned process query failed: $($_.Exception.Message)" }; `
      + `if ($failures.Count) { [Console]::Error.Write($failures -join '; '); exit 1 }; exit 0`])
  }

  private static run(file: string, args: string[], timeout = TerminalDescendants.queryTimeoutMsConst): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        clearTimeout(deadline)
        if (error === null) resolve(stdout)
        else reject(stderr.trim() === '' ? error : new Error(stderr.trim()))
      })
      // execFile's timeout still waits for close; a console inheriting its pipes can prevent close.
      const deadline = setTimeout(() => {
        child.kill()
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()
        reject(new Error(`Managed process query timed out after ${timeout} ms; inspect remaining processes`))
      }, timeout)
    })
  }
}
