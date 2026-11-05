import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ImmutableFileLease } from '../../lib-orchestrator/shared/immutableFileLease'
import { ErrnoCode } from '../../lib-orchestrator/shared/errnoCode'

interface GatewayOwner { pid: number; token: string }

export class GatewayLock {
  private readonly file: string
  private releaseLease: (() => Promise<void>) | null

  constructor(file: string) {
    this.file = file
    this.releaseLease = null
  }

  async acquire(): Promise<void> {
    const lease = await ImmutableFileLease.take(this.file, { pid: process.pid, token: randomUUID() }, {
      read: GatewayLock.read,
      alive: owner => {
        try { process.kill(owner.pid, 0); return true }
        catch (error) { return ErrnoCode.of(error) !== 'ESRCH' }
      },
    })
    if (!lease.ok) throw new Error('A gateway already owns this client identity')
    this.releaseLease = lease.release
  }

  async release(): Promise<void> { await this.releaseLease?.() }

  private static async read(file: string): Promise<GatewayOwner | null> {
    let text: string
    try { text = await readFile(file, 'utf8') }
    catch (error) { if (ErrnoCode.of(error) === 'ENOENT') return null; throw error }
    const value = JSON.parse(text) as Partial<GatewayOwner>
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.token !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token))
      throw new Error('Invalid gateway lock; takeover is refused')
    return value as GatewayOwner
  }
}
