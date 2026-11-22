import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectTodos } from '../../../lib-orchestrator/clientApi/projectTodos'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { ProjectTodosOperations } from './projectTodosOperations'

/** A read of the todo file can run a step first: an outside writer between the change's read and its replace. */
const fsHooks = vi.hoisted(() => ({
  beforeRead: null as ((path: string) => void) | null,
  actual: null as typeof import('node:fs') | null,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsHooks.actual = actual
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('todolist.jsonl')) fsHooks.beforeRead?.(args[0])
      return actual.readFileSync(...args)
    },
  }
})

describe('app-orchestrator/app/projectTodos/projectTodosOperations', () => {
  const nowConst = '2026-11-21T10:00:00.000Z'
  let root: string
  let project: string
  let changed: string[]
  let opened: string[]
  let bench: RegistryBench
  let operations: ProjectTodosOperations

  const sessionsUnderTest = (): Pick<SessionManager, 'catalogProject' | 'catalogProjectOf' | 'snapshot'> => ({
    catalogProject: (sessionId) => Promise.resolve(sessionId === 'inside' ? { ok: true, value: project }
      : sessionId === 'outside' ? { ok: true, value: null }
        : { ok: false, code: 'unknown-session', detail: `Session ${sessionId} does not exist` }),
    catalogProjectOf: (directory) => Promise.resolve(directory.startsWith(project) ? project : null),
    snapshot: () => ({ sessions: [
      { sessionId: 'inside', tabTitle: '014 Alpha', titleParts: { number: '014' } },
      { sessionId: 'outside', tabTitle: '015 Temp', titleParts: { number: '015' } },
      { sessionId: 'twin-a', tabTitle: 'i3 A', titleParts: { number: 'i3' } },
      { sessionId: 'twin-b', tabTitle: 'i3 B', titleParts: { number: 'i3' } },
    ] }) as unknown as ReturnType<SessionManager['snapshot']>,
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-project-todos-'))
    project = join(root, 'Alpha')
    mkdirSync(project)
    changed = []
    opened = []
    fsHooks.beforeRead = null
    bench = new RegistryBench()
    operations = new ProjectTodosOperations({
      sessions: sessionsUnderTest(),
      openTodos: (sessionId, tabTitle, view) => {
        opened.push(`${sessionId}:${tabTitle}:${view}`)
        return Promise.resolve({ ok: true, value: { kind: 'todos-opened', panelId: 'terminal:x', windowId: 'main' } })
      },
      now: () => new Date(nowConst),
      user: 'dana',
      onChanged: (value) => changed.push(value),
    })
    operations.register(bench.registry)
  })

  afterEach(() => {
    operations.stop()
    rmSync(root, { recursive: true, force: true })
  })

  const session = { kind: 'sessionId', sessionId: 'inside' } as const
  const fileOf = (): string => join(project, '.aidocs', 'todolist.jsonl')
  const onDisk = () => {
    const parsed = ProjectTodos.parse(readFileSync(fileOf(), 'utf8'))
    if (!parsed.ok) throw new Error(parsed.detail)
    return parsed.items
  }
  const add = (title: string, extra: Record<string, unknown> = {}) =>
    bench.call('projectTodos.apply', { session, operation: { kind: 'add', title, ...extra } })

  it('reads a project without a file as an empty list, by session, by number and by a directory inside the project', async () => {
    const empty = { project, file: fileOf(), user: 'dana', items: [], total: 0, categories: [], colors: [], authors: [] }

    expect(await bench.call('projectTodos.list', { session })).toEqual({ ok: true, value: empty })
    expect(await bench.call('projectTodos.list', { session: { kind: 'number', number: '014' } })).toEqual({ ok: true, value: empty })
    expect(await bench.call('projectTodos.list', { project: join(project, 'docs') })).toEqual({ ok: true, value: empty })
  })

  it('creates .aidocs and the file on the first change, records the author, gives an id and tells every window', async () => {
    const answer = await add('First', { category: 'ui' })

    expect(answer).toMatchObject({ ok: true, value: { total: 1, items: [{ title: 'First', category: 'ui', author: 'dana', done: false, created: nowConst }],
      categories: [{ name: 'ui', count: 1 }], authors: [{ name: 'dana', count: 1 }] } })
    const parsed = ProjectTodos.parse(readFileSync(fileOf(), 'utf8'))
    expect(parsed).toMatchObject({ ok: true, items: [{ title: 'First', author: 'dana' }] })
    expect(changed).toEqual([project])
  })

  it('puts back a removed task by its id once, and refuses an id it did not remove', async () => {
    await add('Kept', { id: 'k1', category: 'ui', comment: 'note', color: 'teal' })
    await bench.call('projectTodos.apply', { session, operation: { kind: 'remove', id: 'k1' } })
    expect(onDisk()).toEqual([])

    expect(await bench.call('projectTodos.restore', { session, id: 'k1' }))
      .toMatchObject({ ok: true, value: { items: [{ id: 'k1', title: 'Kept', category: 'ui', comment: 'note', color: 'teal', author: 'dana' }] } })
    expect(onDisk()).toHaveLength(1)
    expect(await bench.call('projectTodos.restore', { session, id: 'k1' })).toMatchObject({ ok: false })
    expect(await bench.call('projectTodos.restore', { session, id: 'never' })).toMatchObject({ ok: false })
  })

  it('filters a list as the views do', async () => {
    await add('Mine', { category: 'ui' })
    writeFileSync(fileOf(), readFileSync(fileOf(), 'utf8')
      + `\n${JSON.stringify({ id: 'zz', title: 'Theirs', category: 'bug', author: 'eva', done: true, created: nowConst })}\n`)

    expect(await bench.call('projectTodos.list', { session, filter: { author: 'eva' } }))
      .toMatchObject({ ok: true, value: { total: 2, items: [{ title: 'Theirs' }] } })
    expect(await bench.call('projectTodos.list', { session, filter: { text: '#ui', done: false } }))
      .toMatchObject({ ok: true, value: { items: [{ title: 'Mine' }] } })
  })

  it('applies a change to what is on disk, so an edit made meanwhile stays', async () => {
    await add('First')
    const id = onDisk()[0].id
    writeFileSync(fileOf(), readFileSync(fileOf(), 'utf8') + `\n${JSON.stringify({ id: 'zz', title: 'By an agent', done: false, created: nowConst })}\n`)

    const answer = await bench.call('projectTodos.apply', { session, operation: { kind: 'toggle', id, done: true } })

    expect(answer).toMatchObject({ ok: true, value: { total: 2 } })
    expect(ProjectTodos.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ ok: true, items: [
      { id, done: true, doneAt: nowConst }, { id: 'zz', title: 'By an agent' },
    ] })
  })

  it('applies the change again when the file changes between its read and the replace', async () => {
    await add('First')
    let reads = 0
    fsHooks.beforeRead = (path) => {
      reads += 1
      // The second read is the check before the rename: an svn update lands right there.
      if (reads === 2) writeFileSync(path, fsHooks.actual!.readFileSync(path, 'utf8') + `\n${JSON.stringify({ id: 'zz', title: 'From svn update', done: false, created: nowConst })}\n`)
    }

    const answer = await add('Second')

    expect(answer).toMatchObject({ ok: true, value: { total: 3 } })
    const titles = onDisk().map((item) => item.title).sort()
    expect(titles).toEqual(['First', 'From svn update', 'Second'])
  })

  it('gives up after the file kept changing, and writes nothing', async () => {
    await add('First')
    const before = readFileSync(fileOf(), 'utf8')
    let reads = 0
    fsHooks.beforeRead = (path) => { if (++reads % 2 === 0) writeFileSync(path, `${fsHooks.actual!.readFileSync(path, 'utf8')}\n`) }

    expect(await add('Second')).toMatchObject({ ok: false, error: { data: { sourceCode: 'write-failed' } } })
    fsHooks.beforeRead = null
    expect(readFileSync(fileOf(), 'utf8').trim()).toBe(before.trim())
  })

  it('names an unresolved SVN conflict, never writes over it, and reads again once it is resolved', async () => {
    await add('First')
    const resolved = readFileSync(fileOf(), 'utf8')
    writeFileSync(fileOf(), `${resolved}<<<<<<< .mine\n{"id":"m1","title":"Mine","done":false,"created":"${nowConst}"}\n=======\n>>>>>>> .r12\n`)
    const conflicted = readFileSync(fileOf(), 'utf8')

    expect(await bench.call('projectTodos.list', { session })).toMatchObject({ ok: false, error: { data: { sourceCode: 'file-conflict' } } })
    expect(await add('Second')).toMatchObject({ ok: false, error: { data: { sourceCode: 'file-conflict' } } })
    expect(readFileSync(fileOf(), 'utf8')).toBe(conflicted)
    writeFileSync(fileOf(), resolved)
    expect(await bench.call('projectTodos.list', { session })).toMatchObject({ ok: true, value: { total: 1 } })
  })

  it('refuses a damaged file and never writes over it', async () => {
    mkdirSync(join(project, '.aidocs'))
    writeFileSync(fileOf(), '{ broken')

    expect(await bench.call('projectTodos.list', { session })).toMatchObject({ ok: false, error: { data: { sourceCode: 'file-damaged' } } })
    expect(await add('x')).toMatchObject({ ok: false, error: { data: { sourceCode: 'file-damaged' } } })
    expect(readFileSync(fileOf(), 'utf8')).toBe('{ broken')
  })

  it('opens the split of the named session', async () => {
    expect(await bench.call('projectTodos.open', { session: { kind: 'number', number: '014' } }))
      .toEqual({ ok: true, value: { kind: 'todos-opened', panelId: 'terminal:x', windowId: 'main' } })
    await bench.call('projectTodos.open', { session: { kind: 'number', number: '014' }, view: 'sidebar' })
    expect(opened).toEqual(['inside:014 Alpha:split', 'inside:014 Alpha:sidebar'])
    expect(await bench.call('projectTodos.open', { session: { kind: 'number', number: '014' }, view: 'popup' })).toMatchObject({ ok: false })
  })

  it('refuses what names no list, and an invalid change', async () => {
    const refusal = async (operation: string, body: unknown) =>
      ((await bench.call(operation, body)) as { error?: { data?: { sourceCode?: string } } }).error?.data?.sourceCode

    expect(await refusal('projectTodos.list', {})).toBe('invalid-target')
    expect(await refusal('projectTodos.list', { session, project })).toBe('invalid-target')
    expect(await refusal('projectTodos.list', { session: { kind: 'sessionId', sessionId: 'gone' } })).toBe('session-not-found')
    expect(await refusal('projectTodos.list', { session: { kind: 'number', number: 'i3' } })).toBe('session-ambiguous')
    expect(await refusal('projectTodos.list', { session: { kind: 'sessionId', sessionId: 'outside' } })).toBe('no-project')
    expect(await refusal('projectTodos.list', { project: root })).toBe('no-project')
    expect(await refusal('projectTodos.apply', { session, operation: { kind: 'remove', id: 'missing' } })).toBe('invalid-operation')
    expect(await refusal('projectTodos.apply', { session, operation: { kind: 'drop' } })).toBe('invalid-operation')
    expect(changed).toEqual([])
  })
})
