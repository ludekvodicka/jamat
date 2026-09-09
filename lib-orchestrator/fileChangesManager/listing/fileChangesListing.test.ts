import { describe, expect, it } from 'vitest'

import type { FileChangesLogGroup } from '../logs/fileChangesLogSource.types'
import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'
import { FileChangesLimits } from '../fileChangesLimits'
import { FileChangesListing } from './fileChangesListing'

describe('lib-orchestrator/fileChangesManager/listing/fileChangesListing', () => {
  /*
   * "The VCS is the authority" is right while there IS one. In a plain directory, dropping every
   * workspace mutation the transcript recorded left the top list saying `0 changed` while the chat
   * groups underneath it listed the three files the agent had just written and offered diffs for
   * them. A file inside `.gitignore` read the same way, because `status` runs with `--ignored=no`.
   */
  it('lists what the transcript recorded when there is no VCS to be the authority', async () => {
    const cwd = 'Q:/Project'
    const groups: FileChangesLogGroup[] = [{
      groupId: 'message',
      message: 'change',
      createdAt: 1,
      mutations: [{
        mutationId: 'inside',
        kind: 'update',
        status: 'modified',
        path: 'Q:/Project/src/file.ts',
        previousPath: null,
        location: 'workspace',
        beforeContent: null,
        afterContent: null,
        oldText: 'a',
        newText: 'b',
        replaceAll: false,
        unifiedDiff: null,
        createdAt: 1,
      }],
    }]

    const without = await new FileChangesListing().build({
      cwd,
      hasVcs: false,
      vcsEntries: [],
      logGroups: groups,
    })
    expect(without.map((item) => item.entry.displayPath)).to.deep.equal(['src', 'src/file.ts'])
    expect(without.at(-1)?.entry).to.deep.include({ location: 'workspace', sources: ['chat'] })

    // With a VCS that reported nothing, the same mutation is dropped: a file written and reverted
    // is not a change, and the status is what knows that.
    const withVcs = await new FileChangesListing().build({
      cwd,
      hasVcs: true,
      vcsEntries: [],
      logGroups: groups,
    })
    expect(withVcs).to.deep.equal([])
  })

  /*
   * The row draws `previous -> current`, and it drew an absolute path against a relative one: a
   * plain `git mv src/old.ts src/new.ts` in `Q:/Project` read as
   * `Q:/Project/src/old.ts -> src/new.ts`.
   */
  it('spells a rename\'s old path the way it spells its new one', async () => {
    const listed = await new FileChangesListing().build({
      cwd: 'Q:/Project',
      hasVcs: true,
      vcsEntries: [{
        absolutePath: 'Q:/Project/src/new.ts',
        repositoryPath: 'src/new.ts',
        nodeKind: 'file',
        status: 'renamed',
        previousAbsolutePath: 'Q:/Project/src/old.ts',
        previousRepositoryPath: 'src/old.ts',
        gitState: null,
      }],
      logGroups: [],
    })

    const renamed = listed.find((item) => item.entry.nodeKind === 'file')
    expect(renamed?.entry).to.deep.include({
      displayPath: 'src/new.ts',
      previousDisplayPath: 'src/old.ts',
      // The absolute form is still there, because a caller that has to reach the file needs it.
      previousPath: 'Q:/Project/src/old.ts',
    })
  })

  it('keeps VCS authoritative, attributes chat, adds external files and directory rows', async () => {
    const cwd = 'Q:/Project'
    const vcs: FileChangesVcsEntry[] = [{
      absolutePath: 'Q:/Project/src/file.ts',
      repositoryPath: 'src/file.ts',
      nodeKind: 'file',
      status: 'modified',
      previousAbsolutePath: null,
      previousRepositoryPath: null,
      gitState: { index: ' ', worktree: 'M' },
    }]
    const groups: FileChangesLogGroup[] = [{
      groupId: 'message',
      message: 'change',
      createdAt: 1,
      mutations: [
        {
          mutationId: 'inside',
          kind: 'update',
          status: 'modified',
          path: 'Q:/Project/src/file.ts',
          previousPath: null,
          location: 'workspace',
          beforeContent: null,
          afterContent: null,
          oldText: 'a',
          newText: 'b',
          replaceAll: false,
          unifiedDiff: null,
          createdAt: 1,
        },
        {
          mutationId: 'outside',
          kind: 'delete',
          status: 'deleted',
          path: 'Q:/External/file.txt',
          previousPath: null,
          location: 'external',
          beforeContent: 'old',
          afterContent: null,
          oldText: null,
          newText: null,
          replaceAll: false,
          unifiedDiff: null,
          createdAt: 1,
        },
      ],
    }]
    const listed = await new FileChangesListing().build({ cwd, hasVcs: true, vcsEntries: vcs, logGroups: groups })

    expect(listed.map((item) => item.entry)).toEqual([
      expect.objectContaining({ location: 'external', status: 'deleted', sources: ['chat'] }),
      expect.objectContaining({ displayPath: 'src', nodeKind: 'directory', sources: ['vcs', 'chat'] }),
      expect.objectContaining({
        displayPath: 'src/file.ts',
        status: 'modified',
        sources: ['vcs', 'chat'],
        gitState: { index: ' ', worktree: 'M' },
      }),
    ])
  })

  /**
   * `status` asks git for every untracked file on purpose, so an unignored build directory puts each
   * of its files in here. Cut silently, that list reads as a complete answer about the working copy;
   * cut with a warning, it says what it is.
   */
  it('cuts a list past the ceiling and says that it did', async () => {
    const warnings: string[] = []
    const vcsEntries = Array.from({ length: FileChangesLimits.listingEntriesMax + 5 }, (_, index) => ({
      absolutePath: `Q:/work/file-${index}.ts`,
      repositoryPath: `file-${index}.ts`,
      nodeKind: 'file' as const,
      status: 'untracked' as const,
      previousAbsolutePath: null,
      previousRepositoryPath: null,
      gitState: null,
    }))

    const items = await new FileChangesListing().build({
      cwd: 'Q:/work',
      hasVcs: true,
      vcsEntries,
      logGroups: [],
      warnings,
    })

    expect(items).to.have.length(FileChangesLimits.listingEntriesMax)
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.contain('cut at')
  })
})
