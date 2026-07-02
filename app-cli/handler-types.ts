import type { Key } from 'readline'
import type { MenuState } from '../core/types.js'

export interface HandlerContext {
  suspendKeypress: () => void
  resumeKeypress: () => void
  doRender: () => void
}

export type HandlerResult = { needsRender: boolean }
export type KeyHandler = (s: MenuState, key: Key, str: string, ctx: HandlerContext) => HandlerResult
