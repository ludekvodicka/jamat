import './signalGlyph.css'

export function SignalGlyph(props: { glyph: string }): React.JSX.Element {
  if (props.glyph === '■' || props.glyph === '□')
    return <span className="jamat-signal-square" data-filled={props.glyph === '■'}>{props.glyph}</span>
  if (props.glyph === '🧹')
    return <span className="jamat-signal-broom">
      {props.glyph}
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M13 2 8 8M6 7l4 4-4 3-4-4 4-3ZM4 10l3 3M6 9l3 3" />
      </svg>
    </span>
  return <>{props.glyph}</>
}
