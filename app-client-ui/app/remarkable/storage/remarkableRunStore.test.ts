import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RemarkableRunStore } from './remarkableRunStore'

describe('app-client-ui/app/remarkable/storage/remarkableRunStore', () => {
  let root: string
  let sequence: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-remarkable-runs-'))
    sequence = 0
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('creates unique attempts, promotes the exact nonempty PNG and releases only scratch', async () => {
    const current = store()
    const run = await current.createRun()
    const first = await current.createAttempt(run)
    const second = await current.createAttempt(run)
    expect(first.directory).not.toBe(second.directory)
    expect(first.backupDirectory).toBe(first.directory)
    expect(first.outputPath).toBe(join(first.directory, 'page.png'))

    writeFileSync(first.outputPath, Buffer.from([1, 2, 3, 4]))
    const result = await current.promoteOutput(first, first.outputPath, 4)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.value).toBe(join(root, 'imports', 'id-4.png'))
    expect(existsSync(result.value)).toBe(true)
    expect(existsSync(first.outputPath)).toBe(false)

    await current.release(run)
    expect(existsSync(run.directory)).toBe(false)
    expect(existsSync(result.value)).toBe(true)
  })

  it('rejects a wrong path, zero bytes, byte mismatch and symlink escape without importing', async () => {
    const current = store()
    const run = await current.createRun()

    const wrong = await current.createAttempt(run)
    writeFileSync(wrong.outputPath, 'png')
    expect(await current.promoteOutput(wrong, join(wrong.directory, 'other.png'), 3))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })

    const empty = await current.createAttempt(run)
    writeFileSync(empty.outputPath, '')
    expect(await current.promoteOutput(empty, empty.outputPath, 0))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })

    const mismatch = await current.createAttempt(run)
    writeFileSync(mismatch.outputPath, 'four')
    expect(await current.promoteOutput(mismatch, mismatch.outputPath, 5))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })

    const linked = await current.createAttempt(run)
    const outside = join(root, 'outside.png')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, linked.outputPath, 'file')
    expect(await current.promoteOutput(linked, linked.outputPath, 7))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })

    expect(existsSync(join(root, 'imports'))).toBe(false)
  })

  it('rejects and removes a destination replaced after the validated file was moved', async () => {
    const current = store(Date.now(), async (source, target) => {
      await rename(source, target)
      rmSync(target, { force: true })
      writeFileSync(target, 'evil')
    })
    const run = await current.createRun()
    const attempt = await current.createAttempt(run)
    writeFileSync(attempt.outputPath, 'good')

    expect(await current.promoteOutput(attempt, attempt.outputPath, 4))
      .toMatchObject({ ok: false, code: 'invalid-cli-output' })
    expect(existsSync(join(root, 'imports', 'id-3.png'))).toBe(false)
  })

  it('refuses cleanup through a junction root and leaves its target untouched', async () => {
    const outside = join(root, 'outside')
    const outsideEntry = join(outside, 'old-run')
    mkdirSync(outsideEntry, { recursive: true })
    symlinkSync(outside, join(root, 'runs'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(store().cleanup()).rejects.toThrow(/real profile directory/)
    expect(existsSync(outsideEntry)).toBe(true)
  })

  it('cleans runs and imports older than 30 days only when cleanup is explicitly requested', async () => {
    const now = Date.UTC(2026, 7, 27)
    const oldRun = join(root, 'runs', 'old-run')
    const freshRun = join(root, 'runs', 'fresh-run')
    const oldImport = join(root, 'imports', 'old.png')
    const freshImport = join(root, 'imports', 'fresh.png')
    const unknownRun = join(root, 'runs', 'note.txt')
    const unknownImport = join(root, 'imports', 'folder')
    mkdirSync(oldRun, { recursive: true })
    mkdirSync(freshRun)
    mkdirSync(join(root, 'imports'))
    writeFileSync(oldImport, 'old')
    writeFileSync(freshImport, 'fresh')
    writeFileSync(unknownRun, 'old but not a run')
    mkdirSync(unknownImport)
    const old = new Date(now - RemarkableRunStore.retentionMillisecondsConst - 1)
    const fresh = new Date(now - RemarkableRunStore.retentionMillisecondsConst)
    for (const path of [oldRun, oldImport, unknownRun, unknownImport]) utimesSync(path, old, old)
    for (const path of [freshRun, freshImport]) utimesSync(path, fresh, fresh)

    const current = store(now)
    expect(existsSync(oldRun)).toBe(true)
    expect(existsSync(oldImport)).toBe(true)
    await current.cleanup()
    expect(existsSync(oldRun)).toBe(false)
    expect(existsSync(oldImport)).toBe(false)
    expect(existsSync(freshRun)).toBe(true)
    expect(existsSync(freshImport)).toBe(true)
    expect(existsSync(unknownRun)).toBe(true)
    expect(existsSync(unknownImport)).toBe(true)
  })

  it('keeps at most the newest 64 scratch runs and imports', async () => {
    const now = Date.UTC(2026, 7, 27)
    const runs = join(root, 'runs')
    const imports = join(root, 'imports')
    mkdirSync(runs)
    mkdirSync(imports)
    for (let index = 0; index < RemarkableRunStore.retainedEntriesMaxConst + 3; index += 1) {
      const run = join(runs, `run-${index.toString().padStart(3, '0')}`)
      const imported = join(imports, `import-${index.toString().padStart(3, '0')}.png`)
      mkdirSync(run)
      writeFileSync(imported, 'png')
      const modified = new Date(now - index * 1_000)
      utimesSync(run, modified, modified)
      utimesSync(imported, modified, modified)
    }

    const current = store(now)
    await current.cleanup()

    expect(readdirSync(runs)).toHaveLength(RemarkableRunStore.retainedEntriesMaxConst)
    expect(readdirSync(imports)).toHaveLength(RemarkableRunStore.retainedEntriesMaxConst)
    expect(existsSync(join(runs, 'run-000'))).toBe(true)
    expect(existsSync(join(imports, 'import-000.png'))).toBe(true)
    expect(existsSync(join(runs, 'run-064'))).toBe(false)
    expect(existsSync(join(imports, 'import-064.png'))).toBe(false)

    const created = await current.createRun()
    expect(readdirSync(runs)).toHaveLength(RemarkableRunStore.retainedEntriesMaxConst)
    expect(existsSync(created.directory)).toBe(true)

    const attempt = await current.createAttempt(created)
    writeFileSync(attempt.outputPath, 'png')
    const promoted = await current.promoteOutput(attempt, attempt.outputPath, 3)
    expect(promoted.ok).toBe(true)
    expect(readdirSync(imports)).toHaveLength(RemarkableRunStore.retainedEntriesMaxConst)
    if (promoted.ok) expect(existsSync(promoted.value)).toBe(true)

    const expired = new Date(now - RemarkableRunStore.retentionMillisecondsConst - 1)
    utimesSync(created.directory, expired, expired)
    const newer = join(runs, 'newer-extra')
    mkdirSync(newer)
    utimesSync(newer, new Date(now), new Date(now))
    await current.cleanup()
    expect(readdirSync(runs)).toHaveLength(RemarkableRunStore.retainedEntriesMaxConst)
    expect(existsSync(created.directory)).toBe(true)
  })

  function store(
    now = Date.now(),
    move?: (source: string, target: string) => Promise<void>,
  ): RemarkableRunStore {
    return new RemarkableRunStore({
      runsDirectory: join(root, 'runs'),
      importsDirectory: join(root, 'imports'),
      now: () => now,
      id: () => `id-${++sequence}`,
      ...(move === undefined ? {} : { move }),
    })
  }
})
