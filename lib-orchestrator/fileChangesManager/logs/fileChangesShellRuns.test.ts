import { describe, expect, it } from 'vitest'

import { FileChangesShellRuns } from './fileChangesShellRuns'

describe('lib-orchestrator/fileChangesManager/logs/fileChangesShellRuns', () => {
  const run = (command: string) => ({ command, startedAt: 1_000, endedAt: 2_000 })
  const named = (command: string, path: string, directory = false) =>
    new FileChangesShellRuns([run(command)]).named(path, ['Q:/Project', 'Q:/'], directory).length === 1

  it('finds a path written absolutely, in Git Bash form, or relative to a base', () => {
    expect(named('sed -i s/a/b/ Q:\\Project\\src\\a.ts', 'Q:/Project/src/a.ts')).to.equal(true)
    expect(named('cd /q/Project && sed -i s/a/b/ /q/Project/src/a.ts', 'Q:/Project/src/a.ts')).to.equal(true)
    expect(named("edit('src/a.ts', [])", 'Q:/Project/src/a.ts')).to.equal(true)
    expect(named("edit('Project/src/a.ts', [])", 'Q:/Project/src/a.ts')).to.equal(true)
  })

  it('does not take a longer name, a sibling with the same tail, or a relative name inside another path', () => {
    expect(named('cat src/a.ts.bak', 'Q:/Project/src/a.ts')).to.equal(false)
    expect(named('cat src/data.ts', 'Q:/Project/src/a.ts')).to.equal(false)
    expect(named('cat other/src/a.ts', 'Q:/Project/src/a.ts')).to.equal(false)
    expect(named('cat src/a.ts.', 'Q:/Project/src/a.ts')).to.equal(true)
  })

  it('takes a directory when a command names a path inside it', () => {
    expect(named('mkdir -p fresh/inner && cat > fresh/inner/x.ts', 'Q:/Project/fresh', true)).to.equal(true)
    expect(named('cat > fresh/inner/x.ts', 'Q:/Project/fresh', false)).to.equal(false)
  })

  it('takes a time inside the run, with the slack on both ends', () => {
    const slack = FileChangesShellRuns.slackMillisecondsConst
    expect(FileChangesShellRuns.ranAt([run('x')], 1_000 - slack)).to.equal(true)
    expect(FileChangesShellRuns.ranAt([run('x')], 2_000 + slack)).to.equal(true)
    expect(FileChangesShellRuns.ranAt([run('x')], 2_001 + slack)).to.equal(false)
  })
})
