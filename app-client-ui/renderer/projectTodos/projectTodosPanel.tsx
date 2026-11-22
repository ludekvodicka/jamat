import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

import { ProjectTodos, type ProjectTodoColor, type ProjectTodoItem } from '../../shared/projectTodos'
import { ProjectTodosController, type ProjectTodosText } from './projectTodosController'
import { ProjectTodosFilter, type ProjectTodosCategoryFilter, type ProjectTodosFilterState } from './projectTodosFilter'
import type { ProjectTodosPorts } from './projectTodosPorts'

import './projectTodosPanel.css'

/**
 * The todo list of the session's catalog project. `pane` is the split's full view with category
 * chips; `sidebar` is the narrow File Tools tab with a category list instead. Callers key it by
 * session, so another session is another controller.
 */
export function ProjectTodosPanel(props: {
  sessionId: string
  ports: ProjectTodosPorts
  variant: 'pane' | 'sidebar'
  onOpenInSplit?(): void
  /** The new task's title: what the split focuses when the list opens in front. */
  ref?: React.Ref<HTMLInputElement>
}): React.JSX.Element {
  const [controller] = useState(() => new ProjectTodosController(props.sessionId, props.ports))
  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])
  const view = useSyncExternalStore(controller.subscribe, controller.view, controller.view)
  const [filterState, setFilter] = useState<ProjectTodosFilterState>(ProjectTodosFilter.initial)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newComment, setNewComment] = useState('')
  /** Null follows the colour filter in front, as the category field follows the category chip. */
  const [newColor, setNewColor] = useState<ProjectTodoColor | '' | null>(null)
  const newCommentField = useRef<HTMLTextAreaElement>(null)
  useAutoHeight(newCommentField, newComment)
  const [adding, setAdding] = useState(false)
  const listId = useId()
  const list = useRef<HTMLUListElement>(null)
  /** A task closed from the keyboard hands the caret to its row, so the next Escape closes the list. */
  const refocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = refocus.current
    if (id === null) return
    refocus.current = null
    list.current?.querySelector<HTMLElement>(`[data-todo-id="${id}"] .project-todos__title`)?.focus()
  })
  const pane = props.variant === 'pane'
  // A click on an empty part of the split pane gives it the caret, so the shell's Escape sees the pane.
  const rootTab = pane ? -1 : undefined

  const filter = ProjectTodosFilter.settled(filterState, view.items)
  const shown = ProjectTodosFilter.visible(view.items, filter)
  const categories = ProjectTodos.categoriesOf(view.items)
  const authors = ProjectTodos.authorsOf(view.items)
  const colors = ProjectTodos.colorsOf(view.items)
  const uncolored = ProjectTodosFilter.uncoloredOf(view.items)
  const uncategorized = ProjectTodosFilter.uncategorizedOf(view.items)
  const openCount = view.items.filter((item) => !item.done).length

  if (view.phase === 'loading')
    return <div className={`project-todos project-todos--${props.variant}`} tabIndex={rootTab}><p className="project-todos__status">Loading the todo list…</p></div>
  else if (view.phase === 'unavailable')
    return <div className={`project-todos project-todos--${props.variant}`} tabIndex={rootTab}><p className="project-todos__status">{view.error}</p></div>
  else if (view.phase === 'failed' && view.file === null)
    return (
      <div className={`project-todos project-todos--${props.variant}`} tabIndex={rootTab}>
        <p className="project-todos__error">{view.error} <button type="button" onClick={() => controller.retry()}>Retry</button></p>
      </div>
    )
  else if (view.phase !== 'ready' && view.phase !== 'failed')
    throw new Error(`Unknown todo list phase: ${JSON.stringify(view.phase)}`)

  const submitNew = (): void => {
    if (newTitle.trim() === '') return
    controller.add(newTitle, newCategory.trim() !== '' ? newCategory : ProjectTodosFilter.categoryForNew(filter), newComment,
      newColor ?? ProjectTodosFilter.colorForNew(filter))
    setNewTitle('')
    setNewComment('')
  }
  // Two text fields and no submit button: a browser submits such a form on no Enter, so each field
  // answers Enter itself. The comment takes Enter as a new line and adds on Ctrl+Enter.
  const enterAdds = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (event.currentTarget instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    submitNew()
  }
  // The comment field stays while focus is in the form or a comment is typed, so a click elsewhere
  // never hides typed text.
  const showsComment = adding || newComment !== ''

  return (
    <div className={`project-todos project-todos--${props.variant}`} tabIndex={rootTab}>
      <div className="project-todos__toolbar">
        <input
          type="search"
          className="project-todos__search"
          aria-label="Search tasks"
          placeholder={pane ? 'Search title, comment, #category, @author' : 'Search… #category @author'}
          value={filter.query}
          spellCheck={false}
          data-own-escape={filter.query !== '' || undefined}
          onChange={(event) => setFilter({ ...filter, query: event.target.value })}
        />
        {!pane && (
          <select
            className="project-todos__category-select"
            aria-label="Category"
            value={ProjectTodosPanelText.filterValueOf(filter.category)}
            onChange={(event) => setFilter({ ...filter, category: ProjectTodosPanelText.filterOf(event.target.value) })}
          >
            <option value="all">All</option>
            {categories.map((category) => <option key={category.name} value={`named:${category.name}`}>{category.name}</option>)}
            {uncategorized > 0 && <option value="none">No category</option>}
          </select>
        )}
        {authors.length > 1 && (
          <select
            className="project-todos__author-select"
            aria-label="Author"
            value={filter.author ?? ''}
            onChange={(event) => setFilter({ ...filter, author: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">{pane ? 'All authors' : 'All'}</option>
            {authors.map((author) => <option key={author.name} value={author.name}>{author.name === view.user ? `${author.name} (me)` : author.name}</option>)}
          </select>
        )}
        {(colors.length > 0 || filter.color !== null) && (
          <ProjectTodosColorPicker
            label="Colour filter"
            value={filter.color === null ? 'all' : filter.color === '' ? 'none' : filter.color}
            options={[
              { value: 'all', label: 'All colours', swatch: 'all' },
              ...colors.map((color) => ({ value: color.name, label: ProjectTodosPanelText.colorLabelOf(color.name), swatch: color.name as ProjectTodoColor, count: color.count })),
              ...(uncolored > 0 ? [{ value: 'none', label: 'No colour', swatch: 'none' as const, count: uncolored }] : []),
            ]}
            onChange={(value) => setFilter({ ...filter, color: value === 'all' ? null : value === 'none' ? '' : value })}
          />
        )}
        <button
          type="button"
          aria-pressed={!filter.showDone}
          title={filter.showDone ? 'Hide done tasks' : 'Show done tasks'}
          onClick={() => setFilter({ ...filter, showDone: !filter.showDone })}
        >
          Hide done
        </button>
        {props.onOpenInSplit !== undefined && (
          <button type="button" className="project-todos__icon-button" title="Open in the split" aria-label="Open in the split" onClick={props.onOpenInSplit}>
            <ProjectTodosIcon kind="split" />
          </button>
        )}
      </div>
      {pane && (categories.length > 0 || uncategorized > 0) && (
        <div className="project-todos__chips" role="group" aria-label="Categories">
          <ProjectTodosChip label="All" count={view.items.length} pressed={filter.category.kind === 'all'}
            onClick={() => setFilter({ ...filter, category: { kind: 'all' } })} />
          {categories.map((category) => (
            <ProjectTodosChip key={category.name} label={category.name} count={category.count}
              tone={ProjectTodosFilter.toneOf(category.name)}
              pressed={filter.category.kind === 'named' && ProjectTodos.folded(filter.category.name) === ProjectTodos.folded(category.name)}
              onClick={() => setFilter({ ...filter, category: { kind: 'named', name: category.name } })} />
          ))}
          {uncategorized > 0 && (
            <ProjectTodosChip label="No category" count={uncategorized} pressed={filter.category.kind === 'none'}
              onClick={() => setFilter({ ...filter, category: { kind: 'none' } })} />
          )}
        </div>
      )}
      <form
        className="project-todos__add"
        onSubmit={(event) => event.preventDefault()}
        onFocus={() => setAdding(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setAdding(false) }}
        data-own-escape={newTitle !== '' || newComment !== '' || undefined}
      >
        <div className="project-todos__add-row">
          <input
            ref={props.ref}
            className="project-todos__add-title"
            aria-label="New task"
            placeholder="+ New task (Enter)"
            value={newTitle}
            maxLength={ProjectTodos.titleMaxConst}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={enterAdds}
          />
          {pane && (
            <input
              className="project-todos__add-category"
              aria-label="Category of the new task"
              placeholder={ProjectTodosFilter.categoryForNew(filter) || 'category'}
              list={listId}
              value={newCategory}
              maxLength={ProjectTodos.categoryMaxConst}
              onChange={(event) => setNewCategory(event.target.value)}
              onKeyDown={enterAdds}
            />
          )}
          <ProjectTodosColorPicker
            label="Colour of the new task"
            value={ProjectTodosPanelText.pickerValueOf(newColor ?? ProjectTodosFilter.colorForNew(filter))}
            options={ProjectTodosPanelText.paletteOptions()}
            onChange={(value) => setNewColor(ProjectTodosPanelText.colorOfPicker(value))}
          />
        </div>
        {showsComment && (
          <textarea
            ref={newCommentField}
            className="project-todos__add-comment"
            aria-label="Comment of the new task"
            placeholder="Comment (Ctrl+Enter adds the task)"
            value={newComment}
            maxLength={ProjectTodos.commentMaxConst}
            rows={pane ? 3 : 2}
            spellCheck={false}
            onChange={(event) => setNewComment(event.target.value)}
            onKeyDown={enterAdds}
          />
        )}
      </form>
      {view.error !== null && (
        <p className="project-todos__error" role="alert">{view.error} <button type="button" onClick={() => controller.retry()}>Retry</button></p>
      )}
      {view.items.length === 0
        ? <p className="project-todos__status">No tasks yet.</p>
        : shown.length === 0
          ? <p className="project-todos__status">No task matches the filter.</p>
          : (
            <ul ref={list} className="project-todos__list">
              {shown.map((item) => item.id === expanded
                ? <ProjectTodosEditor key={item.id} item={item} variant={props.variant} listId={listId}
                    onToggle={() => controller.toggle(item.id)}
                    onEdit={(text) => controller.edit(item.id, text)}
                    onFlush={() => controller.flush()}
                    onRemove={() => { setExpanded(null); controller.remove(item.id) }}
                    onClose={() => { controller.flush(); refocus.current = item.id; setExpanded(null) }}
                    onLeave={() => { controller.flush(); setExpanded(null) }} />
                : <ProjectTodosRow key={item.id} item={item} variant={props.variant} showAuthor={authors.length > 1}
                    onToggle={() => controller.toggle(item.id)}
                    onOpen={() => { controller.flush(); setExpanded(item.id) }} />)}
            </ul>
          )}
      <div className="project-todos__footer" role="status">
        {view.removed !== null
          ? <>Removed “{view.removed.item.title}”. <button type="button" onClick={() => controller.undo()}>Undo</button></>
          : <span title={view.file ?? ''}>{openCount} open · {view.items.length - openCount} done{view.saving ? ' · saving…' : ''}</span>}
      </div>
      <datalist id={listId}>
        {categories.map((category) => <option key={category.name} value={category.name} />)}
      </datalist>
    </div>
  )
}

function ProjectTodosRow(props: {
  item: ProjectTodoItem
  variant: 'pane' | 'sidebar'
  /** Only when more than one person wrote into the list; a list of one author would repeat one name. */
  showAuthor: boolean
  onToggle(): void
  onOpen(): void
}): React.JSX.Element {
  const item = props.item
  return (
    <li className={item.done ? 'project-todos__row project-todos__row--done' : 'project-todos__row'} data-todo-id={item.id}>
      <input type="checkbox" aria-label={`Done: ${item.title}`} checked={item.done} onChange={props.onToggle} />
      {item.color !== undefined && (
        <span
          className={`project-todos__swatch project-todos__task-color project-todos__tone--${item.color}`}
          role="img"
          aria-label={`Colour: ${ProjectTodosPanelText.colorLabelOf(item.color)}`}
          title={ProjectTodosPanelText.colorLabelOf(item.color)}
        />
      )}
      <button type="button" className="project-todos__title" title={ProjectTodosPanelText.tooltipOf(item)} onClick={props.onOpen}>
        {item.title === '' ? <em>Untitled</em> : item.title}
      </button>
      {props.variant === 'pane' && item.comment !== undefined && <ProjectTodosIcon kind="comment" />}
      {props.variant === 'pane' && props.showAuthor && item.author !== undefined && <span className="project-todos__author">{item.author}</span>}
      {item.category !== undefined && (props.variant === 'pane'
        ? <span className={`project-todos__chip-label project-todos__tone--${ProjectTodosFilter.toneOf(item.category)}`}>{item.category}</span>
        : <span className={`project-todos__dot project-todos__tone--${ProjectTodosFilter.toneOf(item.category)}`} title={item.category} aria-label={item.category} />)}
    </li>
  )
}

/**
 * The open task edits a draft of its own, so the text typed is what the fields show even while the
 * stored copy trims a category; every keystroke still goes into the change queue.
 */
function ProjectTodosEditor(props: {
  item: ProjectTodoItem
  variant: 'pane' | 'sidebar'
  listId: string
  onToggle(): void
  onEdit(text: ProjectTodosText): void
  onFlush(): void
  onRemove(): void
  /** Escape, Enter in the title or Close: the caret goes to the task's row. */
  onClose(): void
  /** Focus went elsewhere: the task closes and the caret stays where it went. */
  onLeave(): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProjectTodosText>(() =>
    ({ title: props.item.title, category: props.item.category ?? '', comment: props.item.comment ?? '', color: props.item.color ?? '' }))
  const title = useRef<HTMLInputElement>(null)
  const row = useRef<HTMLLIElement>(null)
  const comment = useRef<HTMLTextAreaElement>(null)
  useAutoHeight(comment, draft.comment)
  useLayoutEffect(() => {
    title.current?.focus()
    // After the comment took its height, so a task opened near the bottom shows all of it.
    row.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  const change = (patch: Partial<ProjectTodosText>): void => {
    const next = { ...draft, ...patch }
    setDraft(next)
    props.onEdit(next)
  }
  const keys = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose() }
  }
  // Focus that leaves the task closes it; a window that loses focus keeps it open for the return.
  const left = (event: React.FocusEvent<HTMLLIElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget) && document.hasFocus()) props.onLeave()
  }

  return (
    <li ref={row} className="project-todos__row project-todos__row--open" data-own-escape="true" onKeyDown={keys} onBlur={left}>
      <div className="project-todos__editor-head">
        <input type="checkbox" aria-label={`Done: ${draft.title}`} checked={props.item.done} onChange={props.onToggle} />
        <input
          ref={title}
          className="project-todos__edit-title"
          aria-label="Title"
          value={draft.title}
          maxLength={ProjectTodos.titleMaxConst}
          onChange={(event) => change({ title: event.target.value })}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); props.onClose() } }}
          onBlur={props.onFlush}
        />
      </div>
      <div className="project-todos__editor-fields">
        <input
          className="project-todos__edit-category"
          aria-label="Category"
          placeholder="Category"
          list={props.listId}
          value={draft.category}
          maxLength={ProjectTodos.categoryMaxConst}
          onChange={(event) => change({ category: event.target.value })}
          onBlur={props.onFlush}
        />
        <ProjectTodosColorPicker
          label="Colour"
          value={ProjectTodosPanelText.pickerValueOf(draft.color)}
          options={ProjectTodosPanelText.paletteOptions()}
          onChange={(value) => { change({ color: ProjectTodosPanelText.colorOfPicker(value) }); props.onFlush() }}
        />
      </div>
      <textarea
        ref={comment}
        className="project-todos__edit-comment"
        aria-label="Comment"
        placeholder="Comment"
        value={draft.comment}
        maxLength={ProjectTodos.commentMaxConst}
        rows={props.variant === 'pane' ? 6 : 4}
        spellCheck={false}
        onChange={(event) => change({ comment: event.target.value })}
        onBlur={props.onFlush}
      />
      <div className="project-todos__editor-actions">
        <button type="button" className="project-todos__remove" onClick={props.onRemove}>Delete</button>
        <button type="button" onClick={props.onClose}>Close</button>
      </div>
    </li>
  )
}

