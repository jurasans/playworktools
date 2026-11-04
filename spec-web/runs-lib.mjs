// Run state for headless Claude runs (S-282). Pure file I/O, no HTTP: server.mjs, host-runner and
// tools/spec/agent-run.mjs all share it through the repo, which the Docker container bind-mounts.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { atomicWriteFile } from './fs-safe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
// SPEC_WEB_RUNS_DIR lets a smoke test keep its fake runs out of the real history the page shows.
export const RUNS_DIR = process.env.SPEC_WEB_RUNS_DIR ? resolve(process.env.SPEC_WEB_RUNS_DIR) : resolve(HERE, 'documentation', 'state', 'runs')

// The worker rewrites its heartbeat every 20 s, so a quiet claude (long build) never looks dead.
export const HEARTBEAT_MS = 20_000
export const STALLED_MS = 90_000
const KEEP_RUNS = 20
const MAX_STEPS = 300

// Each kind is a skill started headlessly. Work item ids are validated by format before they reach a prompt.
const WI = (x) => (/^WI-\d+$/.test(x.workItemId) ? x.workItemId : (() => { throw new Error('bad work item id') })())
export const KINDS = {
  'finish-stubs': { label: 'finish-ready-stubs', prompt: () => '/finish-ready-stubs' },
  analyze: { label: 'analyze work item', prompt: (x) => `/spec-work-item
Mode: analyze
Work item: ${WI(x)}` },
  // Sorts stubs into categories for spec-web's Stubs tab. Mode and domain are whitelisted before they reach the prompt.
  categorize: { label: 'categorize stubs', prompt: (x) => `/categorize-stubs
Mode: ${x.mode === 'all' ? 'all' : 'uncategorized'}
Domain: ${x.domain === 'backend' ? 'backend' : 'app'}` },
  // Step 1 of the work: rewrite the spec text only (no tickets). A person reviews and confirms it before step 2.
  respec: { label: 'rewrite spec for work item', prompt: (x) => `/spec-work-item
Mode: respec
Work item: ${WI(x)}` },
  // Step 2, after the spec is confirmed: tickets, development, verification. It drives the banner and its checklist itself.
  develop: { label: 'work on work item', prompt: (x) => `/spec-work-item
Mode: develop
${x.resume ? 'Resume: yes\n' : ''}Work item: ${WI(x)}` },
}

const ID_RE = /^run-\d{8}T\d{6}-[a-f0-9]{4}$/
export const validRunId = (id) => typeof id === 'string' && ID_RE.test(id)
const runFile = (id) => resolve(RUNS_DIR, `${id}.json`)
export const logFile = (id) => resolve(RUNS_DIR, `${id}.log`)
// The claude CLI's stream-json, line for line. Far too verbose to read; kept only for debugging.
export const rawLogFile = (id) => resolve(RUNS_DIR, `${id}.raw.log`)

// Added to the CLI's system prompt for every run, so its last message is a short summary a person can read in the run notes.
// One line without quotes or shell characters: on Windows the CLI is started through a shell, which does not quote arguments.
export const SUMMARY_INSTRUCTION = 'Run summary rule: when you are completely finished, make your last message a plain-text summary for a person, at most 8 lines, each starting with a dash and written as - subject - what happened - detail. Cover what you did, what you checked, what is left or blocked, and what needs a person. No tables and no headings.'

// Display time is Israel time (IDT in summer, IST in winter), whatever zone the PC is set to. Stored timestamps stay UTC ISO.
export function ilTime(d = new Date(), withDate = false) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' }).formatToParts(d).map((x) => [x.type, x.value]))
  const zone = p.timeZoneName === 'GMT+03:00' ? 'IDT' : p.timeZoneName === 'GMT+02:00' ? 'IST' : p.timeZoneName
  return `${withDate ? `${p.year}-${p.month}-${p.day} ` : ''}${p.hour}:${p.minute}:${p.second} ${zone}`
}

