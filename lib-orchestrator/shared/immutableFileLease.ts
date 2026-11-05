import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { ErrnoCode } from './errnoCode'

export type FileLeaseResult<T> = { ok: true; release(): Promise<void> } | { ok: false; heldBy: T }

export class ImmutableFileLease {
  static async take<T extends { token: string }>(file: string, owner: T, deps: {
    read(file: string): Promise<T | null>
    alive(owner: T): Promise<boolean> | boolean
    beforeTakeover?(): Promise<void>
  }): Promise<FileLeaseResult<T>> {
    await mkdir(dirname(file), { recursive: true })
    const candidate = `${file}.${owner.token}.candidate`
    await writeFile(candidate, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' })
    try {
      try { await link(candidate, file) }
      catch (error) {
        if (ErrnoCode.of(error) !== 'EEXIST') throw error
        const previous = await deps.read(file)
        if (previous === null) throw new Error('The lease owner disappeared; retry acquisition')
        let holder = previous
        // Immutable claims serialize retirement without an ownerless lock creation window.
        const seen = new Set<string>()
        for (;;) {
          if (seen.has(holder.token) || seen.size >= 64) throw new Error('Invalid lease takeover chain; takeover is refused')
          seen.add(holder.token)
          if (await deps.alive(holder))
            return { ok: false, heldBy: holder }
          await deps.beforeTakeover?.()
          const claim = `${file}.${holder.token}.takeover`
          try { await link(candidate, claim); break }
          catch (claimError) {
            if (ErrnoCode.of(claimError) !== 'EEXIST') throw claimError
            const next = await deps.read(claim)
            if (next === null) throw new Error('The lease takeover evidence disappeared')
            holder = next
          }
        }
        const latest = await deps.read(file)
        if (latest !== null && latest.token !== previous.token) return { ok: false, heldBy: latest }
        if (latest !== null) await ImmutableFileLease.remove(file, deps.read, previous.token)
        try { await link(candidate, file) }
        catch (installError) {
          if (ErrnoCode.of(installError) !== 'EEXIST') throw installError
          const installed = await deps.read(file)
          if (installed === null) throw new Error('The lease owner disappeared during takeover')
          return { ok: false, heldBy: installed }
        }
      }
      let releasing: Promise<void> | undefined
      return { ok: true, release: () => releasing ??= (async () => {
        const latest = await deps.read(file)
        if (latest?.token === owner.token) await ImmutableFileLease.remove(file, deps.read, owner.token)
      })() }
    } finally { await ImmutableFileLease.remove(candidate, deps.read) }
  }

  static async remove(file: string, read: (file: string) => Promise<{ token: string } | null>, token?: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (token !== undefined && (await read(file))?.token !== token) return
        await unlink(file)
        return
      } catch (error) {
        if (ErrnoCode.of(error) === 'ENOENT') return
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(ErrnoCode.of(error) ?? '') || attempt >= 5) throw error
        await setTimeout(20 * 2 ** attempt)
      }
    }
  }

}
