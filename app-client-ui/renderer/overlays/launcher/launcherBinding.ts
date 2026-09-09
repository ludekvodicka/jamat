/**
 * Where a session will run, as the project screen decided it and the spec still needs it.
 *
 * There is no directory-less arm. The wire still carries one - a session created over the control
 * API may name no directory at all - but nothing this launcher draws chooses it: the row that used
 * to, `Home (no project)`, now names the active category's root and binds it as an ad-hoc path.
 */
export type LauncherBinding =
  | { mode: 'project'; categoryId: string; projectName: string; projectPath: string }
  | { mode: 'adHoc'; path: string }
