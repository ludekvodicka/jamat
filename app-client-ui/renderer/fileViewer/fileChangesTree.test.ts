import { describe, expect, it } from 'vitest'

import type {
  FileChangeEntry,
  FileChangeNodeKind,
  FileChangeStatus,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesTree } from './fileChangesTree'

describe('app-client-ui/renderer/fileViewer/fileChangesTree', () => {
  function entry(
    displayPath: string,
    nodeKind: FileChangeNodeKind,
    status: FileChangeStatus = 'modified',
  ): FileChangeEntry {
    return {
      fileId: displayPath,
      path: `Q:/repo/${displayPath}`,
      displayPath,
      nodeKind,
      location: 'workspace',
      status,
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt: null,
      sources: ['vcs'],
      gitState: null,
    }
  }

  it('compresses a single-directory chain and counts the file leaf, not its ancestors', () => {
    const tree = FileChangesTree.of([
      entry('scripts', 'directory'),
      entry('scripts/loader-animations', 'directory'),
      entry('scripts/loader-animations/catalog.ts', 'file'),
    ])

    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0]).toEqual(expect.objectContaining({
      key: 'scripts',
      label: 'scripts/loader-animations',
      kind: 'directory',
    }))
    expect(tree.nodes[0].children.map((node) => node.label)).toEqual(['catalog.ts'])
    expect(tree.leafCount).toBe(1)
  })

  it('stops compression at siblings and keeps directories before files', () => {
    const tree = FileChangesTree.of([
      entry('src', 'directory'),
      entry('src/scheduler', 'directory'),
      entry('src/scheduler/model.ts', 'file'),
      entry('src/connectors', 'directory'),
      entry('src/connectors/broker.ts', 'file'),
      entry('root.ts', 'file'),
    ])

    expect(tree.nodes.map((node) => node.label)).toEqual(['src', 'root.ts'])
    expect(tree.nodes[0].children.map((node) => node.label)).toEqual(['connectors', 'scheduler'])
    expect(tree.leafCount).toBe(3)
  })

  it('keeps a directly reported SVN directory leaf and its status', () => {
    const tree = FileChangesTree.of([
      entry('generated/assets', 'directory', 'untracked'),
    ])

    expect(tree.nodes[0]).toEqual(expect.objectContaining({
      label: 'generated/assets',
      entry: expect.objectContaining({ status: 'untracked' }),
      children: [],
    }))
    expect(tree.leafCount).toBe(1)
  })

  it('places a rename at its current path while retaining the previous path', () => {
    const renamed = {
      ...entry('src/new.ts', 'file', 'renamed'),
      previousPath: 'Q:/repo/src/old.ts',
      previousDisplayPath: 'src/old.ts',
    }
    const tree = FileChangesTree.of([entry('src', 'directory'), renamed])

    expect(tree.nodes[0].children[0].label).toBe('new.ts')
    expect(tree.nodes[0].children[0].entry?.previousDisplayPath).toBe('src/old.ts')
  })
})
