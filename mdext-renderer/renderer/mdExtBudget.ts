import { FileViewerLimits } from '../../lib-orchestrator/fileViewer/fileViewerLimits'

/**
 * How much of ONE document is given the expensive treatment.
 *
 * The per-call ceilings bound one fence: 64 KiB of source to highlight, 50 000 characters of diagram
 * spec. Nothing bounded how MANY. A generated API report with 500 fences is 500 synchronous Shiki
 * calls chained through the microtask queue with no yield, and one renderer draws every panel of the
 * window - so the terminal and the sessions tree stop with it.
 *
 * **Decided once per fence and remembered**, keyed by where the fence starts in the document. A
 * re-render must not move a fence in or out of the budget: the answer would flip between highlighted
 * and plain while somebody read it, and a diagram would render again from the top.
 */
export class MdExtBudget {
  private readonly highlighted = new Map<number, boolean>()
  private readonly diagrams = new Map<number, boolean>()

  /** Whether the fence starting on this line is highlighted, or drawn as plain text. */
  allowsHighlight(line: number): boolean {
    return MdExtBudget.decide(this.highlighted, line, FileViewerLimits.highlightedFencesMax)
  }

  /** Whether the diagram starting on this line is drawn, or offers its source instead. */
  allowsDiagram(line: number): boolean {
    return MdExtBudget.decide(this.diagrams, line, FileViewerLimits.diagramsMax)
  }

  private static decide(taken: Map<number, boolean>, line: number, limit: number): boolean {
    const already = taken.get(line)
    if (already !== undefined) return already
    const allowed = taken.size < limit
    taken.set(line, allowed)
    return allowed
  }
}
