/**
 * Smoke for the typed IPC contract. Type-only — we never call any IPC.
 * The smoke "passes" when this file compiles cleanly: every utility-type
 * assignment below is a structural assertion that the IpcMap entry has
 * the shape this codebase expects.
 *
 * Run: `npx tsc --noEmit scripts/smoke-ipc-contracts.ts` (or as part of
 *      the global `npx tsc --noEmit`).
 *
 * tsx execution is a no-op — there's nothing to run, only types to
 * resolve. We still ship an executable entry so `npm run smoke` style
 * loops surface "PASS" even when invoked.
 */

import type {
  IpcInvokeMap,
  IpcInvokeArgs,
  IpcInvokeResult,
  IpcSendMap,
  IpcSendArgs,
  IpcEventMap,
  IpcEventArgs,
  CommitResult,
  SessionDescriptionResult,
  SessionRenameResult,
  VcsDetectResult,
  RecentFile,
} from '../core/types/ipc-contracts'

// ────────────────────────────────────────────────────────────────────────────
// Sample type derivations — fails to compile if a channel's shape drifts
// ────────────────────────────────────────────────────────────────────────────

// 1. file:read takes one string, returns string | null.
const _readArgs: IpcInvokeArgs<'file:read'> = ['Q:/foo.txt']
const _readResult: IpcInvokeResult<'file:read'> = null
const _readResult2: IpcInvokeResult<'file:read'> = 'hello'

// 2. file-diff:get-baseline takes filePath + DiffMode + optional projectDir / sessionId.
const _baselineArgs: IpcInvokeArgs<'file-diff:get-baseline'> = [
  'Q:/foo.txt',
  { kind: 'off' },
  null,
  null,
]

// 3. commit:open-dialog returns a CommitResult.
const _commitResult: IpcInvokeResult<'commit:open-dialog'> = {
  ok: true,
  vcs: 'git',
  dialogs: [],
  skipped: [],
}
// Sanity: the shared type matches.
const _commitResultShared: CommitResult = _commitResult

// 4. sessions:rename has the canonical SessionRenameResult shape.
const _renameResult: IpcInvokeResult<'sessions:rename'> = { ok: true }
const _renameResultShared: SessionRenameResult = _renameResult

// 5. session-description channels share the discriminated result shape.
const _descriptionArgs: IpcInvokeArgs<'session-description:save'> = [
  '12345678-1234-1234-1234-123456789012',
  'Investigating restore behavior',
]
const _descriptionResult: IpcInvokeResult<'session-description:load'> = { ok: true, description: 'Saved note' }
const _descriptionResultShared: SessionDescriptionResult = _descriptionResult

// 6. commit:detect-vcs returns the shared VcsDetectResult.
const _detectResult: IpcInvokeResult<'commit:detect-vcs'> = { git: true, svn: false, hg: false }
const _detectResultShared: VcsDetectResult = _detectResult

// 7. file:list-recent's RecentFile shape is canonical.
const _recent: IpcInvokeResult<'file:list-recent'> = [
  { path: '/a', name: 'a', mtime: 0, relative: 'a' } satisfies RecentFile,
]

// 8. Send map: pty:write takes (id, data).
const _ptyWriteArgs: IpcSendArgs<'pty:write'> = ['term-1', 'echo hi\n']

// 9. Event map: file:changed delivers a single filePath.
const _fileChangedArgs: IpcEventArgs<'file:changed'> = ['Q:/foo.txt']

// 10. Negative-shape sanity — `@ts-expect-error` keeps these continuously
//    verified (tsc fails if any line STOPS being an error).
// @ts-expect-error wrong arg count (file:read needs a path)
const _bad: IpcInvokeArgs<'file:read'> = []
// @ts-expect-error wrong return type (declared string | null)
const _bad2: IpcInvokeResult<'file:read'> = 42
// @ts-expect-error unknown channel name
const _bad3: IpcInvokeArgs<'nonexistent'> = []
void _bad
void _bad2
void _bad3

// Touch the maps so the imports aren't pruned by isolatedModules.
type _ChannelCount =
  | keyof IpcInvokeMap
  | keyof IpcSendMap
  | keyof IpcEventMap

const _channelCountTouch: _ChannelCount = 'file:read'

void _readArgs
void _readResult
void _readResult2
void _baselineArgs
void _commitResult
void _commitResultShared
void _renameResult
void _renameResultShared
void _descriptionArgs
void _descriptionResult
void _descriptionResultShared
void _detectResult
void _detectResultShared
void _recent
void _ptyWriteArgs
void _fileChangedArgs
void _channelCountTouch

console.log('=== PASS (smoke-ipc-contracts: types resolved at compile time)')