function ProjectTodosChip(props: {
  label: string
  count: number
  pressed: boolean
  tone?: string
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={props.tone === undefined ? 'project-todos__chip' : `project-todos__chip project-todos__tone--${props.tone}`}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.label} <span className="project-todos__count">{props.count}</span>
    </button>
  )
}

/**
 * A comment field as tall as its text, from its `rows` up to the CSS `max-height` (a share of the
 * window); only a longer text scrolls. It is measured again on every change of the text.
 */
function useAutoHeight(field: React.RefObject<HTMLTextAreaElement | null>, text: string): void {
  useLayoutEffect(() => {
    const element = field.current
    // A hidden field measures 0 and would keep that height once it shows.
    if (element === null || element.getClientRects().length === 0) return
    element.style.height = 'auto'
    const border = element.offsetHeight - element.clientHeight
    element.style.height = `${element.scrollHeight + border}px`
  }, [field, text])
}

interface ProjectTodosColorOption {
  value: string
  label: string
  swatch: ProjectTodoColor | 'none' | 'all'
  count?: number
}

/**
 * A combo whose rows are colour swatches; a native select cannot draw a swatch in its rows. The list
 * closes on a choice, on Escape and when focus leaves it.
 */
function ProjectTodosColorPicker(props: {
  label: string
  value: string
  options: readonly ProjectTodosColorOption[]
  onChange(value: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0]
  const close = (): void => { setOpen(false); button.current?.focus() }
  return (
    <div
      className="project-todos__picker"
      data-own-escape={open || undefined}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() } }}
    >
      <button
        ref={button}
        type="button"
        className="project-todos__picker-button"
        aria-label={`${props.label}: ${selected.label}`}
        title={`${props.label}: ${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ProjectTodosSwatch swatch={selected.swatch} />
        <svg className="project-todos__caret" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      {open && (
        <div className="project-todos__picker-menu" role="listbox" aria-label={props.label}>
          {props.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === props.value}
              className="project-todos__picker-option"
              onClick={() => { props.onChange(option.value); close() }}
            >
              <ProjectTodosSwatch swatch={option.swatch} />
              <span className="project-todos__picker-label">{option.label}</span>
              {option.count !== undefined && <span className="project-todos__count">{option.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectTodosSwatch(props: { swatch: ProjectTodoColor | 'none' | 'all' }): React.JSX.Element {
  const swatch = props.swatch
  let modifier: string
  if (swatch === 'all') modifier = 'project-todos__swatch--all'
  else if (swatch === 'none') modifier = 'project-todos__swatch--none'
  else if (ProjectTodos.isColor(swatch)) modifier = `project-todos__tone--${swatch}`
  else throw new Error(`Unknown todo swatch: ${JSON.stringify(swatch satisfies never)}`)
  return <span className={`project-todos__swatch ${modifier}`} aria-hidden="true" />
}

class ProjectTodosPanelText {
  static colorLabelOf(color: string): string {
    return color.charAt(0).toUpperCase() + color.slice(1)
  }

  /** The palette as a task's combo offers it: no colour first. */
  static paletteOptions(): readonly ProjectTodosColorOption[] {
    return [{ value: 'none', label: 'No colour', swatch: 'none' },
      ...ProjectTodos.colorsConst.map((color) => ({ value: color, label: ProjectTodosPanelText.colorLabelOf(color), swatch: color }))]
  }

  static pickerValueOf(color: ProjectTodoColor | ''): string {
    return color === '' ? 'none' : color
  }

  static colorOfPicker(value: string): ProjectTodoColor | '' {
    if (value === 'none') return ''
    else if (ProjectTodos.isColor(value)) return value
    else throw new Error(`Unknown todo colour option: ${JSON.stringify(value)}`)
  }

  static tooltipOf(item: ProjectTodoItem): string {
    return [item.title, item.comment, item.author === undefined ? undefined : `Added by ${item.author}`]
      .filter((line) => line !== undefined && line !== '').join('\n')
  }

  static filterValueOf(category: ProjectTodosCategoryFilter): string {
    if (category.kind === 'all') return 'all'
    else if (category.kind === 'none') return 'none'
    else if (category.kind === 'named') return `named:${category.name}`
    else throw new Error(`Unknown category filter: ${JSON.stringify(category satisfies never)}`)
  }

  static filterOf(value: string): ProjectTodosCategoryFilter {
    if (value === 'all') return { kind: 'all' }
    else if (value === 'none') return { kind: 'none' }
    else if (value.startsWith('named:')) return { kind: 'named', name: value.slice('named:'.length) }
    else throw new Error(`Unknown category option: ${JSON.stringify(value)}`)
  }
}

/** Text glyphs draw as colour emoji on Windows, so each icon is a path in the text colour. */
function ProjectTodosIcon(props: { kind: 'comment' | 'split' }): React.JSX.Element {
  if (props.kind === 'comment')
    return (
      <svg className="project-todos__icon project-todos__comment" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" role="img" aria-label="Has a comment">
        <path d="M3 4.5h10M3 8h10M3 11.5h6" />
      </svg>
    )
  else if (props.kind === 'split')
    return (
      <svg className="project-todos__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M2.5 2.5h11v11h-11zM8 2.5v11M10 6.5l1.5 1.5-1.5 1.5" />
      </svg>
    )
  else throw new Error(`Unknown todo icon: ${String(props.kind)}`)
}
