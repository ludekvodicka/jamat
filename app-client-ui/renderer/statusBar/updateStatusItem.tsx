import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { AutoUpdateApi } from '../../shared/electron/autoUpdate/common/autoUpdateApi'
import { useAutoUpdate } from '../../shared/electron/autoUpdate/renderer/useAutoUpdate'
import { AutoUpdateIndicator } from '../../shared/electron/autoUpdateWidgets/autoUpdateIndicator'
import { AutoUpdatePanel } from '../../shared/electron/autoUpdateWidgets/autoUpdatePanel'

/**
 * The running version, and a manual update check on a click: the same check as the panel's Check
 * now, so a failure is shown on the update item beside it instead of only logged, as a background
 * check's is. Where the updater admits no check (off in a development run, busy checking or
 * downloading) the click does nothing and the tooltip says why.
 */
export function VersionStatusItem(props: { version: string; api: AutoUpdateApi }): React.JSX.Element {
  const update = useAutoUpdate(props.api)
  const checks = update.view?.actions.includes('check') === true
  return (
    <button
      type="button"
      className="jamat-version-status"
      aria-disabled={!checks}
      title={checks ? 'Check for updates' : update.view?.detail ?? update.view?.text ?? 'Reading update status'}
      onClick={() => { if (checks) update.check() }}
    >
      {`v${props.version}`}
    </button>
  )
}

/**
 * The shared updater's state on the bar, and its panel on a click. The panel is portalled to the
 * body: inside the bar it would inherit the strip's `nowrap` and its pinned 11px text.
 */
export function UpdateStatusItem(props: { api: AutoUpdateApi }): React.JSX.Element {
  const update = useAutoUpdate(props.api)
  const [open, setOpen] = useState(false)

  // Before the first status answers there is nothing true to say, and an empty slot would leave its
  // separator standing alone - the Host item beside it draws the same placeholder for that reason.
  if (update.view === null)
    return <span className="jamat-update-status">Updates …</span>
  return (
    <>
      <AutoUpdateIndicator className="jamat-update-status" update={update} onOpen={() => setOpen(true)} />
      {open && createPortal(
        <div className="jamat-update-panel">
          <AutoUpdatePanel update={update} open={open} onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  )
}
