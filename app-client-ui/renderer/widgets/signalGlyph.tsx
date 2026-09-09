import './signalGlyph.css'

export function SignalGlyph(props: { glyph: string }): React.JSX.Element {
  if (props.glyph === '■' || props.glyph === '□')
    return <span className="jamat-signal-square" data-filled={props.glyph === '■'}>{props.glyph}</span>
  return <>{props.glyph}</>
}
