import type { PassSettler } from './passSettler'
import type { TickGuard } from './tickGuard'

export class PassReconciler {
  private readonly settler: PassSettler

  constructor(settler: PassSettler) { this.settler = settler }

  run(guard: TickGuard): Promise<boolean> { return this.settler.settle(guard, true) }
}
