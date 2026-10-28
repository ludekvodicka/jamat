import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import '../styles/app.css'
import './usageWindow.css'
import { UiSettingsStore } from '../uiSettings/uiSettingsStore'
import { WheelSpeed } from '../uiSettings/wheelSpeed'
import { UsageWindow } from './usageWindow'

const root = document.getElementById('root')
if (!root) throw new Error('Usage renderer root element is missing')
await UiSettingsStore.startSettled()
WheelSpeed.install()
createRoot(root).render(<UsageWindow />)
