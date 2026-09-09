export class TerminalDetectorLimits {
  static readonly detectionsMax = 8
  static readonly directoryChildrenMax = 8
  static readonly urlsMax = 3
  static readonly requestTtlMilliseconds = 120_000
  static readonly requestsMax = 16
  static readonly openedPathsMax = 256
  static readonly captureTokenCharactersMax = 1_024
  static readonly captureContextCharactersMax = 4_096
  /**
   * How many rows either side of the click may be stitched into one token. A path wraps over a
   * handful of rows at most; an unbroken wall of path characters - a base64 blob, a hex dump - wraps
   * over as many as the scrollback holds, and that walk used to run to the end of it.
   */
  static readonly captureStitchRowsMax = 8
  static readonly suffixWalkDepthMax = 12
  static readonly suffixWalkEntriesMax = 20_000
  /**
   * How long one candidate may be probed. A path is a string a foreign process printed, and on
   * Windows a stat of a UNC path is an outbound SMB connect: against a host that does not answer it
   * blocks for the network's timeout, not ours, and the menu waits on the whole probe.
   */
  static readonly probeMilliseconds = 250
}
