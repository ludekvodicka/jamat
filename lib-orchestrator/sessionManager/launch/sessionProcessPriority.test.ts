import { spawn } from 'node:child_process'
import { constants, getPriority, setPriority } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import { SessionProcessPriority } from './sessionProcessPriority'

function runtime(runtimeSessionId: string, overrides?: Partial<RuntimeSessionInfo>): RuntimeSessionInfo {
  return { runtimeSessionId, generation: 1, alive: true, pid: 100, processStartedAt: 1, cols: 120, rows: 30, outputSeq: 0,
    outputEpoch: 1, lastOutputAt: null, startedAt: 1, ...overrides }
}

const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
const below = constants.priority.PRIORITY_BELOW_NORMAL
const normal = constants.priority.PRIORITY_NORMAL

describe('lib-orchestrator/sessionManager/launch/sessionProcessPriority', () => {
  it('sets each live process it governs once, and a restarted one again', () => {
    const calls: [number, number][] = []
    const priority = new SessionProcessPriority(() => {}, (pid, value) => { calls.push([pid, value]) })
    const governs = (id: string): boolean => id !== 'shell'

    priority.observe([runtime('agent'), runtime('shell', { pid: 200 }), runtime('dead', { pid: 300, alive: false }),
      runtime('starting', { pid: undefined })], governs, 'below-normal')
    priority.observe([runtime('agent')], governs, 'below-normal')
    expect(calls).toEqual([[100, below]])

    priority.observe([runtime('agent', { pid: 101, processStartedAt: 2 })], governs, 'below-normal')
    expect(calls).toEqual([[100, below], [101, below]])
  })

  it('follows a changed level on the processes already running', () => {
    const calls: [number, number][] = []
    const priority = new SessionProcessPriority(() => {}, (pid, value) => { calls.push([pid, value]) })

    priority.observe([runtime('agent')], () => true, 'below-normal')
    priority.observe([runtime('agent')], () => true, 'normal')
    priority.observe([runtime('agent')], () => true, 'normal')
    priority.observe([runtime('agent')], () => true, 'below-normal')
    expect(calls).toEqual([[100, below], [100, normal], [100, below]])
  })

  it('forgets a session that is no longer listed, so it is set again when it comes back', () => {
    const calls: number[] = []
    const priority = new SessionProcessPriority(() => {}, (pid) => { calls.push(pid) })

    priority.observe([runtime('agent')], () => true, 'below-normal')
    priority.observe([], () => true, 'below-normal')
    priority.observe([runtime('agent')], () => true, 'below-normal')
    expect(calls).toEqual([100, 100])
  })

  it('reports a refusal once and says nothing about a process that already ended', () => {
    const reports: string[] = []
    const refused = new SessionProcessPriority((text) => reports.push(text), failing('EPERM'))
    refused.observe([runtime('agent')], () => true, 'normal')
    refused.observe([runtime('agent')], () => true, 'normal')
    expect(reports).toEqual(['The priority of session process 100 could not be set to normal: EPERM'])

    const ended = new SessionProcessPriority((text) => reports.push(text), failing('ESRCH'))
    ended.observe([runtime('agent')], () => true, 'below-normal')
    expect(reports).toHaveLength(1)
  })

  // The claim the class rests on: what a lowered process starts afterwards runs lowered too, and the
  // level can be taken back.
  it('lowers a real process, the child it starts afterwards inherits it, and normal restores it', async () => {
    const parent = spawn(process.execPath, ['-e', `
      process.stdin.once('data', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
        process.stdout.write(String(child.pid))
      })
    `], { stdio: ['pipe', 'pipe', 'ignore'] })
    try {
      await new Promise<void>((resolve) => parent.once('spawn', () => resolve()))
      // A runner that is itself below normal (an agent's shell tool) would hand that down on its own.
      setPriority(parent.pid!, normal)
      expect(getPriority(parent.pid!)).toBe(normal)
      const priority = new SessionProcessPriority((text) => { throw new Error(text) })
      priority.observe([runtime('agent', { pid: parent.pid })], () => true, 'below-normal')
      expect(getPriority(parent.pid!)).toBe(below)

      const childPid = await new Promise<number>((resolve) => {
        parent.stdout!.once('data', (data) => resolve(Number(String(data))))
        parent.stdin!.write('go\n')
      })
      try { expect(getPriority(childPid)).toBe(below) }
      finally { process.kill(childPid) }

      // Raising a nice value back needs privilege off Windows.
      if (process.platform === 'win32') {
        priority.observe([runtime('agent', { pid: parent.pid })], () => true, 'normal')
        expect(getPriority(parent.pid!)).toBe(normal)
      }
    } finally { parent.kill() }
  }, 20_000)
})
