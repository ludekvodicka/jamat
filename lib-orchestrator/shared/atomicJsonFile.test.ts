import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AtomicJsonFile } from './atomicJsonFile'

describe('lib-orchestrator/shared/atomicJsonFile', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('moves a complete JSON document into place', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')

    AtomicJsonFile.write(file, { value: 1 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 1 })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('does not reuse or remove another writer staging file', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')
    const foreignStaging = `${file}.tmp`
    writeFileSync(foreignStaging, 'foreign-writer', 'utf8')

    AtomicJsonFile.write(file, { value: 1 })

    expect(readFileSync(foreignStaging, 'utf8')).toBe('foreign-writer')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 1 })
  })

  it('removes the temporary file when the final rename fails', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')
    mkdirSync(file)

    expect(() => AtomicJsonFile.write(file, { token: 'private' })).toThrow()
    expect(readdirSync(root)).toEqual(['document.json'])
  })
})

class AtomicJsonFileTest {
  static root(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-atomic-json-'))
    roots.push(root)
    return root
  }
}
