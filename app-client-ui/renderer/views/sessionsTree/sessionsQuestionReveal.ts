import type { TreeNode } from './sessionsTreeModel'

/**
 * One tree on screen, with the group ids ABOVE its roots. Locally there are none; a remote tree
 * hangs under its computer and that computer's endpoint, and both of those fold away too, so
 * opening the project inside one without them would open nothing anybody can see.
 */
export interface QuestionRevealTree {
  above: readonly string[]
  nodes: readonly TreeNode[]
}

/**
 * Which folded groups have to open: the ones holding a session that has just started waiting for an
 * answer. A question nobody is shown is a session stopped for as long as it takes somebody to
 * remember it is there, and a folded project is exactly where that happens.
 *
 * It reveals on the TRANSITION into waiting and never again, which is what lets the person fold the
 * group back while the question still stands. A row seen waiting is remembered until it is seen
 * NOT waiting, rather than until it leaves the tree: a filter typed and cleared takes every row off
 * this model's screen for a tick, and forgetting there would re-open the group on the way back.
 * The cost is one remembered id per session that has ever asked in this window's lifetime, and the
 * direction of that leak is the safe one - a stale id reveals nothing.
 */
export class SessionsQuestionReveal {
  private readonly asking = new Set<string>()

  groupsToOpen(trees: readonly QuestionRevealTree[]): ReadonlySet<string> {
    const open = new Set<string>()
    for (const tree of trees)
      this.walk(tree.nodes, tree.above, open)
    return open
  }

  private walk(nodes: readonly TreeNode[], ancestors: readonly string[], open: Set<string>): void {
    for (const node of nodes) {
      if (node.kind === 'session') {
        if (node.glyph === 'waiting') {
          if (!this.asking.has(node.id)) {
            this.asking.add(node.id)
            for (const ancestor of ancestors) open.add(ancestor)
          }
        } else
          this.asking.delete(node.id)
        // An install hangs under the session it was started for, and that row carries no twisty:
        // whatever opens the session opens the install with it, so the ancestors do not grow here.
        this.walk(node.children, ancestors, open)
      } else if (node.kind === 'category' || node.kind === 'project')
        this.walk(node.children, [...ancestors, node.id], open)
      else
        throw new Error(`Unknown tree node: ${JSON.stringify(node)}`)
    }
  }
}
