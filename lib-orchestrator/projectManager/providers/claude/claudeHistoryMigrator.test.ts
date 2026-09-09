import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  LeftoverEntry,
  RelocationJournalWriter,
  RelocationLeftoversWriter,
  RelocationStep,
} from '../providerContract.types'
import type { ClaudeStoreIo } from './claudeHistoryMigrator'
import { ClaudeHistoryMigrator } from './claudeHistoryMigrator'
import { ClaudeProjectsLocator } from './claudeProjectsLocator'

describe('lib-orchestrator/projectManager/providers/claude/claudeHistoryMigrator', () => {
  const created: string[] = []

  const oldDir = 'Q:\\Apps\\Foo'
  const newDir = 'Q:\\Apps\\Bar'
  const transcriptConst =
    '{"cwd":"Q:\\\\Apps\\\\Foo","other":"Q:/Apps/Foo","dir":"Q--Apps-Foo"}\n'
  const rewrittenConst =
    '{"cwd":"Q:\\\\Apps\\\\Bar","other":"Q:/Apps/Bar","dir":"Q--Apps-Bar"}\n'

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    claudeHome: string
    messages: string[]
    journal: RelocationJournalWriter & { steps: RelocationStep[] }
    leftovers: RelocationLeftoversWriter & { records: LeftoverEntry[] }
    migrator: ClaudeHistoryMigrator
  }

  function diskIo(): ClaudeStoreIo {
    return {
      readFile: (file) => readFile(file, 'utf8'),
      writeFile: (file, content) => writeFile(file, content, 'utf8'),
      rename: (oldPath, newPath) => rename(oldPath, newPath),
      unlink: (file) => unlink(file),
      readdir: (directory) => readdir(directory),
      mkdir: async (directory) => { await mkdir(directory, { recursive: true }) },
      removeDirectory: (directory) => rmdir(directory),
    }
  }

  function failing(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
    error.code = code
    return error
  }

  function harness(io?: Partial<ClaudeStoreIo>): Harness {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-claude-migrator-'))
    created.push(root)
    const claudeHome = join(root, 'claude')
    mkdirSync(join(claudeHome, 'projects'), { recursive: true })
    const messages: string[] = []
    const steps: RelocationStep[] = []
    const records: LeftoverEntry[] = []
    return {
      claudeHome,
      messages,
      journal: { operationId: 'op-1', steps, checkpoint: (step) => { steps.push(step) } },
      leftovers: { records, record: (entry) => { records.push(entry); return true } },
      migrator: new ClaudeHistoryMigrator({
        claudeHome,
        locator: new ClaudeProjectsLocator(claudeHome),
        report: (message) => messages.push(message),
        io: { ...diskIo(), ...io },
      }),
    }
  }

  function seedStore(claudeHome: string, projectDir: string, names: string[]): string {
    const directory = join(
      claudeHome,
      'projects',
      ClaudeProjectsLocator.encodeProjectDir(projectDir),
    )
    mkdirSync(directory, { recursive: true })
    for (const name of names) writeFileSync(join(directory, name), transcriptConst, 'utf8')
    return directory
  }

  it('lets a move through while only the old store exists', async () => {
    const { claudeHome, migrator } = harness()
    seedStore(claudeHome, oldDir, ['a.jsonl'])
    expect(await migrator.preflight(oldDir, newDir)).toEqual({ ok: true })
  })

  it('has nothing to say about a project that never ran an agent', async () => {
    const { migrator } = harness()
    expect(await migrator.preflight(oldDir, newDir)).toEqual({ ok: true })
  })

  // Two histories merged into one directory could not be told apart afterwards.
  it('refuses the move when both the old and the new store already exist', async () => {
    const { claudeHome, migrator } = harness()
    seedStore(claudeHome, oldDir, ['a.jsonl'])
    seedStore(claudeHome, newDir, ['b.jsonl'])

    const preflight = await migrator.preflight(oldDir, newDir)

    expect(preflight.ok).toBe(false)
    expect(preflight.conflict).toMatch(/Q--Apps-Foo/)
    expect(preflight.conflict).toMatch(/Q--Apps-Bar/)
  })

  it('renames the store directory and rewrites every shape, including the encoded one', async () => {
    const { claudeHome, migrator, journal, leftovers } = harness()
    const source = seedStore(claudeHome, oldDir, ['a.jsonl', 'b.jsonl'])

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    const target = join(claudeHome, 'projects', 'Q--Apps-Bar')
    expect(outcome).toBe('done')
    expect(existsSync(source)).toBe(false)
    // The encoded shape is the one only Claude has, and its rule lives in the locator: seeing it
    // rewritten here is what proves this migrator did not spell that rule a second time.
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(readFileSync(join(target, 'b.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(journal.steps).toEqual([
      { provider: 'claude', file: join(target, 'a.jsonl'), state: 'done' },
      { provider: 'claude', file: join(target, 'b.jsonl'), state: 'done' },
    ])
    expect(leftovers.records).toEqual([])
  })

  it('moves the transcripts one by one when the store directory is held open', async () => {
    const { claudeHome, migrator, journal, leftovers } = harness({
      rename: async (oldPath, newPath) => {
        if (!oldPath.endsWith('.tmp')) throw failing('EBUSY')
        await rename(oldPath, newPath)
      },
    })
    const source = seedStore(claudeHome, oldDir, ['a.jsonl'])

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    const target = join(claudeHome, 'projects', 'Q--Apps-Bar')
    expect(outcome).toBe('done')
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(leftovers.records).toEqual([])
  })

  it('leaves a copy behind when the original cannot be deleted, and finishes anyway', async () => {
    const { claudeHome, migrator, journal, leftovers, messages } = harness({
      rename: async (oldPath, newPath) => {
        if (!oldPath.endsWith('.tmp')) throw failing('EBUSY')
        await rename(oldPath, newPath)
      },
      unlink: async () => { throw failing('EPERM') },
    })
    const source = seedStore(claudeHome, oldDir, ['a.jsonl'])

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    const target = join(claudeHome, 'projects', 'Q--Apps-Bar')
    expect(outcome).toBe('done-with-leftovers')
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(rewrittenConst)
    // A delete record is the path and nothing else: the copy left behind belongs to no provider's
    // store any more, and a provider or a pair of paths filled in here would be a stored untruth.
    expect(leftovers.records).toEqual([{
      kind: 'delete',
      path: join(source, 'a.jsonl'),
      operationId: 'op-1',
      recordedAt: leftovers.records[0]?.recordedAt,
    }])
    expect(journal.steps).toContainEqual({
      provider: 'claude',
      file: join(source, 'a.jsonl'),
      state: 'copied-pending-delete',
    })
    expect(messages.some((message) => message.includes(source))).toBe(true)
  })

  it('records a locked transcript, leaves it untouched and moves to the next one', async () => {
    const { claudeHome, migrator, journal, leftovers } = harness({
      rename: async (oldPath, newPath) => {
        if (oldPath.endsWith('a.jsonl.tmp')) throw failing('EBUSY')
        await rename(oldPath, newPath)
      },
    })
    seedStore(claudeHome, oldDir, ['a.jsonl', 'b.jsonl'])

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    const target = join(claudeHome, 'projects', 'Q--Apps-Bar')
    expect(outcome).toBe('done-with-leftovers')
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(transcriptConst)
    expect(readFileSync(join(target, 'b.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(leftovers.records).toHaveLength(1)
    expect(leftovers.records[0].kind).toBe('rewrite')
    expect(leftovers.records[0].path).toBe(join(target, 'a.jsonl'))
    expect(journal.steps).toEqual([
      { provider: 'claude', file: join(target, 'b.jsonl'), state: 'done' },
    ])
  })

  /**
   * What an interrupted one-at-a-time pass leaves: half the transcripts at each end. Renaming onto
   * the target then fails as ENOTEMPTY off Windows, which is not a lock, and the resume that has to
   * survive a crash used to end as a failure instead.
   */
  it('goes file by file when the target store directory is already there', async () => {
    const { claudeHome, migrator, journal, leftovers, messages } = harness({
      rename: async (oldPath, newPath) => {
        if (!oldPath.endsWith('.tmp')) throw failing('ENOTEMPTY')
        await rename(oldPath, newPath)
      },
    })
    const source = seedStore(claudeHome, oldDir, ['a.jsonl'])
    const target = seedStore(claudeHome, newDir, ['b.jsonl'])
    writeFileSync(join(target, 'b.jsonl'), rewrittenConst, 'utf8')

    const outcome = await migrator.relocate(oldDir, newDir, journal, leftovers)

    expect(outcome).toBe('done')
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(readFileSync(join(target, 'b.jsonl'), 'utf8')).toBe(rewrittenConst)
    expect(messages).toEqual([])
  })

  // The file is on disk whichever way the record went; a count of leftovers nobody can name is not
  // something the user can act on.
  it('reports the path itself when the leftovers registry refuses the record', async () => {
    const { claudeHome, migrator, journal, messages } = harness({
      rename: async (oldPath, newPath) => {
        if (oldPath.endsWith('a.jsonl.tmp')) throw failing('EBUSY')
        await rename(oldPath, newPath)
      },
    })
    seedStore(claudeHome, oldDir, ['a.jsonl'])

    const outcome = await migrator.relocate(oldDir, newDir, journal, { record: () => false })

    const target = join(claudeHome, 'projects', 'Q--Apps-Bar')
    expect(outcome).toBe('done-with-leftovers')
    expect(messages.some((message) => message.includes(join(target, 'a.jsonl')))).toBe(true)
  })

  it('finishes without touching anything when the project has no history', async () => {
    const { migrator, journal, leftovers, messages } = harness()

    expect(await migrator.relocate(oldDir, newDir, journal, leftovers)).toBe('done')
    expect(journal.steps).toEqual([])
    expect(messages).toEqual([])
  })

  it('replays as unchanged over a store that was already moved', async () => {
    const { claudeHome, migrator, journal, leftovers } = harness()
    const target = seedStore(claudeHome, newDir, ['a.jsonl'])
    writeFileSync(join(target, 'a.jsonl'), rewrittenConst, 'utf8')

    expect(await migrator.relocate(oldDir, newDir, journal, leftovers)).toBe('done')
    expect(readFileSync(join(target, 'a.jsonl'), 'utf8')).toBe(rewrittenConst)
  })

  it('reports a failure it cannot classify instead of claiming the history moved', async () => {
    const { claudeHome, migrator, journal, leftovers, messages } = harness({
      rename: async () => { throw failing('EIO') },
    })
    seedStore(claudeHome, oldDir, ['a.jsonl'])

    expect(await migrator.relocate(oldDir, newDir, journal, leftovers)).toBe('failed')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/EIO/)
  })

  it('enumerates exactly the transcripts of the project, and nothing when there are none', async () => {
    const { claudeHome, migrator } = harness()
    const directory = seedStore(claudeHome, oldDir, ['a.jsonl', 'b.jsonl'])
    writeFileSync(join(directory, 'notes.txt'), 'not a transcript', 'utf8')

    expect(await migrator.enumerateProjectFiles(oldDir))
      .toEqual([join(directory, 'a.jsonl'), join(directory, 'b.jsonl')])
    expect(await migrator.enumerateProjectFiles(newDir)).toEqual([])
  })
})
