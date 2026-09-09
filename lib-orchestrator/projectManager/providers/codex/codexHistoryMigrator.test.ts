import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RewriterIo } from '../core/transcriptRewriter'
import type {
  LeftoverEntry,
  RelocationJournalWriter,
  RelocationLeftoversWriter,
  RelocationStep,
} from '../providerContract.types'
import { CodexHistoryMigrator } from './codexHistoryMigrator'
import { CodexRolloutIndex } from './codexRolloutIndex'

describe('lib-orchestrator/projectManager/providers/codex/codexHistoryMigrator', () => {
  const created: string[] = []

  const oldDir = 'Q:\\Apps\\Foo'
  const newDir = 'Q:\\Apps\\Bar'
  const otherDir = 'Q:\\Apps\\Other'
  const sessionIndexConst = '{"id":"1111","name":"kept"}\n{"id":"2222","name":"kept too"}\n'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    codexHome: string
    messages: string[]
    index: CodexRolloutIndex
    journal: RelocationJournalWriter & { steps: RelocationStep[] }
    leftovers: RelocationLeftoversWriter & { records: LeftoverEntry[] }
    migrator: CodexHistoryMigrator
  }

  function diskIo(): RewriterIo {
    return {
      readFile: (file) => readFile(file, 'utf8'),
      writeFile: (file, content) => writeFile(file, content, 'utf8'),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      unlink: (file) => unlink(file),
    }
  }

  function failing(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  function harness(io?: Partial<RewriterIo>): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-codex-migrator-'))
    created.push(root)
    const codexHome = join(root, 'codex')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'session_index.jsonl'), sessionIndexConst, 'utf8')
    const messages: string[] = []
    const steps: RelocationStep[] = []
    const records: LeftoverEntry[] = []
    const index = new CodexRolloutIndex(codexHome, (message) => messages.push(message))
    return {
      codexHome,
      messages,
      index,
      journal: { operationId: 'op-7', steps, checkpoint: (step) => { steps.push(step) } },
      leftovers: { records, record: (entry) => { records.push(entry); return true } },
      migrator: new CodexHistoryMigrator({
        index,
        report: (message) => messages.push(message),
        io: { ...diskIo(), ...io },
      }),
    }
  }

  /** The store's own layout: the day directory carries the date, the file name the time and the id. */
  function seedRollout(
    codexHome: string,
    cwd: string,
    second: number,
    id: string,
    daysAgo = 0,
  ): string {
    const at = new Date(Date.now() - daysAgo * 86_400_000)
    const year = String(at.getFullYear())
    const month = String(at.getMonth() + 1).padStart(2, '0')
    const day = String(at.getDate()).padStart(2, '0')
    const stamp = `${year}-${month}-${day}T12-00-${String(second).padStart(2, '0')}`
    const file = join(codexHome, 'sessions', year, month, day, `rollout-${stamp}-${id}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, rolloutContent(cwd), 'utf8')
    return file
  }

  function rolloutContent(cwd: string): string {
    return `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`
      + `${JSON.stringify({ text: `worked in ${cwd.replace(/\\/g, '/')}` })}\n`
      + `${JSON.stringify({ text: 'store name Q--Apps-Foo' })}\n`
  }

  const idAConst = '11111111-1111-4111-8111-111111111111'
  const idBConst = '22222222-2222-4222-8222-222222222222'
  const idCConst = '33333333-3333-4333-8333-333333333333'

  it('has nothing that could collide with the move', async () => {
    const { migrator } = harness()
    expect(await migrator.preflight(oldDir, newDir)).toEqual({ ok: true })
  })

  it('rewrites the project rollouts in place and leaves every other file alone', async () => {
    const { codexHome, migrator, journal, leftovers } = harness()
    const first = seedRollout(codexHome, oldDir, 1, idAConst)
    const second = seedRollout(codexHome, oldDir, 2, idBConst)
    const foreign = seedRollout(codexHome, otherDir, 3, idCConst)

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    expect(outcome).toBe('done')
    for (const file of [first, second]) {
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('Q:\\\\Apps\\\\Bar')
      expect(content).toContain('Q:/Apps/Bar')
      expect(content).not.toContain('Apps\\\\Foo')
      // Codex never derives a directory name from the path, so the encoded shape is text it must not
      // touch: rewriting it here would edit something unrelated in the user's conversation.
      expect(content).toContain('Q--Apps-Foo')
    }
    expect(readFileSync(foreign, 'utf8')).toBe(rolloutContent(otherDir))
    expect(journal.steps.map((step) => step.file).sort()).toEqual([first, second].sort())
  })

  /**
   * The ninety day window belongs to the listing, where the walk is paid for over and over. A rename
   * happens once: a rollout it skips keeps a path that no longer exists, with nothing reported, no
   * leftover recorded, and the operation answering 'done'.
   */
  it('rewrites a rollout older than the listing window as well', async () => {
    const { codexHome, index, migrator, journal, leftovers } = harness()
    const recent = seedRollout(codexHome, oldDir, 1, idAConst)
    const ancient = seedRollout(codexHome, oldDir, 2, idBConst, 200)

    // The listing never sees it, which is what the window is for.
    expect((await index.filesForProject(oldDir)).map((rollout) => rollout.file)).toEqual([recent])

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    expect(outcome).toBe('done')
    expect(readFileSync(ancient, 'utf8')).toContain('Q:/Apps/Bar')
    expect(readFileSync(ancient, 'utf8')).not.toContain('Apps\\\\Foo')
    expect(journal.steps.map((step) => step.file).sort()).toEqual([recent, ancient].sort())
  })

  it('names a rollout older than the listing window in the delete enumeration', async () => {
    const { codexHome, migrator } = harness()
    const recent = seedRollout(codexHome, oldDir, 1, idAConst)
    const ancient = seedRollout(codexHome, oldDir, 2, idBConst, 200)
    seedRollout(codexHome, otherDir, 3, idCConst, 200)

    expect((await migrator.enumerateProjectFiles(oldDir)).sort())
      .toEqual([recent, ancient].sort())
  })

  // A shared, append-only file of another application: an orphaned name in it is harmless, a
  // rewritten or missing one is not.
  it('never writes to session_index.jsonl', async () => {
    const { codexHome, migrator, journal, leftovers } = harness()
    seedRollout(codexHome, oldDir, 1, idAConst)
    const before = readFileSync(join(codexHome, 'session_index.jsonl'))

    await migrator.relocate(oldDir, newDir, journal, leftovers)

    expect(readFileSync(join(codexHome, 'session_index.jsonl')).equals(before)).toBe(true)
  })

  it('records a locked rollout and carries on with the next one', async () => {
    const { codexHome, migrator, journal, leftovers } = harness({
      rename: async (oldPath, newPath) => {
        if (oldPath.includes(idAConst)) throw failing('EBUSY')
        await rename(oldPath, newPath)
      },
    })
    const locked = seedRollout(codexHome, oldDir, 1, idAConst)
    const open = seedRollout(codexHome, oldDir, 2, idBConst)

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    expect(outcome).toBe('done-with-leftovers')
    expect(readFileSync(locked, 'utf8')).toBe(rolloutContent(oldDir))
    expect(readFileSync(open, 'utf8')).toContain('Q:/Apps/Bar')
    expect(leftovers.records).toEqual([{
      kind: 'rewrite',
      provider: 'codex',
      path: locked,
      operationId: 'op-7',
      oldPath: oldDir,
      newPath: newDir,
      recordedAt: leftovers.records[0]?.recordedAt,
    }])
  })

  it('reports a failure it cannot classify instead of claiming the history moved', async () => {
    const { codexHome, migrator, journal, leftovers, messages } = harness({
      readFile: async () => { throw failing('EIO') },
    })
    seedRollout(codexHome, oldDir, 1, idAConst)

    expect(await migrator.relocate(oldDir, newDir, journal, leftovers)).toBe('failed')
    expect(messages.some((message) => message.includes('EIO'))).toBe(true)
  })

  it('enumerates the rollouts of the project and nothing else', async () => {
    const { codexHome, migrator } = harness()
    const first = seedRollout(codexHome, oldDir, 1, idAConst)
    const second = seedRollout(codexHome, oldDir, 2, idBConst)
    seedRollout(codexHome, otherDir, 3, idCConst)

    expect((await migrator.enumerateProjectFiles(oldDir)).sort()).toEqual([first, second].sort())
    expect(await migrator.enumerateProjectFiles(newDir)).toEqual([])
  })
})
