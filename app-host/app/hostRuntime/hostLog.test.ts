import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostLog } from './hostLog'
import { HostStatePaths } from './hostStatePaths'

describe('app-host/app/hostRuntime/hostLog', () => {
  const saved = process.env.JAMAT_V3_LOCAL_STATE_DIR
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jamat-v3-host-log-'))
    process.env.JAMAT_V3_LOCAL_STATE_DIR = root
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = saved
    rmSync(root, { recursive: true, force: true })
  })

  it('moves a full log aside before the next line and keeps one older file', () => {
    const file = HostStatePaths.log('11111111-1111-4111-8111-111111111111', 'development')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, Buffer.alloc(HostLog.rotateBytesConst, 0x20))
    const log = new HostLog('11111111-1111-4111-8111-111111111111', 'development')
    log.write('info', 'after rotation')
    expect(statSync(`${file}.1`).size).toBe(HostLog.rotateBytesConst)
    expect(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).message)).toEqual(['after rotation'])
    expect(existsSync(`${file}.2`)).toBe(false)
  })
})