// What a headless run may NOT do. Everything else is allowed (the runs use --dangerously-skip-permissions), because these limits
// are enforced by the CLI itself as deny rules, which hold even in that mode, not by instructions the model could ignore:
//  - operate on the cloud: cloud and deploy CLIs, container pushes, git pushes (the repo's remote is the cloud);
//  - write code in the backend: the playwork-backend repo (sam-app) cannot be edited or written by the file tools.
// Limit: a shell command that writes into the backend repo by hand is not covered (a command line cannot be reliably parsed).
export const CLOUD_COMMANDS = ['aws', 'sam', 'cdk', 'npx cdk', 'gcloud', 'gsutil', 'bq', 'firebase', 'npx firebase', 'az', 'azcopy', 'terraform', 'pulumi', 'kubectl', 'helm', 'wrangler', 'vercel', 'netlify', 'flyctl', 'heroku', 'docker push', 'docker login', 'git push', 'gh pr create', 'gh release']
// The backend repo (separate from this one). Rules are given in every path form the CLI might compare against, since an absolute
// path outside the project is matched literally; PLAYWORK_BACKEND_REPO overrides the location.
const BACKEND_REPO = (process.env.PLAYWORK_BACKEND_REPO || 'C:/Users/infer/source/repos/sam-app').replaceAll('\\', '/')
export const BACKEND_PATHS = ['**/sam-app/**', '**/playwork-backend/**', `${BACKEND_REPO}/**`, `//${BACKEND_REPO[0].toLowerCase()}${BACKEND_REPO.slice(2)}/**`, `//${BACKEND_REPO}/**`]
export const AGENT_DENY = [
  ...CLOUD_COMMANDS.map((c) => `Bash(${c} *)`),
  ...CLOUD_COMMANDS.map((c) => `Bash(${c})`),
  'Bash(*scripts/v2.py*)',
  ...['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].flatMap((t) => BACKEND_PATHS.map((p) => `${t}(${p})`)),
]

/** The CLI arguments for a headless run, already quoted for the shell the worker uses (cmd.exe does not quote arguments). */
// The development run is long and mostly delegates to sub-agents, so it runs on a mid-size model at medium effort; other runs use the CLI default.
export const RUN_MODEL = { develop: { model: 'claude-sonnet-5-5', effort: 'medium' } }
export function agentCliArgs(extraDeny = [], kind = '') {
  const m = RUN_MODEL[kind]
  return [...(m ? ['--model', m.model, '--effort', m.effort] : []), '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    '--disallowedTools', ...[...AGENT_DENY, ...extraDeny].map((d) => `"${d}"`),
    '--append-system-prompt', `"${SUMMARY_INSTRUCTION} ${LONG_COMMAND_INSTRUCTION} ${DENY_INSTRUCTION}"`]
}
export const DENY_INSTRUCTION = 'Hard limits enforced by the runner: you cannot write code in the playwork-backend repo and you cannot operate on the cloud (aws, sam, cdk, gcloud, firebase, terraform, docker push, git push); if the work needs either, stop and say so in your summary.'

// Headless runs end the moment the CLI's turn ends, so a long command must run in the foreground and may take up to this long.
export const CLI_COMMAND_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const LONG_COMMAND_INSTRUCTION = 'Headless rule: this run ends as soon as you stop calling tools, so never use run_in_background; run long commands such as tools/spec/nightly-run.mjs in the foreground with the timeout set to 7200000.'

// temp+rename so a reader (server poll) never sees a half-written file.
const atomicWrite = atomicWriteFile

export function readRun(id) {
  if (!validRunId(id)) return null
  try { return JSON.parse(readFileSync(runFile(id), 'utf8')) } catch { return null }
}

export function writeRun(run) {
  mkdirSync(RUNS_DIR, { recursive: true })
  atomicWrite(runFile(run.id), JSON.stringify(run, null, 2) + '\n')
}

export function listRuns() {
  if (!existsSync(RUNS_DIR)) return []
  return readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort().reverse()
    .map((f) => readRun(f.slice(0, -5))).filter(Boolean)
}

// "queued"/"running" with no heartbeat for STALLED_MS means the worker died without writing a final state.
export function effectiveStatus(run, now = Date.now()) {
  if (!run) return null
  if (run.status !== 'running' && run.status !== 'queued') return run.status
  const beat = Date.parse(run.heartbeatAt || run.createdAt)
  return now - beat > STALLED_MS ? 'stalled' : run.status
}

export function view(run) {
  if (!run) return null
  return { ...run, status: effectiveStatus(run), active: ['queued', 'running'].includes(effectiveStatus(run)) }
}

export function activeRun() {
  return listRuns().map(view).find((r) => r.active) || null
}

export function createRun(kind, extra = {}) {
  const def = KINDS[kind]
  if (!def) throw new Error(`unknown run kind: ${kind}`)
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15)
  const run = {
    id: `run-${stamp}-${randomBytes(2).toString('hex')}`,
    kind, label: def.label, prompt: def.prompt(extra), params: extra, status: 'queued',
    createdAt: now.toISOString(), startedAt: null, finishedAt: null, heartbeatAt: now.toISOString(),
    lastEventAt: null, pid: null, exitCode: null, error: null, stopRequested: false, steps: [],
  }
  writeRun(run)
  pruneRuns()
  return run
}

function pruneRuns() {
  for (const old of listRuns().slice(KEEP_RUNS)) {
    for (const f of [runFile(old.id), logFile(old.id), rawLogFile(old.id)]) { try { rmSync(f) } catch { /* already gone */ } }
  }
}

export function addStep(run, kind, text) {
  run.steps.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 240) })
  if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS)
  run.lastEventAt = new Date().toISOString()
}

// The server cannot signal a worker on the host from inside Docker, so Stop is a flag the worker polls.
export function requestStop(id) {
  const run = readRun(id)
  if (!run) return null
  run.stopRequested = true
  writeRun(run)
  return run
}

// For a stalled run whose worker is gone: nobody will ever write the final state, so the UI does.
export function markFailed(id, reason) {
  const run = readRun(id)
  if (!run) return null
  if (!['queued', 'running'].includes(run.status)) return run
  run.status = 'failed'
  run.error = reason
  run.finishedAt = new Date().toISOString()
  writeRun(run)
  return run
}

/**
 * Starts the worker for a run. On Windows it opens a visible console window (tools/spec/run-window.cmd) that shows the run
 * live and stays 2 minutes after it ends; elsewhere, or with SPEC_WEB_HIDDEN_WORKER=1 (smoke tests), it runs hidden and the
 * log file is the only record. The window is the same process as the worker, so closing it stops the run.
 */
export function startWorker(runId) {
  if (!validRunId(runId)) throw new Error('bad run id')
  const script = resolve(ROOT, 'tools', 'spec', 'agent-run.mjs')
  if (process.platform === 'win32' && process.env.SPEC_WEB_HIDDEN_WORKER !== '1') {
    spawn('cmd.exe', ['/d', '/c', 'start', `Playwork ${runId}`, resolve(ROOT, 'tools', 'spec', 'run-window.cmd'), runId],
      { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false, env: { ...process.env, PW_NODE: process.execPath } }).unref()
  } else {
    spawn(process.execPath, [script, runId], { cwd: ROOT, stdio: 'ignore', detached: true }).unref()
  }
}
