import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GoSetupDetector } from './goSetupDetector'

describe('lib-orchestrator/projectSetup/detectors/goSetupDetector', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-go-setup-'))
    created.push(root)
    return root
  }

  const detector = new GoSetupDetector()

  it('reads modules out of a go.mod', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'go.mod'), 'module example.com/x\n\ngo 1.24\n', 'utf8')
    expect(await detector.detect(root)).toEqual({ kind: 'tool', toolId: 'go-mod' })
  })

  it('has nothing to say without one', async () => {
    expect(await detector.detect(temporaryRoot())).toBeNull()
  })

  it('ignores a directory that carries the module file name', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'go.mod'))
    expect(await detector.detect(root)).toBeNull()
  })
})
