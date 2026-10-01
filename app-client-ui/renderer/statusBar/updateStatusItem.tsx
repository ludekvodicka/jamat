import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { AutoUpdateApi } from '../../shared/electron/autoUpdate/common/autoUpdateApi'
import { useAutoUpdate } from '../../shared/electron/autoUpdate/renderer/useAutoUpdate'
import { AutoUpdateIndicator } from '../../shared/electron/autoUpdateWidgets/autoUpdateIndicator'
import { AutoUpdatePanel } from '../../shared/electron/autoUpdateWidgets/autoUpdatePanel'

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
