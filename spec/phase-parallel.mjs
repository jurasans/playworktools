#!/usr/bin/env node
/**
 * phase-parallel.mjs — runs several phase-run.mjs steps AT THE SAME TIME and waits for all of them (one blocking call for the agent).
 *   node tools/spec/phase-parallel.mjs \
 *     --job "Verify: unit|20|10|npm run verify" \
 *     --job "Verify: e2e|45|15|npx playwright test e2e/home.spec.ts"
 * A job is "label|timeoutMin|idleMin|command". Each runs under its own budget (phase-run.mjs), shows on the site with its own percent,
 * and its output is printed prefixed with the label. Exit code: 0 when every job passed, else 1 (a failed step never stops its siblings).
 * Only put steps here that cannot disturb each other (different ports, files and caches); the skill lists which ones.
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { ROOT } from './workers/lib.mjs'

const jobs = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i] === '--job') jobs.push(argv[++i])
if (jobs.length < 2) { console.error('usage: phase-parallel.mjs --job "label|timeoutMin|idleMin|command" --job ... (at least two)'); process.exit(2) }
const RUN = resolve(ROOT, 'tools', 'spec', 'phase-run.mjs')

const run = (spec) => new Promise((res) => {
  const [label, timeout, idle, ...rest] = spec.split('|')
  const command = rest.join('|').trim()
  if (!label || !command || !(Number(timeout) > 0)) { console.error(`bad job "${spec}"`); return res({ label: label || spec, code: 2 }) }
  const child = spawn(`node "${RUN}" --label "${label}" --timeout ${Number(timeout)} --idle ${Number(idle) || 10} -- ${command}`, { cwd: ROOT, shell: true })
  const tag = (d) => String(d).split(/\r?\n/).filter(Boolean).map((l) => `[${label}] ${l}`).join('\n') + '\n'
  child.stdout.on('data', (d) => process.stdout.write(tag(d)))
  child.stderr.on('data', (d) => process.stderr.write(tag(d)))
  child.on('exit', (code) => setTimeout(() => res({ label, code: code ?? 1 }), 2000))
  child.on('error', () => res({ label, code: 1 }))
})

console.log(`[phase-parallel] starting ${jobs.length} steps at the same time`)
const results = await Promise.all(jobs.map(run))
for (const r of results) console.log(`[phase-parallel] ${r.code === 0 ? '✓' : '✗'} ${r.label}${r.code === 0 ? '' : ` (exit ${r.code})`}`)
process.exit(results.every((r) => r.code === 0) ? 0 : 1)
