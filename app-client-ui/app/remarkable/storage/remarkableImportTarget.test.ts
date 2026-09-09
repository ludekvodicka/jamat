import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionWorkingContextResult } from '../../../../lib-orchestrator/sessionManager/sessionManager'
import type { RemarkableStorageSettingsValue } from '../../../shared/remarkableStorageSettings'
import { RemarkableImportTarget } from './remarkableImportTarget'

describe('app-client-ui/app/remarkable/storage/remarkableImportTarget', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function scratch(): string {
    // This subsystem proves a path by realpath(p) === p, and os.tmpdir() is an 8.3 short
    // name on the Windows CI runner. Only the NATIVE call expands one, so a plain
    // realpathSync here would leave the root short and every such proof would refuse.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-import-')))
    roots.push(root)
    return root
  }

  function context(cwd: string): SessionWorkingContextResult {
    return { ok: true, value: { sessionId: 's-1', cwd, agent: null, worktree: null } }
  }

  function storage(value: Partial<RemarkableStorageSettingsValue>): RemarkableStorageSettingsValue {
    return { scope: 'project', projectDirectory: '.aidocs/remarkable', ...value }
  }

  it('keeps global storage global and never asks about a session', async () => {
    const resolution = await RemarkableImportTarget.resolve(
      storage({ scope: 'global' }),
      { ok: false, code: 'unknown-session', detail: 'gone' },
    )

    expect(resolution).toEqual({ destination: { kind: 'global' }, note: null })
  })

  it('resolves the project folder under the session directory', async () => {
    const project = scratch()
    const resolution = await RemarkableImportTarget.resolve(storage({}), context(project))

    expect(resolution.note).toBeNull()
    expect(resolution.destination).toEqual({
      kind: 'project',
      root: project,
      directory: join(project, '.aidocs', 'remarkable'),
    })
  })

  /**
   * The page is already downloaded when this runs, so a session that cannot answer must not cost the
   * user the page. It lands in the global store instead and the note says why.
   */
  it('falls back to global with a reason when the session has no directory', async () => {
    const cases: readonly SessionWorkingContextResult[] = [
      { ok: false, code: 'unknown-session', detail: 'gone' },
      { ok: true, value: { sessionId: 's-1', cwd: '', agent: null, worktree: null } },
      { ok: true, value: { sessionId: 's-1', cwd: 'relative/only', agent: null, worktree: null } },
    ]

    for (const value of cases) {
      const resolution = await RemarkableImportTarget.resolve(storage({}), value)
      expect(resolution.destination).toEqual({ kind: 'global' })
      expect(resolution.note, JSON.stringify(value)).toMatch(/^Saved outside the project, because /)
    }
  })

  it('copies the verified page into the project and answers a relative path', async () => {
    const project = scratch()
    const source = join(scratch(), 'page.png')
    writeFileSync(source, Buffer.from([1, 2, 3, 4]))
    const resolution = await RemarkableImportTarget.resolve(storage({}), context(project))

    const placed = await RemarkableImportTarget.place(source, resolution.destination)

    expect(placed.ok).toBe(true)
    if (!placed.ok) throw new Error(placed.detail)
    expect(placed.value.insertText).toMatch(/^\.aidocs[/\\]remarkable[/\\]remarkable-.+\.png$/)
    expect(placed.value.outputPath).toBe(join(project, placed.value.insertText))
    expect(statSync(placed.value.outputPath).size).toBe(4)
  })

  it('gives a second page in the same second its own name', async () => {
    const project = scratch()
    const source = join(scratch(), 'page.png')
    writeFileSync(source, Buffer.from([1, 2, 3, 4]))
    const { destination } = await RemarkableImportTarget.resolve(storage({}), context(project))

    const first = await RemarkableImportTarget.place(source, destination)
    const second = await RemarkableImportTarget.place(source, destination)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('placement failed')
    expect(second.value.outputPath).not.toBe(first.value.outputPath)
    expect(readdirSync(join(project, '.aidocs', 'remarkable'))).toHaveLength(2)
  })

  /**
   * A symlinked folder is the one way a path that passed every text rule still writes outside the
   * project, so it is refused rather than followed.
   */
  it('refuses a folder that is a link out of the project', async () => {
    const project = scratch()
    const outside = scratch()
    const source = join(scratch(), 'page.png')
    writeFileSync(source, Buffer.from([1, 2, 3, 4]))
    mkdirSync(join(project, '.aidocs'), { recursive: true })
    try { symlinkSync(outside, join(project, '.aidocs', 'remarkable'), 'junction') }
    catch { return }

    const { destination } = await RemarkableImportTarget.resolve(storage({}), context(project))
    const placed = await RemarkableImportTarget.place(source, destination)

    expect(placed).toMatchObject({ ok: false, code: 'import-failed', retryable: false })
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses a page that is gone or empty rather than writing an empty file', async () => {
    const project = scratch()
    const store = scratch()
    const empty = join(store, 'empty.png')
    writeFileSync(empty, Buffer.alloc(0))
    const { destination } = await RemarkableImportTarget.resolve(storage({}), context(project))

    for (const source of [empty, join(store, 'missing.png')])
      expect(await RemarkableImportTarget.place(source, destination), source)
        .toMatchObject({ ok: false, code: 'import-failed' })
    expect(readdirSync(project)).not.toContain('.aidocs')
  })
})
