/**
 * Which node of the Debug window's tree is being talked about. A closed union filled at compile time,
 * and shared by the three places that have to agree on it: the renderer catalog that draws the tree,
 * the IPC contract that carries the active node, and the main-process gate that only pings while the
 * one node that shows a ping is on screen.
 *
 * Every node is named here, parents and children alike, because what travels is the node the user is
 * looking at and not the subsystem it belongs to. It grows by one entry per node, beside the catalog
 * row that adds it.
 */
export type DebugSectionId =
  | 'host'
  | 'host-runtimes'
  | 'host-connection'
  | 'host-launch'
  | 'rate'
  | 'rate-codex'
  | 'rate-claude'
