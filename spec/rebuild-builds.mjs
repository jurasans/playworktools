#!/usr/bin/env node
/**
 * rebuild-builds.mjs — rebuilds the four Downloads-tab APKs (spec-web's "Rebuild all builds" button), in parallel where the
 * build directories allow it, and reports per-build progress in state/rebuild-builds.json.
 *
 * Lanes (run concurrently, each in its own directory so they cannot clash):
 *   A  main tree android/: nightly debug, then nightly production (nightly-run --apk-only; one android/ means one at a time)
 *   B  worktree state/master-build: latest release (debug) of the newest tag (nightly-run --master-only, forced)
 *   C  worktree state/tagged-build-chinese: prod build of the newest tag (tagged-build)
 * Each lane gets its own log (state/rebuild-<lane>.log); NIGHTLY_LOG keeps nightly-run off the real nightly log.
 * Progress comes from the build scripts themselves: they print "[progress] N% label" lines (tools/build/progress.mjs).
 * Run it by hand too: `node tools/spec/rebuild-builds.mjs` (lanes in parallel) or `--serial` (one build at a time, less memory).
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STATE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state')
const FILE = resolve(STATE, 'rebuild-builds.json')
const STALE_MS = 3 * 60 * 60 * 1000
mkdirSync(STATE, { recursive: true })

try {
  const prev = JSON.parse(readFileSync(FILE, 'utf8'))
  if (prev.running && Date.now() - Date.parse(prev.startedAt) < STALE_MS) { console.error('a rebuild is already running'); process.exit(2) }
} catch { /* first run */ }

