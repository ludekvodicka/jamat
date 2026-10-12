import { describe, expect, it } from 'vitest'

import type { SessionRecordScriptStep } from '../records/sessionRecord.types'
import { ScriptChain } from './scriptChain'

describe('lib-orchestrator/sessionManager/scripts/scriptChain', () => {
  function step(name: string, command = `run ${name}`, cwd = '/w'): SessionRecordScriptStep {
    const commands = [{ command, cwd }]
    return { key: ScriptChain.keyOf({ scriptId: 'declared', name, commands }), scriptId: 'declared', name, commands }
  }

  describe('keyOf', () => {
    it('is the same for the same step, whatever order its fields were written in', () => {
      const commands = [{ command: 'pnpm test', cwd: '/w' }]
      const key = ScriptChain.keyOf({ scriptId: 'declared', name: 'tests', commands })
      expect(key).toMatch(/^[0-9a-f]{64}$/)
      expect(ScriptChain.keyOf({ commands: [{ cwd: '/w', command: 'pnpm test' }], name: 'tests', scriptId: 'declared' }))
        .toBe(key)
    })

    it('changes with the script, the name, a command or a directory', () => {
      const commands = [{ command: 'pnpm install', cwd: '/w' }]
      const key = ScriptChain.keyOf({ scriptId: 'setup', name: 'setup', commands })
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'setup', commands })).not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'setup', name: 'install', commands })).not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'setup', name: 'setup', commands: [{ command: 'npm ci', cwd: '/w' }] })).not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'setup', name: 'setup', commands: [{ command: 'pnpm install', cwd: '/x' }] })).not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'setup', name: 'setup', commands: [...commands, ...commands] })).not.toBe(key)
    })

    it('changes with a process argument, its tool or its directory', () => {
      const process = { tool: 'svn' as const, args: ['update', '-q', '--', '.'], cwd: '/w' }
      const key = ScriptChain.keyOf({ scriptId: 'declared', name: 'svn', commands: [], process })
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'svn', commands: [], process: { ...process, args: ['update', '--', '.'] } }))
        .not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'svn', commands: [], process: { ...process, tool: 'jamat-cli' as const } }))
        .not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'svn', commands: [], process: { ...process, cwd: '/x' } }))
        .not.toBe(key)
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'svn', commands: [] })).not.toBe(key)
    })

    // Keys are persisted on records, so a step without a process must keep the key it had before the field.
    it('keeps the key of a step without a process', () => {
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'tests', commands: [{ command: 'pnpm test', cwd: '/w' }] }))
        .toBe('ff887f241ef2d2a079f4a4833f9fa8580d862d990858fb69c9f31b61e5686610')
    })

    it('ignores fields a command carries beyond its command and directory', () => {
      const commands = [{ command: 'pnpm test', cwd: '/w' }]
      const key = ScriptChain.keyOf({ scriptId: 'declared', name: 'tests', commands })
      const extra = [{ command: 'pnpm test', cwd: '/w', note: 'x' }]
      expect(ScriptChain.keyOf({ scriptId: 'declared', name: 'tests', commands: extra })).toBe(key)
    })
  })

  describe('firstDue', () => {
    const steps = [step('setup'), step('codegen'), step('seed')]

    it('answers the first step without a success', () => {
      expect(ScriptChain.firstDue(steps, new Set())).toBe(0)
      expect(ScriptChain.firstDue(steps, new Set([steps[0].key]))).toBe(1)
      expect(ScriptChain.firstDue(steps, new Set([steps[0].key, steps[2].key]))).toBe(1)
    })

    it('answers the length when every step has a success', () => {
      expect(ScriptChain.firstDue(steps, new Set(steps.map((each) => each.key)))).toBe(3)
      expect(ScriptChain.firstDue([], new Set())).toBe(0)
    })

    it('runs a changed step again although a step of the same name succeeded', () => {
      const changed = [step('setup', 'npm ci'), steps[1]]
      expect(ScriptChain.firstDue(changed, new Set([steps[0].key, steps[1].key]))).toBe(0)
    })
  })

  describe('sameKeys', () => {
    it('is true for the same steps in the same order only', () => {
      const lint = step('lint')
      const tests = step('tests')
      expect(ScriptChain.sameKeys([lint, tests], [step('lint'), step('tests')])).toBe(true)
      expect(ScriptChain.sameKeys([], [])).toBe(true)
      expect(ScriptChain.sameKeys([lint, tests], [tests, lint])).toBe(false)
      expect(ScriptChain.sameKeys([lint, tests], [lint])).toBe(false)
      expect(ScriptChain.sameKeys([lint], [lint, tests])).toBe(false)
      expect(ScriptChain.sameKeys([lint], [step('lint', 'pnpm lint --fix')])).toBe(false)
    })
  })
})
