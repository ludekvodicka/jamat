import './smokeHarness'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { prepareSkills } from '../release/prepare-skills'
import { CliClient } from './cliClient'
import { RemoteUiScenarios } from './remoteUiScenarios'
import { LatencyClient, type LatencyAttach } from './latencyClient'
import { LatencyMeasurement } from './latencyMeasurement'

async function run(): Promise<void> {
  assert.equal(process.platform, 'win32', 'The current owned-process smoke fixture targets Windows')
  const repository = resolve(import.meta.dirname, '../..')
  const built = spawnSync('pnpm run build', { cwd: join(repository, 'app-client-ui'), shell: true, stdio: 'inherit' })
  assert.equal(built.status, 0, 'AppClientUI build')
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'jamat-latency-'))
  assert(relative(parent, root).startsWith('jamat-latency-'))
  const previousState = process.env.JAMAT_V3_LOCAL_STATE_DIR, previousHost = process.env.JAMAT_V3_HOST_STATE_DIR
  const clients: LatencyClient[] = []
  try {
    const distribution = join(root, 'cli-distribution')
    await prepareSkills(repository, distribution)
    const wrapper = join(distribution, 'skills/claude/appjamat-v3/scripts/jamat-v3.mjs')
    const bundle = join(distribution, 'cli/jamat-v3.cjs')
    const [wrapperBytes, sourceBytes, bundleBytes] = await Promise.all([readFile(wrapper), readFile(CliClient.wrapperConst), readFile(bundle)])
    assert.deepEqual(wrapperBytes, sourceBytes, 'The actual distributed wrapper must retain the shipped source bytes')
    console.log('[smoke:latency] CLI distribution ' + JSON.stringify({ preparedBy: 'scripts/release/prepare-skills.ts', wrapper,
      wrapperSha256: createHash('sha256').update(wrapperBytes).digest('hex'), bundle,
      bundleSha256: createHash('sha256').update(bundleBytes).digest('hex'), coldSpawn: true }))
    const left = new LatencyClient('A', await RemoteUiScenarios.seed(root, 'A'), wrapper)
    const right = new LatencyClient('B', await RemoteUiScenarios.seed(root, 'B'), wrapper)
    clients.push(left, right)
    RemoteUiScenarios.pair(left.side, right.side)
    RemoteUiScenarios.pair(right.side, left.side)
    await left.start(repository)
    await right.start(repository)
    const work = join(root, 'shells'); await mkdir(work)
    const localSession = await left.createShell(work), remoteSession = await right.createShell(work)
    await left.connect(right, remoteSession)
    await right.connect(left, localSession)
    const routes = [await left.attach(localSession, null, 'local'),
      await right.attach(localSession, left.side.identity.remoteEndpointId, 'inbound'),
      await left.attach(remoteSession, right.side.identity.remoteEndpointId, 'outbound')]
    for (const route of routes) {
      const sample = await route.client.marker(route)
      LatencyMeasurement.check(sample)
      console.log(`[smoke:latency] ${route.direction} established baseline ${sample.milliseconds.toFixed(2)} ms (limit 200)`)
    }
    await left.captureOwned()
    await right.captureOwned()
    for (const pending of [false, true])
      for (const route of routes) await shortCase(left, right, route, pending)

    const longLeft = await left.block(20000), longRight = await right.block(20000)
    const after = Math.max(longLeft.start.at, longRight.start.at) + 16000
    await setTimeout(Math.max(0, after - LatencyClient.now()))
    const samples = []
    for (const route of routes) samples.push({ route, sample: await route.client.marker(route) })
    const endLeft = await left.end(longLeft), endRight = await right.end(longRight)
    for (const { route, sample } of samples) {
      assert(sample.startedAt - longLeft.start.at > 15000)
      assert(sample.startedAt - longRight.start.at > 15000)
      LatencyMeasurement.check(sample, longLeft.start, endLeft)
      LatencyMeasurement.check(sample, longRight.start, endRight)
      console.log(`[smoke:latency] ${route.direction} during 20000 ms block at ${(sample.startedAt - longLeft.start.at).toFixed(0)} ms: marker ${sample.milliseconds.toFixed(2)} ms (limit 200); lease kept`)
      const released = await route.client.marker(route)
      LatencyMeasurement.check(released)
      assert(released.startedAt >= endLeft.observedAt && released.startedAt >= endRight.observedAt)
      console.log(`[smoke:latency] ${route.direction} after 20000 ms release: marker ${released.milliseconds.toFixed(2)} ms (limit 200)`)
    }
    console.log('[smoke:latency] A passed: all 6 orchestration short cases, all 3 directions beyond the 15 s TTL and after release.')
    for (const pending of [false, true])
      for (const route of routes) await mainCase(left, right, route, pending)
    console.log('[smoke:latency] B passed: all 6 main-block cases; main-only cases include shipped CLI status below 500 ms; pending cases overlap a separately recorded real orchestration block.')
  } finally {
    const results = await Promise.allSettled(clients.map(client => client.retire()))
    if (previousState === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousState
    if (previousHost === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
    else process.env.JAMAT_V3_HOST_STATE_DIR = previousHost
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length === 0) {
      const resolved = await realpath(root)
      assert.equal(resolved, root)
      assert(relative(parent, resolved).startsWith('jamat-latency-'))
      await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      console.log(`[smoke:latency] removed owned fixture ${resolved}`)
    } else {
      console.error(`[smoke:latency] retained fixture ${root}; cleanup failures:`, failures)
      throw new AggregateError(failures.map(result => result.reason), 'Latency cleanup failed')
    }
  }
}

