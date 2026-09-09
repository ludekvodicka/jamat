import { useEffect, useState } from 'react'
import type { Components } from 'react-markdown'

import { MdExtBudget } from './mdExtBudget'
import { MdExtSecurity } from './mdExtSecurity'
import { MdExtCode } from './renderers/mdExtCode'
import { MdExtDiagram } from './renderers/mdExtDiagram'
import { MdExtDiagramEngine } from './renderers/mdExtDiagramEngine'

export class MdExtComponents {
  static create(input: {
    resolveImage(reference: string): Promise<string | null>
    onLink(reference: string): void
    /** How much of THIS document is still allowed the expensive treatment. */
    budget: MdExtBudget
    lineOffset: number
  }): Components {
    return {
      p: ({ node, ...props }) => <p {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h1: ({ node, ...props }) => <h1 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h2: ({ node, ...props }) => <h2 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h3: ({ node, ...props }) => <h3 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h4: ({ node, ...props }) => <h4 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h5: ({ node, ...props }) => <h5 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      h6: ({ node, ...props }) => <h6 {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      ul: ({ node, ...props }) => <ul {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      ol: ({ node, ...props }) => <ol {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      li: ({ node, ...props }) => <li {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      blockquote: ({ node, ...props }) => (
        <blockquote {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />
      ),
      table: ({ node, ...props }) => (
        <table {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />
      ),
      tr: ({ node, ...props }) => <tr {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      hr: ({ node, ...props }) => <hr {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      div: ({ node, ...props }) => <div {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />,
      details: ({ node, ...props }) => (
        <details {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />
      ),
      summary: ({ node, ...props }) => (
        <summary {...props} {...MdExtComponents.linesOf(node, input.lineOffset)} />
      ),
      pre: ({ node, children }) => (
        <div className="mdext-source-block" {...MdExtComponents.linesOf(node, input.lineOffset)}>
          {children}
        </div>
      ),
      code: ({ node, className, children }) => {
        const source = String(children ?? '')
        const language = /language-([\w-]+)/.exec(className ?? '')?.[1]
        const start = node?.position?.start.line
        const end = node?.position?.end.line
        const block = (start !== undefined && end !== undefined && start !== end)
          || source.includes('\n')
        if (!block) return <code className="mdext-inline">{children}</code>
        const normalized = source.replace(/\n$/, '')
        // Where the fence begins, which is what the budget remembers it by. A fence with no position
        // is one this parser did not place; it gets the same answer as line 0 rather than a new slot
        // on every render.
        const line = start ?? 0
        if (language && MdExtDiagramEngine.supports(language))
          return (
            <MdExtDiagram
              language={language}
              source={normalized}
              allowed={input.budget.allowsDiagram(line)}
            />
          )
        return (
          <MdExtCode
            language={language ?? 'text'}
            source={normalized}
            highlight={input.budget.allowsHighlight(line)}
          />
        )
      },
      a: ({ href, children }) => {
        const safe = MdExtSecurity.href(href)
        if (safe === null) return <span className="mdext-blocked-link">{children}</span>
        return (
          <a
            href={safe}
            title={safe}
            onClick={(event) => {
              event.preventDefault()
              input.onLink(safe)
            }}
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt }) => (
        <MdExtImage reference={src} alt={alt ?? ''} resolve={input.resolveImage} />
      ),
    }
  }

  private static linesOf(
    node: { position?: { start: { line: number }; end: { line: number } } } | undefined,
    offset: number,
  ): { 'data-file-line-start'?: number; 'data-file-line-end'?: number } {
    const start = node?.position?.start.line
    const end = node?.position?.end.line
    return start === undefined || end === undefined
      ? {}
      : { 'data-file-line-start': start + offset, 'data-file-line-end': end + offset }
  }
}

function MdExtImage(props: {
  reference: string | undefined
  alt: string
  resolve(reference: string): Promise<string | null>
}): React.JSX.Element {
  const reference = MdExtSecurity.relativeImage(props.reference)
  const [source, setSource] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSource(null)
    if (reference !== null)
      void props.resolve(reference).then((value) => { if (alive) setSource(value) })
    return () => { alive = false }
  }, [props.resolve, reference])

  return source === null
    ? <span className="mdext-blocked-img">{props.alt || '[image unavailable]'}</span>
    : <img src={source} alt={props.alt} loading="lazy" />
}
