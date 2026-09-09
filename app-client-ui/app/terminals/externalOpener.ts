import { shell } from 'electron'

import { ErrorText } from '../../shared/errorText'

/**
 * A file handed to whatever the desktop reads that type with.
 *
 * It takes a path the main process resolved from a detection and never one a renderer named, and
 * the caller has already checked that the detection is one the menu offered this for: the desktop
 * runs whatever it is told to open, so the extension whitelist in `TerminalDetector` is the guard
 * and this class is only the door.
 */
export class ExternalOpener {
  /** Null where the desktop took it; otherwise what it said, for the person who clicked. */
  static async open(path: string): Promise<string | null> {
    let refusal: string
    try { refusal = await shell.openPath(path) }
    catch (error) { return ErrorText.of(error) }
    return refusal === '' ? null : refusal
  }
}
