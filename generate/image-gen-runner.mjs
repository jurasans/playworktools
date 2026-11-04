#!/usr/bin/env node
/**
 * Host-side runner for the spec-web "Images" tab (Space Chase art).
 *
 * spec-web (often a Docker container) cannot drive the host's docker/GPU, so the tab only APPENDS JOBS to
 * tools/spec-web/documentation/state/images-gen-queue.json. This script consumes that queue:
 *
 *   node tools/generate-runner.mjs                process every queued job, then exit
 *   node tools/generate-runner.mjs --job <id>     process just that job
 *   node tools/generate-runner.mjs --dry-run      print what WOULD run; touches nothing
 *
 * A job is one asset and N new candidates. It runs spacechase-art.mjs for that single subject, with the asset's feedback
 * (and the notes on its rejected candidates) folded into the prompt as extra wording, into a scratch folder; the files are
 * then added to the asset's folder as the next free versions (_v5, _v6 ...), so earlier candidates and their Keep/Reject
 * state are never overwritten. When the queue is empty the models are unloaded from the GPU and the ComfyUI container is left running. A job may carry `promptOverride`, a string that replaces the feedback wording.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMG_DIR, readImageQueue, updateImageQueue } from '../spec-web/images-lib.mjs'
import { composePrompt } from './spacechase-prompts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMAGE_GEN = HERE
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const only = argv.includes('--job') ? argv[argv.indexOf('--job') + 1] : null
const log = (m) => console.log(`[image-gen-runner] ${m}`)

const seedFor = (id) => parseInt(createHash('sha1').update(id).digest('hex').slice(0, 6), 16)
const patchJob = (id, patch) => updateImageQueue((q) => { const j = q.jobs.find((x) => x.id === id); if (j) Object.assign(j, patch) })

// The same prompt the Images tab shows: notes that say what to leave out ("no wings") go to the negative prompt, the rest is wording.
function wording(job) {
  if (typeof job.promptOverride === 'string' && job.promptOverride.trim()) return { positive: job.promptOverride.trim().slice(0, 600), negative: '' }
  if (typeof job.extraPositive === 'string' || typeof job.extraNegative === 'string') return { positive: (job.extraPositive || '').slice(0, 600), negative: (job.extraNegative || '').slice(0, 600) }
  const notes = [job.feedbackSnapshot, ...(job.candidateFeedback || []).map((c) => c.feedback)].filter(Boolean).join('. ')
  const p = composePrompt(job.group, job.subject, notes)
  return { positive: p.extraPositive.slice(0, 600), negative: p.extraNegative.slice(0, 600) }
}

function run(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { cwd: IMAGE_GEN, stdio: 'inherit' })
    c.on('error', () => res(-1))
    c.on('close', (code) => res(code))
  })
}

async function processJob(job) {
  const { positive: extra, negative: extraNeg } = wording(job)
  const scratch = join(IMG_DIR, '.jobs', job.id)
  const args = ['spacechase-art.mjs', '--only', job.group, '--var', job.subject, '--variants', String(job.count),
    '--seed', String(seedFor(job.id)), '--out', scratch, '--keep-running', ...(extra ? ['--extra', extra] : []), ...(extraNeg ? ['--extra-neg', extraNeg] : [])]
  log(`job ${job.id}: ${job.asset} x${job.count}${extra ? ` with wording "${extra}"` : ''}${extraNeg ? ` and avoiding "${extraNeg}"` : ''}`)
  if (DRY) { console.log(`  cwd: ${IMAGE_GEN}\n  cmd: node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`); return }

  await patchJob(job.id, { status: 'running', startedAt: new Date().toISOString(), error: undefined })
  mkdirSync(scratch, { recursive: true })
  const code = await run(args)
  const made = existsSync(scratch) ? readdirSync(scratch).filter((f) => /_v\d+\.png$/.test(f)).sort() : []
  if (!made.length) {
    await patchJob(job.id, { status: 'failed', finishedAt: new Date().toISOString(), error: `spacechase-art exited ${code} and produced no images` })
    log(`job ${job.id} FAILED`)
    return
  }
  const dest = resolve(IMG_DIR, job.group)
  mkdirSync(dest, { recursive: true })
  const key = job.asset.split('/')[1]
  const taken = readdirSync(dest).map((f) => new RegExp(`^${key}_v(\\d+)\\.png$`).exec(f)).filter(Boolean).map((m) => Number(m[1]))
  let next = (taken.length ? Math.max(...taken) : 0) + 1
  const produced = []
  for (const f of made) {
    const name = `${key}_v${next++}.png`
    renameSync(join(scratch, f), join(dest, name))
    produced.push(`${job.group}/${name}`)
  }
  rmSync(scratch, { recursive: true, force: true })
  await run(['spacechase-previews.mjs'])
  await patchJob(job.id, {
    status: 'done', finishedAt: new Date().toISOString(), produced,
    warning: produced.length < job.count ? `only ${produced.length}/${job.count} images were produced` : undefined,
  })
  log(`job ${job.id} done: ${produced.length} new candidate(s)`)
}

// Keep going until nothing is queued (jobs may be added while one runs); only then free the GPU. The ComfyUI container stays up and
// the models stay loaded between jobs, so a queue of several pays the model load once.
let ran = 0
for (;;) {
  const todo = (await readImageQueue()).jobs.filter((j) => j.status === 'queued' && (!only || j.id === only))
  if (!todo.length) break
  for (const job of todo) { await processJob(job); ran++ }
  if (only) break
}
if (!ran) log(only ? `job ${only} is not queued` : 'queue empty')
else if (!DRY && !argv.includes('--no-unload')) { log('queue empty: unloading the models (the container keeps running)'); await run(['unload.mjs']) }
