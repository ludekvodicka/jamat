export type PeerRequestFamily = 'attached' | 'attach' | 'view' | 'operation'

export class PeerFrontDoor {
  private forwarded: Promise<void>
  private views: number

  constructor() { this.forwarded = Promise.resolve(); this.views = 0 }

  run(family: PeerRequestFamily, work: () => Promise<void>, options?: { closeView?: boolean; overflow?(): void }): Promise<void> {
    switch (family) {
      case 'attached': return work()
      case 'attach': return this.forwarded.then(work)
      case 'view': {
        if (options?.closeView) return work()
        if (this.views >= 16) { options?.overflow?.(); return Promise.resolve() }
        this.views++
        return work().finally(() => { this.views-- })
      }
      case 'operation': {
        const workDone = this.forwarded.then(work)
        this.forwarded = workDone.catch(() => {})
        return workDone
      }
      default: throw new Error(`Unknown peer request family: ${family}`)
    }
  }
}
