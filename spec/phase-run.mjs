#!/usr/bin/env node
/**
 * phase-run.mjs — runs ONE command of a Start working (develop) run as a checklist step with a safety net:
 *   node tools/spec/phase-run.mjs --label "Verify: unit tests" [--timeout 20] [--idle 10] [--retries 1] -- npm run verify
 *   --timeout  minutes of wall clock (default 30)       --idle  minutes without output (default 10)
 *   --retries  extra attempts after a failure (default 0; a timeout is never retried: it would only time out again)
 *   --skip="why"  the step is not needed: marks it skipped on the site and exits 0 without running anything
 * The step shows on the site's banner (active with its live phase, then done / failed / skipped with the reason). When the
 * command prints "[progress] N% label" or "[nightly-run] step: x", that becomes the live detail. A timeout kills the whole
 * process tree (so a leftover Gradle daemon cannot hang the run). Exit code: the command's, 124 on a timeout, 0 when skipped.
 * The label's "Phase: step" form nests the step under its phase on the site.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runLimited, fmtMs } from './workers/runner.mjs'
import { ROOT } from './workers/lib.mjs'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const skipping = argv.includes('--skip')   // a skipped step has no command to run
if (!skipping && (split < 0 || split === argv.length - 1)) { console.error('usage: phase-run.mjs --label "Phase: step" [--timeout min] [--idle min] [--retries n] -- <command...>   or   --label "..." --skip "why"'); process.exit(2) }
const opts = split < 0 ? argv : argv.slice(0, split), command = split < 0 ? [] : argv.slice(split + 1)
const opt = (n, d) => { const i = opts.indexOf(`--${n}`); return i > -1 ? opts[i + 1] : d }
const label = opt('label', command.join(' ').slice(0, 40))
const timeoutMs = Number(opt('timeout', 30)) * 60_000
const idleMs = Number(opt('idle', 10)) * 60_000
const retries = Number(opt('retries', 0))
const skip = opt('skip', null)
const SPEC_CLI = resolve(ROOT, 'tools', 'spec', 'spec.mjs')

// Only a run that owns the amber banner reports to it; PHASE_NO_BANNER=1 silences it (tests, manual runs while another run is up).
let bannerOn = !process.env.PHASE_NO_BANNER
if (bannerOn) { try { bannerOn = JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout).state === 'wip' } catch { bannerOn = false } }
const stage = (status, reason, percent) => {
  if (!bannerOn) return
  try { spawnSync(process.execPath, [SPEC_CLI, 'state', 'checklist-set', label, status, ...(reason ? [`--reason=${reason}`] : []), ...(percent != null ? [`--percent=${percent}`] : [])], { cwd: ROOT, stdio: 'ignore' }) } catch { /* the banner is best effort */ }
}

if (skip) { console.log(`[phase-run] ${label}: skipped (${skip})`); stage('skipped', skip); process.exit(0) }

let detail = '', pct = null, lastSent = 0, carry = ''
// Without its own [progress] lines the percent is a time estimate (elapsed / budget, capped at 95): honest enough for a ring, and the
// step still ends at 100 only when it really finishes.
const t0 = Date.now()
const estimate = () => Math.min(95, Math.round(((Date.now() - t0) / timeoutMs) * 100))
const onData = (d) => {
  process.stdout.write(d)
  carry += String(d)
  const lines = carry.split(/\r?\n/); carry = lines.pop()
  for (const l of lines) {
    const m = /^\[progress\] (\d+)% (.*)$/.exec(l)
    if (m) { pct = Number(m[1]); detail = m[2] }
    else { const n = /^\[nightly-run\] step: (.*)$/.exec(l); if (n) detail = n[1] }
  }
  if (Date.now() - lastSent > 5000) { lastSent = Date.now(); stage('active', detail, pct ?? estimate()) }
}

let result = { code: 1, reason: null }
for (let attempt = 0; attempt <= retries; attempt++) {
  stage('active', attempt ? `attempt ${attempt + 1} of ${retries + 1}` : '', 0)
  detail = ''; pct = null
  result = await runLimited({ cmd: command[0], args: command.slice(1), cwd: ROOT, timeoutMs, idleMs, onData })
  if (result.code === 0 || result.reason) break   // done, or a budget kill (a retry would only repeat it)
  if (attempt < retries) console.log(`[phase-run] ${label}: failed with code ${result.code}, retrying`)
}
const secs = Math.round((Date.now() - t0) / 1000)
if (result.code === 0) { stage('done', `${secs} s`); console.log(`[phase-run] ${label}: done in ${secs} s`); process.exit(0) }
const why = result.reason ? `${result.reason} (limit ${fmtMs(timeoutMs)} / idle ${fmtMs(idleMs)})` : `exit code ${result.code}`
stage('failed', why)
console.log(`[phase-run] ${label}: FAILED: ${why}`)
process.exit(result.code)
