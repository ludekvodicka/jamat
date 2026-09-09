import './welcomePanel.css'

/**
 * Takes no panel parameters. A parameter is part of the derived panel id, so putting the version in
 * one would open a second welcome panel on every version bump; the status bar carries the version.
 */
export function WelcomePanel(): React.JSX.Element {
  return (
    <section className="jamat-welcome" aria-label="Welcome">
      <h1 className="jamat-welcome__name">Jamat</h1>
      <p className="jamat-welcome__hint">
        Drag a tab to move it between groups. Drop it on the edge of a group to split the workspace
        to the right or downwards.
      </p>
    </section>
  )
}
