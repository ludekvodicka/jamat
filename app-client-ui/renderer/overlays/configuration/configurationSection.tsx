/**
 * One titled block inside a settings screen, and the rule above it that separates it from the one
 * before.
 *
 * Every screen in this window is a column of controls, and a column with nothing between its parts
 * reads as one long list of unrelated fields - which is what these screens looked like until
 * 2026-09-07. The separator is drawn by the section that FOLLOWS another rather than by anything
 * between them, so a screen is a list of sections and never a list of sections and dividers.
 *
 * `className` is the tab's own class on the SAME element rather than on a wrapper inside it,
 * because a tab styles its own controls through descendant selectors off that class and a wrapper
 * would be one more node between the two. The layout - a column, one gap - belongs here, so a tab
 * class carries only what is its own.
 *
 * It draws no state and owns nothing. A section that knew whether its screen was saving would be a
 * second owner of that screen's model.
 */
export function ConfigurationSection(props: {
  title: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className={props.className === undefined
        ? 'jamat-configuration__section'
        : `jamat-configuration__section ${props.className}`}
    >
      <h3 className="jamat-configuration__section-title">{props.title}</h3>
      {props.children}
    </section>
  )
}
