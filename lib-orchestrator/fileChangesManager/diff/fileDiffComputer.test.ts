import { describe, expect, it } from 'vitest'

import { FileDiffComputer } from './fileDiffComputer'

describe('lib-orchestrator/fileChangesManager/diff/fileDiffComputer', () => {
  it('computes renderer-safe hunks synchronously', () => {
    expect(FileDiffComputer.compute({
      before: 'one\ntwo\n',
      after: 'one\nthree\n',
    })).toEqual({
      kind: 'computed',
      hunks: [{
        beforeStart: 1,
        beforeLines: 2,
        afterStart: 1,
        afterLines: 2,
        lines: [
          { kind: 'context', text: 'one', beforeLine: 1, afterLine: 1 },
          { kind: 'remove', text: 'two', beforeLine: 2, afterLine: null },
          { kind: 'add', text: 'three', beforeLine: null, afterLine: 2 },
        ],
      }],
    })
  })

  it('reports the edit-length work limit', () => {
    expect(FileDiffComputer.compute({ before: '', after: 'x\n'.repeat(50_001) }))
      .toEqual({ kind: 'work-limit' })
  })
})
