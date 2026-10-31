import { randomUUID } from 'node:crypto'
import { lstat, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { CommandInvoker } from '../../shared/commandInvoker'
import { ErrnoCode } from '../../shared/errnoCode'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'

export interface WorktreeFileHolder {
  pid: number
  /** What Windows calls the program: "Syncovery Background Process", "Windows PowerShell". */
  name: string
}

export interface WorktreeHeldFile {
  path: string
  holders: WorktreeFileHolder[]
}

export type WorktreeHolderLookup =
  | { kind: 'found'; files: WorktreeHeldFile[] }
  /** Windows names no program with one of these files open; a working directory is never named. */
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

/**
 * Names the programs that hold files open below a worktree, through the Windows Restart Manager
 * (`rstrtmgr.dll`), which needs no administrator rights. Windows PowerShell compiles the P/Invoke
 * once per lookup; no native module ships for this. The Restart Manager answers per list of files,
 * so the list is halved until each held file is found alone. A process whose working directory is
 * inside holds no file and is never named.
 */
export class WorktreeFileHolders {
  /** About 9 s for 20,000 files on the development PC, PowerShell start included. */
  static readonly filesConst = 20_000
  static readonly timeoutMillisecondsConst = 30_000
  /** The held files a lookup names at most. */
  static readonly namedConst = 5

  private readonly platform: NodeJS.Platform
  private readonly invoker: CommandInvoker

  constructor(options?: { platform?: NodeJS.Platform; invoker?: CommandInvoker }) {
    this.platform = options?.platform ?? process.platform
    this.invoker = options?.invoker ?? new CommandInvoker({ timeoutMilliseconds: WorktreeFileHolders.timeoutMillisecondsConst })
  }

  /** The holders of `path` itself, or of the files below it when it is a directory. */
  async below(path: string): Promise<WorktreeHolderLookup> {
    if (this.platform !== 'win32') return { kind: 'unavailable', reason: 'only Windows names the programs holding a file' }
    try {
      return await this.of(await WorktreeFileHolders.filesBelow(path))
    } catch (error) { return { kind: 'unavailable', reason: ErrorText.of(error) } }
  }

  private async of(files: readonly string[]): Promise<WorktreeHolderLookup> {
    if (files.length === 0) return { kind: 'none' }
    const list = join(tmpdir(), `jamat-v3-holders-${randomUUID()}.txt`)
    await writeFile(list, files.join('\n'), 'utf8')
    try {
      const script = WorktreeFileHolders.scriptOf(list)
      const outcome = await this.invoker.run({
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: WorktreeFileHolders.timeoutMillisecondsConst,
      })
      if (outcome.failure !== null || outcome.code !== 0)
        return { kind: 'unavailable', reason: `the Restart Manager query failed: ${outcome.failure ?? (WorktreeFileHolders.errorOf(outcome.stderr) || `exit ${outcome.code}`)}` }
      const held = new Map<number, WorktreeFileHolder[]>()
      for (const line of outcome.stdout.split(/\r?\n/)) {
        const match = /^(\d+)\t(\d+)\t(.*)$/.exec(line)
        if (match === null || files[Number(match[1])] === undefined) continue
        const holders = held.get(Number(match[1])) ?? []
        holders.push({ pid: Number(match[2]), name: match[3].trim() || 'a program' })
        held.set(Number(match[1]), holders)
      }
      return held.size === 0 ? { kind: 'none' } : { kind: 'found', files: [...held].map(([index, holders]) => ({ path: files[index], holders })) }
    } finally { await rm(list, { force: true }) }
  }

  /** Breadth first, so the files near the root come before a deep dependency tree; links are not followed. */
  private static async filesBelow(path: string): Promise<string[]> {
    const info = await lstat(path).catch((error: unknown) => { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error })
    if (info === null || info.isSymbolicLink()) return []
    if (!info.isDirectory()) return [path]
    const files: string[] = []
    const directories = [path]
    while (directories.length > 0 && files.length < WorktreeFileHolders.filesConst) {
      const directory = directories.shift()!
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) directories.push(join(directory, entry.name))
        else if (files.length < WorktreeFileHolders.filesConst) files.push(join(directory, entry.name))
      }
    }
    return files
  }

  /** One line per held file: `HELD: src\a.txt by Windows PowerShell (PID 39524)`, paths relative to `root`. */
  static linesOf(lookup: Extract<WorktreeHolderLookup, { kind: 'found' }>, root: string): string[] {
    return lookup.files.map((file) => `HELD: ${WorktreeFileHolders.nameOf(file.path, root)} by ${WorktreeFileHolders.holdersOf(file.holders)}`)
  }

  static holdersOf(holders: readonly WorktreeFileHolder[]): string {
    return holders.map((holder) => `${holder.name} (PID ${holder.pid})`).join(', ')
  }

  /**
   * Windows PowerShell writes its error stream as CLIXML when stderr is redirected; a progress record
   * ("Preparing modules for first use") comes the same way, so the first line alone said `#< CLIXML`.
   */
  static errorOf(stderr: string): string {
    if (!stderr.startsWith('#< CLIXML')) return stderr.trim().split(/\r?\n/)[0] ?? ''
    const decode = (text: string) => text.replace(/_x([0-9A-F]{4})_/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    return [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((match) => decode(match[1])).join('').trim().split(/\r?\n/)[0] ?? ''
  }

  static nameOf(path: string, root: string): string {
    return PathCompare.isInside(root, path) && !PathCompare.isInside(path, root) ? relative(root, path) : path
  }

  private static scriptOf(list: string): string {
    return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JamatFileHolders {
  [StructLayout(LayoutKind.Sequential)]
  struct Unique { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Info {
    public Unique Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
    public int Type; public uint Status; public uint Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, Unique[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] Info[] infos, ref uint reasons);
  static List<string> Holders(string[] files, int from, int to) {
    var found = new List<string>();
    uint handle;
    if (RmStartSession(out handle, 0, new StringBuilder(64)) != 0) throw new Exception("RmStartSession failed");
    try {
      var names = new string[to - from];
      Array.Copy(files, from, names, 0, names.Length);
      if (RmRegisterResources(handle, (uint)names.Length, names, 0, null, 0, null) != 0) return found;
      uint needed, count = 0, reasons = 0;
      Info[] infos = null;
      int code = RmGetList(handle, out needed, ref count, null, ref reasons);
      while (code == 234) { infos = new Info[needed]; count = needed; code = RmGetList(handle, out needed, ref count, infos, ref reasons); }
      if (code != 0 || infos == null) return found;
      for (int i = 0; i < count; i++) found.Add(infos[i].Process.Pid + "\\t" + (infos[i].App ?? "").Replace('\\t', ' ').Replace('\\r', ' ').Replace('\\n', ' '));
    } finally { RmEndSession(handle); }
    return found;
  }
  static void Split(string[] files, int from, int to, List<string> lines, int limit, HashSet<int> named) {
    if (named.Count >= limit) return;
    var holders = Holders(files, from, to);
    if (holders.Count == 0) return;
    if (to - from == 1) { named.Add(from); foreach (var holder in holders) lines.Add(from + "\\t" + holder); return; }
    int middle = from + (to - from) / 2;
    Split(files, from, middle, lines, limit, named);
    Split(files, middle, to, lines, limit, named);
  }
  public static List<string> Find(string[] files, int limit) {
    var lines = new List<string>();
    var named = new HashSet<int>();
    for (int from = 0; from < files.Length; from += 1000) Split(files, from, Math.Min(files.Length, from + 1000), lines, limit, named);
    return lines;
  }
}
'@
$files = [System.IO.File]::ReadAllLines('${list.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
foreach ($line in [JamatFileHolders]::Find($files, ${WorktreeFileHolders.namedConst})) { [Console]::Out.WriteLine($line) }
`
  }
}
