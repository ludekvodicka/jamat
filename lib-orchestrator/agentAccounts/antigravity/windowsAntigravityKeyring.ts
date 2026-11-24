import { tmpdir } from 'node:os'
import { CommandInvoker } from '../../shared/commandInvoker'
import { AntigravityConfigHome } from '../../shared/antigravityConfigHome'
import { JsonShape } from '../../shared/jsonShape'
import { AccountProblem } from '../accountProblem'

export interface AntigravityKeyringMeta {
  label: string
  email: string | null
  planTier: string | null
  savedAt: number
}

export interface AntigravityKeyringSlot extends AntigravityKeyringMeta {
  id: string
  hash: string
}

export interface AntigravityKeyringInspect {
  present: boolean
  currentHash: string | null
  slots: readonly AntigravityKeyringSlot[]
}

/**
 * Manages the active Antigravity CLI Windows Credential Manager entry (`gemini:antigravity`) and
 * Jamat-owned backup slots (`jamat-v3:antigravity-login:<slotId>`) via Win32 CredReadW/CredWriteW/
 * CredDeleteW/CredEnumerateW inside a short-lived PowerShell process.
 *
 * Raw credential bytes stay inside Windows Credential Manager and the child process: nothing secret
 * is written to disk, logged, or printed to stdout/stderr. Only SHA-256 digests and non-secret slot
 * metadata cross back into Node.
 */
export class WindowsAntigravityKeyring {
  static readonly activeTargetConst = 'gemini:antigravity'
  static readonly activeUserConst = 'antigravity'
  static readonly slotPrefixConst = 'jamat-v3:antigravity-login:'
  static readonly slotIdPatternConst = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  static readonly maxSlotIdLengthConst = 64
  /** Win32 CREDENTIALW.Comment is bounded by CRED_MAX_STRING_LENGTH (256 UTF-16 code units incl. NUL). */
  static readonly maxCommentLengthConst = 250
  private static readonly timeoutMsConst = 15_000

  static readonly scriptConst = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class JamatWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  private const uint CRED_TYPE_GENERIC = 1;
  private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
  private const int ERROR_NOT_FOUND = 1168;

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentialsPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  private static extern void CredFree(IntPtr buffer);

  private static string Sha256Hex(byte[] data) {
    using (SHA256 sha = SHA256.Create()) {
      byte[] digest = sha.ComputeHash(data);
      return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
    }
  }

