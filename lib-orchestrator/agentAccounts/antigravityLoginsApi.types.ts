import type { RateWindow } from '../rateMonitor/rateMonitorApi.types'

export interface AntigravitySlotQuota {
  capturedAt: number
  session: RateWindow | null
  weekly: RateWindow | null
}

export interface AntigravitySavedLogin {
  id: string
  label: string
  email: string | null
  planTier: string | null
  savedAt: number
  active: boolean
  quota: AntigravitySlotQuota | null
}

export interface AntigravitySwitchResult {
  reopened: number
  failed: readonly string[]
}

export interface AntigravityLoginsView {
  available: boolean
  unavailableReason: string | null
  currentPresent: boolean
  activeSlotId: string | null
  currentEmail: string | null
  currentPlanTier: string | null
  runningSessionCount: number
  reopenableSessionCount: number
  loginInProgress: boolean
  capturedAt: number
  logins: readonly AntigravitySavedLogin[]
}