async function shortCase(left: LatencyClient, right: LatencyClient, route: LatencyAttach, withPending: boolean): Promise<void> {
  let outbound: boolean
  switch (route.direction) {
    case 'local': case 'inbound': outbound = false; break
    case 'outbound': outbound = true; break
    default: throw new Error(`Unknown latency direction: ${route.direction}`)
  }
  const blockLeft = await left.block(3000)
  const blockRight = outbound ? await right.block(3000) : null
  const target = outbound ? right : left
  const caller = outbound ? left : right
  const pending = withPending ? await caller.pending(target) : null
  const sample = await route.client.marker(route)
  if (pending) {
    assert.equal(pending.settledAt(), null, 'Peer work settled while the orchestration owner was blocked')
    assert(pending.receipt.observedAt <= sample.startedAt)
    assert(pending.receipt.observedAt >= (blockRight?.start.observedAt ?? blockLeft.start.observedAt))
    assert(pending.receipt.at >= (blockRight?.start.at ?? blockLeft.start.at))
    assert(pending.receipt.at <= pending.receipt.observedAt)
  }
  const endLeft = await left.end(blockLeft)
  LatencyMeasurement.check(sample, blockLeft.start, endLeft)
  const endRight = blockRight ? await right.end(blockRight) : null
  if (blockRight) LatencyMeasurement.check(sample, blockRight.start, endRight!)
  if (pending) {
    const result = await pending.done
    assert(result.ok, JSON.stringify(result))
    assert.equal(result.requestId, pending.receipt.requestId, 'The completed request must match the gateway admission receipt')
    assert(pending.settledAt()! >= (endRight ?? endLeft).at, 'Forwarded work must settle only after the blocked owner exits')
    console.log(`[smoke:latency] pending proof ${JSON.stringify({ receipt: pending.receipt, inputAt: sample.startedAt,
      markerAt: sample.arrivedAt, settledAt: pending.settledAt(), end: endRight ?? endLeft })}`)
  }
  console.log(`[smoke:latency] ${route.direction} 3000 ms block${withPending ? ', forwarded peer request pending' : ''}: marker ${sample.milliseconds.toFixed(2)} ms (limit 200); output inside block`)
}

async function mainCase(left: LatencyClient, right: LatencyClient, route: LatencyAttach, withPending: boolean): Promise<void> {
  let outbound: boolean
  switch (route.direction) {
    case 'local': case 'inbound': outbound = false; break
    case 'outbound': outbound = true; break
    default: throw new Error('Unknown latency direction: ' + route.direction)
  }
  // The real peer request needs a held owner now that main no longer runs orchestration.
  const heldLeft = withPending ? await left.block(3000) : null
  const heldRight = withPending && outbound ? await right.block(3000) : null
  const blockLeft = await left.block(3000, 'main')
  const blockRight = outbound ? await right.block(3000, 'main') : null
  const target = outbound ? right : left, caller = outbound ? left : right
  const pending = withPending ? await caller.pending(target) : null
  const sample = await route.client.marker(route)
  if (pending) {
    assert.equal(pending.settledAt(), null, 'Forwarded request must remain unresolved at the marker during the overlapping blocks')
    assert(pending.receipt.observedAt <= sample.startedAt)
    assert(pending.receipt.observedAt >= (blockRight?.start.observedAt ?? blockLeft.start.observedAt))
    assert(pending.receipt.at >= (blockRight?.start.at ?? blockLeft.start.at))
    assert(pending.receipt.at <= pending.receipt.observedAt)
  }
  const status = withPending ? null : await target.status()
  const endLeft = await left.end(blockLeft)
  const endRight = blockRight ? await right.end(blockRight) : null
  LatencyMeasurement.check(sample, blockLeft.start, endLeft)
  if (blockRight) LatencyMeasurement.check(sample, blockRight.start, endRight!)
  if (status) {
    LatencyMeasurement.checkStatus(status, blockRight?.start ?? blockLeft.start, endRight ?? endLeft)
    console.log('[smoke:latency] ' + route.direction + ' main-only 3000 ms block: shipped CLI status ' + status.milliseconds.toFixed(2) + ' ms (limit 500); launch and discovery included')
  }
  const releasedLeft = heldLeft ? await left.end(heldLeft) : null
  const releasedRight = heldRight ? await right.end(heldRight) : null
  if (heldLeft) LatencyMeasurement.check(sample, heldLeft.start, releasedLeft!)
  if (heldRight) LatencyMeasurement.check(sample, heldRight.start, releasedRight!)
  if (pending) {
    const result = await pending.done
    assert(result.ok, JSON.stringify(result))
    assert.equal(result.requestId, pending.receipt.requestId, 'The completed request must match the gateway admission receipt')
    assert(pending.settledAt()! >= (releasedRight ?? releasedLeft)!.at, 'Forwarded work must settle only after the held orchestration owner exits its block')
    console.log('[smoke:latency] main-block pending proof ' + JSON.stringify({ setup: 'real overlapping orchestration block',
      receipt: pending.receipt, inputAt: sample.startedAt, markerAt: sample.arrivedAt, settledAt: pending.settledAt(),
      main: [blockLeft.start, endLeft, blockRight?.start, endRight],
      orchestration: [heldLeft?.start, releasedLeft, heldRight?.start, releasedRight] }))
  }
  console.log('[smoke:latency] ' + route.direction + ' main 3000 ms block' + (withPending ? ', forwarded peer request pending under overlapping orchestration block' : '') + ': marker ' + sample.milliseconds.toFixed(2) + ' ms (limit 200); output inside block')
}

void run().catch(error => { console.error(error); process.exitCode = 1 })
