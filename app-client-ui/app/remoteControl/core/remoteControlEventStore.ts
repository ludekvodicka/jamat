import type {
  RemoteControlEventDto,
  RemoteControlEventKind,
} from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'

export interface RemoteControlEventReplay {
  throughRevision: number
  truncated: boolean
  events: readonly RemoteControlEventDto[]
}

export class RemoteControlEventStore {
  private revision = 0
  private readonly events: RemoteControlEventDto[] = []

  constructor(
    private readonly limit = 256,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`Invalid remote control event limit: ${JSON.stringify(limit)}`)
  }

  publish(kind: RemoteControlEventKind): RemoteControlEventDto {
    const event = { revision: ++this.revision, kind, at: this.now() }
    this.events.push(event)
    if (this.events.length > this.limit) this.events.shift()
    return event
  }

  replay(afterRevision?: number): RemoteControlEventReplay {
    if (afterRevision === undefined)
      return { throughRevision: this.revision, truncated: false, events: [] }
    const oldest = this.events[0]?.revision ?? this.revision + 1
    if (afterRevision > this.revision || afterRevision < oldest - 1)
      return { throughRevision: this.revision, truncated: true, events: [] }
    return {
      throughRevision: this.revision,
      truncated: false,
      events: this.events.filter((event) => event.revision > afterRevision),
    }
  }
}
