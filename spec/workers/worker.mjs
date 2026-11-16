#!/usr/bin/env node
/**
 * worker.mjs <name> — runs ONE stage of the nightly (see jobs.mjs for the list) and reports itself in
 * tools/spec-web/documentation/state/workers/<name>.json: status (running|done|failed|skipped), phase, percent, reason.
 * Exit code: 0 done, 1 failed, 3 skipped (not needed). The orchestrator (nightly-run.mjs) only watches these files and
 * enforces the time budgets; run a worker by hand to build or test just that part.
 */
import { JOBS } from './jobs.mjs'
import { EXIT, writeStatus } from './lib.mjs'

const name = process.argv[2]
const job = JOBS[name]
if (!job) { console.error(`unknown worker "${name}". Workers: ${Object.keys(JOBS).join(', ')}`); process.exit(2) }

writeStatus(name, { status: 'running', phase: 'starting', percent: 0, reason: null, startedAt: new Date().toISOString(), finishedAt: null, pid: process.pid })

// Everything the stage prints passes through here: "[progress] N% label" lines become the status, and any output is a heartbeat.
const realWrite = process.stdout.write.bind(process.stdout)
let carry = '', lastWrite = 0, pending = null
process.stdout.write = (chunk, ...rest) => {
  carry += String(chunk)
  const lines = carry.split(/\r?\n/); carry = lines.pop()
  for (const l of lines) { const m = /^\[progress\] (\d+)% (.*)$/.exec(l); if (m) pending = { percent: Number(m[1]), phase: m[2] } }
  if (Date.now() - lastWrite > 1500) { lastWrite = Date.now(); writeStatus(name, pending || {}); pending = null }
  return realWrite(chunk, ...rest)
}

const finish = (status, code, reason) => { writeStatus(name, { status, reason: reason || null, finishedAt: new Date().toISOString(), pid: null, ...(status === 'done' ? { percent: 100, phase: 'done' } : {}) }); process.exit(code) }

try {
  const skip = await job.skipReason?.()
  if (skip) { realWrite(`[worker ${name}] skipped: ${skip}\n`); finish('skipped', EXIT.SKIPPED, skip) }
  const res = await job.run()
  if (res && typeof res === 'object' && res.skipped) finish('skipped', EXIT.SKIPPED, res.skipped)
  else if (res) finish('done', EXIT.PASS)
  else finish('failed', EXIT.FAIL, 'the stage reported a failure; see its log')
} catch (e) {
  realWrite(`[worker ${name}] crashed: ${e.stack || e.message}\n`)
  finish('failed', EXIT.FAIL, `crashed: ${e.message}`)
}
