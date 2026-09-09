export class HostHealth {
  readonly startedAt = Date.now()

  uptimeMs(): number {
    return Date.now() - this.startedAt
  }
}
