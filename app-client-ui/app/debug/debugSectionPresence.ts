import type { DebugSectionId } from '../../shared/debugSections.types'

/**
 * Which Debug node each workspace renderer has on screen, reduced to the one node orchestration gates
 * its ping on. The Debug tab can move between windows, so the old renderer's `null` may arrive after
 * the new renderer's report; keeping one entry per caller makes that order irrelevant. A caller that
 * reloads, crashes or closes is forgotten through the transport's `gone` event, without a final report.
 */
export class DebugSectionPresence {
  private readonly sections: Map<string, DebugSectionId>
  private readonly onChanged: (section: DebugSectionId | null) => void
  private published: DebugSectionId | null

  constructor(onChanged: (section: DebugSectionId | null) => void) {
    this.sections = new Map()
    this.onChanged = onChanged
    this.published = null
  }

  report(callerId: string, section: DebugSectionId | null): void {
    if (section === null)
      this.sections.delete(callerId)
    else
      this.sections.set(callerId, section)
    this.publish()
  }

  forget(callerId: string): void {
    this.report(callerId, null)
  }

  private publish(): void {
    const values = [...this.sections.values()]
    const effective = values.includes('host') ? 'host' : values[0] ?? null
    if (effective === this.published)
      return
    this.published = effective
    this.onChanged(effective)
  }
}
