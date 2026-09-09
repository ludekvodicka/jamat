import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RustSetupDetector } from './rustSetupDetector'

describe('lib-orchestrator/projectSetup/detectors/rustSetupDetector', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-rust-setup-'))
    created.push(root)
    return root
  }

  const detector = new RustSetupDetector()

  it('reads cargo out of a manifest', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf8')
    expect(await detector.detect(root)).toEqual({ kind: 'tool', toolId: 'rust-cargo' })
  })

  it('has nothing to say without one', async () => {
    expect(await detector.detect(temporaryRoot())).toBeNull()
  })

  it('ignores a directory that carries the manifest name', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'Cargo.toml'))
    expect(await detector.detect(root)).toBeNull()
  })
})
