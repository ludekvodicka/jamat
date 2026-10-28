import type { SnapinDefinition } from './shared/snapinContract'
import { ReviewTodosSnapin } from './reviewTodos/reviewTodosSnapin'

export class BuiltInSnapins {
  static all(): SnapinDefinition[] { return [new ReviewTodosSnapin()] }
}
