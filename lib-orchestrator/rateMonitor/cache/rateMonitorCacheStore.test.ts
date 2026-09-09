import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RateMonitorCacheStore } from './rateMonitorCacheStore'

describe('lib-orchestrator/rateMonitor/cache/rateMonitorCacheStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  /** Deliberately one level below the temporary directory: the store creates what it writes into. */
  function cacheFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-rate-cache-'))
    created.push(directory)
    return join(directory, 'production', 'rate-monitor-cache.json')
  }

  function write(file: string, content: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }

  it('answers null for a cache that was never written', async () => {
    expect(await new RateMonitorCacheStore(cacheFile()).load()).toBeNull()
  })

  it('round-trips both providers, the model-scoped windows and the extras with them', async () => {
    const file = cacheFile()
    const store = new RateMonitorCacheStore(file)
    const providers = {
      claude: {
        fetchedAt: 1_700_000_000_000,
        windows: [
          { durationMinutes: 300, usedPercent: 42, resetsAt: '2026-08-17T10:00:00.000Z' },
          { durationMinutes: 10_080, usedPercent: 12, resetsAt: null, model: 'opus' },
        ],
        extras: [{ label: 'extra usage', detail: '3.20 USD' }],
      },
      codex: { fetchedAt: 1_700_000_001_000, windows: [], extras: [] },
    }
    store.save({ providers, attempts: { claude: 1_700_000_002_000, codex: 1_700_000_003_000 } })

    expect(await store.load()).toEqual({
      providers,
      attempts: { claude: 1_700_000_002_000, codex: 1_700_000_003_000 },
    })
  })

  // The floor a run of refusals has to be held by is measured from the ATTEMPT, and that run stores
  // no windows at all: without this the restart it protects against would begin the floor again.
  it('remembers when a provider was last asked, even though it never answered', async () => {
    const file = cacheFile()
    const store = new RateMonitorCacheStore(file)
    store.save({ providers: {}, attempts: { claude: 1_700_000_000_000 } })

    expect(await store.load())
      .toEqual({ providers: {}, attempts: { claude: 1_700_000_000_000 } })
  })

  it('loads a document written before the attempts were kept', async () => {
    const file = cacheFile()
    write(file, JSON.stringify({
      schemaVersion: 1,
      providers: { codex: { fetchedAt: 7, windows: [], extras: [] } },
    }))

    expect(await new RateMonitorCacheStore(file).load())
      .toEqual({ providers: { codex: { fetchedAt: 7, windows: [], extras: [] } }, attempts: {} })
  })

  it('drops an attempt time it cannot read', async () => {
    const file = cacheFile()
    write(file, JSON.stringify({
      schemaVersion: 1,
      providers: {},
      attempts: { claude: 'a while ago', codex: 9 },
    }))

    expect(await new RateMonitorCacheStore(file).load())
      .toEqual({ providers: {}, attempts: { codex: 9 } })
  })

  // The write goes through a temporary file so a crash half way cannot leave a document that parses
  // into half an answer; what must not survive the rename is the temporary file itself.
  it('creates the state directory and leaves no temporary file behind', () => {
    const file = cacheFile()
    new RateMonitorCacheStore(file).save({
      providers: { codex: { fetchedAt: 1, windows: [], extras: [] } },
      attempts: { codex: 1 },
    })

    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('treats a file that is not JSON as no cache at all', async () => {
    const file = cacheFile()
    write(file, 'not json')

    expect(await new RateMonitorCacheStore(file).load()).toBeNull()
  })

  it('discards a document written by a schema this build does not know', async () => {
    const file = cacheFile()
    write(file, JSON.stringify({
      schemaVersion: 2,
      providers: { codex: { fetchedAt: 1, windows: [], extras: [] } },
    }))

    expect(await new RateMonitorCacheStore(file).load()).toBeNull()
  })

  // A cache is worth exactly what it saves the next start, so one unusable member costs that member
  // and nothing else. Dropping the whole provider would throw away windows that are perfectly good.
  it('drops the windows it cannot trust and keeps the rest of the provider', async () => {
    const file = cacheFile()
    write(file, JSON.stringify({
      schemaVersion: 1,
      providers: {
        claude: {
          fetchedAt: 5,
          windows: [
            { durationMinutes: 300, usedPercent: 40, resetsAt: null },
            { durationMinutes: 0, usedPercent: 40, resetsAt: null },
            { durationMinutes: 10_080, usedPercent: 'most', resetsAt: null },
            'not a window',
          ],
          extras: [{ label: 'extra usage', detail: '1 USD' }, { label: 'no detail' }],
        },
      },
    }))

    expect(await new RateMonitorCacheStore(file).load()).toEqual({
      providers: {
        claude: {
          fetchedAt: 5,
          windows: [{ durationMinutes: 300, usedPercent: 40, resetsAt: null }],
          extras: [{ label: 'extra usage', detail: '1 USD' }],
        },
      },
      attempts: {},
    })
  })

  // Without the moment it was read, an entry cannot say how old it is - which is the one thing a
  // hydrated state has to be honest about.
  it('drops a provider whose entry cannot say when it was read', async () => {
    const file = cacheFile()
    write(file, JSON.stringify({
      schemaVersion: 1,
      providers: {
        claude: { windows: [{ durationMinutes: 300, usedPercent: 40, resetsAt: null }], extras: [] },
        codex: { fetchedAt: 7, windows: [], extras: [] },
      },
    }))

    expect(await new RateMonitorCacheStore(file).load())
      .toEqual({ providers: { codex: { fetchedAt: 7, windows: [], extras: [] } }, attempts: {} })
  })
})
