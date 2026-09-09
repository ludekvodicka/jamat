import type {
  HostEvent,
  HostEventPayload,
  HostWsServerMsg,
} from '../wire/hostWire.js'

export interface EventReplay {
  throughRevision: number
  replay: HostEvent[]
  truncated: boolean
}

export interface EventSocket {
  send(data: string): void
}

export class EventHub {
  private static readonly retainedEventsConst = 2_048
  private readonly subscribers = new Set<EventSocket>()
  private events: HostEvent[] = []
  private revisionValue = 0

  get revision(): number {
    return this.revisionValue
  }

  publish(payload: HostEventPayload): HostEvent {
    const event = {
      ...payload,
      revision: ++this.revisionValue,
      timestamp: Date.now(),
    } as HostEvent
    this.events.push(event)
    if (this.events.length > EventHub.retainedEventsConst)
      this.events = this.events.slice(-EventHub.retainedEventsConst)
    const frame = JSON.stringify({ type: 'event', event } satisfies HostWsServerMsg)
    for (const subscriber of this.subscribers)
      try { subscriber.send(frame) } catch {}
    return event
  }

  /**
   * Replay is bounded, so a subscriber whose cursor fell off the retained window is told `truncated`
   * and reloads the full projection rather than resuming from a gap it cannot see.
   */
  subscribe(webSocket: EventSocket, afterRevision: number): EventReplay {
    this.subscribers.add(webSocket)
    const oldest = this.events[0]?.revision ?? this.revisionValue + 1
    return {
      throughRevision: this.revisionValue,
      replay: this.events.filter((event) => event.revision > afterRevision),
      truncated: afterRevision < oldest - 1,
    }
  }

  unsubscribe(webSocket: EventSocket): void {
    this.subscribers.delete(webSocket)
  }
}
