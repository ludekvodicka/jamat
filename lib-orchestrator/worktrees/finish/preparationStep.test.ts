import { describe, expect, it } from 'vitest'
import { PreparationStep } from './preparationStep'

describe('PreparationStep.incomingMatters', () => {
  const published = ['SrvMirabiaBackend/app/appHub.ts', 'WebMirabiaAdmin/app/editor']

  it.each([
    ['no checks, a research note of the owner', ['.aidocs/research/x.md'], false, 'first-segment', false],
    ['no checks, a source file outside the published paths', ['SrvMirabiaBackend/app/other.ts'], false, 'first-segment', false],
    ['checks, documentation of a member project only', ['WebMirabiaAdmin/docs/a.md'], true, 'first-segment', false],
    ['checks, owner and member documentation together', ['docs/a.md', '.aidocs/b.md', 'SrvMirabiaBackend/.aidocs/c.md'], true, 'first-segment', false],
    ['checks, a source file', ['SrvMirabiaBackend/app/other.ts'], true, 'first-segment', true],
    ['checks, documentation beside a source file', ['WebMirabiaAdmin/docs/a.md', 'WebMirabiaAdmin/app/x.ts'], true, 'first-segment', true],
    ['checks, a docs folder deeper than a member root', ['SrvMirabiaBackend/app/docs/a.md'], true, 'first-segment', true],
    ['checks, a member docs folder in a single project', ['WebMirabiaAdmin/docs/a.md'], true, 'whole', true],
  ] as const)('%s', (_name, incoming, hasChecks, members, expected) => {
    expect(PreparationStep.incomingMatters(incoming, published, hasChecks, members)).toBe(expected)
  })

  it.each([false, true])('always counts an incoming change of a published path or below a published folder (checks=%s)', (hasChecks) => {
    expect(PreparationStep.incomingMatters(['SrvMirabiaBackend/app/appHub.ts'], published, hasChecks, 'first-segment')).toBe(true)
    expect(PreparationStep.incomingMatters(['WebMirabiaAdmin/app/editor/docs/x.md'], published, hasChecks, 'first-segment')).toBe(true)
    expect(PreparationStep.incomingMatters(['WebMirabiaAdmin/app'], published, hasChecks, 'first-segment')).toBe(true)
  })

  it.each([false, true])('counts the worktree root as holding every published path (checks=%s)', (hasChecks) => {
    expect(PreparationStep.incomingMatters(['.'], published, hasChecks, 'first-segment')).toBe(true)
    expect(PreparationStep.incomingMatters(['.aidocs/research/x.md'], ['.'], hasChecks, 'first-segment')).toBe(true)
  })

  it('counts every incoming change while no candidate set is known', () => {
    expect(PreparationStep.incomingMatters(['.aidocs/research/x.md'], null, false, 'first-segment')).toBe(true)
  })
})
