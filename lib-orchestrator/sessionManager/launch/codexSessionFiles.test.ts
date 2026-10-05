import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionRecord } from '../records/sessionRecord.types'
import { CodexSessionFiles } from './codexSessionFiles'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}) })
const nativeId = '11111111-1111-4111-8111-111111111111'
const record: SessionRecord = {
  sessionId: 'tab', kind: 'agent', title: 'Codex', life: 'live', createdAt: 1, binding: null,
  directory: {mode: 'default'},
  agent: {agentId: 'codex', launchMode: 'new', identityLaunchId: 'current'},
}
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'jamat-codex-identities-'))
  roots.push(root)
  mkdirSync(join(root, 'tab'))
  const reports: string[] = []
  return {
    root, reports,
    files: new CodexSessionFiles({directory: root, applicationRoot: resolve(import.meta.dirname, '../../..'),
      resourcesRoot: null, report: message => reports.push(message)}),
    write: (fields: object) => writeFileSync(join(root, 'tab/current.identity.json'), JSON.stringify({
      schemaVersion: 1, jamatSessionId: 'tab', launchId: 'current', nativeSessionId: nativeId, sequence: 1, ...fields,
    })),
  }
}

it('reads only a receipt for the exact Jamat tab and launch generation', () => {
  const {files, write, reports} = harness()
  expect(files.identity(record)).toBeNull()
  write({})
  expect(files.identity(record)?.nativeSessionId).toBe(nativeId)
  for (const fields of [{launchId: 'old'}, {jamatSessionId: 'sibling'}, {schemaVersion: 2},
    {nativeSessionId: 'not-a-thread'}, {sequence: 0}, {sequence: 1.2}]) {
    write(fields)
    expect(files.identity(record)).toBeNull()
  }
  expect(reports).toHaveLength(1)
})

it('never reads a receipt as a substitute for a legacy inferred identity', () => {
  const {files, write} = harness()
  write({})
  expect(files.identity({...record, agent: {agentId: 'codex', launchMode: 'new'}})).toBeNull()
})

it('launches the bridge with a private generation and preserves native argument boundaries', () => {
  const {files} = harness()
  const prompt = 'first line\nsecond "quoted" line'
  const native = {command: 'codex', args: [prompt], cwd: 'Q:/work', env: {JAMAT_V3_SESSION_ID: 'tab'}, cols: 120, rows: 30}
  const wrapped = files.launch(record, native, [prompt], {yolo: true, model: 'model-one', effort: 'high'})
  expect(wrapped.command).toBe(process.execPath)
  expect(wrapped.env).toEqual({JAMAT_V3_SESSION_ID: 'tab'})
  const launch = JSON.parse(readFileSync(wrapped.args.at(-1)!, 'utf8'))
  expect(launch).toMatchObject({jamatSessionId: 'tab', launchId: 'current', mode: 'new', yolo: true,
    client: {command: 'codex', prefixArgs: [], args: [prompt]}})
  expect(launch.server.args).not.toContain(prompt)
  expect(launch.server.args).toContain('approval_policy="never"')
  expect(launch.server.args).toContain('sandbox_mode="danger-full-access"')
  expect(launch.server.args).toContain('projects={"Q:/work"={trust_level="trusted"}}')
})

it('keeps gated launches free of YOLO overrides', () => {
  const {files} = harness()
  const native = {command: 'codex', args: [], cwd: 'Q:/work', env: {}, cols: 120, rows: 30}
  for (const yolo of [undefined, false]) {
    const wrapped = files.launch(record, native, [], {yolo})
    const launch = JSON.parse(readFileSync(wrapped.args.at(-1)!, 'utf8'))
    expect(launch.yolo).toBe(false)
    expect(launch.client.args).toEqual([])
    expect(launch.server.args).toEqual(['app-server', '--listen', 'stdio://'])
  }
})

it('refuses path traversal in a persisted launch identity', () => {
  const {files} = harness()
  expect(files.identity({...record, agent: {...record.agent!, identityLaunchId: '../other'}})).toBeNull()
})

it('uses the shipped console Node runtime for a packaged bridge and refuses a missing runtime', () => {
  const {root} = harness()
  const resources = join(root, 'resources')
  const runtime = join(resources, 'launcher', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  mkdirSync(join(resources, 'codex'), {recursive: true})
  mkdirSync(join(resources, 'launcher', 'bin'), {recursive: true})
  writeFileSync(join(resources, 'codex', 'start.cjs'), '')
  const files = new CodexSessionFiles({directory: root, applicationRoot: root, resourcesRoot: resources, report: () => {}})
  const native = {command: 'codex', args: [], cwd: root, env: {}, cols: 120, rows: 30}
  expect(() => files.launch(record, native, [], {})).toThrow(/packaged Node runtime/)
  writeFileSync(runtime, '')
  const wrapped = files.launch(record, native, [], {})
  expect(wrapped.command).toBe(runtime)
  expect(wrapped.args[0]).toBe(join(resources, 'codex', 'start.cjs'))
})
