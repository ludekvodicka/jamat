import type { SnapinDefinition } from './shared/snapinContract'
import { ReviewTodosSnapin } from './reviewTodos/reviewTodosSnapin'
import { PerfStallsSnapin } from './perfStalls/perfStallsSnapin'

export class BuiltInSnapins {
  static all(perf?: ConstructorParameters<typeof PerfStallsSnapin>[0]): SnapinDefinition[] {
    return [new ReviewTodosSnapin(), new PerfStallsSnapin(perf)]
  }
}
