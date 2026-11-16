#!/usr/bin/env node
/**
 * spec-web — a thin HTTP wrapper around tools/spec/spec.mjs.
 *
 * This server owns NO spec logic. Every read that has a CLI equivalent shells
 * out to `node tools/spec/spec.mjs ... --json`, and every WRITE goes through the
 * CLI without exception — so the atomic index+block write, the status-token
 * preservation and the line-ending detection that spec.mjs implements are all
 * still the single code path that touches SPEC_STUBS.md. If this server ever grows
 * its own SPEC_STUBS.md writer, that guarantee is gone and Key Rule 15 is broken.
 *
 * Zero runtime dependencies (node: builtins only) — deliberately, so this tool
 * can never drag a supply-chain risk onto a publicly-tunnelled port, and so it
 * needs no install/build step of its own.
 *
 * Usage:
 *   node tools/spec-web/server.mjs [--port 8788] [--no-auth]
 *
 * Security model — read this before exposing it:
 *   - The spec is the product's full private design doc AND this tool can WRITE
 *     to it, so an open port is both a disclosure and an integrity risk.
 *   - A fixed username/password gate is therefore required on every request
 *     (sign in at /login; see AUTH_USERNAME/AUTH_PASSWORD below) — a
 *     successful sign-in mints a random session token good for 24h, held as
 *     an httpOnly cookie. Sessions live in memory only, so a server restart
 *     signs everyone out. Pass --no-auth (or the older --no-token alias)
 *     only for a strictly local session.
 *   - Child processes are spawned with execFile + an argv ARRAY, never a shell
 *     string, so answer text containing quotes/backticks/; cannot inject.
 *   - Stub ids and question numbers are format-validated before ever reaching
 *     the CLI.
 *   - Static file serving is a fixed allow-list, not a path join, so there is
 *     no traversal surface.
 */

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { readFile, readdir, stat, rename, writeFile, mkdir, unlink } from 'node:fs/promises'
import { LOC_REL, parseGrid, setCell, gitBase, subsetCsv } from './loc-lib.mjs'
import { applyImport } from './loc-import.mjs'
import * as manualI18n from './manual-lib.mjs'
import * as manualMt from './manual-mt.mjs'
import * as work from './workitems-lib.mjs'
import { cleanName } from './workitems-lib.mjs'
import * as feature from './featurelib.mjs'
import { startWorker, KINDS, latestRun, listRuns, activeRun, createRun, writeRun, readRun, requestStop, markFailed, validRunId, view as runView, logFile as runLogFile, rawLogFile as runRawLogFile } from './runs-lib.mjs'
import { createPush, diffSnapshots, batchEvents } from './push-lib.mjs'
import { writeFileSync, readFileSync, mkdirSync, createReadStream } from 'node:fs'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listAudio, resolveId, readState, updateState, fileEntry, readQueue, updateQueue, newJobId,
  knownNamesWithLive, AUDIO_MIME, DECISIONS, STATE_FILE, QUEUE_FILE, enforceSingleKeep,
  audioMeta, audioNotes, setAudioComplete, writeAudioSelectionManifest,
} from './audio-lib.mjs'
import { previewPrompt } from './audio-prompt.mjs'
import { rewriteNotes } from './images-rewrite.mjs'
import { listGenQueue, moveGenJob } from './gen-queue.mjs'
import { composePrompt, splitNotes } from '../../tools/generate/spacechase-prompts.mjs'
import { createManage } from '../manage/web/routes.mjs'
import { listImages, resolveImageId, readImageState, updateImageState, setDecision, setMulti, setComplete, assetMeta, notesFor, writeSelectionManifest, readImageQueue, updateImageQueue, newImageJobId, IMG_MIME } from './images-lib.mjs'
import {
  readTemplate as readFeedbackTemplate, writeTemplate as writeFeedbackTemplate,
  readSubmissions as readFeedbackSubmissions, appendSubmission as appendFeedbackSubmission,
  computeStats as computeFeedbackStats, buildCsv as buildFeedbackCsv,
} from './feedback-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
// Two registries, one server: the mobile app's SPEC_STUBS.md and
// playwork-backend's own SPEC_STUBS_BACKEND.md (see CLAUDE.md's "Backend
// (playwork-backend)" section and that file's own header) are both served
// from this single instance, selected per-request via a `domain` query
// param / POST body field (`'app'` | `'backend'`, default `'app'`) — see
// specFileFor()/specPathFor() below. The SPEC_STUBS_FILE env var still
// overrides what `'app'` resolves to (kept for anyone still running a
// single-domain instance the old way, e.g. inside the playwork-backend
// repo's own tooling); `'backend'` always means SPEC_STUBS_BACKEND.md
// regardless of that env var, since the whole point of this file existing
// is to be reachable from the one shared instance.
const DEFAULT_SPEC_FILE = process.env.SPEC_STUBS_FILE || 'SPEC_STUBS.md'
const SPEC_FILES = { app: DEFAULT_SPEC_FILE, backend: 'SPEC_STUBS_BACKEND.md' }
function domainOf(v) { return v === 'backend' ? 'backend' : 'app' }
function specFileFor(domain) { return SPEC_FILES[domainOf(domain)] }
/** Spec tab documents: one per docs/spec/*.md (CLAUDE.md is the agent entry point, SPEC.md a stale overview; neither is listed). Backend shows only its own page. */
async function specDocs(domain) {
  const title = (f) => f.replace(/.md$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
  const out = []
  const dir = resolve(ROOT, 'docs', 'spec')
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')).sort()
  for (const f of files) {
    if (domain === 'backend' && f !== 'backend-and-feedback.md') continue
    const h1 = /^# (.+)$/m.exec(await readFile(resolve(dir, f), 'utf8'))?.[1]
    out.push({ key: 'spec/' + f.slice(0, -3), title: h1 || title(f), path: resolve(dir, f) })
  }
  return out
}

const hashOf = (t) => createHash('sha1').update(t).digest('hex')

/** A tracked file as git's index (else HEAD) has it. execFile + argv array, never a shell. */
function gitShowFile(rel) {
  const run = (spec) => new Promise((ok) => {
    execFile('git', ['-c', 'safe.directory=*', 'show', spec], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => ok(err ? { error: String(stderr || err.message).trim() } : { text: stdout }))
  })
  return (async () => {
    const idx = await run(':' + rel)
    if (idx.text != null) return { text: idx.text, ref: 'index' }
    const head = await run('HEAD:' + rel)
    if (head.text != null) return { text: head.text, ref: 'HEAD' }
    return { error: head.error || idx.error || 'git unavailable' }
  })()
}

/** Line diff via LCS: 1-based line numbers in `now` that are new/changed, plus a count of deleted lines. */
function changedLines(before, now) {
  const a = before.split(/\r?\n/), b = now.split(/\r?\n/)
  const n = a.length, m = b.length
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  }
  // `deleted`: the erased lines, grouped by the 0-based line of the new text they used to precede (so the page can show them in place).
  const changed = [], deleted = {}; let removed = 0, i = 0, j = 0
  const gone = (text, at) => { removed++; (deleted[at] ||= []).push(text) }
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++ }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { gone(a[i], j); i++ }
    else { changed.push(j + 1); j++ }
  }
  for (; i < n; i++) gone(a[i], j)
  while (j < m) { changed.push(j + 1); j++ }
  return { changed, removed, deleted }
}

function specPathFor(domain) { return resolve(ROOT, specFileFor(domain)) }
// Back-compat alias — a few read paths that predate the two-domain split
// still reference the bare app-domain path directly.
const SPEC = specPathFor('app')
const CLI = resolve(ROOT, 'tools', 'spec', 'spec.mjs')
const LOC_PATH = resolve(ROOT, 'src', 'locales', 'strings.csv')

// Static, non-interactive doc pages (Suggestions / App Review / Images) —
// plain markdown under documentation/<super-tab>/<sub-tab>.md, rendered
// client-side by the same renderMd() the Spec tab already uses. A fixed
// allow-list, not a free-form path join, so /api/doc can never be pointed
// outside this one folder regardless of what a `key` query param contains.
const DOCS_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation')
const DOC_FILES = {
  'product/suggestions': resolve(DOCS_DIR, 'product', 'suggestions.md'),
  'product/appreview': resolve(DOCS_DIR, 'product', 'appreview.md'),
  'assets/images': resolve(DOCS_DIR, 'assets', 'images.md'),
}
let locQueue = Promise.resolve()
// Test-status: written by tools/spec/record-test-run.mjs after each unit/e2e
// run — this server only ever READS it (no SPEC_STUBS.md-style write path needed,
// it's disposable/regenerable, not the product's spec).
const TEST_STATUS_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'test-status.json')
// Live "Run Full Suite" progress — see README.md "Test running (host-runner)".
const TEST_RUN_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'test-run.json')
const RUN_FULL_SUITE_SCRIPT = resolve(ROOT, 'tools', 'spec', 'run-full-suite.mjs')
const AGENT_RUN_SCRIPT = resolve(ROOT, 'tools', 'spec', 'agent-run.mjs')
const IN_DOCKER = process.env.SPEC_WEB_IN_DOCKER === '1'
const manage = createManage()
const HOST_RUNNER_URL = process.env.HOST_RUNNER_URL || 'http://host.docker.internal:8899'
const HOST_RUNNER_TOKEN = process.env.HOST_RUNNER_TOKEN || 'YANI_TOMER_ILIA_RUNNER'
// A `running:true` lock older than this is treated as abandoned.
const TEST_RUN_STALE_MS = 30 * 60 * 1000
// Screenshot browser: the device-matrix e2e suite's own output directory.
const SCREENSHOTS_DIR = resolve(ROOT, 'e2e-artifacts')
const IMG_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg'])
// Nightly debug-APK build — written by tools/spec/nightly-run.mjs, read-only here.
// Web Push: VAPID key and subscriptions live in state/push.json (gitignored with the rest of state/).
const push = createPush({ file: resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'push.json'), subject: process.env.PUSH_SUBJECT || 'mailto:spec-web@example.com' })
const DOWNLOADS_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'downloads')
// Playwright's own JSON reporter output — written by
// tools/spec/record-test-run.mjs's e2e/screenshots runs, read-only here.
// Suggestions voting (see documentation/product/suggestions.md, rendered and
// wired by wireSuggestionVoting() in public/index.html). Tallies live in
// their own file rather than in SPEC_STUBS.md: these are opinions being
// gathered, not spec, and nothing here should ever end up in the stub
// registry by accident.
const VOTES_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'suggestion-votes.json')
const E2E_JSON_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'e2e-results.json')
const SCREENSHOTS_JSON_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'screenshots-results.json')
// Vitest's own JSON reporter (Jest-compatible shape) — written by
// tools/spec/record-test-run.mjs's unit suite alongside its normal stdout
// reporter, read-only here. Gives the Tests tab per-file pass/fail for the
// unit suite's "green dots per module" square the same way E2E_JSON_FILE
// already does for e2e.
const UNIT_JSON_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'unit-results.json')
const E2E_DIR = resolve(ROOT, 'e2e')
const DEVICES_TS_FILE = resolve(ROOT, 'e2e', 'devices.ts')
// Temporary ART review tab — browses whatever's under the image-gen
// pipeline's own output directory (one subfolder per dated batch, e.g.
// 2026-08-17-review-batch/) so a non-technical reviewer can mark generated
// art for deletion without needing filesystem access. Marking is a plain
// filename rename (append ART_DELETE_MARK before the extension) rather than
// a separate database — the mark IS the file state, so it's trivially
// visible/auditable outside this tool too (e.g. `ls`), and "which files are
// marked" can never drift out of sync with a JSON sidecar.
const ART_ROOT = resolve(ROOT, 'tools', 'generate', 'data', 'output')
const ART_DELETE_MARK = '_DELETE'
const BUILD_MANIFEST_FILE = resolve(DOWNLOADS_DIR, 'manifest.json')
const BUILD_APK_FILE = resolve(DOWNLOADS_DIR, 'playwork-debug-latest.apk')
const BUILD_PROD_APK_FILE = resolve(DOWNLOADS_DIR, 'playwork-prod-latest.apk')
const BUILD_MASTER_APK_FILE = resolve(DOWNLOADS_DIR, 'playwork-master-latest.apk')
const BUILD_CHINESE_APK_FILE = resolve(DOWNLOADS_DIR, 'playwork-chinese-latest.apk')

// Standalone, dependency-free page for /login — the private spec tool's own
// access gate (see AUTH_USERNAME/AUTH_PASSWORD/sessions below). Kept as a
// separate static page rather than folded into the SPA for the same reason
// /download is: it must be reachable and fully functional with ZERO prior
// auth state, so it can never itself depend on the gate it exists to get
// past.
const LOGIN_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playwork — Sign In</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{color-scheme:dark}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}
  .card{max-width:380px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:2rem}
  h1{font-size:1.3rem;margin:0 0 .3rem}
  .sub{color:#94a3b8;font-size:.9rem;margin:0 0 1.5rem}
  input{width:100%;box-sizing:border-box;padding:.7rem .9rem;border-radius:10px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;font-size:1rem;margin-bottom:.8rem}
  button{width:100%;padding:.8rem;border-radius:10px;border:none;background:#22c55e;color:#052e12;
         font-weight:700;font-size:1rem;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .err{color:#f87171;font-size:.85rem;min-height:1.2em;margin:.4rem 0 0}
</style></head>
<body>
  <div class="card">
    <h1>PLAYWORK</h1>
    <p class="sub">Sign in to continue.</p>
    <input id="u" type="text" placeholder="Username" autocomplete="username">
    <input id="p" type="password" placeholder="Password" autocomplete="current-password">
    <button id="go">Sign in</button>
    <div class="err" id="err"></div>
  </div>
<script>
const $ = (s) => document.querySelector(s)
async function go() {
  $('#err').textContent = ''
  $('#go').disabled = true
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('#u').value, password: $('#p').value }),
    })
    if (r.status === 401) { $('#err').textContent = 'Wrong username or password.'; return }
    if (!r.ok) { $('#err').textContent = 'Something went wrong — try again.'; return }
    const next = new URLSearchParams(location.search).get('next')
    location.href = (next && next.startsWith('/')) ? next : '/'
  } catch { $('#err').textContent = 'Something went wrong — try again.' }
  finally { $('#go').disabled = false }
}
$('#go').onclick = go
$('#p').addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
$('#u').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#p').focus() })
$('#u').focus()
</script>
</body></html>`

// Standalone, dependency-free page for /download — intentionally not part of
// the SPA (public/index.html), since that whole app assumes it's behind the
// private login gate. Password-checks client-side only for UX (instant
// feedback, no page reload); the server re-checks it on every API call
// regardless, so a tampered client can't skip the check.
const DOWNLOAD_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playwork — Debug Build</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{color-scheme:dark}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}
  .card{max-width:420px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:2rem}
  h1{font-size:1.3rem;margin:0 0 .3rem}
  .sub{color:#94a3b8;font-size:.9rem;margin:0 0 1.5rem}
  input{width:100%;box-sizing:border-box;padding:.7rem .9rem;border-radius:10px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;font-size:1rem;margin-bottom:.8rem}
  button{width:100%;padding:.8rem;border-radius:10px;border:none;background:#22c55e;color:#052e12;
         font-weight:700;font-size:1rem;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .err{color:#f87171;font-size:.85rem;min-height:1.2em;margin:.4rem 0 0}
  .meta{margin-top:1.3rem;padding-top:1.1rem;border-top:1px solid #334155;font-size:.85rem;color:#94a3b8;display:none}
  .meta div{margin:.2rem 0}
  .meta b{color:#e2e8f0}
</style></head>
<body>
  <div class="card">
    <h1>Playwork — Debug Build</h1>
    <p class="sub">Enter the download password to get the latest debug APK.</p>
    <input id="pw" type="password" placeholder="Password" autocomplete="off">
    <button id="go">Unlock</button>
    <div class="err" id="err"></div>
    <div class="meta" id="meta"></div>
  </div>
<script>
const $ = (s) => document.querySelector(s)
async function go() {
  const pw = $('#pw').value
  $('#err').textContent = ''
  $('#go').disabled = true
  try {
    const r = await fetch('/api/build/public?pw=' + encodeURIComponent(pw))
    if (r.status === 401) { $('#err').textContent = 'Wrong password.'; return }
    const d = await r.json()
    if (!d || d.available === false) { $('#err').textContent = 'No build has been published yet — check back after the next nightly run.'; return }
    $('#meta').style.display = 'block'
    $('#meta').innerHTML =
      '<div><b>Version</b> ' + (d.versionName ?? '?') + ' (build ' + (d.versionCode ?? '?') + ')</div>' +
      '<div><b>Built</b> ' + new Date(d.builtAt).toLocaleString() + '</div>' +
      '<div><b>Size</b> ' + (d.sizeBytes ? (d.sizeBytes/1024/1024).toFixed(1) + ' MB' : '?') + '</div>' +
      (d.gitCommit ? '<div><b>Commit</b> ' + d.gitCommit + (d.gitBranch ? ' (' + d.gitBranch + ')' : '') + '</div>' : '')
    $('#go').textContent = 'Download APK'
    $('#go').onclick = () => { location.href = '/api/build/client-download?pw=' + encodeURIComponent(pw) }
  } catch { $('#err').textContent = 'Something went wrong — try again.' }
  finally { $('#go').disabled = false }
}
$('#go').onclick = go
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
</script>
</body></html>`

