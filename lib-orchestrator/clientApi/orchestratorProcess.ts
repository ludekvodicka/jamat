import type { OrchestratorApi } from './orchestratorApi.types'

export const OrchestratorRequestMethodsConst = [
  'viewerPath', 'viewerImageDragPath', 'viewerOpenDetected', 'mediaMetadata', 'mediaOpen',
  'viewerOpenWorkspace', 'viewerMediaResource', 'detect', 'detectionPath', 'workingContext', 'conflictRoot',
  'sessionsSnapshot', 'pingHost', 'saveImage', 'remoteSessionView', 'remoteAuthorizeView', 'remotePasteImage',
  'remotePasteFile', 'autolauncherGet', 'autolauncherInspect', 'autolauncherEnable', 'autolauncherDisable',
  'checkTreeRemoval', 'executeDiff',
] as const satisfies readonly (keyof OrchestratorApi)[]
export const OrchestratorNoticeMethodsConst = [
  'viewerReleaseGrant', 'mediaCancel', 'viewerRelease', 'markOpened', 'setDebugVisible', 'setDebugSection',
  'personActive', 'openSnapin', 'tabsChanged', 'revokeCommitOwner', 'revokeOwner', 'setPresentation',
  'startBackground', 'runaway',
] as const satisfies readonly (keyof OrchestratorApi)[]
