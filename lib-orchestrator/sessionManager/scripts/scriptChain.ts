import { createHash } from 'node:crypto'

import type { SessionRecordScriptStep } from '../records/sessionRecord.types'

/** The pure rules of a chain of script steps: a step's identity, where a chain resumes, when two chains are one. */
export class ScriptChain {
  /**
   * A step's identity across attempts. A changed command, process, directory or name is a different
   * step, so a success recorded for the old one never lets the new one be skipped.
   */
  static keyOf(step: Pick<SessionRecordScriptStep, 'scriptId' | 'name' | 'commands' | 'process'>): string {
    // Built field by field, so the hash never depends on the order a caller wrote its keys in. A step
    // without a process hashes exactly what it did before the field existed, so no key on disk moves.
    const input = {
      scriptId: step.scriptId,
      name: step.name,
      commands: step.commands.map(({ command, cwd }) => ({ command, cwd })),
      ...(step.process === undefined ? {} : {
        process: { tool: step.process.tool, args: [...step.process.args], cwd: step.process.cwd },
      }),
    }
    return createHash('sha256').update(JSON.stringify(input)).digest('hex')
  }

  /** A step that spawns a tool directly in `process.cwd`, keyed like every other step. */
  static processStepOf(
    scriptId: SessionRecordScriptStep['scriptId'],
    name: string,
    process: NonNullable<SessionRecordScriptStep['process']>,
  ): SessionRecordScriptStep {
    const step = { scriptId, name, commands: [], process: { tool: process.tool, args: [...process.args], cwd: process.cwd } }
    return { key: ScriptChain.keyOf(step), ...step }
  }

  /** The first step without a success; `steps.length` when every step has one. */
  static firstDue(steps: readonly SessionRecordScriptStep[], succeeded: ReadonlySet<string>): number {
    const index = steps.findIndex((step) => !succeeded.has(step.key))
    return index === -1 ? steps.length : index
  }

  /** The same steps in the same order. */
  static sameKeys(left: readonly SessionRecordScriptStep[], right: readonly SessionRecordScriptStep[]): boolean {
    return left.length === right.length && left.every((step, index) => step.key === right[index].key)
  }
}
