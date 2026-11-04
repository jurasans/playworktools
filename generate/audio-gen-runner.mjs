#!/usr/bin/env node
/**
 * Host-side runner for the spec-web "Audio" tab (S-235).
 *
 * spec-web (often a Docker container) cannot drive the host's docker/GPU, so
 * the tab only APPENDS JOBS to a queue file. This script — run by you or by a
 * Claude session on the host, whenever you like — consumes that queue:
 *
 *   node tools/generate/audio-gen-runner.mjs                 process every queued job, then exit
 *   node tools/generate/audio-gen-runner.mjs --watch         keep polling the queue (Ctrl+C to stop)
 *   node tools/generate/audio-gen-runner.mjs --job <id>      process just that job
 *   node tools/generate/audio-gen-runner.mjs --dry-run       print what WOULD run; touches nothing
 *   node tools/generate/audio-gen-runner.mjs --promote       copy KEPT candidates over the live file
 *   node tools/generate/audio-gen-runner.mjs --promote --name pickup --dry-run
 *
 * Generation: for each queued job it builds a prompt from the sound's existing
 * prompt vars (tools/generate/vars/*.txt, same `key|description|seconds`
 * lines generate-sound.mjs reads; falls back to tools/spec-web/audio-catalog.mjs)
 * plus the feedback text stored in the state file, then runs
 *   node generate-sound.mjs --variants N --out <GEN>/audio-output/spec-web-jobs/<jobId> ...
 * (Docker + GPU required — see tools/generate/README.md). Each job writes to
 * its OWN output folder so a new run never overwrites earlier variants
 * (<name>_v1.mp3 .. <name>_vN.mp3 restart at 1 in every run). The new files
 * show up in the Audio tab as candidates for that sound.
 *
 * Feedback -> prompt: the free-text feedback is folded into the description as
 * "<base description>. Refinements: <feedback>" (whitespace-collapsed, 600
 * chars max). Text-to-audio models respond better to positive descriptors than
 * complaints, so if a job's raw feedback reads badly as a prompt, rewrite it
 * before running: set `promptOverride` on the job in the queue file (a string
 * that replaces the whole description) — Claude can do this for you.
 *
 * Promotion (--promote): per sound, takes the most recently updated candidate
 * whose state decision is "keep", moves the CURRENT live file into
 * data/versions/<name>/vN.mp3 (next unused N, same numbering as
 * lib/wireOutput.mjs), and copies the candidate over public/audio/<kind>/<name>.mp3.
 * The candidate's own file is left in place (it is a copy, not a move). Other
 * kept candidates for the same sound are reported but not promoted — promote
 * one at a time. Records `promotedAt` on the candidate and `liveFrom` on the
 * sound in the state file. Add --dry-run to preview.
 *
 * Env overrides are shared with the server (see tools/spec-web/audio-lib.mjs):
 * SPEC_WEB_AUDIO_LIVE_DIR, SPEC_WEB_AUDIO_GEN_DIR, SPEC_WEB_DATA_DIR.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ROOT, LIVE_DIR, GEN_DIR, QUEUE_FILE, STATE_FILE, readQueue, updateQueue, readState, updateState,
  fileEntry, resolveId, idFor, audioKeptKey, markAudioIntegrated, writeAudioSelectionManifest,
} from '../spec-web/audio-lib.mjs'
import { CATALOG_BY_NAME } from '../spec-web/audio-catalog.mjs'
import { buildPrompt } from '../spec-web/audio-prompt.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMAGE_GEN = HERE
const VARS_DIR = resolve(IMAGE_GEN, 'vars')

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DRY = flag('--dry-run')

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, ''))
  process.exit(0)
}

const log = (...a) => console.log('[audio-gen-runner]', ...a)
const warn = (...a) => console.warn('[audio-gen-runner]', ...a)
const nowIso = () => new Date().toISOString()
const rel = (p) => relative(ROOT, p).split('\\').join('/')

function seedFor(jobId) {
  return parseInt(createHash('sha1').update(jobId).digest('hex').slice(0, 6), 16)
}

// ── job execution ────────────────────────────────────────────────────────────
function runNode(args, cwd) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (d) => { process.stdout.write(d); tail = (tail + d.toString()).slice(-2000) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    child.on('error', (e) => resolveP({ code: -1, tail: String(e) }))
    child.on('close', (code) => resolveP({ code, tail }))
  })
}

// generate-sound drops the _vN suffix when only one variant is made.
function producedFiles(outDir, name) {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir).filter((f) => new RegExp(`^${name}(_v\\d+)?\\.mp3$`).test(f)).sort()
}

async function patchJob(id, patch) {
  await updateQueue((q) => { const j = q.jobs.find((x) => x.id === id); if (j) Object.assign(j, patch) })
  // mirror the outcome into the state file's generationRequests entry (best effort)
  await updateState((s) => { const g = s.generationRequests.find((x) => x.id === id); if (g) Object.assign(g, patch) }).catch(() => {})
}

async function processJob(job) {
  let p
  try { p = buildPrompt(job, job.extraSource === 'claude' ? { positive: job.extraPositive || '', negative: job.extraNegative || '' } : null) } catch (e) {
    warn(`job ${job.id}: ${e.message}`)
    if (!DRY) await patchJob(job.id, { status: 'failed', finishedAt: nowIso(), error: e.message })
    return
  }
  const outDir = join(GEN_DIR, 'audio-output', 'spec-web-jobs', job.id)
  const varsFile = join(outDir, 'vars.txt')
  const varsLine = `${job.name}|${p.desc}|${p.seconds}`
  const args = [
    'generate-sound.mjs', '--prompt', p.template, '--vars-file', varsFile,
    '--variants', String(job.count), '--seed', String(seedFor(job.id)), '--out', outDir,
    '--keep-running', // models stay loaded for the whole queue; unloaded in runQueue() when it drains (the container stays up)
  ]
  if (p.negative) args.push('--negative', p.negative)
  if (p.cfg) args.push('--cfg', String(p.cfg))

  log(`job ${job.id}: "${job.name}" (${p.kind}) x${job.count}  base prompt from ${p.source}`)
  if (DRY) {
    console.log(`  cwd : ${rel(IMAGE_GEN)}`)
    console.log(`  cmd : node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
    console.log(`  ${rel(varsFile)} would contain:\n    ${varsLine}`)
    console.log(`  output -> ${rel(outDir)}   (dry-run: nothing written, queue untouched)`)
    return
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(varsFile, varsLine + '\n', 'utf8')
  await patchJob(job.id, { status: 'running', startedAt: nowIso(), outputDir: idFor('gen', outDir), error: undefined })
  const { code, tail } = await runNode(args, IMAGE_GEN)
  const made = producedFiles(outDir, job.name)
  const produced = made.map((f) => idFor('gen', join(outDir, f)))
  if (made.length === 0) {
    await patchJob(job.id, { status: 'failed', finishedAt: nowIso(), produced, error: `generate-sound exited ${code} and produced no files. Tail: ${tail.slice(-600)}` })
    warn(`job ${job.id} FAILED`)
  } else {
    await patchJob(job.id, {
      status: 'done', finishedAt: nowIso(), produced,
      warning: made.length < job.count ? `only ${made.length}/${job.count} clips were produced` : undefined,
    })
    log(`job ${job.id} done — ${made.length} clip(s) in ${rel(outDir)}`)
  }
}

async function runQueue() {
  const only = val('--job', null)
  const q = await readQueue()
  const todo = q.jobs.filter((j) => j.status === 'queued' && (!only || j.id === only))
  if (!todo.length) { log(only ? `job ${only} is not queued` : 'queue empty'); return 0 }
  try { for (const job of todo) await processJob(job) }
  finally { if (!DRY && !flag('--no-unload')) await runNode(['unload.mjs'], IMAGE_GEN).catch(() => {}) }
  return todo.length
}

// ── promotion ────────────────────────────────────────────────────────────────
const sameBytes = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b))

function nextVersionNumber(name) {
  const dir = join(GEN_DIR, 'versions', name)
  if (!existsSync(dir)) return 2
  const nums = readdirSync(dir).map((f) => /^v(\d+)\./.exec(f)).filter(Boolean).map((m) => parseInt(m[1], 10))
  return nums.length ? Math.max(...nums) + 1 : 2
}

async function promote() {
  const only = val('--name', null)
  const state = await readState()
  const plans = []
  for (const [name, entry] of Object.entries(state.files)) {
    if (only && name !== only) continue
    const kept = Object.entries(entry.candidates || {})
      .filter(([id, c]) => c?.decision === 'keep' && id.startsWith('gen/'))
      .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
    if (!kept.length) continue
    const [id] = kept[0]
    const src = resolveId(id)
    const cat = CATALOG_BY_NAME.get(name)
    const kind = cat?.kind || (existsSync(join(LIVE_DIR, 'music', `${name}.mp3`)) ? 'music' : 'sfx')
    const dest = join(LIVE_DIR, kind, `${name}.mp3`)
    if (!src || !existsSync(src)) { warn(`${name}: kept candidate ${id} is missing on disk — skipped`); continue }
    if (!src.toLowerCase().endsWith('.mp3')) { warn(`${name}: ${id} is not an .mp3 — the app loads ${name}.mp3, skipped`); continue }
    if (sameBytes(src, dest)) { log(`${name}: ${id} is already the live file — nothing to do`); if (!DRY) await markAudioIntegrated([name]); continue }
    plans.push({ name, id, src, dest, kind, others: kept.slice(1).map(([i]) => i) })
  }
  if (!plans.length) { log('nothing to promote (no kept candidates that differ from the live file)'); return }

  for (const p of plans) {
    const hadLive = existsSync(p.dest)
    const n = nextVersionNumber(p.name)
    const backup = join(GEN_DIR, 'versions', p.name, `v${n}.mp3`)
    log(`${p.name}: promote ${p.id}`)
    console.log(`  live   : ${rel(p.dest)}${hadLive ? '' : '  (no live file yet)'}`)
    if (hadLive) console.log(`  backup : ${rel(p.dest)} -> ${rel(backup)}`)
    console.log(`  copy   : ${rel(p.src)} -> ${rel(p.dest)}`)
    if (p.others.length) console.log(`  note   : ${p.others.length} other kept candidate(s) not promoted (one per run): ${p.others.join(', ')}`)
    if (DRY) continue
    if (hadLive) { mkdirSync(dirname(backup), { recursive: true }); copyFileSync(p.dest, backup) }
    mkdirSync(dirname(p.dest), { recursive: true })
    copyFileSync(p.src, p.dest)
    await updateState((s) => {
      const f = fileEntry(s, p.name)
      f.liveFrom = p.id
      f.promotedAt = nowIso()
      if (f.candidates[p.id]) f.candidates[p.id].promotedAt = f.promotedAt
    })
    await markAudioIntegrated([p.name])
  }
  if (DRY) return void log('dry-run: no files were changed')
  await writeAudioSelectionManifest()
  log(`promoted ${plans.length} sound(s) — validating with the asset-manifest generator + tests...`)
  const gen = await runNode(['tools/build/gen-asset-manifest.mjs'], ROOT)
  const vt = await runNode([resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/assets/assetManifest.test.ts'], ROOT)
  if (gen.code === 0 && vt.code === 0) log('validation passed: manifest regenerated and assetManifest tests are green. Rebuild the app to ship the new sounds.')
  else { warn('VALIDATION FAILED after promotion — the live files WERE replaced; old ones are in data/versions/<name>/. Inspect the output above.'); process.exitCode = 1 }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`queue: ${rel(QUEUE_FILE)}  state: ${rel(STATE_FILE)}${DRY ? '  [DRY RUN]' : ''}`)
  if (flag('--promote')) return promote()
  if (!flag('--watch')) return void await runQueue()
  const interval = Math.max(3, Number(val('--interval', 15))) * 1000
  log(`watching the queue every ${interval / 1000}s — Ctrl+C to stop`)
  for (;;) {
    await runQueue().catch((e) => warn(e.message))
    if (DRY) return
    await new Promise((r) => setTimeout(r, interval))
  }
}

main().catch((e) => { console.error('[audio-gen-runner] FAILED:', e.message); process.exit(1) })
