/**
 * The numbers both sides of the session wire have to agree on.
 *
 * A class of fixed values with no imports of its own, deliberately web-safe, and shared for the one
 * reason `FileViewerLimits` is: so the two sides cannot end up disagreeing about a limit. The note
 * limit lived twice - named and private in the library, an anonymous `maxLength={4000}` in the card -
 * so raising it in the library would have left the textarea silently cutting at the old number, and
 * lowering it would have let the card accept a note the save then refused.
 */
export class SessionLimits {
  /** Characters, after trimming. The refusal quotes this number, so the form must not exceed it. */
  static readonly noteCharacters = 4_000
}
