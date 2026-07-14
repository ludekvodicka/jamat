/**
 * The phase machine's guards are the only thing standing between a background poll and a download the
 * user consented to — and every one of the bugs pinned here shipped in 0.2.5/0.2.6 (review 053-057).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const publish = vi.fn()
let idle = true

vi.mock('../streams', () => ({ publish: (...args: unknown[]) => publish(...args) }))
vi.mock('../app-root', () => ({ getAppVersion: () => '0.2.6' }))
vi.mock('../tab-tree-cache', () => ({ allTabsIdle: () => idle }))
vi.mock('../relaunch', () => ({ buildSessionList: () => '  • project — claude (working)' }))

type State = typeof import('./update-state')

async function freshState(): Promise<State> {
  vi.resetModules()          // the module holds singleton state — without this, phases leak between tests
  publish.mockClear()
  idle = true
  return import('./update-state')
}

describe('update-state phase machine', () => {
  let s: State
  beforeEach(async () => { s = await freshState() })

  it('a background check that finds nothing cannot cancel a consented download', () => {
    s.setAvailable('0.3.0')
    s.setDownloading({ version: '0.3.0', percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 })
    s.setIdle()                                    // the 120-min poll landing mid-download
    expect(s.getUpdateStatus().phase).to.equal('downloading')
    expect(s.getUpdateStatus().pendingVersion).to.equal('0.3.0')
  })

  it('a downloaded-but-parked update survives a later check too', () => {
    s.setReady('0.3.0')
    s.setChecking()
    s.setIdle()
    expect(s.getUpdateStatus().phase).to.equal('ready')
  })

  it('a pending offer is not knocked back to checking by the next poll', () => {
    s.setAvailable('0.3.0')
    s.setChecking()
    expect(s.getUpdateStatus().phase).to.equal('available')
  })

  it('a failed download surfaces even though a download was in progress', () => {
    s.setDownloading({ version: '0.3.0', percent: 10, transferred: 1, total: 10, bytesPerSecond: 1 })
    s.setError('socket hang up')                   // setError is deliberately NOT guarded by inProgress()
    expect(s.getUpdateStatus().phase).to.equal('error')
    expect(s.getUpdateStatus().lastError).to.equal('socket hang up')
  })

  it('an offer after a failed download leaves the error phase (or the dialog cannot be answered)', () => {
    s.setAvailable('0.3.0')
    s.setError('socket hang up')
    s.setAvailable('0.3.0')                        // what offerIfAvailable() now does before gate.offer()
    expect(s.getUpdateStatus().phase).to.equal('available')
    expect(s.getUpdateStatus().lastError).to.equal(null)
  })

  it('up to date clears the pending version', () => {
    s.setAvailable('0.3.0')
    s.setIdle()
    expect(s.getUpdateStatus().phase).to.equal('idle')
    expect(s.getUpdateStatus().pendingVersion).to.equal(null)
  })

  it('the status carries the busy terminals, so a chip-opened dialog can warn', () => {
    idle = false
    expect(s.getUpdateStatus().busy).to.contain('claude (working)')
    idle = true
    expect(s.getUpdateStatus().busy).to.equal(null)
  })

  it('every mutation broadcasts the new status', () => {
    publish.mockClear()
    s.setAvailable('0.3.0')
    s.setDownloading({ version: '0.3.0', percent: 1, transferred: 1, total: 10, bytesPerSecond: 1 })
    s.setReady('0.3.0')
    s.setInstalling('0.3.0')
    const phases = publish.mock.calls.map(([channel, status]) => {
      expect(channel).to.equal('update:changed')
      return (status as { phase: string }).phase
    })
    expect(phases).to.deep.equal(['available', 'downloading', 'ready', 'installing'])
  })
})
