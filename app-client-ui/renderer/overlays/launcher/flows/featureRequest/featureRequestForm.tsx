import type { FeatureRequestInput, FeatureRequestState } from './featureRequestFlow'

/**
 * The form itself, and nothing around it: the frame, the footer and the Start button belong to the
 * flow screen, which every flow shares. What a flow owns is its own fields.
 */
export function FeatureRequestForm(props: {
  state: FeatureRequestState
  problem: string | null
  dispatch(input: FeatureRequestInput): void
}): React.JSX.Element {
  const { state, problem, dispatch } = props
  // Every problem this flow can have is about the summary, which is its only required field.
  return (
    <>
      <div className="jamat-launcher-flows__row">
        <span className="jamat-launcher-flows__label">Summary</span>
        <input
          className={`jamat-launcher-flows__line${
            problem !== null ? ' jamat-launcher-flows__line--invalid' : ''}`}
          type="text"
          aria-label="Summary"
          aria-invalid={problem !== null}
          autoFocus
          value={state.summary}
          onChange={(event) => dispatch({ field: 'summary', value: event.target.value })}
        />
      </div>
      {problem !== null && (
        <div className="jamat-launcher-flows__row">
          <span className="jamat-launcher-flows__label" />
          <span className="jamat-launcher-flows__problem">{problem}</span>
        </div>
      )}
      <div className="jamat-launcher-flows__row">
        <span className="jamat-launcher-flows__label">Description</span>
        <textarea
          className="jamat-launcher-flows__area"
          aria-label="Description"
          rows={6}
          value={state.description}
          onChange={(event) => dispatch({ field: 'description', value: event.target.value })}
        />
      </div>
      <div className="jamat-launcher-flows__row">
        <span className="jamat-launcher-flows__label">Acceptance</span>
        <textarea
          className="jamat-launcher-flows__area"
          aria-label="Acceptance criteria"
          rows={4}
          value={state.acceptance}
          onChange={(event) => dispatch({ field: 'acceptance', value: event.target.value })}
        />
      </div>
    </>
  )
}
