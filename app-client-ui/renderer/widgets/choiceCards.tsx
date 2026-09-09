import './choiceCards.css'

export function ChoiceRow(props: {
  label: string
  current: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`jamat-choice__row${
      props.current ? ' jamat-choice__row--current' : ''}${
      props.className === undefined ? '' : ` ${props.className}`}`}>
      <span className="jamat-choice__label">{props.label}</span>
      <div className="jamat-choice__content">{props.children}</div>
    </div>
  )
}

export function ChoiceCard(props: {
  title: string
  note: string | null
  glyph: string
  glyphClass?: string
  chosen: boolean
  refusal: string | null
  danger?: boolean
  onChoose(): void
}): React.JSX.Element {
  return (
    <button
      className={`jamat-choice__card${
        props.chosen ? ' jamat-choice__card--chosen' : ''}${
        props.danger === true ? ' jamat-choice__card--danger' : ''}`}
      type="button"
      aria-pressed={props.chosen}
      disabled={props.refusal !== null}
      title={props.refusal ?? undefined}
      onClick={props.onChoose}
    >
      <span className={props.glyphClass ?? 'jamat-choice__glyph'}>{props.glyph}</span>
      <span className="jamat-choice__card-title">{props.title}</span>
      {props.note !== null && (
        <span className="jamat-choice__card-note">{props.note}</span>
      )}
    </button>
  )
}
