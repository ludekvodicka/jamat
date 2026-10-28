import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapinLog } from './snapinLog'

describe('SnapinLog', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'snapin-log-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('keeps the newest 2000 records after crossing 1 MiB and skips malformed lines', async () => {
    const rows = Array.from({ length: 2100 }, (_, at) => JSON.stringify({ at, level: 'info', text: 'x'.repeat(510) }))
    await writeFile(join(directory, 'log.jsonl'), rows.join('\n') + '\n{broken\n')
    const log = new SnapinLog(directory, vi.fn())
    await log.append({ at: 2100, level: 'warn', text: 'last' })
    const retained = await log.read(3000)
    expect(retained).toHaveLength(2000)
    expect(retained[0].at).toBe(101)
    expect(retained.at(-1)?.text).toBe('last')
    expect((await readFile(join(directory, 'log.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2000)
    expect(await log.read()).toHaveLength(200)
  })

  it('reports a failed append once and resolves every call', async () => {
    const blocked = join(directory, 'blocked')
    await writeFile(blocked, 'file, not directory')
    const report = vi.fn()
    const log = new SnapinLog(blocked, report)
    await log.append({ at: 1, level: 'error', text: 'one' })
    await log.append({ at: 2, level: 'error', text: 'two' })
    expect(report).toHaveBeenCalledTimes(1)
  })
})
