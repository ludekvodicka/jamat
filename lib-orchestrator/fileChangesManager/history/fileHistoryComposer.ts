import { applyPatch, parsePatch, reversePatch } from 'diff'

import { PathCompare } from '../../shared/pathCompare'
import type { FileHistoryCompleteness } from '../fileChangesManagerApi.types'
import type {
  FileChangesLogGroup,
  FileChangesLogMutation,
} from '../logs/fileChangesLogSource.types'

export type FileHistoryState =
  | {
    kind: 'available'
    path: string
    content: string | null
    completeness: Exclude<FileHistoryCompleteness, 'unavailable'>
    detail: string | null
  }
  | { kind: 'unavailable'; detail: string }

interface MutableFileState {
  path: string
  content: string | null
}

export class FileHistoryComposer {
  compose(input: {
    currentPath: string
    currentContent: string | null
    selectedGroupId: string
    groups: readonly FileChangesLogGroup[]
  }): FileHistoryState {
    const selectedIndex = input.groups.findIndex((group) => group.groupId === input.selectedGroupId)
    if (selectedIndex < 0)
      return { kind: 'unavailable', detail: 'The selected chat message is no longer available' }
    const state: MutableFileState = { path: input.currentPath, content: input.currentContent }
    const later = input.groups.slice(selectedIndex + 1)
    for (let groupIndex = later.length - 1; groupIndex >= 0; groupIndex -= 1) {
      const mutations = later[groupIndex].mutations
      for (let mutationIndex = mutations.length - 1; mutationIndex >= 0; mutationIndex -= 1) {
        const mutation = mutations[mutationIndex]
        if (!FileHistoryComposer.affects(state.path, mutation)) continue
        const failure = FileHistoryComposer.reverse(state, mutation)
        if (failure !== null)
          return { kind: 'unavailable', detail: failure }
      }
    }
    const selectedChain = FileHistoryComposer.chainFor(
      state.path,
      input.groups[selectedIndex].mutations,
    )
    if (selectedChain.length === 0)
      return { kind: 'unavailable', detail: 'The selected message did not change this file' }
    const anchorIndex = selectedChain.findIndex((mutation) =>
      mutation.kind === 'add' || mutation.kind === 'write' || mutation.kind === 'delete')
    if (anchorIndex >= 0) {
      const anchor = selectedChain[anchorIndex]
      const anchored: MutableFileState = {
        path: anchor.path,
        content: anchor.kind === 'delete' ? null : anchor.afterContent,
      }
      if (anchor.kind !== 'delete' && anchored.content === null)
        return { kind: 'unavailable', detail: 'The transcript has no complete anchor content' }
      for (const mutation of selectedChain.slice(anchorIndex + 1)) {
        const failure = FileHistoryComposer.forward(anchored, mutation)
        if (failure !== null) return { kind: 'unavailable', detail: failure }
      }
      return {
        kind: 'available',
        path: anchored.path,
        content: anchored.content,
        completeness: 'full',
        detail: null,
      }
    }
    const verification: MutableFileState = { ...state }
    for (let index = selectedChain.length - 1; index >= 0; index -= 1) {
      const failure = FileHistoryComposer.reverse(verification, selectedChain[index])
      if (failure !== null) return { kind: 'unavailable', detail: failure }
    }
    return {
      kind: 'available',
      path: state.path,
      content: state.content,
      completeness: 'region',
      detail: 'Only the regions recorded by the transcript are known at this point',
    }
  }

  private static chainFor(
    endPath: string,
    mutations: readonly FileChangesLogMutation[],
  ): FileChangesLogMutation[] {
    const reversed: FileChangesLogMutation[] = []
    let path = endPath
    for (let index = mutations.length - 1; index >= 0; index -= 1) {
      const mutation = mutations[index]
      if (!FileHistoryComposer.affects(path, mutation)) continue
      reversed.push(mutation)
      if (mutation.kind === 'move' && mutation.previousPath !== null) path = mutation.previousPath
    }
    return reversed.reverse()
  }

  private static affects(path: string, mutation: FileChangesLogMutation): boolean {
    return PathCompare.comparable(path) === PathCompare.comparable(mutation.path)
  }

