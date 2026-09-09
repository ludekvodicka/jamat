import type {
  SessionColorName,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * What is missing from the list below, expressed as a type. It exists so that a colour added to the
 * library and forgotten here stops the compile instead of quietly never appearing in the menu -
 * the same trick that keeps this client's protocol constant honest against the Host's.
 */
type MissingSessionColor = Exclude<SessionColorName, (typeof SessionPalette.namesConst)[number]>

/**
 * The colours as the menu offers them.
 *
 * The names are the library's and the VALUES are not here at all: every colour is a CSS custom
 * property, so the whole palette can be themed in one file and the token gate stays green. This
 * class knows what to call each one and which class draws its square, and nothing more.
 */
export class SessionPalette {
  static readonly namesConst = [
    'red', 'orange', 'amber', 'green', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose',
  ] as const satisfies readonly SessionColorName[]

  /** Public only so it counts as read: its whole job is to be a type that stops compiling. */
  static readonly completeConst: [MissingSessionColor] extends [never] ? true : never = true

  /** `null` is None: the absence of a colour, which is a choice a person makes and so needs a word. */
  static labelOf(name: SessionColorName | null): string {
    if (name === null) return 'None'
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  }

  static swatchClassOf(name: SessionColorName): string {
    return `jamat-tab-menu__swatch--${name}`
  }
}
