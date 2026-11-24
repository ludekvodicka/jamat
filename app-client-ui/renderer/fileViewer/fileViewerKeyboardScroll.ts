import type React from 'react'

import { FileViewerScrollTop } from './fileViewerScrollRestore'

/**
 * Scrolls the viewer's active vertical scroller on PageUp, PageDown, Home and End.
 *
 * Focus lands on the outer `.file-viewer` section when a split pane opens, on a toolbar button
 * after toggling a control, or inside `.file-viewer-body` while Diff mode scrolls `.file-diff-scroll`.
 * Chromium only walks up from `document.activeElement` for keyboard scrolling, never down into a
 * child scroller, so these keys did nothing until we route them to `FileViewerScrollTop.scrollerOf`.
 */
export class FileViewerKeyboardScroll {
  /** Blink's own page-scroll step: at least 87.5 % of the viewport, leaving at most 40 px overlap. */
  private static readonly pageFractionConst = 0.875
  private static readonly maxOverlapPxConst = 40

  static handle(event: React.KeyboardEvent<HTMLElement>, body: HTMLElement | null): boolean {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.shiftKey || event.metaKey)
      return false
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target))
      return false
    if (FileViewerKeyboardScroll.isInteractiveTarget(event.target))
      return false
    const scroller = FileViewerScrollTop.scrollerOf(body)
    if (scroller === null || scroller.clientHeight <= 0 || scroller.scrollHeight <= scroller.clientHeight)
      return false
    const top = FileViewerKeyboardScroll.targetTop(event, scroller)
    if (top === null)
      return false
    event.preventDefault()
    scroller.scrollTop = top
    return true
  }

  private static targetTop(event: React.KeyboardEvent<HTMLElement>, scroller: HTMLElement): number | null {
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (event.key === 'Home')
      return 0
    else if (event.key === 'End')
      return maxTop
    else if (event.ctrlKey)
      return null
    else if (event.key === 'PageUp')
      return Math.max(0, scroller.scrollTop - FileViewerKeyboardScroll.pageStep(scroller.clientHeight))
    else if (event.key === 'PageDown')
      return Math.min(maxTop, scroller.scrollTop + FileViewerKeyboardScroll.pageStep(scroller.clientHeight))
    else
      return null
  }

  private static pageStep(clientHeight: number): number {
    return Math.max(
      1,
      Math.max(
        Math.round(clientHeight * FileViewerKeyboardScroll.pageFractionConst),
        clientHeight - FileViewerKeyboardScroll.maxOverlapPxConst,
      ),
    )
  }

  private static isInteractiveTarget(target: Element): boolean {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLMediaElement)
      return true
    if (target instanceof HTMLInputElement)
      return target.type !== 'checkbox' && target.type !== 'radio'
    if (target instanceof HTMLElement && target.isContentEditable)
      return true
    return target.closest('[contenteditable=""], [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"], [role="combobox"], [role="slider"]') !== null
  }
}
