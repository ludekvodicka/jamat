import { useState } from 'react'

import type { AutolauncherSnapshot, AutolauncherTargetView, AutolauncherSelection } from '../../../../../shared/autolauncher'

export function AutolauncherTargetDetails({ view }: { view: AutolauncherTargetView }): React.JSX.Element {
  return <dl className="jamat-configuration-autolauncher__details">
    <dt>Kind</dt><dd>{view.recipe?.kind ?? 'Invalid recipe'}</dd>
    {view.process && <>
      <dt>Command</dt><dd>{view.process.command}</dd>
      <dt>Arguments</dt><dd>{JSON.stringify(view.process.args)}</dd>
      <dt>Working directory</dt><dd>{view.process.cwd}</dd>
    </>}
    <dt>Availability</dt><dd>{availabilityText(view)}</dd>
  </dl>
}

function availabilityText(view: AutolauncherTargetView): string {
  switch (view.availability.state) {
    case 'available': return 'Available'
    case 'missing': return `Missing: ${view.availability.path}`
    case 'invalid': return `Invalid: ${view.availability.path}`
    case 'unverifiable': return `Cannot verify: ${view.availability.path}`
    default: throw new Error('Unknown target availability')
  }
}

export function AutolauncherTargetEditor({ snapshot, recipe, disabled, onChange }: {
  snapshot: AutolauncherSnapshot
  recipe: AutolauncherSelection['recipe']
  disabled: boolean
  onChange: (recipe: AutolauncherSelection['recipe'] | null) => void
}): React.JSX.Element {
  const [mode, setMode] = useState(() => {
    switch (recipe.kind) {
      case 'development': return 'development'
      case 'source': return 'source'
      case 'command': case 'detached-command': return 'custom'
      case 'executable': return JSON.stringify(recipe) === JSON.stringify(snapshot.currentTarget.recipe) ? 'current' : 'installed'
      default: throw new Error('Unknown launch recipe')
    }
  })
  const [root, setRoot] = useState(recipe.kind === 'source' || recipe.kind === 'development'
    ? recipe.repositoryRoot : snapshot.target.mode === 'source' ? snapshot.target.path : '')
  const [command, setCommand] = useState(recipe.kind === 'command' || recipe.kind === 'detached-command' ? recipe.command : '')
  const [cwd, setCwd] = useState(recipe.kind === 'command' || recipe.kind === 'detached-command' ? recipe.cwd : '')
  const [args, setArgs] = useState(JSON.stringify(recipe.kind === 'command' || recipe.kind === 'detached-command' ? recipe.args : []))
  const [longRunning, setLongRunning] = useState(recipe.kind === 'detached-command')
  const [verbatim, setVerbatim] = useState((recipe.kind === 'command' || recipe.kind === 'detached-command') && recipe.windowsVerbatimArguments)

  function change(values: { mode?: string; root?: string; command?: string; cwd?: string; args?: string; longRunning?: boolean; verbatim?: boolean }): void {
    const selected = values.mode ?? mode
    if (selected === 'current') onChange(snapshot.currentTarget.recipe)
    else if (selected === 'installed') onChange(snapshot.installedTarget?.recipe ?? null)
    else if (selected === 'source' || selected === 'development')
      onChange({ kind: selected, repositoryRoot: values.root ?? root })
    else if (selected === 'custom') {
      let parsed: unknown
      try { parsed = JSON.parse(values.args ?? args) } catch { onChange(null); return }
      if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) { onChange(null); return }
      onChange({ kind: (values.longRunning ?? longRunning) ? 'detached-command' : 'command',
        command: values.command ?? command, cwd: values.cwd ?? cwd, args: parsed,
        windowsVerbatimArguments: values.verbatim ?? verbatim })
    } else throw new Error('Unknown target choice')
  }

  return <fieldset disabled={disabled} className="jamat-configuration-autolauncher__editor">
    <label>Start target<select value={mode} onChange={event => { setMode(event.target.value); change({ mode: event.target.value }) }}>
      <option value="current">Running application</option>
      {snapshot.installedTarget?.recipe?.kind === 'executable' && <option value="installed">Recorded executable</option>}
      <option value="development">Development checkout</option>
      <option value="source">Packaged build from checkout</option>
      <option value="custom">Custom command</option>
    </select></label>
    {(mode === 'source' || mode === 'development') && <label>Checkout directory<input value={root}
      onChange={event => { setRoot(event.target.value); change({ root: event.target.value }) }} /></label>}
    {mode === 'custom' && <>
      <label>Executable<input value={command} onChange={event => { setCommand(event.target.value); change({ command: event.target.value }) }} /></label>
      <label>Arguments (JSON array)<textarea value={args} onChange={event => { setArgs(event.target.value); change({ args: event.target.value }) }} /></label>
      <label>Working directory<input value={cwd} onChange={event => { setCwd(event.target.value); change({ cwd: event.target.value }) }} /></label>
      <label><input type="checkbox" checked={longRunning} onChange={event => { setLongRunning(event.target.checked); change({ longRunning: event.target.checked }) }} />Long-running process</label>
      <label><input type="checkbox" checked={verbatim} onChange={event => { setVerbatim(event.target.checked); change({ verbatim: event.target.checked }) }} />Windows verbatim arguments (advanced)</label>
    </>}
  </fieldset>
}
