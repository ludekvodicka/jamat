/* archify engine — vendored, deterministic spec→SVG renderers (github.com/tt-a1i/archify, MIT).
 * The LLM authors an `archify` fence holding the archify JSON; `diagram_type` selects the renderer.
 * Output is a static `<svg>` string the widget sanitizes (sanitizeSvg) and injects inline; theming is
 * via CSS classes (archify.css) driven by the widget's light/dark. See ./LICENSE. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderArchitecture } from './architecture'
import { renderWorkflow } from './workflow'
import { renderSequence } from './sequence'
import { renderDataflow } from './dataflow'
import { renderLifecycle } from './lifecycle'

const RENDERERS: Record<string, (d: any) => string> = {
  architecture: renderArchitecture,
  workflow: renderWorkflow,
  sequence: renderSequence,
  dataflow: renderDataflow,
  lifecycle: renderLifecycle,
}

export function renderArchify(diagram: any): string {
  const type = diagram?.diagram_type
  const renderer = RENDERERS[type]
  if (!renderer) {
    throw new Error(`archify: unknown diagram_type ${JSON.stringify(type)} — expected one of ${Object.keys(RENDERERS).join(', ')}`)
  }
  return renderer(diagram)
}
