#!/usr/bin/env node
// Space Chase art batch (WI-1): N SDXL variants per asset for review in spec-web's Images tab.
// Usage: node spacechase-art.mjs [--variants 4] [--only player,enemy,asteroid,background] [--seed 7000] [--var "<subject>" --extra "<wording>" --extra-neg "<terms to avoid>" --out <dir>]
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEG, GROUPS } from './spacechase-prompts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const variants = arg('variants', '4')
const seed = arg('seed', '7000')
const only = arg('only', 'player,enemy,asteroid,background').split(',')
// Single-asset rounds (spec-web's "Generate new options", via image-gen-runner.mjs): one subject, extra wording, own output folder.
const oneVar = arg('var', null)
const extra = arg('extra', '')
const extraNeg = arg('extra-neg', '')
const outOverride = arg('out', null)


const list = only.filter((k) => GROUPS[k])
list.forEach((k, idx) => {
  const g = GROUPS[k]
  const args = ['generate.mjs', '--prompt', extra ? `${g.prompt}, ${extra}` : g.prompt, '--vars', (oneVar ? [oneVar] : g.vars).join(','), '--variants', variants,
    '--seed', String(Number(seed) + idx * 100 + (arg('seed-shift', '0') | 0)), '--negative', extraNeg ? `${NEG}, ${extraNeg}` : NEG, '--width', String(g.w), '--height', String(g.h),
    '--out', outOverride ? path.resolve(outOverride) : g.out]
  if (idx < list.length - 1 || process.argv.includes('--keep-running')) args.push('--keep-running')
  const r = spawnSync('node', args, { cwd: here, stdio: 'inherit' })
  if (r.status !== 0) console.error(`[spacechase-art] ${k} exited ${r.status}`)
})