  private static bool TryRead(string target, out byte[] blob, out string user, out string comment) {
    blob = null;
    user = null;
    comment = null;
    IntPtr ptr;
    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_NOT_FOUND) return false;
      throw new InvalidOperationException("CRED_READ_ERROR:" + err);
    }
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      blob = new byte[cred.CredentialBlobSize];
      if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
        Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
      }
      user = cred.UserName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.UserName) : null;
      comment = cred.Comment != IntPtr.Zero ? Marshal.PtrToStringUni(cred.Comment) : null;
      return true;
    } finally {
      CredFree(ptr);
    }
  }

  private static void Write(string target, string user, string comment, byte[] blob) {
    IntPtr targetPtr = IntPtr.Zero;
    IntPtr userPtr = IntPtr.Zero;
    IntPtr commentPtr = IntPtr.Zero;
    IntPtr blobPtr = IntPtr.Zero;
    try {
      targetPtr = Marshal.StringToCoTaskMemUni(target);
      userPtr = user != null ? Marshal.StringToCoTaskMemUni(user) : IntPtr.Zero;
      commentPtr = comment != null ? Marshal.StringToCoTaskMemUni(comment) : IntPtr.Zero;
      if (blob.Length > 0) {
        blobPtr = Marshal.AllocCoTaskMem(blob.Length);
        Marshal.Copy(blob, 0, blobPtr, blob.Length);
      }
      CREDENTIAL cred = new CREDENTIAL {
        Flags = 0,
        Type = CRED_TYPE_GENERIC,
        TargetName = targetPtr,
        Comment = commentPtr,
        CredentialBlobSize = (uint)blob.Length,
        CredentialBlob = blobPtr,
        Persist = CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount = 0,
        Attributes = IntPtr.Zero,
        TargetAlias = IntPtr.Zero,
        UserName = userPtr,
      };
      if (!CredWrite(ref cred, 0)) {
        throw new InvalidOperationException("CRED_WRITE_ERROR:" + Marshal.GetLastWin32Error());
      }
    } finally {
      if (blobPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(blobPtr);
      if (commentPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(commentPtr);
      if (userPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(userPtr);
      if (targetPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(targetPtr);
    }
  }

  public static Dictionary<string, object> Inspect(string activeTarget, string slotPrefix) {
    byte[] activeBlob;
    string activeUser;
    string activeComment;
    bool present = TryRead(activeTarget, out activeBlob, out activeUser, out activeComment);
    string currentHash = null;
    if (present) {
      try { currentHash = Sha256Hex(activeBlob); }
      finally { Array.Clear(activeBlob, 0, activeBlob.Length); }
    }
    var slots = new List<Dictionary<string, object>>();
    uint count;
    IntPtr credsPtr;
    if (CredEnumerate(slotPrefix + "*", 0, out count, out credsPtr)) {
      try {
        for (int i = 0; i < (int)count; i++) {
          IntPtr itemPtr = Marshal.ReadIntPtr(credsPtr, i * IntPtr.Size);
          CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(itemPtr, typeof(CREDENTIAL));
          string target = cred.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.TargetName) : "";
          if (!target.StartsWith(slotPrefix, StringComparison.Ordinal)) continue;
          string id = target.Substring(slotPrefix.Length);
          string comment = cred.Comment != IntPtr.Zero ? Marshal.PtrToStringUni(cred.Comment) : "";
          byte[] blob = new byte[cred.CredentialBlobSize];
          if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
            Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
          }
          string hash;
          try { hash = Sha256Hex(blob); }
          finally { Array.Clear(blob, 0, blob.Length); }
          slots.Add(new Dictionary<string, object> {
            { "id", id },
            { "comment", comment },
            { "hash", hash },
          });
        }
      } finally {
        CredFree(credsPtr);
      }
    } else {
      int err = Marshal.GetLastWin32Error();
      if (err != ERROR_NOT_FOUND) throw new InvalidOperationException("CRED_ENUM_ERROR:" + err);
    }
    return new Dictionary<string, object> {
      { "present", present },
      { "currentHash", currentHash },
      { "slots", slots },
    };
  }

  public static void Store(string activeTarget, string slotTarget, string fallbackUser, string comment) {
    byte[] blob;
    string user;
    string unusedComment;
    if (!TryRead(activeTarget, out blob, out user, out unusedComment)) {
      throw new InvalidOperationException("NO_CURRENT_LOGIN");
    }
    try {
      Write(slotTarget, string.IsNullOrEmpty(user) ? fallbackUser : user, comment, blob);
    } finally {
      Array.Clear(blob, 0, blob.Length);
    }
  }

  public static void Activate(string slotTarget, string activeTarget, string activeUser) {
    byte[] blob;
    string user;
    string unusedComment;
    if (!TryRead(slotTarget, out blob, out user, out unusedComment)) {
      throw new InvalidOperationException("SLOT_NOT_FOUND");
    }
    try {
      Write(activeTarget, string.IsNullOrEmpty(user) ? activeUser : user, null, blob);
    } finally {
      Array.Clear(blob, 0, blob.Length);
    }
  }

  public static void Delete(string target, bool requirePresent) {
    if (!CredDelete(target, CRED_TYPE_GENERIC, 0)) {
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_NOT_FOUND) {
        if (requirePresent) throw new InvalidOperationException("SLOT_NOT_FOUND");
        return;
      }
      throw new InvalidOperationException("CRED_DELETE_ERROR:" + err);
    }
  }
}
"@
$op = $env:JAMAT_V3_AGY_OP
$slot = $env:JAMAT_V3_AGY_SLOT
$meta = $env:JAMAT_V3_AGY_META
$active = '${WindowsAntigravityKeyring.activeTargetConst}'
$activeUser = '${WindowsAntigravityKeyring.activeUserConst}'
$prefix = '${WindowsAntigravityKeyring.slotPrefixConst}'
try {
  switch ($op) {
    'inspect' {
      $result = [JamatWinCred]::Inspect($active, $prefix)
      Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
    }
    'store' {
      if ($slot -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $slot.Length -gt 64) { throw 'INVALID_SLOT' }
      [JamatWinCred]::Store($active, ($prefix + $slot), $activeUser, $meta)
      Write-Output '{"ok":true}'
    }
    'activate' {
      if ($slot -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $slot.Length -gt 64) { throw 'INVALID_SLOT' }
      [JamatWinCred]::Activate(($prefix + $slot), $active, $activeUser)
      Write-Output '{"ok":true}'
    }
    'clear' {
      [JamatWinCred]::Delete($active, $false)
      Write-Output '{"ok":true}'
    }
    'remove' {
      if ($slot -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' -or $slot.Length -gt 64) { throw 'INVALID_SLOT' }
      [JamatWinCred]::Delete(($prefix + $slot), $true)
      Write-Output '{"ok":true}'
    }
    default { throw 'UNKNOWN_OP' }
  }
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException -and $_.Exception.InnerException.Message) {
    $msg = $_.Exception.InnerException.Message
  }
  [Console]::Error.WriteLine($msg)
  exit 1
}
`

  readonly available: boolean
  readonly unavailableReason: string | null

  private readonly invoker: Pick<CommandInvoker, 'run'>
  private readonly environment: NodeJS.ProcessEnv
  private readonly cwd: string
  private readonly encodedScript: string

  constructor(options?: {
    invoker?: Pick<CommandInvoker, 'run'>
    platform?: NodeJS.Platform
    environment?: NodeJS.ProcessEnv
    cwd?: string
  }) {
    const platform = options?.platform ?? process.platform
    const environment = options?.environment ?? process.env
    const geminiOverride = (environment[AntigravityConfigHome.variableConst] ?? '').trim()
    if (platform !== 'win32') {
      this.available = false
      this.unavailableReason = 'Antigravity login switching is only supported on Windows'
    } else if (geminiOverride.length > 0) {
      this.available = false
      this.unavailableReason = `Antigravity login switching is disabled while ${AntigravityConfigHome.variableConst} is set`
    } else {
      this.available = true
      this.unavailableReason = null
    }
    this.invoker = options?.invoker ?? new CommandInvoker({ timeoutMilliseconds: WindowsAntigravityKeyring.timeoutMsConst })
    this.environment = environment
    this.cwd = options?.cwd ?? tmpdir()
    this.encodedScript = Buffer.from(WindowsAntigravityKeyring.scriptConst, 'utf16le').toString('base64')
  }

  async inspect(): Promise<AntigravityKeyringInspect> {
    const stdout = await this.execute('inspect')
    return WindowsAntigravityKeyring.parseInspectOutput(stdout)
  }

  async store(slotId: string, meta: AntigravityKeyringMeta): Promise<void> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    await this.execute('store', slotId, WindowsAntigravityKeyring.encodeMeta(meta))
  }

  async activate(slotId: string): Promise<void> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    await this.execute('activate', slotId)
  }

  async clear(): Promise<void> {
    await this.execute('clear')
  }

  async remove(slotId: string): Promise<void> {
    WindowsAntigravityKeyring.assertSlotId(slotId)
    await this.execute('remove', slotId)
  }

  static assertSlotId(slotId: string): void {
    if (!WindowsAntigravityKeyring.slotIdPatternConst.test(slotId) || slotId.length > WindowsAntigravityKeyring.maxSlotIdLengthConst)
      throw new AccountProblem('Invalid Antigravity login id')
  }

  static encodeMeta(meta: AntigravityKeyringMeta): string {
    const base = { v: 1, l: meta.label, t: meta.savedAt }
    const full = JSON.stringify({
      ...base,
      ...(meta.email === null ? {} : { e: meta.email }),
      ...(meta.planTier === null ? {} : { p: meta.planTier }),
    })
    if (full.length <= WindowsAntigravityKeyring.maxCommentLengthConst) return full
    const withoutPlan = JSON.stringify({
      ...base,
      ...(meta.email === null ? {} : { e: meta.email }),
    })
    if (withoutPlan.length <= WindowsAntigravityKeyring.maxCommentLengthConst) return withoutPlan
    const labelOnly = JSON.stringify(base)
    if (labelOnly.length <= WindowsAntigravityKeyring.maxCommentLengthConst) return labelOnly
    return JSON.stringify({ v: 1, l: meta.label.slice(0, 80), t: meta.savedAt })
  }

  static decodeMeta(id: string, comment: string): AntigravityKeyringMeta {
    let parsed: unknown
    try { parsed = JSON.parse(comment) }
    catch { return { label: id, email: null, planTier: null, savedAt: 0 } }
    const record = JsonShape.record(parsed)
    if (record === null || record.v !== 1) return { label: id, email: null, planTier: null, savedAt: 0 }
    const label = typeof record.l === 'string' && record.l.trim().length > 0 ? record.l.trim() : id
    const email = typeof record.e === 'string' && record.e.trim().length > 0 ? record.e.trim() : null
    const planTier = typeof record.p === 'string' && record.p.trim().length > 0 ? record.p.trim() : null
    const savedAt = typeof record.t === 'number' && Number.isFinite(record.t) && record.t >= 0 ? record.t : 0
    return { label, email, planTier, savedAt }
  }

  static parseInspectOutput(stdout: string): AntigravityKeyringInspect {
    let parsed: unknown
    try { parsed = JSON.parse(stdout.trim()) }
    catch { throw new AccountProblem('Could not read Windows Credential Manager state') }
    const record = JsonShape.record(parsed)
    if (record === null || typeof record.present !== 'boolean')
      throw new AccountProblem('Could not read Windows Credential Manager state')
    const currentHash = typeof record.currentHash === 'string' && record.currentHash.length > 0 ? record.currentHash : null
    const rawSlots = Array.isArray(record.slots) ? record.slots : record.slots === null || record.slots === undefined ? [] : [record.slots]
    const slots: AntigravityKeyringSlot[] = []
    for (const item of rawSlots) {
      const row = JsonShape.record(item)
      if (row === null || typeof row.id !== 'string' || typeof row.hash !== 'string') continue
      if (!WindowsAntigravityKeyring.slotIdPatternConst.test(row.id) || row.id.length > WindowsAntigravityKeyring.maxSlotIdLengthConst) continue
      const comment = typeof row.comment === 'string' ? row.comment : ''
      slots.push({ id: row.id, hash: row.hash, ...WindowsAntigravityKeyring.decodeMeta(row.id, comment) })
    }
    return { present: record.present, currentHash, slots }
  }

  private async execute(operation: 'inspect' | 'store' | 'activate' | 'clear' | 'remove', slotId = '', meta = ''): Promise<string> {
    if (!this.available) throw new AccountProblem(this.unavailableReason ?? 'Antigravity login switching is not available')
    const outcome = await this.invoker.run({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', this.encodedScript],
      cwd: this.cwd,
      env: {
        ...this.environment,
        JAMAT_V3_AGY_OP: operation,
        JAMAT_V3_AGY_SLOT: slotId,
        JAMAT_V3_AGY_META: meta,
      },
      timeoutMs: WindowsAntigravityKeyring.timeoutMsConst,
    })
    if (outcome.failure !== null || outcome.code !== 0)
      throw WindowsAntigravityKeyring.problemOf(outcome.stderr.trim(), outcome.failure)
    return outcome.stdout
  }

  private static problemOf(stderr: string, failure: string | null): AccountProblem {
    if (stderr.includes('NO_CURRENT_LOGIN'))
      return new AccountProblem('No current Antigravity login found in Windows Credential Manager')
    if (stderr.includes('SLOT_NOT_FOUND'))
      return new AccountProblem('Saved Antigravity login not found')
    if (stderr.includes('INVALID_SLOT'))
      return new AccountProblem('Invalid Antigravity login id')
    if (failure === 'timeout')
      return new AccountProblem('Timed out accessing Windows Credential Manager')
    if (failure === 'command-missing')
      return new AccountProblem('powershell.exe is required to manage Antigravity logins')
    return new AccountProblem('Windows Credential Manager operation failed')
  }
}
