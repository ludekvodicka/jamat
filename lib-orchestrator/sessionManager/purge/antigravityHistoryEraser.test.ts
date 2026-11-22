import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AntigravityHistoryEraser } from './antigravityHistoryEraser'

describe('lib-orchestrator/sessionManager/purge/antigravityHistoryEraser', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('removes the conversation brain directory and rejects unsafe ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-agy-erase-'))
    roots.push(root)
    const convId = '452a5365-fc15-4ac0-8947-f76a56cbf194'
    const convDir = join(root, 'brain', convId)
    mkdirSync(join(convDir, '.system_generated', 'logs'), { recursive: true })
    writeFileSync(join(convDir, '.system_generated', 'logs', 'transcript.jsonl'), '{}\n')

    const eraser = new AntigravityHistoryEraser({ home: root })
    const report = await eraser.erase({
      nativeSessionIds: [convId, '../escape'],
      cwd: root,
      since: 0,
    })

    expect(existsSync(convDir)).toBe(false)
    expect(report.erased).toContain(convDir)
    expect(report.leftovers).toHaveLength(1)
    expect(report.leftovers[0]).toContain('../escape')
  })
})
