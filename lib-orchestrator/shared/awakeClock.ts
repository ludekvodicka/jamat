export class AwakeClock {
  private readonly source: () => number
  private lastTick: number
  private excluded: number
  private armed: boolean
  private epoch: number
  private recentGap: number | null

  constructor(source: () => number = () => performance.now()) {
    this.source = source
    this.lastTick = source()
    this.excluded = 0
    this.armed = false
    this.epoch = 0
    this.recentGap = null
  }

  now(): number { this.tick(); return this.lastTick - this.excluded }

  tick(): void {
    const at = this.source()
    // Only an OS suspend event permits a gap to be excluded; an ordinary stall remains elapsed time.
    if (at - this.lastTick > 2_000) {
      if (this.armed) {
        this.excluded += at - this.lastTick
        this.armed = false
      } else {
        this.recentGap = at
        setTimeout(() => { if (this.recentGap === at) this.recentGap = null }, 0).unref?.()
      }
    }
    this.lastTick = at
  }

  power(epoch: number, event: 'suspend' | 'resume'): { changed: boolean; late: boolean } {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid power event epoch')
    if (epoch <= this.epoch) return { changed: false, late: false }
    this.epoch = epoch
    let late = false
    if (event === 'suspend') {
      late = this.recentGap !== null
      this.armed = !late
      this.recentGap = null
    }
    else if (event === 'resume') {
      const at = this.source()
      if (this.armed) this.excluded += at - this.lastTick
      this.armed = false
      this.lastTick = at
      this.recentGap = null
    } else throw new Error(`Unknown power event: ${event}`)
    return { changed: true, late }
  }
}
