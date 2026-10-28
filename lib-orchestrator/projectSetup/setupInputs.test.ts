import { describe, expect, it } from 'vitest'
import { SetupInputs } from './setupInputs'

describe('SetupInputs', () => {
  it.each(['.pnpmfile.cjs', 'bun.lock', 'bun.lockb', '.nvmrc', '.node-version', '.python-version', 'requirements-test.txt'])('invalidates setup when %s changes in a nested project', (name) => {
    const before = SetupInputs.of([{ path: `service/${name}`, content: 'before' }, { path: 'code.ts', content: 'source' }])
    const after = SetupInputs.of([{ path: `service/${name}`, content: 'after' }, { path: 'code.ts', content: 'edited' }])
    expect(before.paths).toEqual([`service/${name}`])
    expect(after.digest).not.toBe(before.digest)
    expect(SetupInputs.of([{ path: `service/${name}`, content: 'before' }, { path: 'code.ts', content: 'edited' }]).digest).toBe(before.digest)
  })

  it('names only the inputs that changed or went, and every input of a read that kept no hashes (Finish 072)', () => {
    const before = SetupInputs.of([{ path: 'package.json', content: 'v1' }, { path: 'pnpm-lock.yaml', content: 'lock' }, { path: 'app/.nvmrc', content: '22' }])
    const after = SetupInputs.of([{ path: 'package.json', content: 'v2' }, { path: 'pnpm-lock.yaml', content: 'lock' }])
    expect(before.hashes).toEqual({ 'app/.nvmrc': '22', 'package.json': 'v1', 'pnpm-lock.yaml': 'lock' })
    expect(SetupInputs.changed(after, before.hashes)).toEqual(['app/.nvmrc', 'package.json'])
    expect(SetupInputs.changed(after, after.hashes)).toEqual([])
    expect(SetupInputs.changed(after, undefined)).toEqual(['package.json', 'pnpm-lock.yaml'])
  })
})