  private static reverse(state: MutableFileState, mutation: FileChangesLogMutation): string | null {
    if (mutation.kind === 'add') {
      if (state.content !== mutation.afterContent)
        return `Cannot reverse add ${mutation.mutationId}: current content does not match its output`
      state.content = null
      return null
    }
    else if (mutation.kind === 'delete') {
      if (state.content !== null)
        return `Cannot reverse delete ${mutation.mutationId}: the file exists`
      if (mutation.beforeContent === null)
        return `Cannot reverse delete ${mutation.mutationId}: prior content is absent`
      state.content = mutation.beforeContent
      return null
    }
    else if (mutation.kind === 'write')
      return `Cannot reverse Write ${mutation.mutationId}: the transcript has no prior content`
    else if (mutation.kind === 'update' || mutation.kind === 'move') {
      if (state.content === null)
        return `Cannot reverse ${mutation.kind} ${mutation.mutationId}: the file is missing`
      const reversed = FileHistoryComposer.reverseUpdate(state.content, mutation)
      if (reversed === null)
        return `Cannot reverse ${mutation.kind} ${mutation.mutationId}: its expected output is not present`
      state.content = reversed
      if (mutation.kind === 'move') {
        if (mutation.previousPath === null)
          return `Cannot reverse move ${mutation.mutationId}: its prior path is absent`
        state.path = mutation.previousPath
      }
      return null
    }
    else
      throw new Error(`Unknown log mutation: ${JSON.stringify(mutation)}`)
  }

  private static forward(state: MutableFileState, mutation: FileChangesLogMutation): string | null {
    if (mutation.kind === 'add') {
      if (state.content !== null)
        return `Cannot replay add ${mutation.mutationId}: the file already exists`
      state.content = mutation.afterContent
      return state.content === null ? `Cannot replay add ${mutation.mutationId}: content is absent` : null
    }
    else if (mutation.kind === 'delete') {
      if (mutation.beforeContent !== null && state.content !== mutation.beforeContent)
        return `Cannot replay delete ${mutation.mutationId}: prior content does not match`
      state.content = null
      return null
    }
    else if (mutation.kind === 'write') {
      if (mutation.afterContent === null)
        return `Cannot replay Write ${mutation.mutationId}: content is absent`
      state.content = mutation.afterContent
      return null
    }
    else if (mutation.kind === 'update' || mutation.kind === 'move') {
      if (state.content === null)
        return `Cannot replay ${mutation.kind} ${mutation.mutationId}: the file is missing`
      const updated = FileHistoryComposer.forwardUpdate(state.content, mutation)
      if (updated === null)
        return `Cannot replay ${mutation.kind} ${mutation.mutationId}: its expected input is not present`
      state.content = updated
      state.path = mutation.path
      return null
    }
    else
      throw new Error(`Unknown log mutation: ${JSON.stringify(mutation)}`)
  }

  private static reverseUpdate(content: string, mutation: FileChangesLogMutation): string | null {
    if (mutation.unifiedDiff !== null) {
      try {
        const patches = parsePatch(mutation.unifiedDiff)
        if (patches.length !== 1) return null
        const result = applyPatch(content, reversePatch(patches[0]))
        return result === false ? null : result
      }
      catch { return null }
    }
    if (mutation.replaceAll || mutation.newText === null || mutation.oldText === null)
      return null
    return FileHistoryComposer.replaceExactlyOnce(content, mutation.newText, mutation.oldText)
  }

  private static forwardUpdate(content: string, mutation: FileChangesLogMutation): string | null {
    if (mutation.unifiedDiff !== null) {
      try {
        const patches = parsePatch(mutation.unifiedDiff)
        if (patches.length !== 1) return null
        const result = applyPatch(content, patches[0])
        return result === false ? null : result
      }
      catch { return null }
    }
    if (mutation.replaceAll || mutation.oldText === null || mutation.newText === null)
      return null
    return FileHistoryComposer.replaceExactlyOnce(content, mutation.oldText, mutation.newText)
  }

  private static replaceExactlyOnce(content: string, find: string, replacement: string): string | null {
    if (!find) return null
    const first = content.indexOf(find)
    if (first < 0 || content.indexOf(find, first + find.length) >= 0) return null
    return content.slice(0, first) + replacement + content.slice(first + find.length)
  }
}
