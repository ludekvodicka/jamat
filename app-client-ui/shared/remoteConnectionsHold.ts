/**
 * Why a window wants the paired computers reachable. A closed set rather than free text: the main
 * process keys a hold by window and reason, and a typo in a reason would be a hold nobody can
 * release - which is a connection held open until the window dies.
 *
 * Both are screens somebody opens for seconds and closes again. A remote TAB is not on this list:
 * a tab holds its own endpoint through its terminal attach, which the connector already counts.
 */
export type RemoteConnectionsHoldReason = 'launcher-computers' | 'network-settings'
