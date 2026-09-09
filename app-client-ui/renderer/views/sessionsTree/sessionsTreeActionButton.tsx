/**
 * Every button the sessions panel puts on a row or a heading, drawn once.
 *
 * There were three copies of this markup - `+ Session` on a group row, the inline actions on a
 * session row, and `+ Tab` on the Tabs heading - each writing `jamat-sessions__action` by hand. The
 * third arrived without the hover container the other two sit in and was therefore the one button in
 * the panel that was always on screen, in a panel whose whole convention is that actions appear on
 * the row being pointed at. A class three files write is a look three files can change; a component
 * is one.
 *
 * It owns the class, the armed modifier and the confirm marker, and nothing else: what a button
 * MEANS - which call it makes, when it is dead, whether it asks twice - belongs to its caller.
 */
export function SessionsTreeActionButton(props: {
  label: string
  onClick: () => void
  /** Read by screen readers where the visible word alone does not say which row it belongs to. */
  ariaLabel?: string
  /** The armed step of a two-click action, which reads as the question it is. */
  armed?: boolean
  /** Dead while its own call is out, so a second click cannot fire a second call. */
  disabled?: boolean
  /**
   * Marks both steps of a two-click action, so the outside-click handler can tell the click that
   * ARMS one from a click that cancels it. Absent on a button that acts at once.
   */
  confirm?: string
}): React.JSX.Element {
  const armed = props.armed === true
  return (
    <button
      className={`jamat-sessions__action${armed ? ' jamat-sessions__action--armed' : ''}`}
      type="button"
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      data-confirm={props.confirm}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}
