#!/usr/bin/env node
/**
 * agent-run.mjs <runId> — worker for one headless Claude run (S-282). It owns no skill logic: it feeds
 * the run's prompt to the `claude` CLI on stdin, turns the stream-json output into steps, and ALWAYS
 * writes a terminal state (done/failed/cancelled), even on a crash, so the UI never shows a stuck run.
 * Started by spec-web directly (bare host) or by tools/spec/host-runner.mjs (spec-web in Docker).
 * Needs the standalone CLI installed and logged in on this machine (claude auth login).
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runFinished } from '../spec-web/workitems-lib.mjs'
import { finishRefine } from '../spec-web/featurelib.mjs'
import { ROOT, HEARTBEAT_MS, agentCliArgs, ilTime, CLI_COMMAND_TIMEOUT_MS, readRun, writeRun, logFile, rawLogFile, addStep, validRunId } from '../spec-web/runs-lib.mjs'

const SPEC_CLI = resolve(ROOT, 'tools', 'spec', 'spec.mjs')
const id = process.argv[2]
if (!validRunId(id)) { console.error('usage: agent-run.mjs <runId>'); process.exit(2) }
const run = readRun(id)
if (!run || run.status !== 'queued') { console.error(`run ${id} missing or not queued`); process.exit(2) }

// The readable log: worker messages and one short line per step. The CLI's raw stream goes to a separate file.
// Everything the worker logs is also echoed to its console, so the window that started it shows the run live.
const log = (s) => { const line = s.endsWith('\n') ? s : s + '\n'; appendFileSync(logFile(id), line); process.stdout.write(line) }
// Claude's own words are the useful part of a live view: print long ones in full (the file log keeps the short form).
const sayFull = (text) => process.stdout.write(`\n${text}\n\n`)
const rawLog = (s) => appendFileSync(rawLogFile(id), s.endsWith('\n') ? s : s + '\n')
function step(kind, text) {
  addStep(run, kind, text)
  log(`${ilTime()} ${kind.padEnd(6)} ${String(text).replace(/\s+/g, ' ').slice(0, 220)}`)
}
let lastWrite = 0
// Re-read stopRequested before each write: the server sets it from another process and must not be overwritten.
function save(force = false) {
  const now = Date.now()
  if (!force && now - lastWrite < 1000) return
  lastWrite = now
  const disk = readRun(id)
  if (disk?.stopRequested) run.stopRequested = true
  // A failed state write (a locked file) must never kill a run that is working; the next write catches up.
  try { writeRun(run) } catch (e) { log(`[agent-run] could not write run state (${e.code || e.message}); will retry`) }
}

// Windows needs the whole tree gone (claude spawns gradle/vitest through a shell); elsewhere the child leads its own group.
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ } }
}

// A run can last hours; the PC must not idle-sleep and kill it (the 09:36 run died mid-step). Released when this worker exits.
function keepAwake() {
  try {
    if (process.platform === 'win32') {
      // SetThreadExecutionState holds per thread, so the same PowerShell thread must stay alive; it also exits when this worker does.
      const ps = `Add-Type -Name W -Namespace K -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [K.W]::SetThreadExecutionState([uint32]2147483649) | Out-Null; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 10 }`
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref()
    }
  } catch (e) { log(`[agent-run] could not hold the PC awake: ${e.message}`) }
}

// Safety limits, so a hung run ends with a reason instead of holding a CLI seat for ever. "Idle" = the CLI printed nothing
// (long commands are bounded by their own phase-run budget, so a healthy run keeps talking). Minutes; env overrides for tests.
const LIMITS = run.kind === 'develop'
  ? { idle: Number(process.env.AGENT_RUN_IDLE_MIN) || 90, total: Number(process.env.AGENT_RUN_TOTAL_MIN) || 8 * 60 }
  : { idle: Number(process.env.AGENT_RUN_IDLE_MIN) || 30, total: Number(process.env.AGENT_RUN_TOTAL_MIN) || 3 * 60 }
let lastEventAt = Date.now()
const startedMs = Date.now()
const watchdogTrip = () => {
  if (Date.now() - startedMs > LIMITS.total * 60_000) return `ran longer than ${LIMITS.total} min`
  if (Date.now() - lastEventAt > LIMITS.idle * 60_000) return `no output from claude for ${LIMITS.idle} min`
  return null
}
// The checklist step that was running when the run died is marked failed, with the reason, so the site shows where it stopped.
function failActiveStep(reason) {
  try {
    const s = JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout)
    for (const item of (s.checklist || []).filter((i) => (i.status ?? (i.done ? 'done' : 'pending')) === 'active')) {
      spawnSync(process.execPath, [SPEC_CLI, 'state', 'checklist-set', item.label, 'failed', `--reason=${reason}`], { cwd: ROOT, stdio: 'ignore' })
    }
  } catch { /* the banner is best effort */ }
}

