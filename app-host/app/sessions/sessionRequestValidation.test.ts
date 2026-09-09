import { describe, expect, it } from 'vitest'

import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { SessionRequestValidation } from './sessionRequestValidation.js'

describe('app-host/app/sessions/sessionRequestValidation', () => {
  function launch(overrides: Partial<RuntimeLaunchSpec> = {}): RuntimeLaunchSpec {
    return {
      command: 'fake',
      args: [],
      cwd: process.cwd(),
      env: { A: 'one' },
      cols: 80,
      rows: 24,
      ...overrides,
    }
  }

  it('accepts a complete launch spec', () => {
    expect(() => SessionRequestValidation.validateLaunch(launch())).not.toThrow()
  })

  // The Host inherits nothing into the child, so a non-string value is a variable the child loses.
  it('requires env to be a complete string map', () => {
    expect(() => SessionRequestValidation.validateLaunch(
      launch({ env: { A: 1 } as unknown as Record<string, string> }),
    )).toThrow(/complete string environment/)
    expect(() => SessionRequestValidation.validateLaunch(
      launch({ env: undefined as unknown as Record<string, string> }),
    )).toThrow(/complete string environment/)
    expect(() => SessionRequestValidation.validateLaunch(
      launch({ env: [] as unknown as Record<string, string> }),
    )).toThrow(/complete string environment/)
  })

  it('requires cwd to be an existing directory', () => {
    expect(() => SessionRequestValidation.validateLaunch(
      launch({ cwd: join_nonexistent() }),
    )).toThrow(/existing directory/)
  })

  it('bounds cols and rows', () => {
    expect(() => SessionRequestValidation.validateLaunch(launch({ cols: 0 }))).toThrow(/1\.\.500/)
    expect(() => SessionRequestValidation.validateLaunch(launch({ cols: 501 }))).toThrow(/1\.\.500/)
    expect(() => SessionRequestValidation.validateLaunch(launch({ rows: 0 }))).toThrow(/1\.\.200/)
    expect(() => SessionRequestValidation.validateLaunch(launch({ rows: 201 }))).toThrow(/1\.\.200/)
    expect(() => SessionRequestValidation.validateLaunch(launch({ cols: 80.5 }))).toThrow(/1\.\.500/)
  })

  it('requires command and a string args array', () => {
    expect(() => SessionRequestValidation.validateLaunch(launch({ command: '' })))
      .toThrow(/command is required/)
    expect(() => SessionRequestValidation.validateLaunch(
      launch({ args: [1] as unknown as string[] }),
    )).toThrow(/string array/)
  })

  it('rejects identifiers outside the permitted shape', () => {
    expect(() => SessionRequestValidation.validateRuntimeId('runtime-1')).not.toThrow()
    expect(() => SessionRequestValidation.validateRuntimeId('has space')).toThrow(/invalid format/)
    expect(() => SessionRequestValidation.validateRuntimeId('')).toThrow(/invalid format/)
    expect(() => SessionRequestValidation.validateRuntimeId('x'.repeat(129))).toThrow(/invalid format/)
    expect(() => SessionRequestValidation.validateOperationId('op-1')).not.toThrow()
    expect(() => SessionRequestValidation.validateOperationId('x'.repeat(201)))
      .toThrow(/invalid format/)
  })

  // A retry that is identical apart from key order must produce the same digest, or it is not a replay.
  it('canonicalises key order and drops undefined', () => {
    expect(SessionRequestValidation.canonicalJson({ b: 1, a: 2 }))
      .toBe(SessionRequestValidation.canonicalJson({ a: 2, b: 1 }))
    expect(SessionRequestValidation.canonicalJson({ a: 1, b: undefined }))
      .toBe(SessionRequestValidation.canonicalJson({ a: 1 }))
    expect(SessionRequestValidation.canonicalJson([1, { d: 1, c: 2 }]))
      .toBe(SessionRequestValidation.canonicalJson([1, { c: 2, d: 1 }]))
  })

  it('ignores the omitted keys in the request digest', () => {
    const base = { operationId: 'op-1', launch: launch() }
    expect(SessionRequestValidation.requestKey(
      { ...base, controllerLeaseId: 'lease-1' },
      ['controllerLeaseId'],
    )).toBe(SessionRequestValidation.requestKey(
      { ...base, controllerLeaseId: 'lease-2' },
      ['controllerLeaseId'],
    ))
  })

  it('changes the digest when the request really differs', () => {
    expect(SessionRequestValidation.requestKey({ launch: launch({ env: { A: 'one' } }) }))
      .not.toBe(SessionRequestValidation.requestKey({ launch: launch({ env: { A: 'two' } }) }))
  })

  function join_nonexistent(): string {
    return `${process.cwd()}/definitely-not-a-directory-${Date.now()}`
  }
})
