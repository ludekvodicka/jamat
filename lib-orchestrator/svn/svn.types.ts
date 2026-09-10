export type SvnErrorCode =
  | 'svn-missing'
  | 'not-a-working-copy'
  | 'out-of-date'
  | 'locked'
  | 'external-target'
  | 'svn-failed'

export type SvnResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SvnErrorCode; detail: string }
