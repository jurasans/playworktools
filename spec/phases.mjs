// Phase planner for a Start working (develop) run: which phases are needed for this work item, and why the others are skipped.
// Used through `work.mjs phases <WI-n> [--init] [--apply] [--final]`; the banner checklist then shows skipped phases struck out
// with the reason. --final means the code is written: decisions can then look at the files the run really changed.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as W from '../spec-web/workitems-lib.mjs'

const ROOT = W.ROOT
// Order matters: the manual is translated, then documented and committed, BEFORE any build starts (the app bundles the manual).
export const PHASES = ['Plan', 'Build', 'Assets', 'Translate', 'Document', 'Verify', 'Publish', 'Hand over']
// Phases that touch disjoint files and can run at the same time: integrating chosen art/audio copies into public/, the translation
// writes docs/manual/<lang>/ (Ollama). Everything else waits for the one before it (Document commits what both produced).
export const CONCURRENT = [['Assets', 'Translate']]

const git = (args) => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout : '' }

// Files the run touched: every commit recorded on the work item plus whatever is still uncommitted.
export function changedFiles(wi) {
  const files = new Set()
  for (const c of wi.commits || []) for (const f of git(['show', '--name-only', '--format=', c.sha]).split(/\r?\n/)) if (f.trim()) files.add(f.trim())
  for (const l of git(['status', '--porcelain']).split(/\r?\n/)) if (l.trim()) files.add(l.slice(3).trim().replace(/^"|"$/g, ''))
  return [...files]
}

// Art/audio a person already chose that is not in the game yet (their selection files list it as "selected").
function chosenAssetsWaiting() {
  const reasons = []
  for (const f of ['tools/generate/data/spacechase/selection.json', 'tools/generate/data/audio-output/selection.json']) {
    const p = resolve(ROOT, f)
    if (!existsSync(p)) continue
    try { if (JSON.stringify(JSON.parse(readFileSync(p, 'utf8'))).includes('"status":"selected"')) reasons.push(f) } catch { /* unreadable: treated as nothing chosen */ }
  }
  return reasons
}

const APP_FILE = /^(src|public|android-proguard)\/|^(index\.html|package(-lock)?\.json|vite\.config\.\w+|capacitor\.config\.\w+)$/

// Returns [{ phase, skip: reason | null }] in PHASES order.
export function planPhases(wi, { final = false } = {}) {
  const analysis = wi.analysis || {}
  const docsOnly = !!wi.analysis && !(analysis.codeGaps || []).length && !(wi.stubIds || []).length
  const backend = wi.domain === 'backend'
  const changed = final ? changedFiles(wi) : []
  const touchedApp = changed.some((f) => APP_FILE.test(f))
  const touchedManual = changed.some((f) => f.startsWith('docs/manual/en/'))
  const rework = !!wi.sentBack
  const skip = {}
  if (docsOnly) {
    skip.Plan = 'every edit only describes behaviour that already exists: no tickets needed'
    skip.Build = 'documentation only: nothing to build'
    skip.Assets = 'documentation only'
    skip.Translate = 'documentation only: the manual did not change'
    skip.Publish = 'documentation only: no app change to build'
  }
  if (rework) skip.Plan = 'rework of existing stubs: no new tickets'
  if (!chosenAssetsWaiting().length) skip.Assets = skip.Assets || 'no art or audio a person chose is waiting to be integrated'
  if (final && !touchedManual) skip.Translate = 'the English manual did not change in this run'
  if (final && !touchedApp) skip.Publish = 'no file that goes into the app changed (src, public, package files): the existing build is current'
  if (backend) skip.Publish = 'backend work item: there is no app build to publish'
  return PHASES.map((phase) => ({ phase, skip: skip[phase] || null }))
}
