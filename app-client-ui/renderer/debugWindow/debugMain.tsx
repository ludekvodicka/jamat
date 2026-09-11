import { createRoot } from 'react-dom/client'

import '../styles/tokens.css'
import '../styles/app.css'

import { UiSettingsStore } from '../uiSettings/uiSettingsStore'
import { WheelSpeed } from '../uiSettings/wheelSpeed'
import { DebugWindow } from './debugWindow'

const root = document.getElementById('root')
if (!root)
  throw new Error('Debug renderer root element is missing')

// Started here for the same reason as in the workspace document: the scale is a property of a
// window, and this one draws the same tokens. Awaited for that reason too - this window opens and
// closes far more often than the workspace one, so a jump on every open would be seen more, not
// less. The stop function is dropped with the document.
await UiSettingsStore.startSettled()
// This window is a stack of long lists, so the speed is a property of it too.
WheelSpeed.install()

// No StrictMode, for the same reason the workspace document has none: a dev-only double mount would
// run every reader twice against the same main process.
createRoot(root).render(<DebugWindow />)