function handleLine(line) {
  lastEventAt = Date.now()
  rawLog(line)
  let ev
  try { ev = JSON.parse(line) } catch { step('output', line); return }
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'tool_use') step('tool', `${c.name} ${JSON.stringify(c.input || {}).slice(0, 160)}`)
      else if (c.type === 'text' && c.text?.trim()) { step('text', c.text.trim()); if (c.text.trim().length > 220) sayFull(c.text.trim().slice(0, 4000)) }
    }
  } else if (ev.type === 'result') {
    run.resultText = String(ev.result || '').slice(0, 2000)
    run.resultError = !!ev.is_error
    step('result', ev.is_error ? `error: ${ev.result}` : 'finished')
  }
  bannerStep()
  save()
}

// The site's status banner (spec.mjs `state`): every run kind raises it so people see work happening, but a
// banner someone else raised is never taken over. Updates are queued so the final one cannot be overtaken.
let ownsBanner = false
let bannerQueue = Promise.resolve()
function banner(state, note) {
  bannerQueue = bannerQueue.then(() => new Promise((res) => {
    const c = spawn(process.execPath, [SPEC_CLI, 'state', 'set', state, note], { cwd: ROOT, stdio: 'ignore' })
    c.on('close', res); c.on('error', res)
  }))
}
let lastBannerAt = 0
let lastBannerNote = ''
// finish-ready-stubs and the integration run drive their own banner and checklist; the shorter runs show their latest step here.
const SELF_BANNER = new Set(['finish-stubs', 'develop'])
function bannerStep() {
  if (!ownsBanner || SELF_BANNER.has(run.kind)) return
  const last = run.steps[run.steps.length - 1]
  if (!last || last.kind === 'result') return
  const note = `${run.label}: ${last.text}`.replace(/\s+/g, ' ').slice(0, 110)
  if (note === lastBannerNote || Date.now() - lastBannerAt < 8000) return
  lastBannerAt = Date.now(); lastBannerNote = note
  banner('wip', note)
}

// A run that ended on purpose to wait for a person leaves the "human" banner up for them; nothing may overwrite it.
function humanBannerUp() {
  try { return JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout).state === 'human' } catch { return false }
}

function clearStuckBanner(reason) {
  // The skill's last step flips the banner back to "ready"; if claude died first nothing would.
  // A killed claude can leave the state file mid-write, so retry a failed read before giving up.
  let state = null
  for (let i = 0; i < 3 && !state; i++) {
    if (i) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},700)'])
    const get = spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' })
    try { state = JSON.parse(get.stdout) } catch { log(`[agent-run] could not read banner state (try ${i + 1})`) }
  }
  if (state?.state === 'wip') {
    log('[agent-run] banner still "wip" after an unclean end, clearing it')
    spawnSync(process.execPath, [SPEC_CLI, 'state', 'set', 'ready', reason], { cwd: ROOT })
  }
}

// The CLI's last message, asked for as a short summary, shaped like run notes ("- subject — what happened — detail").
// Whatever it wrote is kept (capped); only a run that produced no final message gets a one-line fallback.
function summaryBullets() {
  const text = String(run.resultText || '').trim()
  const bullets = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => {
    const body = l.replace(/^([-*]|\u2022)\s*/, '')
    // The prompt asks for " - " between parts (no non-ASCII on a Windows command line); the notes panel splits on an em dash.
    return ('- ' + body.replace(/ - /g, ' \u2014 ')).slice(0, 260)
  })
  if (bullets.length) return bullets.join('\n')
  return `- ${run.label} \u2014 ${run.status} \u2014 ${run.steps.length} steps and no summary from the CLI; see the run log`
}

