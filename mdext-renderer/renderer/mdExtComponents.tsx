import { createContext, useContext, useEffect, useState } from 'react'
import type { Components } from 'react-markdown'

import { MdExtBudget } from './mdExtBudget'
import type { MdExtInteraction } from './mdExt.types'
import { MdExtSecurity } from './mdExtSecurity'
import { MdExtCode } from './renderers/mdExtCode'
import { MdExtDiagram } from './renderers/mdExtDiagram'
import { MdExtDiagramEngine } from './renderers/mdExtDiagramEngine'

export class MdExtComponents {
  static readonly context = createContext<{ budget: MdExtBudget; interaction?: MdExtInteraction } | null>(null)
  private static readonly taskContext = createContext<{ line: number; label: string } | null>(null)

  static create(input: {
    resolveImage(reference: string): Promise<string | null>
    onLink(reference: string): void
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
      li: ({ node, children, ...props }) => {
        const interaction = useContext(MdExtComponents.context)?.interaction
        const line = node?.position?.start.line
        const first = node?.children.find((child) => child.type !== 'text' || child.value.trim() !== '')
        const candidate = first?.type === 'element' && first.tagName === 'p' ? first.children[0] : first
        const task = line !== undefined && candidate?.type === 'element'
          && candidate.tagName === 'input' && candidate.properties.type === 'checkbox'
        const attributes = MdExtComponents.linesOf(node, input.lineOffset)
        if (!interaction || !task) return <li {...props} {...attributes}>{children}</li>
        const absoluteLine = line + input.lineOffset
        const label = MdExtComponents.itemText(node!).trim()
        return <li {...props} {...attributes}>
          <MdExtComponents.taskContext.Provider value={{ line: absoluteLine, label }}>
            {children}
            {interaction.askAbout && <button type="button" className="mdext-task-ask"
              aria-label={`Ask about this item: ${label}`} title="Ask about this item"
              onClick={() => interaction.askAbout?.(absoluteLine)}>?</button>}
          </MdExtComponents.taskContext.Provider>
        </li>
      },
      input: ({ node: _node, ...props }) => {
        const interaction = useContext(MdExtComponents.context)?.interaction
        const task = useContext(MdExtComponents.taskContext)
        if (!interaction || !task) return <input {...props} />
        return <input {...props} disabled={!interaction.enabled} aria-label={task.label}
          checked={Boolean(props.checked)} onChange={() => {
            if (interaction.enabled) interaction.toggleTask(task.line, !props.checked)
          }} />
      },
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
        const context = useContext(MdExtComponents.context)
        if (!context) throw new Error('MdExt code requires its document context')
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
              allowed={context.budget.allowsDiagram(line)}
            />
          )
        return (
          <MdExtCode
            language={language ?? 'text'}
            source={normalized}
            highlight={context.budget.allowsHighlight(line)}
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

  private static itemText(node: { type: string; value?: unknown; tagName?: string; children?: readonly unknown[] }): string {
    if (node.type === 'text') return String(node.value ?? '')
    if (node.tagName === 'ul' || node.tagName === 'ol') return ''
    return (node.children ?? []).map((child) => MdExtComponents.itemText(child as typeof node)).join('')
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
