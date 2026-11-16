#!/usr/bin/env node
/**
 * nightly-run.mjs — the one entry point the nightly scheduled task calls. It is an ORCHESTRATOR: each stage is its own worker
 * (tools/spec/workers/worker.mjs <name>, stages in workers/jobs.mjs) that reports itself in state/workers/<name>.json; this
 * script starts them one after another, enforces each one's time budget (wall clock and idle, then kills its process tree),
 * mirrors their status to the site's banner checklist and ends with a summary table. One stage failing never skips the rest.
 *
 * Order: manual translation FIRST (skipped when nothing changed or Ollama is down; the app bundles the manual, so it must be
 * translated before anything is built), web dev build, unit / e2e / screenshot tests, debug APK, production APK, the latest-release
 * APK (newest tag, in a separate worktree). An APK already built from this commit with nothing app-related changed is skipped.
 * A failed build never replaces the APK already published.
 *
 * Concurrency: after the translation, the main lane (web build, tests, debug APK, prod APK: they share this tree) and the latest-release
 * build (its own worktree) run at the same time; --serial runs everything one by one (less memory).
 *
 * Usage: node tools/spec/nightly-run.mjs [--apk-only] [--debug-only] [--master-only] [--no-master] [--serial] [--only a,b]
 *   --only takes worker names (manual-translation, web-build, unit, e2e, screenshots, apk-debug, apk-prod, master-build)
 * Env:   BUILD_FORCE=1 builds even when up to date; BUILD_SOURCE=WI-n labels the debug card; NIGHTLY_LOG keeps parallel runs
 *        apart; PHASE_PARENT names the checklist group the stages report under (default "Nightly").
 * Log:   tools/spec-web/documentation/state/nightly-log.txt (overwritten each run; also echoed to stdout).
 * Scheduled by the host (Windows Task Scheduler), not CronCreate; see docs/nightly-build.md.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ilTime } from '../spec-web/runs-lib.mjs'
import { JOBS } from './workers/jobs.mjs'
import { ROOT, DATA_DIR, WORKERS_DIR, EXIT, readStatus, writeStatus } from './workers/lib.mjs'
import { runLimited, fmtMs } from './workers/runner.mjs'

const LOG_FILE = process.env.NIGHTLY_LOG || resolve(DATA_DIR, 'nightly-log.txt')
const WORKER = resolve(ROOT, 'tools', 'spec', 'workers', 'worker.mjs')
const SPEC_CLI = resolve(ROOT, 'tools', 'spec', 'spec.mjs')
const PARENT = process.env.PHASE_PARENT || 'Nightly'
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(WORKERS_DIR, { recursive: true })
writeFileSync(LOG_FILE, `[nightly-run] started ${ilTime(new Date(), true)}\n`)

function log(line) { const s = `${line}\n`; process.stdout.write(s); appendFileSync(LOG_FILE, s) }
const bar = '='.repeat(60)

// When a run (a Start working run, finish-ready-stubs, spec-web) owns the amber banner, each stage shows up under it as a
// sub-step. A standalone nightly leaves the banner alone; a failed update never stops the run.
let bannerIsWip = false
try { bannerIsWip = JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout).state === 'wip' } catch { /* no banner state */ }
function stage(label, status, reason, percent) {
  if (!bannerIsWip) return
  try { spawnSync(process.execPath, [SPEC_CLI, 'state', 'checklist-set', `${PARENT}: ${label}`, status, ...(reason ? [`--reason=${reason}`] : []), ...(percent != null ? [`--percent=${percent}`] : [])], { cwd: ROOT, stdio: 'ignore' }) } catch { /* best effort */ }
}