async function main() {
  writeFileSync(logFile(id), `[agent-run] ${id} (${run.kind}) started ${ilTime(new Date(), true)}\n`)
  process.stdout.write(`\n=== ${run.label} (${run.kind}) - ${id} ===\n${run.prompt.split('\n').map((l) => '  > ' + l).join('\n')}\n\n`)
  run.status = 'running'
  run.startedAt = new Date().toISOString()
  run.heartbeatAt = run.startedAt
  run.pid = process.pid
  addStep(run, 'system', 'starting claude')
  save(true)
  let current = null
  try { current = JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout) } catch { /* no banner state yet */ }
  // A resume run starts on the amber banner the server set for it, and still has to close it when it ends.
  ownsBanner = current?.state !== 'wip' || !!run.params?.resume
  if (ownsBanner) banner('wip', `${run.label}: starting`)

  // AGENT_RUN_CLAUDE lets a smoke test substitute a fake CLI so no real skill runs.
  keepAwake()
  const child = spawn(process.env.AGENT_RUN_CLAUDE || 'claude', agentCliArgs([], run.kind),
    { cwd: ROOT, shell: true, detached: process.platform !== 'win32',
      env: { ...process.env, PLAYWORK_ACTOR: 'claude', ...(run.params?.domain === 'backend' ? { SPEC_STUBS_FILE: 'SPEC_STUBS_BACKEND.md' } : {}), BASH_DEFAULT_TIMEOUT_MS: String(CLI_COMMAND_TIMEOUT_MS), BASH_MAX_TIMEOUT_MS: String(CLI_COMMAND_TIMEOUT_MS) } })
  const stop = () => {
    if (run.stopSent) return
    run.stopSent = true
    log('[agent-run] stop requested, killing claude')
    killTree(child)
  }
  const beat = setInterval(() => {
    run.heartbeatAt = new Date().toISOString()
    save(true)
    if (run.stopRequested) stop()
    const trip = !run.stopSent && watchdogTrip()
    if (trip) { run.watchdog = trip; step('system', `watchdog: ${trip}, stopping the run`); failActiveStep(trip); stop() }
  }, HEARTBEAT_MS)
  // Stop must not wait a full heartbeat; poll the flag more often than we write.
  const stopPoll = setInterval(() => {
    if (readRun(id)?.stopRequested) { run.stopRequested = true; stop() }
  }, 2000)

  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handleLine(l) }
  })
  child.stderr.on('data', (d) => { rawLog(`[stderr] ${d}`); log(`[stderr] ${String(d).trim().slice(0, 300)}`) })
  child.stdin.on('error', () => { /* claude exited before reading the prompt; close handler reports it */ })
  child.stdin.end(run.prompt)

  const exitCode = await new Promise((res) => {
    child.on('close', (code) => res(code ?? 1))
    child.on('error', (err) => { run.error = `could not start claude: ${err.message}`; res(1) })
  })
  clearInterval(beat); clearInterval(stopPoll)
  if (buf.trim()) handleLine(buf.trim())

  run.exitCode = exitCode
  run.pid = null
  run.finishedAt = new Date().toISOString()
  if (run.watchdog) { run.status = 'failed'; run.error = `stopped by the watchdog: ${run.watchdog}` }
  else if (run.stopRequested) run.status = 'cancelled'
  else if (exitCode === 0 && !run.resultError) run.status = 'done'
  else { run.status = 'failed'; run.error = run.error || run.resultText || `claude exited with code ${exitCode}` }
  step('system', `run ${run.status}`)
  run.summary = run.status === 'done' ? summaryBullets() : `- ${run.label} \u2014 ${run.status} \u2014 ${String(run.error || 'stopped').replace(/\s+/g, ' ').slice(0, 200)}`
  save(true)
  log(`[agent-run] ${run.status} (exit ${exitCode})`)
  // A develop run that failed (crash, watchdog, CLI error) is resumable: the phase it died in is marked failed and the banner asks
  // a person to press Resume. This comes BEFORE runFinished, which reads that banner to pause the work item instead of failing it.
  await bannerQueue
  const failedDevelop = run.kind === 'develop' && run.status === 'failed' && run.params?.workItemId && !humanBannerUp()
  if (failedDevelop) {
    failActiveStep(String(run.error || 'the run failed').slice(0, 150))
    spawnSync(process.execPath, [SPEC_CLI, 'state', 'set', 'human', `${run.params.workItemId}: the run stopped (${String(run.error || 'failed').replace(/\s+/g, ' ').slice(0, 220)}). Press Resume to continue from the phase that failed.`, `--work-item=${run.params.workItemId}`], { cwd: ROOT })
  }
  // A run that ends without storing its result must not leave the work item stuck in analyzing, rewriting or working.
  if (['analyze', 'respec', 'develop'].includes(run.kind) && run.params?.workItemId) {
    try { runFinished(run.params.workItemId, run.kind, run.status, run.summary) } catch (e) { log(`[agent-run] could not update the work item: ${e.message}`) }
  }
  // The feature page shows the spec diff this run made, so it is recorded here and not left to the skill.
  if (run.kind === 'feature' && run.params?.featureId) {
    try { finishRefine(run.params.featureId, run.status, String(run.summary).replace(/^- /, '').split(' — ').slice(1).join(' — ') || run.summary) } catch (e) { log(`[agent-run] could not update the feature: ${e.message}`) }
  }
  await bannerQueue
  // Always flips the banner off amber, with the summary as its run notes. finish-ready-stubs writes its own closing
  // note, so for that kind the summary is only used when the banner is still amber after the run.
  if (failedDevelop) { /* the human banner stays up for a person */ } else if (ownsBanner) {
    if (SELF_BANNER.has(run.kind)) clearStuckBanner(run.summary)
    else if (!humanBannerUp()) spawnSync(process.execPath, [SPEC_CLI, 'state', 'set', 'ready', run.summary.slice(0, 1800)], { cwd: ROOT })
  }
}

main().catch((err) => {
  // Anything thrown above must still end in a terminal state.
  run.status = 'failed'; run.error = String(err?.message || err); run.finishedAt = new Date().toISOString(); run.pid = null
  try { save(true); log(`[agent-run] crashed: ${run.error}`) } catch { /* disk gone, nothing more to do */ }
  if (ownsBanner) spawnSync(process.execPath, [SPEC_CLI, 'state', 'set', 'ready', `- ${run.label} \u2014 crashed \u2014 ${run.error.slice(0, 200)}`], { cwd: ROOT })
  process.exit(1)
})
