import { Fragment, memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'

import { MdExtBudget } from './mdExtBudget'
import { MdExtComponents } from './mdExtComponents'
import { MdExtDirectives } from './mdExtDirectives'
import { MdExtFrontmatter } from './mdExtFrontmatter'
import { MdExtSecurity } from './mdExtSecurity'
import type { MdExtRendererProps } from './mdExt.types'
import './mdExtRenderer.css'

/**
 * Memoised, because react-markdown re-parses the whole source in its own body on every render - up
 * to the 2 MiB the reader will hand over - and the components object below decides whether the
 * drawn tree survives a parent's render at all.
 */
export const MdExtRenderer = memo(function MdExtRenderer(
  props: MdExtRendererProps,
): React.JSX.Element {
  const split = useMemo(() => MdExtFrontmatter.split(props.source), [props.source])
  // One budget per document, so what it decided about a fence survives every re-render of it and
  // only a different document starts counting again.
  const budget = useMemo(() => new MdExtBudget(), [split.body])
  const components = useMemo(() => MdExtComponents.create({
    resolveImage: props.resolveImage,
    onLink: props.onLink,
    budget,
    lineOffset: split.bodyLineOffset,
  }), [budget, props.onLink, props.resolveImage, split.bodyLineOffset])
  const className = ['mdext', props.className].filter(Boolean).join(' ')
  return (
    <div className={className}>
      {split.frontmatter !== null && (
        <MdExtFrontmatterView entries={split.frontmatter} endLine={split.bodyLineOffset} />
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkDirective, MdExtDirectives.plugin]}
        rehypePlugins={[[rehypeSanitize, MdExtSecurity.sanitizeSchema]]}
        components={components}
      >
        {split.body}
      </ReactMarkdown>
    </div>
  )
})

function MdExtFrontmatterView(props: {
  entries: readonly (readonly [string, string])[]
  endLine: number
}): React.JSX.Element {
  return (
    <details
      className="mdext-frontmatter"
      data-file-line-start={1}
      data-file-line-end={props.endLine}
    >
      <summary>metadata ({props.entries.length})</summary>
      <dl>
        {props.entries.map(([key, value]) => (
          <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>
        ))}
      </dl>
    </details>
  )
}