const has = (f) => process.argv.includes(f)
const only = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? String(process.argv[i + 1] || '').split(',').filter(Boolean) : null })()
const apkOnly = has('--apk-only')
// A plan is { first: [...], lanes: [[...], ...] }: `first` runs alone and finishes before the lanes start; the lanes run at the
// same time, each one stage after another. Only stages that cannot disturb each other share a time: the latest-release build has its
// own git worktree, node_modules and android/ folder, while everything in the main lane shares this tree's tsbuildinfo, asset
// manifest, dist/ and android/, so those stay in one lane in order. --serial (or NIGHTLY_SERIAL=1) runs everything one by one.
const serial = has('--serial') || !!process.env.NIGHTLY_SERIAL
function plan() {
  let p
  if (only) {
    const bad = only.filter((n) => !JOBS[n]); if (bad.length) { log(`[nightly-run] unknown worker(s): ${bad.join(', ')}`); process.exit(2) }
    p = { first: [], lanes: [only] }
  } else if (has('--master-only')) p = { first: [], lanes: [['master-build']] }
  else {
    // Translation first and alone: the app bundles the manual, and the unit tests read it.
    const main = []
    if (!apkOnly) main.push('web-build', 'unit', 'e2e', 'screenshots')
    main.push('apk-debug')
    if (!has('--debug-only')) main.push('apk-prod')   // after the debug APK: both build into android/
    p = { first: apkOnly ? [] : ['manual-translation'], lanes: [main, ...(!has('--no-master') && !apkOnly ? [['master-build']] : [])] }
  }
  if (serial) p = { first: p.first, lanes: [p.lanes.flat()] }
  return p
}

const detailOf = (s) => (s?.phase && s.phase !== 'starting' ? `${s.phase}${s.percent ? ` ${s.percent}%` : ''}` : '')

async function runStage(name) {
  const job = JOBS[name]
  log(`\n${bar}\n[nightly-run] step: ${job.heading}\n${bar}`)
  stage(job.label, 'active')
  writeStatus(name, { status: 'queued', phase: 'starting', percent: 0, reason: null, finishedAt: null })
  const t0 = Date.now()
  let lastDetail = ''
  // The worker reports itself; mirror its phase/percent to the banner every few seconds (only when it changed).
  const mirror = setInterval(() => {
    const s = readStatus(name)
    const d = detailOf(s)
    if (d && d !== lastDetail) { lastDetail = d; stage(job.label, 'active', s.phase, s.percent) }
  }, 5000)
  const { code, reason } = await runLimited({
    cmd: `"${process.execPath}"`, args: [`"${WORKER}"`, name], cwd: ROOT, timeoutMs: job.timeoutMs, idleMs: job.idleMs,
    onData: (d) => { process.stdout.write(d); appendFileSync(LOG_FILE, d) },
  })
  clearInterval(mirror)
  const st = readStatus(name) || {}
  let status = code === EXIT.PASS ? 'done' : code === EXIT.SKIPPED ? 'skipped' : 'failed'
  let why = st.reason || null
  // A budget kill leaves the worker's own file saying "running": the orchestrator is the one that knows why it stopped.
  if (reason) { status = 'failed'; why = `${reason} (while ${st.phase || 'starting'}${st.percent ? ` ${st.percent}%` : ''})`; log(`[nightly-run] ${job.label}: ${why}`) }
  else if (status === 'failed' && !why) why = `exited with code ${code}`
  writeStatus(name, { status, reason: why, finishedAt: new Date().toISOString(), pid: null })
  stage(job.label, status, why)
  return { name, label: job.label, status, reason: why, ms: Date.now() - t0 }
}

const results = []
const p = plan()
for (const name of p.first) results.push(await runStage(name))
if (p.lanes.length > 1) log(`[nightly-run] running ${p.lanes.length} lanes at the same time: ${p.lanes.map((l) => l.join(' > ')).join('  |  ')}`)
await Promise.all(p.lanes.map(async (lane) => { for (const name of lane) results.push(await runStage(name)) }))

const order = Object.keys(JOBS)
results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))   // lanes finish in any order; the table reads in pipeline order
const mark = { done: '✓', skipped: '–', failed: '✗' }
const mins = (ms) => (ms >= 60_000 ? fmtMs(ms).replace(/ min$/, ' min') : `${Math.round(ms / 1000)} s`)
log(`\n${bar}\n[nightly-run] summary`)
for (const r of results) log(`  ${mark[r.status]} ${r.label.padEnd(20)} ${r.status.padEnd(8)} ${mins(r.ms).padStart(8)}${r.reason ? `  ${r.reason}` : ''}`)
const summary = Object.fromEntries(results.map((r) => [r.name, r.status === 'done' ? 'pass' : r.status === 'failed' ? 'fail' : `skipped${r.reason ? ` (${r.reason})` : ''}`]))
writeFileSync(resolve(WORKERS_DIR, '_last-run.json'), JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2) + '\n')
log(`[nightly-run] done — ${JSON.stringify(summary)}\n${bar}`)
// A failed stage is a failed run for whoever launched it (the Rebuild button reads this); skipped stages are fine.
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0)