// Standalone, dependency-free page for the PUBLIC customer feedback survey
// (S-248) — GET /feedback, deliberately OUTSIDE the main auth gate below and
// NOT password-gated at all (unlike /download): any customer with the link
// must be able to open and submit it with zero prior state, the same "must
// work with nothing else loaded" requirement /login and /download already
// follow. Renders itself from GET /api/feedback/template (also public) and
// posts to POST /api/feedback/submit (also public) — both re-validate
// server-side regardless of what this page sends, per this file's own
// security model note at the top.
const FEEDBACK_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playwork — Feedback</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;
       margin:0;padding:2rem 1rem 4rem;display:flex;justify-content:center}
  .wrap{max-width:560px;width:100%}
  h1{font-size:1.5rem;margin:0 0 .2rem}
  .sub{color:#94a3b8;font-size:.92rem;margin:0 0 1.6rem;line-height:1.5}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:1.3rem 1.4rem;margin-bottom:1rem}
  .card.required{border-color:#eab308}
  label.field-label{display:block;font-weight:700;font-size:.95rem;margin-bottom:.3rem}
  .req{color:#eab308;margin-left:.25rem}
  input[type=email]{width:100%;padding:.7rem .9rem;border-radius:10px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;font-size:1rem}
  .scale{display:flex;gap:.4rem;margin:.5rem 0 .6rem}
  .scale button{flex:1;padding:.6rem 0;border-radius:10px;border:1px solid #334155;background:#0f172a;
        color:#94a3b8;font-weight:700;font-size:1rem;cursor:pointer}
  .scale button.on{background:#22c55e;border-color:#22c55e;color:#052e12}
  .scale-labels{display:flex;justify-content:space-between;font-size:.72rem;color:#64748b;margin-bottom:.7rem}
  textarea{width:100%;min-height:4.2rem;padding:.6rem .8rem;border-radius:10px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;font:inherit;resize:vertical}
  .hint{color:#64748b;font-size:.8rem;margin-top:.3rem}
  button.submit{width:100%;padding:.9rem;border-radius:12px;border:none;background:#22c55e;color:#052e12;
         font-weight:800;font-size:1.05rem;cursor:pointer;margin-top:.4rem}
  button.submit:disabled{opacity:.5;cursor:default}
  .err{color:#f87171;font-size:.88rem;min-height:1.2em;margin:.6rem 0 0;text-align:center}
  .done{display:none;text-align:center;padding:3rem 1rem}
  .done h1{margin-bottom:.6rem}
  .done p{color:#94a3b8}
</style></head>
<body>
  <div class="wrap" id="formWrap">
    <h1>How's Playwork working for you?</h1>
    <p class="sub">A few quick questions about the features you've used — your answers go straight to the Playwork team and help us prioritize what to improve next. Skip anything you haven't tried.</p>
    <div class="card">
      <label class="field-label" for="email">Your Email <span class="req">*</span></label>
      <input type="email" id="email" placeholder="you@clinic.com" autocomplete="email">
    </div>
    <div id="features"></div>
    <div class="err" id="err"></div>
    <button class="submit" id="go">Submit Feedback</button>
  </div>
  <div class="wrap done" id="doneWrap">
    <h1>Thank you!</h1>
    <p>Your feedback has been recorded — we really appreciate it.</p>
  </div>
<script>
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]))
let TEMPLATE = null
const SCORES = {} // featureId -> 1..scale or undefined

function renderFeatures() {
  const box = $('#features')
  box.innerHTML = ''
  for (const f of TEMPLATE.features) {
    const card = document.createElement('div')
    card.className = 'card' + (f.required ? ' required' : '')
    const scaleBtns = Array.from({ length: TEMPLATE.scale }, (_, i) => i + 1)
      .map((n) => '<button type="button" data-f="' + esc(f.id) + '" data-n="' + n + '">' + n + '</button>').join('')
    card.innerHTML =
      '<label class="field-label">' + esc(f.label) + (f.required ? '<span class="req">*</span>' : '') + '</label>' +
      '<div class="scale">' + scaleBtns + '</div>' +
      '<div class="scale-labels"><span>Not helpful</span><span>Very helpful</span></div>' +
      '<textarea placeholder="Perceived helpfulness, or actual results you have seen with patients (optional)" data-t="' + esc(f.id) + '"></textarea>' +
      (f.required ? '<div class="hint">Required</div>' : '<div class="hint">Skip this if you have not used this feature</div>')
    box.appendChild(card)
  }
  box.querySelectorAll('.scale button').forEach((b) => b.onclick = () => {
    const fid = b.dataset.f, n = Number(b.dataset.n)
    SCORES[fid] = SCORES[fid] === n ? undefined : n // tap again to clear
    box.querySelectorAll('.scale button[data-f="' + fid + '"]').forEach((x) =>
      x.classList.toggle('on', Number(x.dataset.n) === SCORES[fid]))
  })
}

async function load() {
  try {
    const r = await fetch('/api/feedback/template')
    TEMPLATE = await r.json()
    renderFeatures()
  } catch { $('#err').textContent = 'Could not load the form — please refresh and try again.' }
}
load()

async function submit() {
  $('#err').textContent = ''
  const email = $('#email').value.trim()
  const answers = TEMPLATE.features.map((f) => ({
    featureId: f.id,
    score: SCORES[f.id] ?? null,
    text: (document.querySelector('textarea[data-t="' + f.id + '"]')?.value || '').trim(),
  }))
  $('#go').disabled = true
  try {
    const r = await fetch('/api/feedback/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, answers }),
    })
    const d = await r.json()
    if (!r.ok || !d.ok) { $('#err').textContent = d.error || 'Something went wrong — please try again.'; return }
    $('#formWrap').style.display = 'none'
    $('#doneWrap').style.display = 'block'
  } catch { $('#err').textContent = 'Something went wrong — please try again.' }
  finally { $('#go').disabled = false }
}
$('#go').onclick = submit
</script>
</body></html>`

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argVal = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(argVal('--port', 8888 || 8888))
// Bare `node server.mjs` stays localhost-only by default (the security model
// this whole file is built around). Docker needs 0.0.0.0 to publish the port
// at all — Docker's port-forwarding proxy targets the container's external
// interface, not its loopback — so the container passes --host 0.0.0.0
// explicitly rather than this default ever silently widening.
const HOST = argVal('--host', process.env.SPEC_WEB_HOST || '127.0.0.1')
const NO_AUTH = argv.includes('--no-token') || argv.includes('--no-auth') // --no-token kept as an alias, existing muscle memory

// ── auth: username/password → a 24h session token ───────────────────────────
// Replaces the earlier "?t=<random-token-per-restart>" scheme entirely. Fixed
// credentials (not env-configurable — meant to be the same fixed pair shared
// out of band with the small group of people who need it, same convention as
// DOWNLOAD_PASSWORD below) checked timing-safely, then a random per-LOGIN
// session token is minted and handed back as an HttpOnly cookie good for
// SESSION_MAX_AGE_MS. (Sessions are now also saved to documentation/state/sessions.json, hashed; the next sentence is the old design.) Sessions live in memory only (a Map, not a file) — on a
// server restart every session is invalidated and everyone has to sign in
// again, which is an acceptable, even desirable, property for a tool that
// writes to the product's private spec.
const AUTH_USERNAME = 'playwork'
const AUTH_PASSWORD = 'YANI_TOMER_ILIA'
// Every account that can sign in, with its role. 'admin' sees the whole tool.
// 'translator' can only view and edit strings.csv (the Assets → Localization
// tab) — enforced server-side by translatorAllowed() in the auth gate, not
// just hidden in the UI.
const USERS = [
  { username: AUTH_USERNAME, password: AUTH_PASSWORD, role: 'admin' },
  { username: 'translator', password: 'fWpEKa_4LN93', role: 'translator' },
  // 'tester' lands straight in the dev web build (/web-build/) and sees nothing of the spec tool.
  { username: 'test', password: 'playwork_TEST_1', role: 'tester' },
]
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
// Sessions survive a restart: they are saved (keyed by the SHA-256 of the cookie token, never the token itself) in the
// git-ignored state folder, so restarting the container does not sign anyone out.
const SESSIONS_FILE = resolve(HERE, 'documentation', 'state', 'sessions.json')
const sessions = new Map() // sha256(token) -> { exp: expiresAtMs, role }
const tokenKey = (token) => createHash('sha256').update(String(token)).digest('hex')
try {
  const saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
  for (const [k, v] of Object.entries(saved)) if (v && v.exp > Date.now() && ['admin', 'translator', 'tester'].includes(v.role)) sessions.set(k, v)
} catch { /* no saved sessions yet */ }
function saveSessions() {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true })
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 })
  } catch { /* best effort: the session still works until the next restart */ }
}

// Pages and API routes a 'translator' session may reach. Every page path
// below serves the same index.html, which then shows only Localization.
const TRANSLATOR_PAGES = new Set(['/', '/index.html', '/assets', '/assets/localization', '/assets/manual', '/localization'])
function translatorAllowed(path) {
  return TRANSLATOR_PAGES.has(path) || path === '/api/loc' || path.startsWith('/api/loc/') ||
    path === '/api/manual' || path.startsWith('/api/manual/')
}

// A 'tester' session may reach ONLY the dev web build (and the art it loads):
// no page, API or markup of the spec tool itself. Anything else sends them to the app.
function testerAllowed(path) {
  return isWebAppPath(path)
}

function timingSafeStrEqual(given, expected) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The matching account's role, or null. Every account is checked (both
 *  fields, always) so response timing doesn't reveal which part was wrong. */
function credentialsOk(username, password) {
  let role = null
  for (const u of USERS) {
    const userOk = timingSafeStrEqual(username, u.username)
    const passOk = timingSafeStrEqual(password, u.password)
    if (userOk && passOk && !role) role = u.role
  }
  return role
}

function createSession(role) {
  pruneSessions()
  const token = randomBytes(24).toString('hex')
  sessions.set(tokenKey(token), { exp: Date.now() + SESSION_MAX_AGE_MS, role })
  saveSessions()
  return token
}

/** True (and refreshes nothing — a session's expiry is fixed at creation,
 *  not extended by use) iff `token` is a currently-live session. Lazily
 *  drops anything already expired so `sessions` can't grow unbounded across
 *  a long-running process. */
function sessionValid(token) {
  if (!token) return null
  const sess = sessions.get(tokenKey(token))
  if (!sess) return null
  if (Date.now() > sess.exp) { sessions.delete(tokenKey(token)); saveSessions(); return null }
  return sess
}

function pruneSessions() {
  const now = Date.now()
  for (const [token, sess] of sessions) if (now > sess.exp) sessions.delete(token)
}

function sessionCookie(req) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'spec_session') return decodeURIComponent(v.join('='))
  }
  return null
}

// A separate, fixed password for the client-facing APK download page
// (/download) — deliberately NOT the login password above. That gates the
// whole private spec tool (writes to SPEC_STUBS.md, full stub history); clients
// being handed a debug build need a narrower, stable credential that isn't
// also a key to the product's private design doc. Hardcoded rather than
// env-configurable since it's meant to be the same fixed phrase shared out
// of band with the small group of people who need it.
const DOWNLOAD_PASSWORD = 'YANI_TOMER_ILIA_PLAYWORK_4_LIFE'
function downloadPwOk(given) {
  if (!given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(DOWNLOAD_PASSWORD)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── CLI bridge ───────────────────────────────────────────────────────────────
/**
 * Runs `node tools/spec/spec.mjs <args>`. `args` MUST be an array — execFile with
 * an argv array never invokes a shell, so no element of it can be interpreted
 * as a metacharacter no matter what the user typed into an answer box.
 *
 * `domain` ('app' | 'backend', default 'app') selects which registry file
 * the CLI reads/writes by setting SPEC_STUBS_FILE on the child's own env
 * (execFile does not inherit process.env by default — an explicit `env`
 * must be passed, or the child gets none at all and things like PATH break,
 * so this always spreads process.env first).
 */
function spec(args, domain, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, SPEC_STUBS_FILE: specFileFor(domain), ...extraEnv },
      },
      (err, stdout, stderr) => {
        resolvePromise({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      },
    )
  })
}

async function specJson(args, domain) {
  const r = await spec([...args, '--json'], domain)
  if (!r.ok) throw new Error(r.stderr.trim() || r.stdout.trim() || 'spec CLI failed')
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`spec CLI did not return JSON for: ${args.join(' ')}`)
  }
}

// ── validation ───────────────────────────────────────────────────────────────
// A reopened stub carries a version-letter suffix (S-183 → S-183-a on its
// first reopen, S-183-b on a second, …) — see spec.mjs's `nextReopenId`.
const ID_RE = /^S-\d{1,5}(-[a-z])?$/
const STATUSES = new Set(['deferred', 'delay', 'enabled', 'in-progress', 'in-qa', 'done'])
const assertId = (id) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`bad stub id: ${id}`)
  return id
}
const assertN = (n) => {
  const v = Number(n)
  if (!Number.isInteger(v) || v < 1 || v > 999) throw new Error(`bad question number: ${n}`)
  return String(v)
}

// ── stub block extraction (no CLI equivalent — `show` has no --json) ─────────
/**
 * Pulls one stub's own markdown out of SPEC_STUBS.md — either a top-level
 * `### STUB: <id> — ...` block, or (if `id` carries a reopen-version letter,
 * e.g. S-183-a) the matching NESTED `#### SUB-STUB: <id> — ...` section that
 * lives inside its parent's own block (see spec.mjs's `cmdReopen`). Read-only,
 * so it is safe for this server to parse the file directly; nothing here
 * ever writes.
 */
async function stubBlock(id, domain) {
  const md = await readFile(specPathFor(domain), 'utf8')
  const lines = md.split(/\r?\n/)
  const startsTopStub = (l) => /^### STUB:\s*S-\d+(-[a-z])?\s/.test(l)
  const startsSubStub = (l) => /^#### SUB-STUB:\s*S-\d+(-[a-z])?\s/.test(l)

  const subRe = new RegExp(`^#### SUB-STUB:\\s*${id}\\s`)
  let start = lines.findIndex((l) => subRe.test(l))
  const isSub = start !== -1
  if (!isSub) {
    const topRe = new RegExp(`^### STUB:\\s*${id}\\s`)
    start = lines.findIndex((l) => topRe.test(l))
  }
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // A sub-stub's own content stops at the NEXT sub-stub, its parent's own
    // end (a top-level heading), or a real markdown section heading —
    // whichever comes first. A top-level stub's content still spans through
    // any sub-stubs nested inside it (unchanged from before) — its own "VIEW
    // RAW STUB BLOCK" button is meant to show the whole reopen history too.
    if (isSub && startsSubStub(lines[i])) { end = i; break }
    if (startsTopStub(lines[i]) || /^#{1,2}\s/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n').trimEnd()
}

// ── full test-run orchestration ─────────────────────────────────────────────
async function readTestRun() {
  let data
  try { data = JSON.parse(await readFile(TEST_RUN_FILE, 'utf8')) }
  catch { return { running: false, phase: null, phaseLabel: null, startedAt: null, completed: [] } }
  if (data.running && data.startedAt && Date.now() - new Date(data.startedAt).getTime() > TEST_RUN_STALE_MS) {
    return { ...data, running: false, stale: true }
  }
  return data
}

// Analyzed-tracking — a flat { [stubId]: { lastAnalyzedAt, outcome, ... } }
// map the finish-ready-stubs SKILL maintains itself (Read/Write, not
// spec.mjs — it is deliberately NOT part of the SPEC_STUBS.md stub data, same
// "disposable side file" convention as session-state.json/test-run.json).
// This server only ever reads it, to (a) surface "analyzed" on each stub in
// /api/bootstrap and (b) gate /api/status's deferred→enabled transition —
// see README.md "Only analyzed stubs can be enabled".
const STUB_ANALYSIS_FILE = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'stub-analysis.json')
async function readStubAnalysis() {
  try { return JSON.parse(await readFile(STUB_ANALYSIS_FILE, 'utf8')) }
  catch { return {} }
}

// ── screenshot tree ──────────────────────────────────────────────────────────
/**
 * Walks e2e-artifacts/<device>/<orientation>/*.png (the device-matrix e2e
 * suite's own layout — see CLAUDE.md's "Device-Matrix Screenshot Suite") two
 * levels deep and returns a device -> orientation -> files[] tree, each file
 * carrying its mtime so the UI can show "captured <date>" per shot without a
 * second round-trip. Read-only, best-effort: a missing directory (suite never
 * run) returns an empty tree rather than an error.
 */
/**
 * Extracts the doc comment immediately preceding `needleAfter` in `src` (or
 * the file's very first block comment if `needleAfter` is omitted) —
 * "gleaned from the code using standard tooling" per the Tests page's
 * row-by-row test detail view: rather than hand-write a description for
 * every spec file / device, this reads the same `/** ... *\/` comments a
 * developer would, via a plain regex (this tool is deliberately zero-
 * dependency, so no real TS/JS parser is available) rather than a second,
 * hand-maintained copy of the same reasoning.
 */
function nearestDocComment(src, needleAfter) {
  const upTo = needleAfter != null ? src.slice(0, src.indexOf(needleAfter)) : src
  const matches = [...upTo.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
  const last = matches[matches.length - 1]
  if (!last) return ''
  return last[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
}

/** Cheap in-process cache — these source files rarely change mid-session, and re-reading/re-regexing them on every request is wasted work for a private internal tool. */
let devicesMetaCache = null
async function parseDevicesMeta() {
  if (devicesMetaCache) return devicesMetaCache
  let src
  try { src = await readFile(DEVICES_TS_FILE, 'utf8') } catch { return { overview: '', devices: [] } }
  const overview = nearestDocComment(src, 'export const DEVICES')
  const devices = []
  const re = /id:\s*'([^']+)'[\s\S]*?label:\s*'([^']+)'[\s\S]*?note:\s*'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(src))) {
    devices.push({ id: m[1], label: m[2], note: m[3].replace(/\\'/g, "'") })
  }
  devicesMetaCache = { overview, devices }
  return devicesMetaCache
}

/**
 * Flattens Playwright's own JSON reporter output (`suites[]`, recursively
 * nested for `describe` blocks, each eventually holding `specs[].tests[]`)
 * into one row per test — the real per-run title/status/duration, not a
 * second parse of the human-readable stdout summary (see record-test-run.mjs
 * for why both reporters run side by side).
 */
function flattenPlaywrightJson(report) {
  const rows = []
  function walk(suite, file) {
    const f = suite.file || file
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const result = t.results?.[t.results.length - 1]
        rows.push({
          file: spec.file || f,
          line: spec.line ?? null,
          title: spec.title,
          project: t.projectName ?? null,
          status: result?.status ?? t.status ?? 'unknown',
          duration: result?.duration ?? null,
        })
      }
    }
    for (const child of suite.suites || []) walk(child, f)
  }
  for (const s of report.suites || []) walk(s, s.file)
  return rows
}

/**
 * The Tests page's row-by-row detail view for one suite ('e2e' or
 * 'screenshots') — real per-test rows from Playwright's JSON reporter,
 * grouped by spec file, each file annotated with its own top-of-file doc
 * comment (every e2e spec in this repo opens with one explaining what it
 * covers and why — see e.g. device-screenshots.spec.ts). For the
 * screenshots suite specifically, each row's title is exactly
 * "<device label> — <orientation>" (device-screenshots.spec.ts's own test
 * naming), so it's matched back against devices.ts's id/label/note to
 * attach a deep-link into the screenshot browser below (`/tests?device=…`).
 */
async function testDetails(suiteName) {
  const jsonFile = suiteName === 'screenshots' ? SCREENSHOTS_JSON_FILE : E2E_JSON_FILE
  let report
  try { report = JSON.parse(await readFile(jsonFile, 'utf8')) } catch { return { available: false } }
  const rows = flattenPlaywrightJson(report)
  const { devices, overview } = suiteName === 'screenshots' ? await parseDevicesMeta() : { devices: [], overview: '' }

  const byFile = new Map()
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, [])
    let deepLink = null, note = null
    if (suiteName === 'screenshots') {
      const m = /^(.*) — (portrait|landscape)$/.exec(row.title)
      if (m) {
        const dev = devices.find((d) => d.label === m[1])
        if (dev) { deepLink = { device: dev.id, portrait: m[2] === 'portrait' ? 1 : 0 }; note = dev.note }
      }
    }
    byFile.get(row.file).push({ ...row, deepLink, note })
  }

  const files = []
  for (const [file, tests] of byFile) {
    let description = ''
    try { description = nearestDocComment(await readFile(resolve(E2E_DIR, file), 'utf8')) } catch { /* best-effort */ }
    // Same file-level aggregate shape unitDetails() computes — the Tests
    // tab's dot-grid squares (both suites) read status/passed/total off the
    // file itself, not off individual rows.
    const passed = tests.filter((t) => t.status === 'passed').length
    const failed = tests.filter((t) => t.status === 'failed' || t.status === 'timedOut').length
    files.push({ file, description, tests, status: failed ? 'fail' : 'pass', passed, failed, total: tests.length })
  }
  files.sort((a, b) => a.file.localeCompare(b.file))
  return { available: true, generatedAt: report.stats?.startTime ?? null, overview, files }
}

/**
 * Unit suite equivalent of testDetails() — separate function rather than a
 * third branch threaded through it, since vitest's JSON reporter is a
 * different (Jest-compatible) shape entirely (testResults/assertionResults,
 * not Playwright's suites/specs) and none of e2e's device-deep-link/
 * doc-comment logic applies here. Gives the Tests tab's unit-suite square
 * one entry per test FILE with a pass/fail status, for the "green dots per
 * module" view — see CLAUDE.md's Tests-tab restructure notes.
 */
// vitest's JSON reporter writes r.name as an ABSOLUTE path from whatever
// machine actually ran the suite — the "unit" suite runs on the real HOST
// (tools/spec/host-runner.mjs; this container's own node_modules native addons
// don't match its Alpine/musl userland, per CLAUDE.md's own note), while
// this server reads the result file from INSIDE the container, where ROOT
// resolves to /repo, not the host's own path — so relative(ROOT, r.name)
// computes a relative path between two unrelated filesystems and produces
// garbage. A plain string search for the '/src/' segment (vitest always
// normalizes to forward slashes, even on a Windows host) sidesteps this
// entirely: it needs no assumption about what either machine calls its own
// repo root, only that the test file lives under src/ — true for every
// vitest file in this repo.
function relFromTestName(name) {
  const norm = String(name).replace(/\\/g, '/')
  const idx = norm.indexOf('/src/')
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

async function unitDetails() {
  let report
  try { report = JSON.parse(await readFile(UNIT_JSON_FILE, 'utf8')) } catch { return { available: false } }
  const files = (report.testResults || []).map((r) => {
    const rel = relFromTestName(r.name)
    const assertions = r.assertionResults || []
    const passed = assertions.filter((a) => a.status === 'passed').length
    const failed = assertions.filter((a) => a.status === 'failed').length
    // Raw milliseconds (a number), not pre-formatted — matches
    // flattenPlaywrightJson()'s row.duration contract exactly, since
    // buildTestFileGroup() on the client does its own (t.duration/1000)
    // formatting and expects a number either way.
    return {
      file: rel,
      status: r.status === 'passed' ? 'pass' : 'fail',
      passed, failed, total: assertions.length,
      duration: (r.endTime != null && r.startTime != null) ? Math.round(r.endTime - r.startTime) : null,
      tests: assertions.map((a) => ({
        title: a.fullName || a.title,
        status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : a.status,
        duration: a.duration != null ? Math.round(a.duration) : null,
      })),
    }
  })
  files.sort((a, b) => a.file.localeCompare(b.file))
  return { available: true, generatedAt: report.startTime ?? null, files }
}

async function listScreenshots() {
  let devices
  try { devices = await readdir(SCREENSHOTS_DIR, { withFileTypes: true }) } catch { return { devices: [] } }

  const out = []
  for (const d of devices) {
    if (!d.isDirectory()) continue
    const devPath = resolve(SCREENSHOTS_DIR, d.name)
    let orientations
    try { orientations = await readdir(devPath, { withFileTypes: true }) } catch { continue }

    const orientList = []
    for (const o of orientations) {
      if (!o.isDirectory()) continue
      const oriPath = resolve(devPath, o.name)
      let entries
      try { entries = await readdir(oriPath, { withFileTypes: true }) } catch { continue }

      const files = []
      let latest = 0
      for (const f of entries) {
        if (!f.isFile()) continue
        const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
        if (!IMG_EXT.has(ext)) continue
        const st = await stat(resolve(oriPath, f.name))
        const mtime = st.mtimeMs
        if (mtime > latest) latest = mtime
        files.push({
          name: f.name,
          path: relative(SCREENSHOTS_DIR, resolve(oriPath, f.name)).split(sep).join('/'),
          mtime: new Date(mtime).toISOString(),
          sizeKB: Math.round(st.size / 1024),
        })
      }
      if (!files.length) continue
      files.sort((a, b) => a.name.localeCompare(b.name))
      orientList.push({ name: o.name, count: files.length, capturedAt: latest ? new Date(latest).toISOString() : null, files })
    }
    if (!orientList.length) continue
    orientList.sort((a, b) => a.name.localeCompare(b.name))
    const capturedAt = orientList.reduce((max, o) => (o.capturedAt && o.capturedAt > max ? o.capturedAt : max), '')
    out.push({ name: d.name, capturedAt: capturedAt || null, orientations: orientList })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return { devices: out }
}

// Temporary ART review gallery — walks the whole image-gen output tree
// (every dated batch, every style-variant subfolder) and reports each file's
// current mark state. A file is "marked" purely by its own filename carrying
// ART_DELETE_MARK before the extension (e.g. `apple_v3_DELETE.png`) — there
// is no separate index/sidecar to go stale, the rename IS the state.
function isArtMarked(filename) {
  const dot = filename.lastIndexOf('.')
  const stem = dot === -1 ? filename : filename.slice(0, dot)
  return stem.endsWith(ART_DELETE_MARK)
}

async function walkArtImages(dir, relBase = '') {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    const abs = resolve(dir, e.name)
    const rel = relBase ? `${relBase}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(...(await walkArtImages(abs, rel)))
      continue
    }
    if (!e.isFile()) continue
    const ext = '.' + (e.name.split('.').pop() || '').toLowerCase()
    if (!IMG_EXT.has(ext)) continue
    const st = await stat(abs)
    out.push({
      path: rel.split(sep).join('/'),
      name: e.name,
      marked: isArtMarked(e.name),
      mtime: new Date(st.mtimeMs).toISOString(),
      sizeKB: Math.round(st.size / 1024),
    })
  }
  return out
}

// Groups the flat file list the same way the Screenshots tab groups by
// device→orientation: top-level path segment = "batch" (a dated review
// folder), everything after that = "group" (e.g. a game/style subfolder) so
// the client can render nested foldout accordions identically to Screenshots.
async function listArt() {
  const files = await walkArtImages(ART_ROOT)
  const batches = new Map()
  for (const f of files) {
    const parts = f.path.split('/')
    const batchName = parts[0]
    const groupName = parts.slice(1, -1).join('/') || '(root)'
    if (!batches.has(batchName)) batches.set(batchName, new Map())
    const groups = batches.get(batchName)
    if (!groups.has(groupName)) groups.set(groupName, [])
    groups.get(groupName).push(f)
  }
  const out = []
  for (const [batchName, groups] of batches) {
    const groupList = []
    for (const [groupName, groupFiles] of groups) {
      groupFiles.sort((a, b) => a.name.localeCompare(b.name))
      groupList.push({
        name: groupName,
        count: groupFiles.length,
        marked: groupFiles.filter((f) => f.marked).length,
        files: groupFiles,
        latest: groupFiles.reduce((max, f) => (f.mtime > max ? f.mtime : max), ''),
      })
    }
    groupList.sort((a, b) => a.name.localeCompare(b.name))
    out.push({
      name: batchName,
      count: groupList.reduce((n, g) => n + g.count, 0),
      marked: groupList.reduce((n, g) => n + g.marked, 0),
      groups: groupList,
      latest: groupList.reduce((max, g) => (g.latest > max ? g.latest : max), ''),
    })
  }
  // Not every top-level entry is a dated batch folder — some are loose stray
  // files sitting directly under ART_ROOT — so sort by each batch's own most
  // recently modified file rather than its folder name, otherwise an
  // in-progress batch (e.g. `2026-08-17-review-batch`) can sort BELOW an old
  // loose file just because '2' < 'z' alphabetically.
  out.sort((a, b) => b.latest.localeCompare(a.latest))
  return { batches: out }
}

// ── http helpers ─────────────────────────────────────────────────────────────
const json = (res, status, body) => {
  const s = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(s)
}

// ── suggestion votes ─────────────────────────────────────────────────────────
// Shape: { "R-01": { up: [name, …], down: [name, …] }, … }
// A voter is the display name the browser asks for on the first vote ("Who is
// this?") and keeps in localStorage — not a login account, and not verified.
// Names compare case-insensitively, so "Ilia" and "ilia" are one voter.
// Storing the name list rather than a bare counter is what lets a voter change
// or retract a vote without the tally drifting, and lets the page show who voted.
const VOTE_ID_RE = /^[RXMGD]-\d{2}$/
const VOTER_MAX = 40
/** Trimmed, whitespace-collapsed name, or '' if unusable. */
function normVoter(raw) {
  if (typeof raw !== 'string') return ''
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  return n.length >= 1 && n.length <= VOTER_MAX ? n : ''
}
const sameVoter = (a, b) => a.toLowerCase() === b.toLowerCase()

async function readVotes() {
  try { return JSON.parse(await readFile(VOTES_FILE, 'utf8')) } catch { return {} }
}

// Every write goes through this one chained promise. The server is a single
// process, so serialising read-modify-write here is enough to make concurrent
// votes safe — two voters clicking at once cannot clobber each other.
let voteWriteChain = Promise.resolve()
function writeVotes(mutate) {
  voteWriteChain = voteWriteChain.then(async () => {
    const votes = await readVotes()
    const result = mutate(votes)
    writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2) + '\n')
    return result
  })
  return voteWriteChain
}

const tally = (votes) => {
  const out = {}
  for (const [id, v] of Object.entries(votes)) {
    out[id] = { up: (v?.up || []).length, down: (v?.down || []).length, upBy: v?.up || [], downBy: v?.down || [] }
  }
  return out
}
const myVote = (votes, voter) => {
  const out = {}
  if (!voter) return out
  for (const [id, v] of Object.entries(votes)) {
    if ((v?.up || []).some((n) => sameVoter(n, voter))) out[id] = 'up'
    else if ((v?.down || []).some((n) => sameVoter(n, voter))) out[id] = 'down'
  }
  return out
}

// ── Audio tab (S-235) ────────────────────────────────────────────────────────
// Plumbing (roots, ids, state/queue files) lives in audio-lib.mjs, shared with
// tools/generate/audio-gen-runner.mjs. See README.md "Audio tab" for the file schemas.

/** Picks the newest e2e-artifacts screenshot for a catalog `screens` entry
 *  ({ screen:'game-playing', device?, orientation?, note? }). The numeric
 *  prefix of the filename drifts between suite runs (stale + fresh files can
 *  coexist), so we match on the name part and take the most recent mtime. */
async function findScreenshot(spec) {
  const re = new RegExp('^\\d+-' + String(spec.screen).replace(/[^a-z0-9-]/gi, '') + '\\.(png|webp|jpe?g)$', 'i')
  let devices
  try { devices = (await readdir(SCREENSHOTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return null }
  if (spec.device && devices.includes(spec.device)) devices = [spec.device, ...devices.filter((d) => d !== spec.device)]
  for (const dev of devices) {
    let oris
    try { oris = (await readdir(resolve(SCREENSHOTS_DIR, dev), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { continue }
    if (spec.orientation && oris.includes(spec.orientation)) oris = [spec.orientation, ...oris.filter((o) => o !== spec.orientation)]
    for (const ori of oris) {
      let files
      try { files = await readdir(resolve(SCREENSHOTS_DIR, dev, ori)) } catch { continue }
      let best = null
      for (const f of files) {
        if (!re.test(f)) continue
        const st = await stat(resolve(SCREENSHOTS_DIR, dev, ori, f))
        if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs }
      }
      if (best) return { path: `${dev}/${ori}/${best.f}`, device: dev, orientation: ori, screen: spec.screen, note: spec.note || '', capturedAt: new Date(best.mtimeMs).toISOString() }
    }
  }
  return null
}

async function audioOverview() {
  const [data, queue, astate] = await Promise.all([listAudio(), readQueue(), readState()])
  for (const s of data.sounds) {
    s.meta = audioMeta(s.name, s.kind, astate.files[s.name] || {}, !!s.live)
    s.screenshots = (await Promise.all((s.screens || []).map(findScreenshot))).filter(Boolean)
    delete s.screens
  }
  const jobs = queue.jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60)
  return { ...data, jobs, stateFile: relative(ROOT, STATE_FILE).split(sep).join('/'), queueFile: relative(ROOT, QUEUE_FILE).split(sep).join('/') }
}

/** Streams an audio file with HTTP Range support (needed for <audio> seeking,
 *  and Safari refuses to play media without it). */
async function serveAudio(req, res, abs) {
  let st
  try { st = await stat(abs) } catch { return json(res, 404, { error: 'not found' }) }
  const ext = '.' + (abs.split('.').pop() || '').toLowerCase()
  const type = AUDIO_MIME[ext] || 'application/octet-stream'
  const size = st.size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  let start = 0, end = size - 1, status = 200
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), size - 1) }
    else { start = Math.max(0, size - Number(range[2])) } // suffix range: last N bytes
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    status = 206
  }
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-cache' }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(status, headers)
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res)
}

const cleanText = (v, max = 4000) => String(v ?? '').replace(/\0/g, '').slice(0, max)

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolvePromise({})
      try { resolvePromise(JSON.parse(raw)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

// ── static ───────────────────────────────────────────────────────────────────
// Fixed allow-list rather than a path join: there is no traversal surface here.
// Every path below serves the one SPA shell (public/index.html reads
// location.pathname on load to pick the right super-tab/sub-tab) so a direct
// link or page refresh always lands in the right place, not just in-page nav
// clicks. The canonical routes are the two-level /<super>/<sub> ones; the
// bare-super (no sub) and pre-reorg legacy paths are kept working too since
// they may be bookmarked — index.html's own tabForPath()/subForPath() decide
// what each one resolves to.
const STATIC = {
  '/sw.js': ['public/sw.js', 'text/javascript; charset=utf-8'],
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/stubs': ['public/index.html', 'text/html; charset=utf-8'],
  '/tests': ['public/index.html', 'text/html; charset=utf-8'],
  '/work': ['public/index.html', 'text/html; charset=utf-8'],
  '/manage': ['public/index.html', 'text/html; charset=utf-8'],
  '/assets': ['public/index.html', 'text/html; charset=utf-8'],
  '/assets/audio': ['public/index.html', 'text/html; charset=utf-8'],
  '/assets/images': ['public/index.html', 'text/html; charset=utf-8'],
  '/assets/localization': ['public/index.html', 'text/html; charset=utf-8'],
  '/assets/manual': ['public/index.html', 'text/html; charset=utf-8'],
  '/product': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/suggestions': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/feedback': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/gdpr': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/regulations': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/appreview': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/license-v2': ['public/index.html', 'text/html; charset=utf-8'],
  '/product/license-v2/page': ['public/license-v2.html', 'text/html; charset=utf-8'],
  '/product/license-v2/fable': ['public/license-v2-fable.html', 'text/html; charset=utf-8'],
  '/product/feature/page': ['public/feature.html', 'text/html; charset=utf-8'],
  '/downloads': ['public/index.html', 'text/html; charset=utf-8'],
  '/downloads/spec': ['public/index.html', 'text/html; charset=utf-8'],
  '/downloads/build': ['public/index.html', 'text/html; charset=utf-8'],
  '/downloads/web': ['public/index.html', 'text/html; charset=utf-8'],
  // Legacy pre-reorg paths — kept working for old bookmarks/links.
  '/art': ['public/index.html', 'text/html; charset=utf-8'],
  '/audio': ['public/index.html', 'text/html; charset=utf-8'],
  '/localization': ['public/index.html', 'text/html; charset=utf-8'],
  '/suggestions': ['public/index.html', 'text/html; charset=utf-8'],
  '/feedback-editor': ['public/index.html', 'text/html; charset=utf-8'],
  '/gdpr': ['public/index.html', 'text/html; charset=utf-8'],
}

function downloadPwCookie(req) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'dl_pw') return decodeURIComponent(v.join('='))
  }
  return null
}

// Cheap snapshot of every work item's and stub's state: polled by the page's toggle and diffed server-side for Web Push.
async function watchSnapshot(domain) {
  const [stubs, questions] = await Promise.all([specJson(['list', 'all'], domain).catch(() => []), specJson(['questions'], domain).catch(() => [])])
  // Ready to enable = deferred with no unanswered blocking question (what `spec enable-ready` accepts).
  const blocked = new Set(questions.filter((q) => q.blocking).map((q) => q.id))
  // The nightly run truncates its log when it starts and ends it with a "done" line, so that line is the finish signal.
  let nightly = { running: false, finishedAt: null, summary: '' }
  try {
    const f = resolve(DOWNLOADS_DIR, '..', 'nightly-log.txt')
    const text = await readFile(f, 'utf8'), m = /\[nightly-run\] done — (\{.*\})\s*$/m.exec(text.slice(-4000))
    if (m) {
      let r = {}; try { r = JSON.parse(m[1]) } catch { /* summary stays empty */ }
      const bad = Object.entries(r).filter(([, v]) => v === 'fail').map(([k]) => k)
      nightly = { running: false, finishedAt: (await stat(f)).mtimeMs, summary: bad.length ? 'Failed: ' + bad.join(', ') : 'Everything passed' }
    } else nightly.running = true
  } catch { /* no nightly yet */ }
  return {
    work: work.list(domain).map((w) => ({ id: w.id, title: w.title, status: w.status, waiting: !!w.waitingHuman })),
    stubs: stubs.map((s) => ({ id: s.id, title: s.title, status: s.status, ready: s.status === 'deferred' && !blocked.has(s.id) })),
    nightly,
    // START WORKING runs are global (one at a time), so the push watcher reports them from one registry only.
    lastRun: (() => { const r = latestRun('finish-stubs'); return r ? { id: r.id, status: r.status, summary: String((Array.isArray(r.summary) ? r.summary[0] : r.summary) || '').split('\n')[0].replace(/^-\s*/, '').slice(0, 140) } : null })(),
  }
}

// Creates a run and hands it to a worker: the host-runner when this server is in Docker, else a detached local process.
async function launchRun(kind, params) {
  const current = activeRun()
  if (current) return { status: 409, body: { error: 'a run is already in progress', run: current } }
  const run = createRun(kind, params)
  if (IN_DOCKER) {
    // The container has no claude; the host-runner on the PC spawns the worker. Same repo, so state is shared.
    try {
      const hostRes = await fetch(`${HOST_RUNNER_URL}/agent/start`, {
        method: 'POST',
        headers: { 'x-runner-token': HOST_RUNNER_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: run.id }),
      })
      if (!hostRes.ok) throw new Error(`host-runner answered HTTP ${hostRes.status}`)
    } catch (err) {
      markFailed(run.id, `Could not start on the host: ${err.message}. Start it on your PC: npm run spec:host-runner`)
      return { status: 502, body: { error: 'Could not reach the host-runner. Start it on your PC first: npm run spec:host-runner' } }
    }
  } else {
    startWorker(run.id)
  }
  return { status: 200, body: { ok: true, run: runView(run) } }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  // The tab icon (the app's logo). Public like /login: the browser asks for it before anyone has signed in,
  // and it is a fixed allow-list of two files, never a path from the request.
  const ICONS = { '/favicon.ico': 'favicon.png', '/favicon.png': 'favicon.png', '/apple-touch-icon.png': 'apple-touch-icon.png' }
  if (ICONS[path] && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const body = await readFile(resolve(HERE, 'public', ICONS[path]))
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch { res.writeHead(404); res.end() }
    return
  }

  // ── login — deliberately OUTSIDE the auth gate below (it IS how you get
  // past it). Both the page and the credential-check API must work with
  // zero prior auth state.
  if (path === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(LOGIN_PAGE_HTML)
    return
  }
  if (path === '/api/login' && req.method === 'POST') {
    let b
    try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
    const role = credentialsOk(String(b?.username ?? ''), String(b?.password ?? ''))
    if (!role) return json(res, 401, { error: 'wrong username or password' })
    const token = createSession(role)
    res.setHeader('set-cookie', `spec_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`)
    json(res, 200, { ok: true })
    return
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = sessionCookie(req)
    if (token) { sessions.delete(tokenKey(token)); saveSessions() }
    res.setHeader('set-cookie', 'spec_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    json(res, 200, { ok: true })
    return
  }

  // ── client-facing download page — deliberately OUTSIDE the main auth
  // gate below. This is the one surface meant to be handed to people who
  // don't have (and shouldn't need) access to the private spec tool itself;
  // it carries its own separate password instead. Every route under here
  // must re-check the password itself — nothing upstream does it for them.
  if (path === '/download') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(DOWNLOAD_PAGE_HTML)
    return
  }
  if (path === '/api/build/public') {
    const pw = url.searchParams.get('pw') || downloadPwCookie(req)
    if (!downloadPwOk(pw)) return json(res, 401, { error: 'wrong password' })
    if (url.searchParams.get('pw')) {
      res.setHeader('set-cookie', `dl_pw=${encodeURIComponent(pw)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`)
    }
    let data = null
    try { data = JSON.parse(await readFile(BUILD_MANIFEST_FILE, 'utf8')) } catch { /* no nightly build yet */ }
    json(res, 200, data ?? { available: false })
    return
  }
  if (path === '/api/build/client-download') {
    const pw = url.searchParams.get('pw') || downloadPwCookie(req)
    if (!downloadPwOk(pw)) return json(res, 401, { error: 'wrong password' })
    let stats
    try { stats = await stat(BUILD_APK_FILE) } catch { return json(res, 404, { error: 'no build available yet' }) }
    const body = await readFile(BUILD_APK_FILE)
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': stats.size,
      'content-disposition': 'attachment; filename="playwork-debug-latest.apk"',
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }

  // ── public customer feedback survey (S-248) — deliberately OUTSIDE the
  // main auth gate below, and with NO password of any kind (unlike
  // /download): a customer must be able to open and submit this with
  // nothing but the link. GET /api/feedback/template is public too, since
  // the survey page itself needs it to render before any auth exists; only
  // the EDITOR's write (POST /api/feedback/template) and the responses view
  // are behind the normal session gate, further down with every other
  // /api/ route.
  if (path === '/feedback' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FEEDBACK_PAGE_HTML)
    return
  }
  if (path === '/api/feedback/template' && req.method === 'GET') {
    json(res, 200, await readFeedbackTemplate())
    return
  }
  if (path === '/api/feedback/submit' && req.method === 'POST') {
    let b
    try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
    const out = await appendFeedbackSubmission({ email: b?.email, answers: b?.answers })
    json(res, out.ok ? 200 : 400, out)
    return
  }

  // Auth gate — everything below is the private spec tool; a live session
  // (see /api/login above) is required except for --no-auth (a strictly
  // local session) and the /login + /download surfaces above. A page
  // navigation (no `accept: application/json` and not an /api/ path) gets
  // redirected straight to /login (with `?next=` so it lands back where it
  // was headed); an API call gets a plain 401 JSON so the client's own
  // fetch wrapper can react (see index.html's `post()`) instead of a
  // redirect silently swallowing a POST body.
  const session = NO_AUTH ? { role: 'admin' } : sessionValid(sessionCookie(req))
  if (!session) {
    if (path.startsWith('/api/')) return json(res, 401, { error: 'not authenticated', loginRequired: true })
    res.writeHead(302, { location: '/login?next=' + encodeURIComponent(path + url.search) })
    res.end()
    return
  }
  // Translator role: only the Localization tab and its /api/loc* routes.
  if (session.role === 'translator' && !translatorAllowed(path)) {
    if (path.startsWith('/api/')) return json(res, 403, { error: 'not allowed for the translator role' })
    res.writeHead(302, { location: '/assets/localization' })
    res.end()
    return
  }

  // Tester role: only the dev web build (/web-build/), nothing of the spec tool.
  if (session.role === 'tester' && !testerAllowed(path)) {
    if (path.startsWith('/api/')) return json(res, 403, { error: 'not allowed for the tester role' })
    res.writeHead(302, { location: WEBAPP_BASE })
    res.end()
    return
  }

  // Manage tool (prod licenses/balls/customers): admin only, plus its own second password (tools/manage).
  if (path === '/manage/page' || path.startsWith('/api/manage/')) {
    if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
    if (await manage(req, res, url, { key: sessionCookie(req) || 'local', actor: 'spec-web admin' })) return
  }

  // The dev web build (behind the same login gate as everything else here).
  if (isWebAppPath(path) && (req.method === 'GET' || req.method === 'HEAD')) return serveWebApp(req, res, path)

  try {
    // ── static ──
    if (STATIC[path]) {
      const [rel, type] = STATIC[path]
      let body = await readFile(resolve(HERE, rel), 'utf8')
      // Tell the page which role it is rendering for (see PW_ROLE in index.html).
      if (rel === 'public/index.html') body = body.replace("/*__PW_ROLE__*/'admin'", JSON.stringify(session.role))
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    // ── read APIs ──
    if (path === '/api/bootstrap' && req.method === 'GET') {
      const domain = domainOf(url.searchParams.get('domain'))
      // The `analyzed`/`analyzedAt` tracking file below is a side-artifact of
      // THIS repo's own finish-ready-stubs skill run — it only ever has
      // entries for the app-domain registry. The backend registry's own
      // equivalent skill (finish-ready-backend-stubs) runs inside the
      // separate playwork-backend repo and writes its tracking file there,
      // unreachable from here — so the analyzed gate below (and the "not yet
      // analyzed" badge) is deliberately skipped for domain:'backend' rather
      // than showing every backend stub as permanently unanalyzed.
      const [stubs, questions, check, analysis] = await Promise.all([
        specJson(['list', 'all'], domain),
        specJson(['questions'], domain),
        spec(['check'], domain),
        domain === 'app' ? readStubAnalysis() : Promise.resolve(null),
      ])
      if (analysis) {
        // Stamp `analyzed`/`analyzedAt` onto every top-level stub AND every
        // nested sub-stub, from the skill's own side-tracking file — see
        // readStubAnalysis() above. A stub with no entry is simply
        // `analyzed: false`; this never blocks reading, only the SET READY
        // button (client-side) and the enabled transition itself (server-side,
        // in /api/status below).
        const stamp = (s) => {
          const a = analysis[s.id]
          s.analyzed = !!a
          s.analyzedAt = a?.lastAnalyzedAt ?? null
          if (s.subStubs) s.subStubs.forEach(stamp)
          return s
        }
        stubs.forEach(stamp)
      } else {
        stubs.forEach((s) => { s.analyzed = true; s.analyzedAt = null })
      }
      json(res, 200, {
        domain,
        stubs,
        questions,
        check: { ok: check.ok, text: stripAnsi(check.stdout + check.stderr).trim() },
      })
      return
    }

    // The Spec tab shows the OFFICIAL spec (docs/spec/*.md), never the stub registry:
    // stubs live in the Stubs tab. `doc` must be a key from specDocs(), never a filesystem path.
    if (path === '/api/spec/index' && req.method === 'GET') {
      json(res, 200, { docs: (await specDocs(domainOf(url.searchParams.get('domain')))).map(({ key, title }) => ({ key, title })) })
      return
    }
    if (path === '/api/spec' && req.method === 'GET') {
      const docs = await specDocs(domainOf(url.searchParams.get('domain')))
      const doc = docs.find((d) => d.key === url.searchParams.get('doc')) ?? docs[0]
      if (!doc) { json(res, 404, { error: 'no spec documents' }); return }
      const body = await readFile(doc.path, 'utf8')
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-doc-hash': hashOf(body) })
      res.end(body)
      return
    }

    // Lines of the working file that differ from git (index, else HEAD), 1-based, for the
    // Spec tab's change highlighting. Read-only; `doc` is an allow-listed key, never a path.
    if (path === '/api/spec/changes' && req.method === 'GET') {
      const docs = await specDocs(domainOf(url.searchParams.get('domain')))
      const doc = docs.find((d) => d.key === url.searchParams.get('doc'))
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      const base = await gitShowFile(relative(ROOT, doc.path).split(sep).join('/'))
      if (base.error) { json(res, 200, { gitOk: false, error: base.error, changed: [], removed: 0, ref: null }); return }
      json(res, 200, { gitOk: true, ref: base.ref, ...changedLines(base.text, await readFile(doc.path, 'utf8')) })
      return
    }

    // Save ONE section of a spec document (a heading plus what follows it up to the next heading).
    // Admin only. The client sends the section's old text with its 0-based start line and line count;
    // it is spliced in only if those lines still read exactly that, so an edit elsewhere in the file
    // (e.g. by Claude) does not conflict, but an edit to this very section is a 409.
    if (path === '/api/spec/save-section' && req.method === 'POST') {
      if (session.role !== 'admin') { json(res, 403, { error: 'admin only' }); return }
      let b
      try { b = await readBody(req, 2 * 1024 * 1024) } catch (e) { json(res, 400, { error: String(e.message || e) }); return }
      const docs = await specDocs(domainOf(b?.domain))
      const doc = docs.find((d) => d.key === b?.doc)
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      const { startLine, lineCount, oldText, newText } = b
      if (!Number.isInteger(startLine) || !Number.isInteger(lineCount) || startLine < 0 || lineCount < 1 || typeof oldText !== 'string' || typeof newText !== 'string') {
        json(res, 400, { error: 'startLine, lineCount, oldText and newText required' }); return
      }
      const current = await readFile(doc.path, 'utf8')
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const lines = current.split(/\r?\n/)
      if (lines.slice(startLine, startLine + lineCount).join('\n') !== oldText.replace(/\r\n/g, '\n')) {
        json(res, 409, { error: 'This section changed on disk since you opened it. Reload and re-apply your edit.' }); return
      }
      const by = cleanName(normVoter(b.by))
      if (!by) { json(res, 400, { error: 'Say who you are before saving.' }); return }
      lines.splice(startLine, lineCount, ...newText.replace(/\r\n/g, '\n').split('\n'))
      const text = lines.join(eol)
      work.recordEdit({ domain: domainOf(b?.domain), doc: doc.key, title: doc.title, before: current, after: text, by })
      const tmp = doc.path + '.tmp-' + process.pid
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, doc.path)
      json(res, 200, { ok: true, hash: hashOf(text) })
      return
    }

    // Save an edited spec document. Admin only (the translator/tester allow-lists already
    // refuse /api/spec/*; this is the explicit second check). `base` is the hash the editor
    // loaded, so a concurrent edit (e.g. Claude rewriting the file) is a 409, never a silent overwrite.
    if (path === '/api/spec/save' && req.method === 'POST') {
      if (session.role !== 'admin') { json(res, 403, { error: 'admin only' }); return }
      let b
      try { b = await readBody(req, 2 * 1024 * 1024) } catch (e) { json(res, 400, { error: String(e.message || e) }); return }
      const docs = await specDocs(domainOf(b?.domain))
      const doc = docs.find((d) => d.key === b?.doc)
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      if (typeof b.content !== 'string' || typeof b.base !== 'string') { json(res, 400, { error: 'content and base required' }); return }
      const current = await readFile(doc.path, 'utf8')
      if (hashOf(current) !== b.base) { json(res, 409, { error: 'The file changed on disk since you opened it. Reload and re-apply your edit.' }); return }
      // Keep the file's existing line endings so the git diff only shows real edits.
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const by = cleanName(normVoter(b.by))
      if (!by) { json(res, 400, { error: 'Say who you are before saving.' }); return }
      const text = b.content.replace(/\r\n/g, '\n').replace(/\n/g, eol)
      work.recordEdit({ domain: domainOf(b?.domain), doc: doc.key, title: doc.title, before: current, after: text, by })
      const tmp = doc.path + '.tmp-' + process.pid
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, doc.path)
      json(res, 200, { ok: true, hash: hashOf(text) })
      return
    }

    // Download the open spec document as a file (the Spec tab's Download button).
    if (path === '/api/spec/doc-download' && req.method === 'GET') {
      const doc = (await specDocs(domainOf(url.searchParams.get('domain')))).find((d) => d.key === url.searchParams.get('doc'))
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${doc.path.split(sep).pop()}"`,
        'cache-control': 'no-store',
      })
      res.end(await readFile(doc.path, 'utf8'))
      return
    }

    // Replace the whole open spec document with an uploaded file. Admin only. It is recorded as the person's edit, like a save,
    // so it joins the pile of changes and Undo changes can take it back.
    if (path === '/api/spec/upload' && req.method === 'POST') {
      if (session.role !== 'admin') { json(res, 403, { error: 'admin only' }); return }
      let b
      try { b = await readBody(req, 2 * 1024 * 1024) } catch (e) { json(res, 400, { error: String(e.message || e) }); return }
      const doc = (await specDocs(domainOf(b?.domain))).find((d) => d.key === b?.doc)
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      if (typeof b.content !== 'string' || !b.content.trim()) { json(res, 400, { error: 'the uploaded file is empty' }); return }
      const by = cleanName(normVoter(b.by))
      if (!by) { json(res, 400, { error: 'Say who you are before uploading.' }); return }
      const current = await readFile(doc.path, 'utf8')
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const text = b.content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n/g, eol)
      work.recordEdit({ domain: domainOf(b?.domain), doc: doc.key, title: doc.title, before: current, after: text, by })
      const tmp = doc.path + '.tmp-' + process.pid
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, doc.path)
      json(res, 200, { ok: true, hash: hashOf(text) })
      return
    }

    // Put the open spec document back to how it was before the changes: the text it had when the current round of edits began,
    // else git's copy (index, then HEAD). Admin only.
    if (path === '/api/spec/undo' && req.method === 'POST') {
      if (session.role !== 'admin') { json(res, 403, { error: 'admin only' }); return }
      let b
      try { b = await readBody(req) } catch (e) { json(res, 400, { error: String(e.message || e) }); return }
      const domain = domainOf(b?.domain)
      const doc = (await specDocs(domain)).find((d) => d.key === b?.doc)
      if (!doc) { json(res, 404, { error: 'unknown spec document' }); return }
      const by = cleanName(normVoter(b.by))
      if (!by) { json(res, 400, { error: 'Say who you are before undoing.' }); return }
      const current = await readFile(doc.path, 'utf8')
      const collected = work.baselineOf(domain, doc.key)
      let original = collected, ref = 'before your edits'
      if (original == null) {
        const g = await gitShowFile(relative(ROOT, doc.path).split(sep).join('/'))
        if (g.error) { json(res, 409, { error: 'There is no original to go back to: ' + g.error }); return }
        original = g.text; ref = 'git ' + g.ref
      }
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const text = original.replace(/\r\n/g, '\n').replace(/\n/g, eol)
      if (text === current) { json(res, 200, { ok: true, unchanged: true, ref }); return }
      if (collected != null) work.recordEdit({ domain, doc: doc.key, title: doc.title, before: current, after: text, by })
      const tmp = doc.path + '.tmp-' + process.pid
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, doc.path)
      json(res, 200, { ok: true, hash: hashOf(text), ref })
      return
    }

    // Generic static-doc fetch for Suggestions / App Review / Images — see
    // DOC_FILES above. `key` must be one of the fixed allow-listed names;
    // anything else is a 404, never a filesystem path.
    if (path === '/api/doc' && req.method === 'GET') {
      const key = url.searchParams.get('key') || ''
      const file = DOC_FILES[key]
      if (!file) { json(res, 404, { error: 'unknown doc key' }); return }
      const md = await readFile(file, 'utf8')
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
      res.end(md)
      return
    }

    // Same content as /api/spec above, just with a content-disposition that
    // makes the browser save it as a file instead of rendering/fetching it
    // inline — for the nav's "Download Spec" button.
    if (path === '/api/spec/download' && req.method === 'GET') {
      const domain = domainOf(url.searchParams.get('domain'))
      const md = await readFile(specPathFor(domain), 'utf8')
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${specFileFor(domain)}"`,
        'cache-control': 'no-store',
      })
      res.end(md)
      return
    }


    // ── Localization tab — src/locales/strings.csv as an editable grid, diffed
    // against git's index (see loc-lib.mjs). Not registry-scoped (there is one
    // strings file), so `domain` is ignored here.
    if (path === '/api/loc' && req.method === 'GET') {
      const text = await readFile(LOC_PATH, 'utf8')
      const base = await gitBase(ROOT)
      const out = { file: LOC_REL, ...parseGrid(text), gitOk: !base.error, gitError: base.error || null, baseRef: base.ref || null }
      if (!base.error) { const bg = parseGrid(base.text); out.base = bg.rows; out.baseHeader = bg.header }
      return json(res, 200, out)
    }
    if (path === '/api/loc/download' && req.method === 'GET') {
      // ?langs=en,fr,he → key + just those columns (partial file); omitted → the whole file, byte-identical.
      let body = await readFile(LOC_PATH, 'utf8'), name = 'strings.csv'
      const langs = (url.searchParams.get('langs') || '').split(',').map((x) => x.trim()).filter(Boolean)
      if (langs.length) {
        const r = subsetCsv(body, langs)
        if (r.error) return json(res, 400, { error: r.error })
        body = r.text
        name = 'strings-' + r.columns.slice(1).join('-') + '.csv'
      }
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="' + name + '"',
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }
    if (path === '/api/loc/import' && req.method === 'POST') {
      const b = await readBody(req, 16 * 1024 * 1024)
      const apply = b?.apply === true
      const job = async () => {
        try {
          const r = applyImport(await readFile(LOC_PATH, 'utf8'), String(b?.csv ?? ''))
          if (r.fatal) return { status: 400, body: { ok: false, error: r.fatal } }
          const { text, ...report } = r
          if (apply && r.changed.length) {
            const tmp = LOC_PATH + '.tmp'
            await writeFile(tmp, text, 'utf8')
            await rename(tmp, LOC_PATH)
          }
          return { status: 200, body: { ok: true, applied: apply, ...report } }
        } catch (e) { return { status: 500, body: { ok: false, error: String(e) } } }
      }
      const result = locQueue.then(job)
      locQueue = result
      const r = await result
      return json(res, r.status, r.body)
    }
    if ((path === '/api/loc/cell' || path === '/api/loc/revert') && req.method === 'POST') {
      const b = await readBody(req)
      const key = String(b?.key ?? ''), col = String(b?.col ?? '')
      const isRevert = path === '/api/loc/revert'
      // Serialised read-modify-write so two quick saves can't interleave.
      const job = async () => {
        try {
          const text = await readFile(LOC_PATH, 'utf8')
          let value = b?.value, expected = b?.expected
          if (isRevert) {
            const base = await gitBase(ROOT)
            if (base.error) return { status: 503, body: { ok: false, error: 'git base unavailable: ' + base.error } }
            const { header, rows } = parseGrid(base.text)
            const row = rows.find((r) => r[0].trim() === key)
            const c = header.indexOf(col)
            if (!row || c < 0) return { status: 404, body: { ok: false, error: 'this cell has no baseline in git' } }
            value = row[c]; expected = undefined
          }
          const r = setCell(text, key, col, value, expected)
          if (r.error) return { status: r.status, body: { ok: false, error: r.error, current: r.current } }
          if (!r.unchanged) {
            const tmp = LOC_PATH + '.tmp'
            await writeFile(tmp, r.text, 'utf8')
            await rename(tmp, LOC_PATH)
          }
          return { status: 200, body: { ok: true, before: r.before, value } }
        } catch (e) { return { status: 500, body: { ok: false, error: String(e) } } }
      }
      const result = locQueue.then(job)
      locQueue = result
      const r = await result
      return json(res, r.status, r.body)
    }

    // ── Manual translation tab (manual-lib.mjs): sectioned translation of the
    // in-app manual, one article section at a time. Available to the translator role.
    if (path.startsWith('/api/manual/')) {
      const lang = String(url.searchParams.get('lang') || '')
      try {
        if (path === '/api/manual/overview' && req.method === 'GET') return json(res, 200, await manualI18n.overview(ROOT, lang))
        if (path === '/api/manual/article' && req.method === 'GET') return json(res, 200, await manualI18n.article(ROOT, lang, String(url.searchParams.get('slug') || '')))
        if (path === '/api/manual/mt-status' && req.method === 'GET') return json(res, 200, await manualMt.ollamaStatus())
        if (req.method === 'POST') {
          const b = await readBody(req)
          const l = String(b?.lang ?? '')
          // Draft only (nothing saved): Ollama/TranslateGemma translation of one English section or title.
          if (path === '/api/manual/mt') {
            const art = await manualI18n.article(ROOT, l, String(b?.slug ?? ''))
            if (b?.kind === 'title') return json(res, 200, { ok: true, text: await manualMt.translatePlain(l, art.title.en) })
            const sec = art.sections.find((x) => x.id === b?.id)
            if (!sec) return json(res, 404, { ok: false, error: 'no such section' })
            return json(res, 200, { ok: true, ...(await manualMt.translateSection(ROOT, l, sec.en)) })
          }
          if (path === '/api/manual/section') return json(res, 200, await manualI18n.saveSection(ROOT, l, String(b?.slug ?? ''), b?.id, b?.text))
          if (path === '/api/manual/title')   return json(res, 200, await manualI18n.saveTitle(ROOT, l, String(b?.slug ?? ''), b?.title))
          if (path === '/api/manual/group')   return json(res, 200, await manualI18n.saveGroup(ROOT, l, String(b?.group ?? ''), b?.value))
        }
      } catch (e) { return json(res, e.status || 500, { ok: false, error: String(e.message || e) }) }
    }

    if (path === '/api/stub' && req.method === 'GET') {
      const domain = domainOf(url.searchParams.get('domain'))
      const id = assertId(url.searchParams.get('id'))
      const block = await stubBlock(id, domain)
      if (!block) return json(res, 404, { error: `no stub block for ${id}` })
      json(res, 200, { id, markdown: block })
      return
    }

    // Last-known unit/e2e test run — written by tools/spec/record-test-run.mjs,
    // this endpoint only ever reads. Missing file = "never run yet", not an
    // error, so the Tests tab can render a plain "no run recorded" state.
    if (path === '/api/test-status' && req.method === 'GET') {
      let data = {}
      try { data = JSON.parse(await readFile(TEST_STATUS_FILE, 'utf8')) } catch { /* no run recorded yet */ }
      json(res, 200, data)
      return
    }

    // Session-state banner — "is someone actively mid-change on this repo
    // right now". Deliberately proxied through the CLI (`spec state get`)
    // rather than reading tools/spec-web/documentation/state/session-state.json directly —
    // the CLI is the one place that knows this file's shape, same discipline
    // as every SPEC_STUBS.md read/write in this server.
    if (path === '/api/session-state' && req.method === 'GET') {
      try { json(res, 200, await specJson(['state', 'get'])) }
      catch { json(res, 200, { state: 'ready', note: null, updatedAt: null }) }
      return
    }

    // Row-by-row test detail view — real per-test rows (title/status/
    // duration) plus each spec file's own doc-comment description, gleaned
    // from the code rather than hand-duplicated. ?suite=e2e|screenshots.
    if (path === '/api/tests/details' && req.method === 'GET') {
      const suiteParam = url.searchParams.get('suite')
      const details = suiteParam === 'unit' ? await unitDetails()
        : await testDetails(suiteParam === 'screenshots' ? 'screenshots' : 'e2e')
      json(res, 200, details)
      return
    }

    // Screenshot browser — the device-matrix e2e suite's own output tree
    // (e2e-artifacts/<device>/<orientation>/<NN-screen>.png), which is
    // gitignored and can be large, so this walks it live rather than
    // shelling out to the spec CLI (which has no reason to know about it).
    if (path === '/api/screenshots' && req.method === 'GET') {
      const tree = await listScreenshots()
      json(res, 200, tree)
      return
    }

    // Serves one screenshot's raw bytes. `path` is a relative path returned
    // by /api/screenshots (never user-typed in normal use) — still resolved
    // and bounds-checked against SCREENSHOTS_DIR so a crafted `../../` can't
    // escape it.
    if (path === '/api/screenshot' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || ''
      const abs = resolve(SCREENSHOTS_DIR, rel)
      const inside = abs === SCREENSHOTS_DIR || abs.startsWith(SCREENSHOTS_DIR + sep)
      const ext = '.' + (abs.split('.').pop() || '').toLowerCase()
      if (!inside || !IMG_EXT.has(ext)) return json(res, 400, { error: 'bad path' })
      let body
      try { body = await readFile(abs) } catch { return json(res, 404, { error: 'not found' }) }
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    // Temporary ART review gallery — see the ART_ROOT/walkArtImages/listArt
    // comments above. Three routes, same shape as the Screenshots trio just
    // above: list the tree, serve one image's bytes, and mark/unmark one
    // file by renaming it (the mark IS the persisted state).
    if (path === '/api/art' && req.method === 'GET') {
      const tree = await listArt()
      json(res, 200, tree)
      return
    }

    if (path === '/api/art/image' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || ''
      const abs = resolve(ART_ROOT, rel)
      const inside = abs === ART_ROOT || abs.startsWith(ART_ROOT + sep)
      const ext = '.' + (abs.split('.').pop() || '').toLowerCase()
      if (!inside || !IMG_EXT.has(ext)) return json(res, 400, { error: 'bad path' })
      let body
      try { body = await readFile(abs) } catch { return json(res, 404, { error: 'not found' }) }
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
      return
    }

    if (path === '/api/art/mark' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const rel = typeof b?.path === 'string' ? b.path : ''
      const marked = !!b?.marked
      const abs = resolve(ART_ROOT, rel)
      const inside = abs === ART_ROOT || abs.startsWith(ART_ROOT + sep)
      const ext = '.' + (abs.split('.').pop() || '').toLowerCase()
      if (!inside || !IMG_EXT.has(ext)) return json(res, 400, { error: 'bad path' })
      const dot = abs.lastIndexOf('.')
      const stem = abs.slice(0, dot)
      const extPart = abs.slice(dot)
      const alreadyMarked = stem.endsWith(ART_DELETE_MARK)
      let newAbs = abs
      if (marked && !alreadyMarked) newAbs = stem + ART_DELETE_MARK + extPart
      else if (!marked && alreadyMarked) newAbs = stem.slice(0, -ART_DELETE_MARK.length) + extPart
      if (newAbs !== abs) {
        try { await rename(abs, newAbs) } catch (e) { return json(res, 500, { error: String(e.message || e) }) }
      }
      const newRel = relative(ART_ROOT, newAbs).split(sep).join('/')
      json(res, 200, { path: newRel, marked })
      return
    }

    // ── Images tab: review of generated art candidates (images-lib.mjs) ──
    if (path === '/api/images' && req.method === 'GET') {
      const listing = await listImages(), state = await readImageState()
      for (const a of listing.assets) a.meta = assetMeta(a, state.assets[a.asset] || {})
      json(res, 200, { ...listing, state, jobs: (await readImageQueue()).jobs.slice(-50) })
      return
    }

    if (path === '/api/images/file' && req.method === 'GET') {
      const abs = resolveImageId(url.searchParams.get('id') || '')
      if (!abs) return json(res, 400, { error: 'bad id' })
      let body
      try { body = await readFile(abs) } catch { return json(res, 404, { error: 'not found' }) }
      res.writeHead(200, { 'content-type': IMG_MIME['.' + abs.split('.').pop().toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' })
      res.end(body)
      return
    }

    // { asset, candidateId?, decision?: 'keep'|'reject', feedback?, multi?: boolean, complete?: boolean } — Keep is exclusive per asset unless `multi` is on; the latest keep is the pick the promote script uses.
    // Without candidateId, `feedback` is the asset's own note for the next generation round.
    if (path === '/api/images/state' && req.method === 'PUT') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const listing = await listImages()
      const asset = listing.assets.find((a) => a.asset === b?.asset)
      if (!asset) return json(res, 400, { error: 'unknown asset' })
      if (b.candidateId !== undefined && !asset.candidates.some((c) => c.id === b.candidateId)) return json(res, 400, { error: 'not a candidate of this asset' })
      if (b.decision !== undefined && !['keep', 'reject'].includes(b.decision)) return json(res, 400, { error: 'decision must be keep or reject' })
      if (b.feedback !== undefined && typeof b.feedback !== 'string') return json(res, 400, { error: 'feedback must be a string' })
      if (b.complete !== undefined && typeof b.complete !== 'boolean') return json(res, 400, { error: 'complete must be true or false' })
      let failure = null
      const entry = await updateImageState((state) => {
        const e = (state.assets[asset.asset] ||= { pick: null, feedback: '', candidates: {}, updatedAt: null })
        e.candidates = e.candidates && typeof e.candidates === 'object' ? e.candidates : {}
        if (b.candidateId !== undefined) {
          if (b.decision !== undefined) setDecision(e, b.candidateId, b.decision)
          if (b.feedback !== undefined) (e.candidates[b.candidateId] ||= { decision: 'reject', feedback: '' }).feedback = cleanText(b.feedback, 1000)
        } else if (b.feedback !== undefined) e.feedback = cleanText(b.feedback)
        if (b.multi !== undefined) setMulti(e, b.multi)
        if (b.complete !== undefined) { try { setComplete(e, b.complete) } catch (err) { failure = err.message } }
        e.updatedAt = new Date().toISOString()
        return e
      })
      if (failure) return json(res, 409, { error: failure })
      // The notes changed: have the local model rewrite them into prompt wording (rules are the fallback), and keep the result with them.
      let result = entry
      const notes = notesFor(entry)
      if (notes !== (entry.rewrite?.notes || '')) {
        const base = composePrompt(asset.group, asset.subject, '').positive
        const llm = notes ? await rewriteNotes({ subject: asset.subject, basePrompt: base, notes, mustAvoid: splitNotes(notes).negative.split(',') }, IN_DOCKER ? { url: HOST_RUNNER_URL, token: HOST_RUNNER_TOKEN } : null) : null
        const ruled = composePrompt(asset.group, asset.subject, notes)
        const rewrite = { notes, positive: llm ? llm.positive : ruled.extraPositive, negative: llm ? llm.negative : ruled.extraNegative, source: llm ? 'claude' : 'rules', at: new Date().toISOString() }
        result = await updateImageState((state) => { const e = state.assets[asset.asset]; if (e && notesFor(e) === notes) e.rewrite = rewrite; return e || entry })
      }
      writeSelectionManifest().catch(() => {})
      json(res, 200, { asset: asset.asset, entry: result, meta: assetMeta(asset, result) })
      return
    }

    // { asset, count 1..8 } — queue N new candidates; tools/generate-runner.mjs on the host generates them.
    if (path === '/api/images/generate' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const listing = await listImages()
      const asset = listing.assets.find((a) => a.asset === b?.asset && a.cataloged)
      if (!asset) return json(res, 400, { error: 'unknown asset' })
      const count = Math.floor(Number(b.count ?? 4))
      if (!(count >= 1 && count <= 8)) return json(res, 400, { error: 'count must be 1..8' })
      const st = (await readImageState()).assets[asset.asset] || {}
      const feedbackSnapshot = cleanText(st.feedback || '')
      const candidateFeedback = Object.entries(st.candidates || {}).filter(([, c]) => c?.feedback && c.decision !== 'keep').map(([id, c]) => ({ id, feedback: cleanText(c.feedback, 1000) }))
      const result = await updateImageQueue((q) => {
        const pending = q.jobs.find((j) => j.asset === asset.asset && (j.status === 'queued' || j.status === 'running'))
        if (pending) return { conflict: pending }
        const p = assetMeta(asset, st).prompt
        const job = { id: newImageJobId(), asset: asset.asset, group: asset.group, subject: asset.subject, count, feedbackSnapshot, candidateFeedback, extraPositive: p.extraPositive, extraNegative: p.extraNegative, status: 'queued', createdAt: new Date().toISOString() }
        q.jobs.push(job)
        return { job }
      })
      if (result.conflict) return json(res, 409, { error: `a generation job for this asset is already ${result.conflict.status}`, job: result.conflict })
      json(res, 200, { job: result.job })
      return
    }

    // Starts the queue runner on the host (the host-runner when this server is in Docker, else a local child) for queued jobs.
    if ((path === '/api/images/run' || path === '/api/audio/run' || path === '/api/gen-queue/run') && req.method === 'POST') {
      if (!(await listGenQueue()).queued.length) return json(res, 200, { started: false, message: 'nothing is queued' })
      if (IN_DOCKER) {
        try {
          const r = await fetch(`${HOST_RUNNER_URL}/gen/run`, { method: 'POST', headers: { 'x-runner-token': HOST_RUNNER_TOKEN } })
          if (!r.ok) throw new Error(`host-runner answered HTTP ${r.status}`)
          return json(res, 200, await r.json())
        } catch (err) {
          return json(res, 502, { error: `Could not reach the host-runner (${err.message}). Start it on your PC: npm run spec:host-runner` })
        }
      }
      const child = spawn(process.execPath, [resolve(ROOT, 'tools', 'generate', 'gen-queue-runner.mjs')], { cwd: ROOT, stdio: 'ignore', detached: true })
      child.unref()
      return json(res, 200, { started: true })
    }

    // The art and audio tabs share one queue (one GPU): both show it and reorder it here.
    if (path === '/api/gen-queue' && req.method === 'GET') return json(res, 200, await listGenQueue())
    if (path === '/api/gen-queue/move' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      if (!['image', 'audio'].includes(b?.kind) || typeof b.id !== 'string' || !['up', 'top'].includes(b.how)) return json(res, 400, { error: 'need kind, id and how (up|top)' })
      const out = await moveGenJob(b.kind, b.id, b.how)
      return out ? json(res, 200, out) : json(res, 409, { error: 'that job is no longer queued' })
    }

    // A job still marked running after its runner died (reboot, crash) never finishes by itself; this marks it failed so it leaves the queue.
    if (path === '/api/gen-queue/clear' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const fail = (q) => { const j = q.jobs.find((x) => x.id === b?.id && x.status === 'running'); if (j) Object.assign(j, { status: 'failed', finishedAt: new Date().toISOString(), error: 'cleared by hand: the runner was not running' }); return !!j }
      const hit = b?.kind === 'image' ? await updateImageQueue(fail) : b?.kind === 'audio' ? await updateQueue(fail) : false
      return hit ? json(res, 200, await listGenQueue()) : json(res, 409, { error: 'that job is not running' })
    }

    // Deletes one generated image for good (file, thumbnail and its state). The kept-and-integrated one is refused.
    if (path === '/api/images/candidate/delete' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const asset = (await listImages()).assets.find((a) => a.asset === b?.asset)
      const cand = asset?.candidates.find((c) => c.id === b?.candidateId)
      if (!cand) return json(res, 400, { error: 'not a candidate of this asset' })
      let refused = false
      const entry = await updateImageState((state) => {
        const e = (state.assets[asset.asset] ||= { pick: null, feedback: '', candidates: {}, updatedAt: null })
        if (e.candidates?.[cand.id]?.decision === 'keep' && e.integratedKey) { refused = true; return e }
        delete e.candidates?.[cand.id]
        if (e.pick === cand.id) e.pick = Object.entries(e.candidates || {}).filter(([, o]) => o.decision === 'keep').map(([id]) => id).pop() || null
        e.updatedAt = new Date().toISOString()
        return e
      })
      if (refused) return json(res, 409, { error: 'this version is already integrated in the game; un-keep it first' })
      for (const id of new Set([cand.id, cand.preview])) { const abs = resolveImageId(id); if (abs) await unlink(abs).catch(() => {}) }
      writeSelectionManifest().catch(() => {})
      return json(res, 200, { asset: asset.asset, entry, meta: assetMeta(asset, entry) })
    }

    if (path === '/api/images/generate/cancel' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const out = await updateImageQueue((q) => {
        const job = q.jobs.find((j) => j.id === b?.id)
        if (!job) return { status: 404, body: { error: 'no such job' } }
        if (job.status !== 'queued') return { status: 409, body: { error: `job is ${job.status}, only queued jobs can be cancelled` } }
        job.status = 'cancelled'; job.finishedAt = new Date().toISOString()
        return { status: 200, body: { job } }
      })
      json(res, out.status, out.body)
      return
    }

    // ── Audio tab (S-235) — see README.md "Audio tab" ──
    if (path === '/api/audio' && req.method === 'GET') {
      json(res, 200, await audioOverview())
      return
    }

    if (path === '/api/audio/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const abs = resolveId(url.searchParams.get('id') || '')
      if (!abs) return json(res, 400, { error: 'bad id' })
      await serveAudio(req, res, abs)
      return
    }

    if (path === '/api/audio/state' && req.method === 'GET') {
      json(res, 200, await readState())
      return
    }

    // Patch one sound (or one of its candidates): { name, decision?, feedback? }
    // or { name, candidateId, decision?, feedback? }. Omitted fields untouched.
    if (path === '/api/audio/state' && req.method === 'PUT') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const name = typeof b?.name === 'string' ? b.name : ''
      if (!(await knownNamesWithLive()).has(name)) return json(res, 400, { error: 'unknown sound name' })
      if (b.decision !== undefined && !DECISIONS.has(b.decision)) return json(res, 400, { error: 'decision must be keep|reject' })
      if (b.feedback !== undefined && typeof b.feedback !== 'string') return json(res, 400, { error: 'feedback must be a string' })
      if (b.candidateId !== undefined && !(typeof b.candidateId === 'string' && b.candidateId.startsWith('gen/') && resolveId(b.candidateId))) {
        return json(res, 400, { error: 'bad candidateId' })
      }
      if (b.multi !== undefined && typeof b.multi !== 'boolean') return json(res, 400, { error: 'multi must be true or false' })
      if (b.complete !== undefined && typeof b.complete !== 'boolean') return json(res, 400, { error: 'complete must be true or false' })
      const snd = (await listAudio()).sounds.find((x) => x.name === name)
      const kind = snd?.kind || 'sfx', hasLive = !!snd?.live
      const now = new Date().toISOString()
      let failure = null
      const entry = await updateState((state) => {
        const f = fileEntry(state, name)
        const target = b.candidateId
          ? (f.candidates[b.candidateId] ||= { decision: 'reject', feedback: '', updatedAt: null })
          : f
        if (b.multi !== undefined) {
          f.multi = b.multi
          // Turning the switch off leaves only the newest kept clip kept.
          if (!f.multi) {
            const kept = Object.entries(f.candidates).filter(([, c]) => c?.decision === 'keep').sort((x, y) => String(y[1].updatedAt).localeCompare(String(x[1].updatedAt)))
            for (const [id, c] of kept.slice(1)) { c.decision = 'reject'; c.updatedAt = now }
          }
        }
        if (b.decision !== undefined) {
          target.decision = b.decision
          // Only one KEEP per sound (live file + every candidate) unless multi is on.
          if (b.decision === 'keep') enforceSingleKeep(f, b.candidateId ?? null, now)
        }
        if (b.feedback !== undefined) target.feedback = cleanText(b.feedback)
        if (b.complete !== undefined) { try { setAudioComplete(f, name, kind, b.complete, hasLive) } catch (err) { failure = err.message } }
        target.updatedAt = now
        return f
      })
      if (failure) return json(res, 409, { error: failure })
      // Notes changed: have Claude rewrite them into prompt wording (the rule-based matching is the fallback) and keep it with them.
      let result = entry
      const notes = audioNotes(entry)
      if (notes !== (entry.rewrite?.notes || '')) {
        const base = previewPrompt(name, kind, '', null)
        const llm = notes ? await rewriteNotes({ subject: name, basePrompt: base.positive, notes, kind: 'audio' }, IN_DOCKER ? { url: HOST_RUNNER_URL, token: HOST_RUNNER_TOKEN } : null) : null
        const rewrite = llm ? { notes, positive: llm.positive, negative: llm.negative, source: 'claude', at: new Date().toISOString() } : null
        result = await updateState((state) => { const e = fileEntry(state, name); if (audioNotes(e) === notes) { if (rewrite) e.rewrite = rewrite; else delete e.rewrite } return e })
      }
      writeAudioSelectionManifest().catch(() => {})
      json(res, 200, { name, entry: result, meta: audioMeta(name, kind, result, hasLive) })
      return
    }

    // Queue a generation job for a host-side runner (tools/generate/audio-gen-runner.mjs)
    // — this server may be inside Docker and cannot drive the host's GPU/docker.
    if (path === '/api/audio/generate' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const name = typeof b?.name === 'string' ? b.name : ''
      if (!(await knownNamesWithLive()).has(name)) return json(res, 400, { error: 'unknown sound name' })
      const count = Math.floor(Number(b.count ?? 3))
      if (!(count >= 1 && count <= 10)) return json(res, 400, { error: 'count must be 1..10' })
      const overview = await listAudio()
      const kind = overview.sounds.find((s) => s.name === name)?.kind || 'sfx'
      const state = await readState()
      const f = state.files[name]
      const feedbackSnapshot = cleanText(f?.feedback || '')
      // Notes on non-kept candidates are context for the next round too.
      const candidateFeedback = Object.entries(f?.candidates || {})
        .filter(([, c]) => c?.feedback && c.decision !== 'keep')
        .map(([id, c]) => ({ id, feedback: cleanText(c.feedback, 1000) }))
      const now = new Date().toISOString()
      const result = await updateQueue((q) => {
        const pending = q.jobs.find((j) => j.name === name && (j.status === 'queued' || j.status === 'running'))
        if (pending) return { conflict: pending }
        const p = f ? audioMeta(name, kind, f).prompt : {}
        const job = { id: newJobId(), name, kind, count, feedbackSnapshot, candidateFeedback, extraPositive: p.extraPositive || '', extraNegative: p.extraNegative || '', extraSource: p.rewrittenBy || 'none', status: 'queued', createdAt: now }
        q.jobs.push(job)
        return { job }
      })
      if (result.conflict) return json(res, 409, { error: `a generation job for "${name}" is already ${result.conflict.status}`, job: result.conflict })
      await updateState((s) => {
        s.generationRequests.push({ id: result.job.id, name, kind, count, feedbackSnapshot, candidateFeedback, createdAt: now })
        if (s.generationRequests.length > 500) s.generationRequests.splice(0, s.generationRequests.length - 500)
      })
      json(res, 200, { job: result.job })
      return
    }

    // Deletes one generated clip for good. Only files in the generation folders: the bundled live file is never removed.
    if (path === '/api/audio/candidate/delete' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const name = typeof b?.name === 'string' ? b.name : '', id = typeof b?.candidateId === 'string' ? b.candidateId : ''
      const abs = id.startsWith('gen/') ? resolveId(id) : null
      if (!abs || !(await knownNamesWithLive()).has(name)) return json(res, 400, { error: 'not a generated clip' })
      await unlink(abs).catch(() => {})
      const entry = await updateState((s) => { const e = fileEntry(s, name); delete e.candidates[id]; e.updatedAt = new Date().toISOString(); return e })
      return json(res, 200, { entry })
    }

    // Cancel a still-queued job (a running one can't be interrupted from here).
    if (path === '/api/audio/generate/cancel' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const id = typeof b?.id === 'string' ? b.id : ''
      const out = await updateQueue((q) => {
        const job = q.jobs.find((j) => j.id === id)
        if (!job) return { status: 404, body: { error: 'no such job' } }
        if (job.status !== 'queued') return { status: 409, body: { error: `job is ${job.status}, only queued jobs can be cancelled` } }
        job.status = 'cancelled'
        job.finishedAt = new Date().toISOString()
        return { status: 200, body: { job } }
      })
      json(res, out.status, out.body)
      return
    }

    // ── suggestion votes ──
    if (path === '/api/suggestions/votes' && req.method === 'GET') {
      const voter = normVoter(url.searchParams.get('voter') || '')
      const votes = await readVotes()
      json(res, 200, { tallies: tally(votes), mine: myVote(votes, voter) })
      return
    }

    if (path === '/api/suggestions/vote' && req.method === 'POST') {
      let b
      try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const id = typeof b?.id === 'string' ? b.id : ''
      const voter = normVoter(b?.voter)
      // null clears the voter's vote — the same button click that cast it
      // toggles it back off, so there is always a way to undo.
      const vote = b?.vote === 'up' || b?.vote === 'down' ? b.vote : null
      if (!VOTE_ID_RE.test(id)) return json(res, 400, { error: 'bad suggestion id' })
      if (!voter) return json(res, 400, { error: `name required (1-${VOTER_MAX} characters)` })
      const out = await writeVotes((votes) => {
        const entry = votes[id] || (votes[id] = { up: [], down: [] })
        entry.up = (entry.up || []).filter((v) => !sameVoter(v, voter))
        entry.down = (entry.down || []).filter((v) => !sameVoter(v, voter))
        if (vote) entry[vote].push(voter)
        return { id, up: entry.up.length, down: entry.down.length, upBy: entry.up, downBy: entry.down, mine: vote }
      })
      json(res, 200, out)
      return
    }

    // ── customer feedback editor + responses (S-248) — AUTHENTICATED, same
    // session gate as every other /api/ route below (this block sits inside
    // the same try{} the auth check above already guards). The public
    // GET /api/feedback/template + POST /api/feedback/submit live OUTSIDE
    // the gate, earlier in this handler, alongside /download.
    if (path === '/api/feedback/template' && req.method === 'POST') {
      let b
      try { b = await readBody(req, 512 * 1024) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const out = await writeFeedbackTemplate(b?.features)
      json(res, out.ok ? 200 : 400, out)
      return
    }
    if (path === '/api/feedback/responses' && req.method === 'GET') {
      const template = await readFeedbackTemplate()
      const { submissions } = await readFeedbackSubmissions()
      json(res, 200, {
        template,
        stats: computeFeedbackStats(template, submissions),
        submissions: submissions.slice().reverse(), // newest first
      })
      return
    }
    if (path === '/api/feedback/responses/export.csv' && req.method === 'GET') {
      const template = await readFeedbackTemplate()
      const { submissions } = await readFeedbackSubmissions()
      const csv = buildFeedbackCsv(template, submissions)
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="playwork-feedback.csv"',
        'cache-control': 'no-store',
      })
      res.end(csv)
      return
    }

    // Nightly debug APK — manifest (version/commit/size/build-time) is a
    // small JSON blob so the UI can render a card without downloading the
    // (large) APK just to know if one exists yet.
    // Dev build running in Chrome: status of the static web builds that
    // tools/build/build-web-dev.mjs wrote under documentation/state/webapp/. Each
    // variant is served on its own port at the web root (see serveWebApp below).
    if (path === '/api/webapp' && req.method === 'GET') {
      let manifest = {}
      try { manifest = JSON.parse(await readFile(WEBAPP_MANIFEST, 'utf8')) } catch { /* not built yet */ }
      return json(res, 200, { path: WEBAPP_BASE, manifest })
    }

    // Rebuild the four Downloads builds. Gradle needs the host, so in Docker the host-runner does it; progress is a state file.
    const REBUILD_FILE = resolve(DOWNLOADS_DIR, '..', 'rebuild-builds.json')
    const rebuildState = async () => {
      let st = {}
      try { st = JSON.parse(await readFile(REBUILD_FILE, 'utf8')) } catch { /* never run */ }
      if (st.running && Date.now() - Date.parse(st.startedAt) > 3 * 60 * 60 * 1000) st.running = false
      return st
    }
    if (path === '/api/build/rebuild-status' && req.method === 'GET') return json(res, 200, await rebuildState())
    if (path === '/api/build/rebuild' && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      if ((await rebuildState()).running) return json(res, 409, { error: 'a rebuild is already running' })
      // ?only=<build ids> refreshes just those builds (the Refresh button on a stale card); none = all four.
      const only = new URL(req.url, 'http://x').searchParams.get('only') || ''
      if (only && !/^(nightly-debug|nightly-prod|latest-debug|latest-prod)(,(nightly-debug|nightly-prod|latest-debug|latest-prod))*$/.test(only)) return json(res, 400, { error: 'unknown build id' })
      if (IN_DOCKER) {
        let hostRes
        try { hostRes = await fetch(`${HOST_RUNNER_URL}/builds/rebuild${only ? `?only=${only}` : ''}`, { method: 'POST', headers: { 'x-runner-token': HOST_RUNNER_TOKEN } }) } catch { return json(res, 502, { error: 'Could not reach the host-runner. Start it on your PC: npm run spec:host-runner' }) }
        if (!hostRes.ok) return json(res, 502, { error: `host-runner answered HTTP ${hostRes.status} (restart it so it knows /builds/rebuild)` })
      } else {
        spawn(process.execPath, [resolve(ROOT, 'tools', 'spec', 'rebuild-builds.mjs'), ...(only ? ['--only', only] : [])], { cwd: ROOT, stdio: 'ignore', detached: true }).unref()
      }
      return json(res, 200, { ok: true, started: true })
    }

    if (path === '/api/build' && req.method === 'GET') {
      let data = null
      try { data = JSON.parse(await readFile(BUILD_MANIFEST_FILE, 'utf8')) } catch { /* no nightly build yet */ }
      // What a build would have to match to be fresh: the current HEAD, and the newest release tag by date.
      const gitLine = (args) => new Promise((ok) => execFile('git', ['-c', 'safe.directory=*', ...args], { cwd: ROOT, windowsHide: true }, (err, out) => ok(err ? null : String(out).trim() || null)))
      const current = {
        head: await gitLine(['rev-parse', 'HEAD']),
        latestTag: await gitLine(['for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:short)', 'refs/tags']),
      }
      json(res, 200, { ...(data ?? { available: false }), current })
      return
    }

    // Streams the actual APK. Token-gated identically to every other route
    // here (see the auth check earlier in this handler) — this is a private
    // debug build of a clinical app, not a public release artifact.
    // ?variant=prod serves the production APK (internal only: it reports to the production Firebase, never offered on the public /download page).
    if (path === '/api/build/download' && req.method === 'GET') {
      const variant = url.searchParams.get('variant')
      const prod = variant === 'prod'
      const master = variant === 'master'
      const chinese = variant === 'chinese'
      const file = prod ? BUILD_PROD_APK_FILE : master ? BUILD_MASTER_APK_FILE : chinese ? BUILD_CHINESE_APK_FILE : BUILD_APK_FILE
      let stats
      try { stats = await stat(file) } catch { return json(res, 404, { error: 'no build available yet' }) }
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': stats.size,
        'content-disposition': `attachment; filename="${prod ? 'playwork-prod-latest.apk' : master ? 'playwork-master-latest.apk' : chinese ? 'playwork-chinese-latest.apk' : 'playwork-debug-latest.apk'}"`,
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    // ── write APIs — all delegate to the CLI ──
    if (path === '/api/answer' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const id = assertId(b.id)
      const n = assertN(b.n)
      const text = String(b.text ?? '').trim()
      if (!text) return json(res, 400, { error: 'answer text is empty' })
      const args = ['answer', id, n, text]
      if (b.force) args.push('--force')
      if (b.dryRun) args.push('--dry-run')
      const r = await spec(args, domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    if (path === '/api/question' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const id = assertId(b.id)
      const text = String(b.text ?? '').trim()
      if (!text) return json(res, 400, { error: 'question text is empty' })
      const args = ['question', id, text]
      if (b.blocking) args.push('--blocking')
      const r = await spec(args, domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    // Completion notes are a separate mechanism from question/answer on
    // purpose (see tools/spec/spec.mjs's `note` command doc comment) — a note is
    // the implementer's own record of what was done, not a design-decision
    // answer, and must stay visible independently of any Q/A state.
    if (path === '/api/note' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const id = assertId(b.id)
      const text = String(b.text ?? '').trim()
      if (!text) return json(res, 400, { error: 'note text is empty' })
      const r = await spec(['note', id, text], domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    // Register a new stub from raw text — delegates entirely to `spec new`,
    // which takes a plain title+text pair (no file needed) and marks the
    // result for the spec-planning skill's own Analyze mode to turn into a
    // fully-triaged stub. `tests` is optional (--tests=<value>) — lets the
    // person filing the stub specify how they want it verified up front,
    // same as `create-stub`'s JSON `tests` field already supports on the
    // CLI side, just now reachable from this form too instead of only ever
    // being left TBD for a later Analyze pass to fill in.
    if (path === '/api/new-stub' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const title = String(b.title ?? '').trim()
      const text = String(b.text ?? '').trim()
      const tests = String(b.tests ?? '').trim()
      if (!title) return json(res, 400, { error: 'title is empty' })
      if (!text) return json(res, 400, { error: 'description text is empty' })
      const args = ['new', title, text]
      if (tests) args.push(`--tests=${tests}`)
      if (b.dryRun) args.push('--dry-run')
      const r = await spec(args, domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    // Reopen an in-progress/in-qa/done stub for reanalysis with a reason —
    // delegates entirely to `spec reopen`, which records the reason as a
    // fresh BLOCKING question and moves the stub back to `deferred`.
    if (path === '/api/reopen' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const id = assertId(b.id)
      const reason = String(b.reason ?? '').trim()
      if (!reason) return json(res, 400, { error: 'reopen reason is empty' })
      const args = ['reopen', id, reason]
      if (b.force) args.push('--force')
      if (b.dryRun) args.push('--dry-run')
      const r = await spec(args, domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    if (path === '/api/status' && req.method === 'POST') {
      const b = await readBody(req)
      const domain = domainOf(b.domain)
      const id = assertId(b.id)
      const status = String(b.status ?? '')
      if (!STATUSES.has(status)) return json(res, 400, { error: `bad status: ${status}` })
      // Only-analyzed-stubs-can-be-enabled gate — this is real enforcement,
      // not just the UI disabling SET READY: a direct POST here (bypassing
      // the button) is checked the same way. Scoped to spec-web only, same
      // as the analyzed-tracking file itself — spec.mjs / SPEC_STUBS.md are
      // untouched, so `node tools/spec/spec.mjs status <id> enabled` from a
      // terminal is NOT gated by this (an operator working the CLI directly
      // is trusted; this guard is for the shared, possibly-multi-user site).
      // `force:true` bypasses it deliberately, mirroring the CLI's own
      // `--force` escape hatch for the blocking-question refusal below —
      // no UI button wires it today, so this only matters for someone
      // calling the API directly and choosing to override. Skipped entirely
      // for domain:'backend' — its own analysis tracking lives in the
      // separate playwork-backend repo, unreachable from here (see
      // /api/bootstrap's own comment on this).
      if (status === 'enabled' && !b.force && domain === 'app') {
        const analysis = await readStubAnalysis()
        if (!analysis[id]) {
          return json(res, 403, {
            error: `${id} has not been analyzed yet (no record in stub-analysis.json) — run the finish-ready-stubs skill (or its "▶ START WORKING" button) at least once before enabling it, or pass force:true to override.`,
          })
        }
      }
      const args = ['status', id, status]
      if (b.force) args.push('--force')
      if (b.dryRun) args.push('--dry-run')
      const r = await spec(args, domain)
      json(res, r.ok ? 200 : 400, { ok: r.ok, output: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    if (path === '/api/check' && req.method === 'GET') {
      const domain = domainOf(url.searchParams.get('domain'))
      const r = await spec(['check'], domain)
      json(res, 200, { ok: r.ok, text: stripAnsi(r.stdout + r.stderr).trim() })
      return
    }

    if (path === '/api/tests/run-status' && req.method === 'GET') {
      json(res, 200, await readTestRun())
      return
    }

    if (path === '/api/tests/run' && req.method === 'POST') {
      const current = await readTestRun()
      if (current.running) return json(res, 409, { error: 'a test run is already in progress', run: current })
      if (IN_DOCKER) {
        let hostRes
        try {
          hostRes = await fetch(`${HOST_RUNNER_URL}/run`, {
            method: 'POST',
            headers: { 'x-runner-token': HOST_RUNNER_TOKEN },
          })
        } catch {
          return json(res, 502, {
            error: 'Could not reach the host test-runner. Start it on your PC first: npm run spec:host-runner',
          })
        }
        if (!hostRes.ok) {
          return json(res, 502, { error: `host-runner rejected the request (HTTP ${hostRes.status})` })
        }
        json(res, 200, { ok: true, started: true })
        return
      }
      const child = spawn(process.execPath, [RUN_FULL_SUITE_SCRIPT], { cwd: ROOT, stdio: 'ignore', detached: true })
      child.unref()
      json(res, 200, { ok: true, started: true })
      return
    }

    // Headless Claude runs (docs/spec/spec-web-agent-runs.md). State is files under state/runs/.
    if (path === '/api/runs' && req.method === 'GET') {
      const runs = listRuns().slice(0, 10).map(runView)
      const domain = domainOf(url.searchParams.get('domain'))
      const items = work.list(domain)
      json(res, 200, {
        active: runs.find((r) => r.active) || null, latest: runs[0] || null, runs,
        // Top-bar counts: items whose spec a person confirmed (the gold Start working button), items waiting for the spec
        // rewrite, for a spec review, for answers, or for QA.
        workReady: items.filter((w) => w.status === 'approved').map((w) => ({ id: w.id, title: w.title, rework: !!w.sentBack })),
        workRewrite: items.filter((w) => w.status === 'ready').length,
        workReview: items.filter((w) => w.status === 'spec-review').length,
        workQuestions: items.filter((w) => w.status === 'questions').length,
        workQa: items.filter((w) => w.status === 'in-qa').length,
        workCollecting: work.collecting(domain).length,
      })
      return
    }

    if (path === '/api/runs/start' && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      const kind = url.searchParams.get('kind')
      // Work item runs are started from /api/work/*; this endpoint only starts the stub queue.
      if (kind !== 'finish-stubs' || !KINDS[kind]) return json(res, 400, { error: `unknown or not yet available run kind: ${kind}` })
      // Nothing in the current batch and the person chose to go anyway: a real run that only analyzes existing stubs.
      const out = await launchRun(kind, url.searchParams.get('analyzeOnly') === '1' ? { analyzeOnly: true } : {})
      return json(res, out.status || 200, out.body)
    }

    // ── stub categories: a person sets one, or a headless run sorts the rest ──
    if (path === '/api/stubs/category' && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      let b
      try { b = await readBody(req, 4096) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      if (!/^S-\d+$/.test(String(b?.id))) return json(res, 400, { error: 'bad stub id' })
      const r = await spec(['category', b.id, ...String(b.category || '').split(/\s+/).filter(Boolean)], domainOf(b?.domain))
      return json(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { error: stripAnsi(r.stderr || r.stdout).trim() })
    }
    if (path === '/api/stubs/categorize' && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      let b
      try { b = await readBody(req, 4096) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const out = await launchRun('categorize', { mode: b?.mode === 'all' ? 'all' : 'uncategorized', domain: domainOf(b?.domain) })
      return json(res, out.status || 200, out.body)
    }

    // ── work items (docs/spec/spec-work-items.md) ──
    // Cheap snapshot of every work item's and stub's state, polled by the page's browser-notification toggle.
    if (path === '/api/push/key' && req.method === 'GET') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      return json(res, 200, { key: push.publicKey() })
    }
    if ((path === '/api/push/subscribe' || path === '/api/push/unsubscribe') && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      let b; try { b = await readBody(req) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      try {
        if (path.endsWith('/subscribe')) push.subscribe(b, req.headers['user-agent'])
        else push.unsubscribe(String(b?.endpoint || ''))
      } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      return json(res, 200, { ok: true, subscriptions: push.count() })
    }
    if (path === '/api/watch' && req.method === 'GET') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      json(res, 200, await watchSnapshot(domainOf(url.searchParams.get('domain'))))
      return
    }
    if (path === '/api/work' && req.method === 'GET') {
      const domain = domainOf(url.searchParams.get('domain'))
      json(res, 200, { collecting: work.collecting(domain), items: work.list(domain).map(work.summary) })
      return
    }
    const wiMatch = path.match(/^\/api\/work\/(WI-\d+)(?:\/([a-z-]+))?$/)
    if (wiMatch && req.method === 'GET' && !wiMatch[2]) {
      const wi = work.get(wiMatch[1])
      if (!wi) return json(res, 404, { error: 'no such work item' })
      // Live status of the stubs it created (read-only for people) and the files the rewrite changed so far.
      let stubs = []
      if (wi.stubIds.length) {
        const all = await specJson(['list', 'all', '--json'], wi.domain)
        stubs = (Array.isArray(all) ? all : []).filter((x) => wi.stubIds.includes(x.id)).map((x) => ({ id: x.id, title: x.title, status: x.status, notes: x.notes }))
      }
      const runId = wi.status === 'working' ? wi.runs.develop : wi.status === 'rewriting' ? wi.runs.respec : wi.status === 'analyzing' ? wi.runs.analyze : null
      return json(res, 200, { item: wi, stubs, files: work.integrationDiff(wi.id).map(({ hunks, ...f }) => f), run: runId ? runView(readRun(runId)) : null })
    }
    if (wiMatch && req.method === 'GET' && wiMatch[2] === 'diff') {
      const d = work.integrationDiff(wiMatch[1]).find((x) => x.file === (url.searchParams.get('file') || ''))
      return d ? json(res, 200, d) : json(res, 404, { error: 'no such changed file' })
    }
    if (path.startsWith('/api/work') && req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      let b
      try { b = await readBody(req, 256 * 1024) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const by = cleanName(normVoter(b?.by))
      const domain = domainOf(b?.domain)
      try {
        if (path === '/api/work/collect-git') {
          if (!by) return json(res, 400, { error: 'Say who you are first.' })
          return json(res, 200, { ok: true, added: work.collectFromGit({ domain, docs: await specDocs(domain), by }) })
        }
        if (path === '/api/work/create') {
          const wi = work.createFromCollection({ domain, by, title: b?.title })
          // Analysis starts at once when nothing else is running; otherwise the card offers an Analyze button.
          const out = activeRun() ? null : await launchRun('analyze', { workItemId: wi.id })
          if (out?.body?.run) work.attachRun(wi.id, 'analyze', out.body.run.id)
          return json(res, 200, { ok: true, item: work.get(wi.id), started: !!out?.body?.run })
        }
        if (!wiMatch || !wiMatch[2]) return json(res, 404, { error: 'not found' })
        const [, id, action] = wiMatch
        if (action === 'analyze') {
          const wi = work.get(id)
          if (!wi || !['collected', 'failed'].includes(wi.status)) return json(res, 409, { error: 'This work item is not waiting for an analysis.' })
          const out = await launchRun('analyze', { workItemId: id })
          if (out.body.run) work.attachRun(id, 'analyze', out.body.run.id)
          return json(res, out.status || 200, out.body)
        }
        if (action === 'answer') return json(res, 200, { ok: true, item: work.answer(id, b?.n, b?.text, by) })
        if (action === 'rewrite') {
          // Step 1: rewrite the spec text only. The pre-rewrite copies of the spec files are taken here, once.
          const busy = activeRun()
          if (busy) return json(res, 409, { error: 'a run is already in progress', run: busy })
          const files = [resolve(ROOT, 'CLAUDE.md'), resolve(ROOT, 'SPEC.md'), ...(await specDocs('app')).map((d) => d.path)]
          const wi = work.startRewrite(id, by, files)
          const out = await launchRun('respec', { workItemId: id })
          if (!out.body.run) { work.runFinished(id, 'respec', 'failed'); return json(res, out.status || 502, out.body) }
          work.attachRun(id, 'respec', out.body.run.id)
          return json(res, 200, { ok: true, item: work.get(wi.id), run: out.body.run })
        }
        if (action === 'approve-spec') return json(res, 200, { ok: true, item: work.approveSpec(id, by) })
        if (action === 'spec-changes') return json(res, 200, { ok: true, item: work.requestSpecChanges(id, b?.reason, by) })
        if (action === 'start') {
          // Step 2, only after the person confirmed the rewritten spec: tickets, development, verification.
          const busy = activeRun()
          if (busy) return json(res, 409, { error: 'a run is already in progress', run: busy })
          const wi = work.startWork(id, by)
          const out = await launchRun('develop', { workItemId: id })
          if (!out.body.run) { work.runFinished(id, 'develop', 'failed'); return json(res, out.status || 502, out.body) }
          work.attachRun(id, 'develop', out.body.run.id)
          return json(res, 200, { ok: true, item: work.get(wi.id), run: out.body.run })
        }
        if (action === 'resume') {
          // The person did what the "human intervention" banner asked: start the develop run again, continuing where it stopped.
          const busy = activeRun()
          if (busy) return json(res, 409, { error: 'a run is already in progress', run: busy })
          const wi = work.get(id)
          if (!wi?.waitingHuman) return json(res, 409, { error: id + ' is not waiting for a person.' })
          work.resumeWork(id, by)
          await spec(['state', 'set', 'wip', 'Resuming ' + id + ' after the human step'], wi.domain)
          const out = await launchRun('develop', { workItemId: id, resume: true })
          if (!out.body.run) {
            await spec(['state', 'set', 'human', wi.waitingHuman.note, '--work-item=' + id], wi.domain)
            return json(res, out.status || 502, out.body)
          }
          work.attachRun(id, 'develop', out.body.run.id)
          return json(res, 200, { ok: true, item: work.get(id), run: out.body.run })
        }
        if (action === 'done') {
          const wi = work.get(id)
          const done = work.confirmDone(id, by)
          // The stubs were managed by Claude all along; closing the work item is what finally marks them done.
          const moved = []
          for (const sid of done.stubIds) {
            const r = await spec(['status', sid, 'done', '--force'], wi.domain, { PLAYWORK_ACTOR: 'system' })
            if (r.ok) moved.push(sid)
          }
          return json(res, 200, { ok: true, item: done, stubsDone: moved })
        }
        if (action === 'sendback') {
          const wi = work.sendBack(id, b?.reason, by)
          const reopened = []
          for (const sid of wi.stubIds) {
            const r1 = await spec(['status', sid, 'in-progress'], wi.domain, { PLAYWORK_ACTOR: 'system' })
            await spec(['note', sid, `Sent back from QA by ${by || 'someone'}: ${wi.sentBack.reason}`], wi.domain, { PLAYWORK_ACTOR: 'system' })
            if (r1.ok) reopened.push(sid)
          }
          return json(res, 200, { ok: true, item: wi, reopened })
        }
        if (action === 'redo') {
          // Redo a step. A run of this work item that is still going (or stalled) is stopped first; the step then restarts from
          // its normal button, which the page presses for you when nothing had to be stopped.
          const wi = work.get(id)
          if (!wi) return json(res, 404, { error: 'no such work item' })
          let stopped = false
          for (const kind of ['analyze', 'respec', 'develop']) {
            const r = wi.runs[kind] && readRun(wi.runs[kind])
            const v = r && runView(r)
            if (v && v.active) { requestStop(r.id); stopped = true }                       // a worker is alive: ask it to stop
            else if (v && v.status === 'stalled') markFailed(r.id, 'Redone by hand: the worker had stopped reporting.')   // its worker is gone
          }
          return json(res, 200, { ok: true, item: work.resetToStep(id, b?.step, by), stopped })
        }
        if (action === 'cancel') return json(res, 200, { ok: true, item: work.cancel(id, by) })
        if (action === 'retry') return json(res, 200, { ok: true, item: work.retry(id) })
      } catch (e) { return json(res, 409, { error: String(e.message || e) }) }
      return json(res, 404, { error: 'not found' })
    }

    // ── feature modules (docs/spec/feature-modules.md) ──
    if (path === '/api/features' && req.method === 'GET') return json(res, 200, { features: feature.list() })
    const fMatch = path.match(/^\/api\/features\/([a-z][a-z0-9-]{1,40})(?:\/([a-z-]+))?$/)
    if (fMatch && req.method === 'GET' && !fMatch[2]) {
      let v
      try { v = feature.view(fMatch[1]) } catch (e) { return json(res, 404, { error: String(e.message || e) }) }
      // Live state of the linked work items and of the update run, so the page needs no second request.
      const workItems = v.workItems.map((w) => { const x = work.get(w.id); return { ...w, status: x?.status ?? 'missing', title: x?.title ?? '' } })
      const r = v.refine?.runId && validRunId(v.refine.runId) ? readRun(v.refine.runId) : null
      return json(res, 200, { ...v, workItems, canEdit: session.role === 'admin', run: r ? runView(r) : null })
    }
    if (fMatch && req.method === 'POST' && fMatch[2]) {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
      let b
      try { b = await readBody(req, 2 * 1024 * 1024) } catch (e) { return json(res, 400, { error: String(e.message || e) }) }
      const [, fid, action] = fMatch
      const by = cleanName(normVoter(b?.by))
      try { feature.meta(fid) } catch (e) { return json(res, 404, { error: String(e.message || e) }) }
      try {
        if (action === 'spec') return json(res, 200, { ok: true, ...feature.saveSpec(fid, { content: b.content, base: b.base, by }) })
        if (action === 'question') return json(res, 200, { ok: true, question: feature.addQuestion(fid, { text: b.text, blocking: !!b.blocking, by }) })
        if (action === 'answer') return json(res, 200, { ok: true, question: feature.answerQuestion(fid, b.n, b.text, by) })
        if (action === 'remove-question') { feature.removeQuestion(fid, b.n, by); return json(res, 200, { ok: true }) }
        if (action === 'note') return json(res, 200, { ok: true, note: feature.addNote(fid, { text: b.text, by }) })
        if (action === 'remove-note') { feature.removeNote(fid, b.n, by); return json(res, 200, { ok: true }) }
        if (action === 'refine') {
          // Claude edits the feature's own spec from the answers and notes nobody has applied yet.
          if (!by) return json(res, 400, { error: 'Say who you are first.' })
          const busy = activeRun()
          if (busy) return json(res, 409, { error: 'a run is already in progress', run: busy })
          feature.startRefine(fid, by)
          const out = await launchRun('feature', { featureId: fid })
          if (!out.body.run) { feature.finishRefine(fid, 'failed', out.body.error || 'could not start'); return json(res, out.status || 502, out.body) }
          feature.attachRefineRun(fid, out.body.run.id)
          return json(res, 200, { ok: true, run: out.body.run })
        }
        if (action === 'work-item') {
          // The whole feature spec becomes one work item: the normal flow then rewrites the product spec around it.
          if (!by) return json(res, 400, { error: 'Say who you are first.' })
          const text = feature.readSpec(fid)
          if (!text.trim()) return json(res, 409, { error: 'The feature spec is empty.' })
          const dead = (wid) => ['failed', 'cancelled'].includes(work.get(wid)?.status)
          const open = feature.readQa(fid).workItems.map((w) => work.get(w.id)).find((w) => w && !['done', 'cancelled', 'failed'].includes(w.status))
          if (open) return json(res, 409, { error: `${open.id} is still open for this feature. Finish or cancel it first.` })
          const pendingEdits = work.collecting('app')
          if (pendingEdits.length) return json(res, 409, { error: `${pendingEdits.length} other spec edit${pendingEdits.length === 1 ? ' is' : 's are'} waiting in the Work tab. Press "I completed my changes" there (or discard them) first, so this work item holds only the feature.` })
          const baseline = feature.workItemBaseline(fid, dead)
          if (baseline.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) return json(res, 409, { error: 'Nothing changed since the last work item.' })
          const m = feature.meta(fid)
          work.recordEdit({ domain: 'app', doc: 'feature/' + fid, title: 'Feature: ' + m.title, before: baseline, after: text, by })
          const wi = work.createFromCollection({ domain: 'app', by, title: String(b.title || '').trim() || (baseline ? 'Update feature: ' : 'Add feature: ') + m.title })
          feature.linkWorkItem(fid, { wi: wi.id, by, text })
          const out = activeRun() ? null : await launchRun('analyze', { workItemId: wi.id })
          if (out?.body?.run) work.attachRun(wi.id, 'analyze', out.body.run.id)
          return json(res, 200, { ok: true, item: work.get(wi.id), started: !!out?.body?.run })
        }
      } catch (e) { return json(res, e.status || 409, { error: String(e.message || e) }) }
      return json(res, 404, { error: 'not found' })
    }

    const runMatch = path.match(/^\/api\/runs\/(run-[^/]+)\/(stop|fail|log)$/)
    if (runMatch) {
      const [, runId, action] = runMatch
      if (!validRunId(runId) || !readRun(runId)) return json(res, 404, { error: 'no such run' })
      if (action === 'log' && req.method === 'GET') {
        let text = ''
        // The readable log by default; ?raw=1 is the CLI's own stream-json, for debugging only.
        try { text = await readFile((url.searchParams.get('raw') ? runRawLogFile : runLogFile)(runId), 'utf8') } catch { /* no output yet */ }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text.split('\n').slice(-300).join('\n'))
        return
      }
      if (req.method === 'POST') {
        if (session.role !== 'admin') return json(res, 403, { error: 'admin only' })
        // Stop is a flag the worker polls (it may live outside this container); fail is for a worker that is gone.
        const out = action === 'stop' ? requestStop(runId) : markFailed(runId, 'Marked failed by hand: the worker stopped reporting.')
        return json(res, 200, { ok: true, run: runView(out) })
      }
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 400, { error: String(err?.message || err) })
  }
})

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

// ── Dev build running in Chrome ─────────────────────────────────────────────
// tools/build/build-web-dev.mjs builds the app with base /web-build/ into
// documentation/state/webapp/app and this server serves it on the SAME origin
// as the tool, so the normal login gate (and https through the tunnel, which
// Web Bluetooth needs) covers it with nothing extra. The build's own assets
// and routes live under /web-build/. The app also hard-codes root paths for
// its public/ files (/images/..., /audio/..., /videos/...); none of those are
// used by the tool itself, so they are mapped to the same build folder.
// ONE build covers both sensor modes (real Web Bluetooth by default, fake balls
// with ?mock=1, see src/utils/runtimeMock.ts).
const WEBAPP_BASE = '/web-build/'
const WEBAPP_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'webapp', 'app')
const WEBAPP_MANIFEST = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'webapp', 'manifest.json')
const WEBAPP_PUBLIC_PREFIXES = ['/images/', '/audio/', '/videos/']
const WEB_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
}
function isWebAppPath(path) {
  return path === '/web-build' || path.startsWith(WEBAPP_BASE) || WEBAPP_PUBLIC_PREFIXES.some((p) => path.startsWith(p))
}
async function serveWebApp(req, res, path) {
  try {
    if (path === '/web-build') { res.writeHead(302, { location: WEBAPP_BASE }); return res.end() }
    const root = WEBAPP_DIR
    const rel = decodeURIComponent(path.startsWith(WEBAPP_BASE) ? path.slice(WEBAPP_BASE.length - 1) : path)
    let file = resolve(root, '.' + (rel === '/' ? '/index.html' : rel))
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end('forbidden') }
    let st = await stat(file).catch(() => null)
    if (!st || st.isDirectory()) {
      // Single-page app: a route like /web-build/home gets index.html; a missing file is a real 404.
      if (/\.[a-z0-9]+$/i.test(rel) || !path.startsWith(WEBAPP_BASE)) { res.writeHead(404); return res.end('not found') }
      file = resolve(root, 'index.html'); st = await stat(file).catch(() => null)
    }
    if (!st) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not built yet. On the host run: npm run build:web-dev') }
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    // no-cache = the browser keeps the file but asks first; an unchanged file answers 304 with no body, a rebuilt one is fetched fresh.
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const headers = { etag, 'cache-control': 'no-cache', 'last-modified': st.mtime.toUTCString() }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end() }
    res.writeHead(200, { 'content-type': WEB_MIME[ext] || 'application/octet-stream', ...headers })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  } catch { res.writeHead(400); res.end('bad request') }
}

// Push watcher: diffs the same snapshot the page polls and pushes the changes, so cards arrive with every tab closed.
// Only runs while someone is subscribed; the first snapshot per registry is the baseline, so subscribing never floods.
const PUSH_PREV = {}
setInterval(async () => {
  if (!push.count()) { for (const k of Object.keys(PUSH_PREV)) delete PUSH_PREV[k]; return }
  const events = []
  for (const domain of ['app', 'backend']) {
    try {
      const cur = await watchSnapshot(domain), prev = PUSH_PREV[domain]
      PUSH_PREV[domain] = cur
      // Nightly and START WORKING runs are not per registry: take them from the first one only, or they arrive twice.
      if (prev) events.push(...diffSnapshots(prev, cur).filter((e) => !e.global || domain === 'app').map((e) => ({ ...e, domain })))
    } catch { /* snapshot failed this round; the next one retries */ }
  }
  for (const e of batchEvents(events)) await push.broadcast(e)
}, 15000).unref()

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`
  console.log('')
  console.log('  spec-web  —  a wrapper around tools/spec/spec.mjs')
  console.log(`  spec file : ${SPEC}`)
  console.log(`  bind      : ${HOST}:${PORT}`)
  console.log(`  local     : ${base}`)
  if (NO_AUTH) {
    console.log('  auth      : DISABLED (--no-auth) — do not tunnel this')
  } else {
    console.log(`  auth      : sign in at ${base}/login  (username: ${AUTH_USERNAME})`)
    console.log(`              session lasts ${SESSION_MAX_AGE_MS / 86400000} days and survives restarts`)
  }
  console.log('')
})