const tag = (() => {
  const r = spawnSync('git', ['for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:short)', 'refs/tags'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
})()

const now = () => new Date().toISOString()
// --only nightly-prod,latest-debug refreshes just those (the per-card Refresh button); the others are left exactly as they are.
const ALL = [
  { id: 'nightly-debug', title: 'Nightly debug build', lane: 'A', worker: 'apk-debug' },
  { id: 'nightly-prod', title: 'Nightly production build', lane: 'A', worker: 'apk-prod' },
  { id: 'latest-debug', title: 'LATEST RELEASE (DEBUG)', lane: 'B' },
  { id: 'latest-prod', title: 'LATEST RELEASE (PROD | CHINESE BUILD)', lane: 'C' },
]
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx > -1 ? String(process.argv[onlyIdx + 1] || '').split(',').filter(Boolean) : null
if (only && (!only.length || only.some((id) => !ALL.some((b) => b.id === id)))) { console.error(`--only takes: ${ALL.map((b) => b.id).join(', ')}`); process.exit(2) }
const builds = ALL.filter((b) => !only || only.includes(b.id)).map((b) => ({ ...b, status: 'queued', phase: 'waiting', percent: 0, startedAt: null, finishedAt: null }))
// A build that was not asked for is not tracked: its lane code still calls these, so it gets a throwaway record.
const byId = (id) => builds.find((b) => b.id === id) ?? { id, status: 'done', ghost: true }
const state = { running: true, startedAt: now(), tag, builds }

let lastSave = 0
function save(force) {
  if (!force && Date.now() - lastSave < 1000) return
  lastSave = Date.now()
  writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n')
}
const begin = (id, phase) => { const b = byId(id); if (b.status === 'queued') { b.status = 'running'; b.startedAt = now() } b.phase = phase; save(true) }
const finish = (id, ok, phase) => { const b = byId(id); if (b.status === 'done' || b.status === 'failed') return; if (!b.startedAt) b.startedAt = now(); b.status = ok ? 'done' : 'failed'; b.phase = phase || (ok ? 'published' : 'failed'); if (ok) b.percent = 100; b.finishedAt = now(); save(true) }

// Reads a lane's output line by line: phase markers move the build's phase, "> Task" lines are counted as Gradle progress.
function watch(lane, active, lines) {
  const cur = () => byId(active.id)
  for (const line of lines) {
    const b = cur()
    const m = /^\[progress\] (\d+)% (.*)$/.exec(line)
    if (m) { if (b.status === 'queued') { b.status = 'running'; b.startedAt = now() } b.percent = Number(m[1]); b.phase = m[2]; save() }
  }
}

function startLane(lane, id, cmd, args, env, onLine) {
  return new Promise((res) => {
    const log = resolve(STATE, `rebuild-${lane}.log`)
    writeFileSync(log, `[rebuild ${lane}] ${cmd} ${args.join(' ')}\n`)
    const active = { id }
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const onData = (d) => {
      appendFileSync(log, d)
      buf += d.toString()
      const lines = buf.split(/\r?\n/); buf = lines.pop()
      watch(lane, active, lines)
      for (const l of lines) onLine(l, active)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => res(code ?? 1))
    child.on('error', () => res(1))
  })
}

const SERIAL = process.argv.includes('--serial')
const laneA = () => (async () => {
  const mine = builds.filter((b) => b.lane === 'A')
  if (!mine.length) return
  begin(mine[0].id, 'starting')
  // BUILD_FORCE: a refresh always builds, even when the manifest says the commit is already built.
  const code = await startLane('A', mine[0].id, 'node', ['tools/spec/nightly-run.mjs', '--only', mine.map((b) => b.worker).join(',')], { BUILD_FORCE: '1', NIGHTLY_LOG: resolve(STATE, 'rebuild-A-nightly.log') }, (l, a) => {
    if (/step: debug APK build/.test(l)) { a.id = 'nightly-debug'; begin(a.id, 'building') }
    else if (/APK copied to /.test(l)) finish('nightly-debug', true)
    else if (/skipping APK publish/.test(l)) finish('nightly-debug', false)
    else if (/step: production APK build/.test(l)) { finish('nightly-debug', false, 'no APK produced'); a.id = 'nightly-prod'; begin(a.id, 'starting') }
    else if (/production APK copied to /.test(l)) finish('nightly-prod', true)
    else if (/production APK (skipped|build)|keystore\.properties not found/.test(l)) finish('nightly-prod', false)
  })
  // Anything still open when the process ends: the exit code decides.
  for (const { id } of mine) finish(id, code === 0 && byId(id).status === 'running', code === 0 ? 'published' : 'failed')
})()

const laneB = () => (async () => {
  if (byId('latest-debug').ghost) return
  if (!tag) { finish('latest-debug', false, 'no release tag'); return }
  begin('latest-debug', 'starting')
  await startLane('B', 'latest-debug', 'node', ['tools/spec/nightly-run.mjs', '--master-only'], { BUILD_FORCE: '1', NIGHTLY_LOG: resolve(STATE, 'rebuild-B-nightly.log') }, (l) => {
    if (/master APK \(.*\) published/.test(l)) finish('latest-debug', true)
    else if (/master build failed|latest-release build skipped/.test(l)) finish('latest-debug', false)
  })
  finish('latest-debug', false, 'no result reported')
})()

const laneC = () => (async () => {
  if (byId('latest-prod').ghost) return
  if (!tag) { finish('latest-prod', false, 'no release tag'); return }
  begin('latest-prod', 'starting')
  await startLane('C', 'latest-prod', 'node', ['tools/spec/tagged-build.mjs', '--tag', tag, '--key', 'chinese', '--title', 'THE CHINESE BUILD'], {}, (l) => {
    if (/\[tagged-build\] .* published to/.test(l)) finish('latest-prod', true)
    else if (/\[tagged-build\] failed/.test(l)) finish('latest-prod', false)
  })
  finish('latest-prod', false, 'no result reported')
})()

if (SERIAL) { await laneA(); await laneB(); await laneC() } else await Promise.all([laneA(), laneB(), laneC()])
state.running = false
state.finishedAt = now()
state.ok = builds.every((b) => b.status === 'done')
save(true)
