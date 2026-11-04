#!/usr/bin/env node
/**
 * Runs the shared art + audio generation queue on the host, one job at a time in the order the spec-web tabs show (priority, then
 * oldest first), and keeps waiting for new ones (--once exits when the queue is empty). The ComfyUI container stays up and the models stay loaded between jobs; they are unloaded when the queue is empty.
 * The per-kind runners do the work (image-gen-runner.mjs / audio-gen-runner.mjs --job <id> --no-unload).
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nextQueuedJob } from '../spec-web/gen-queue.mjs'
import { updateImageQueue } from '../spec-web/images-lib.mjs'
import { updateQueue } from '../spec-web/audio-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const run = (script, args, cwd = HERE) => new Promise((res) => {
  const c = spawn(process.execPath, [resolve(HERE, script), ...args], { cwd, stdio: 'inherit' })
  c.on('error', () => res(-1))
  c.on('close', res)
})

// Only one of these runs at a time (the host-runner guards it), so a job still marked running was cut off by a crash or reboot.
const orphan = (q) => { for (const j of q.jobs) if (j.status === 'running') Object.assign(j, { status: 'failed', finishedAt: new Date().toISOString(), error: 'interrupted: the runner stopped before it finished' }) }
await updateImageQueue(orphan); await updateQueue(orphan)

let waiting = false
const once = process.argv.includes('--once')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failed = new Set()
let dirty = false // models are loaded since the last unload
for (;;) {
  const job = await nextQueuedJob()
  // A job that is still queued after its runner exited would loop forever; skip it once.
  if (!job || failed.has(job.id)) {
    if (dirty) { console.log('[gen-queue] queue empty: unloading the models (the container keeps running)'); await run('unload.mjs', [], HERE); dirty = false }
    if (once) break
    if (!waiting) { console.log('[gen-queue] waiting for jobs (Ctrl+C to stop)'); waiting = true }
    await sleep(3000)
    continue
  }
  waiting = false
  console.log(`[gen-queue] ${job.kind} job ${job.id}: ${job.label}`)
  const code = await run(job.kind === 'image' ? 'image-gen-runner.mjs' : 'audio-gen-runner.mjs', ['--job', job.id, '--no-unload'])
  if (code !== 0) failed.add(job.id)
  dirty = true
}
