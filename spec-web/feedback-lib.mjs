/**
 * Shared plumbing for the spec-web "Feedback" tab (S-248) — a public,
 * unauthenticated customer survey (GET /feedback) plus an authenticated
 * Editor/Responses tab for the team, wired into server.mjs the same way
 * audio-lib.mjs/loc-lib.mjs are: this file owns no HTTP, just the data shape,
 * validation, and file I/O; server.mjs calls into it.
 *
 * Storage — deliberately TRACKED IN GIT (per the stub's confirmed answer),
 * unlike every other spec-web data file (audio-state.json, stub-analysis.json,
 * etc., all under documentation/state/, which stays gitignored). This lives
 * in its own sibling directory, documentation/feedback/, which the repo's
 * .gitignore does not touch, so the customer feedback record persists in git
 * history the same way SPEC_STUBS.md/CLAUDE.md do. Nothing here
 * auto-commits — a write is a plain file write, same as any other tracked
 * file; committing stays a manual `git add`/`commit` step for whoever's
 * maintaining the repo.
 *
 * Zero dependencies (node: builtins only), same convention as the rest of
 * spec-web.
 */
import { resolve, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
export const DATA_DIR = resolve(HERE, 'documentation', 'feedback')
export const TEMPLATE_FILE = resolve(DATA_DIR, 'feedback-template.json')
export const SUBMISSIONS_FILE = resolve(DATA_DIR, 'feedback-submissions.json')

// One feature is permanent — every submission carries at least one
// substantive, comparable data point even if every other feature is skipped
// (see the stub's confirmed A6). The editor can rename its label but can
// never remove it or make it optional.
export const OVERALL_ID = 'overall'
const SCALE = 5 // fixed 1-5 across every feature (A2) — not per-question
const MAX_FEATURES = 40
const MAX_LABEL_LEN = 160
const MAX_TEXT_LEN = 3000
const MAX_EMAIL_LEN = 254

// Seed list (A1) — one row per GAME_REGISTRY game (by display name, not the
// internal gameName key — this lib is a plain zero-dependency Node script and
// deliberately does not import the TS registry), one row folding both test
// catalogs together, one for sensor reliability, one for the trainer-facing
// surface, and the permanent Overall row. Purely a starting point: the editor
// can add/remove/reorder/relabel everything except OVERALL_ID.
export function defaultTemplate() {
  return {
    updatedAt: null,
    scale: SCALE,
    features: [
      { id: 'game_asteroid',      label: 'Asteroid (game)',                    removable: true,  required: false },
      { id: 'game_rolltheball',   label: 'Roll the Ball (game)',               removable: true,  required: false },
      { id: 'game_shootthebottle',label: 'Shoot the Bottle (game)',            removable: true,  required: false },
      { id: 'game_carride',       label: 'Car Ride (game)',                    removable: true,  required: false },
      { id: 'game_memorycards',   label: 'Memory Cards (game)',                removable: true,  required: false },
      { id: 'game_darthit',       label: 'Dart Hit (game)',                    removable: true,  required: false },
      { id: 'game_matchinggame',  label: 'Matching Game (game)',               removable: true,  required: false },
      { id: 'tests',              label: 'Strength & Clinical Tests',          removable: true,  required: false },
      { id: 'sensor',             label: 'Sensor Connectivity & Reliability',  removable: true,  required: false },
      { id: 'trainer',            label: 'Trainer Panel / Settings',           removable: true,  required: false },
      { id: OVERALL_ID,           label: 'Overall App Experience',             removable: false, required: true },
    ],
  }
}

// ── atomic json (same shape as audio-lib.mjs's writeJsonAtomic/serialized) ──
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}
async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}
const chains = new Map()
function serialized(file, fn) {
  const prev = chains.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(file, next.catch(() => {}))
  return next
}

// ── template ─────────────────────────────────────────────────────────────────
function normalizeFeature(f) {
  if (!f || typeof f !== 'object') return null
  const id = String(f.id ?? '').trim()
  const label = String(f.label ?? '').trim().slice(0, MAX_LABEL_LEN)
  if (!id || !/^[a-z0-9_]{1,64}$/i.test(id) || !label) return null
  return {
    id,
    label,
    removable: id === OVERALL_ID ? false : f.removable !== false,
    required: id === OVERALL_ID ? true : !!f.required,
  }
}

export async function readTemplate() {
  const raw = await readJson(TEMPLATE_FILE, null)
  if (!raw || !Array.isArray(raw.features)) return defaultTemplate()
  const seen = new Set()
  const features = []
  for (const f of raw.features) {
    const nf = normalizeFeature(f)
    if (!nf || seen.has(nf.id)) continue
    seen.add(nf.id)
    features.push(nf)
  }
  if (!seen.has(OVERALL_ID)) features.push(normalizeFeature({ id: OVERALL_ID, label: 'Overall App Experience' }))
  return { updatedAt: raw.updatedAt ?? null, scale: SCALE, features: features.slice(0, MAX_FEATURES) }
}

/** Validates + writes a full feature list from the editor. Returns
 *  { ok:true, template } or { ok:false, error }. Never trusts the caller for
 *  OVERALL_ID's removable/required flags — normalizeFeature() pins those. */
export async function writeTemplate(rawFeatures) {
  if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) return { ok: false, error: 'at least one feature is required' }
  if (rawFeatures.length > MAX_FEATURES) return { ok: false, error: `too many features (max ${MAX_FEATURES})` }
  const seen = new Set()
  const features = []
  for (const f of rawFeatures) {
    const nf = normalizeFeature(f)
    if (!nf) return { ok: false, error: `invalid feature: ${JSON.stringify(f)}` }
    if (seen.has(nf.id)) return { ok: false, error: `duplicate feature id: ${nf.id}` }
    seen.add(nf.id)
    features.push(nf)
  }
  if (!seen.has(OVERALL_ID)) features.push(normalizeFeature({ id: OVERALL_ID, label: 'Overall App Experience' }))
  return serialized(TEMPLATE_FILE, async () => {
    const template = { updatedAt: new Date().toISOString(), scale: SCALE, features }
    await writeJsonAtomic(TEMPLATE_FILE, template)
    return { ok: true, template }
  })
}

// ── submissions ──────────────────────────────────────────────────────────────
// Deliberately permissive email check (non-empty + a plausible shape) — this
// is a feedback form, not an account system; no confirmation email is ever
// sent, so there is nothing a stricter regex would actually protect.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function readSubmissions() {
  const raw = await readJson(SUBMISSIONS_FILE, null)
  return { submissions: Array.isArray(raw?.submissions) ? raw.submissions : [] }
}

/** Validates one public submission against the CURRENT template (read fresh,
 *  not trusted from the client) and appends it. Returns
 *  { ok:true, submission } or { ok:false, error }. */
export async function appendSubmission({ email, answers }) {
  const cleanEmail = String(email ?? '').trim().slice(0, MAX_EMAIL_LEN)
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) return { ok: false, error: 'a valid email is required' }
  if (!Array.isArray(answers)) return { ok: false, error: 'answers must be a list' }

  const template = await readTemplate()
  const byId = new Map(template.features.map((f) => [f.id, f]))
  const cleanAnswers = []
  const answered = new Set()
  for (const a of answers) {
    if (!a || typeof a !== 'object') continue
    const featureId = String(a.featureId ?? '').trim()
    const feature = byId.get(featureId)
    if (!feature || answered.has(featureId)) continue // unknown/duplicate feature id — silently dropped, not a hard error
    const scoreRaw = a.score
    const score = scoreRaw === null || scoreRaw === undefined || scoreRaw === '' ? null : Number(scoreRaw)
    const text = typeof a.text === 'string' ? a.text.trim().slice(0, MAX_TEXT_LEN) : ''
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > template.scale)) {
      return { ok: false, error: `invalid score for ${featureId}: must be an integer 1-${template.scale}` }
    }
    if (score === null && !text) continue // nothing answered for this feature — skip it entirely
    answered.add(featureId)
    cleanAnswers.push({ featureId, score, text })
  }
  const overall = cleanAnswers.find((a) => a.featureId === OVERALL_ID)
  if (!overall || overall.score === null) return { ok: false, error: 'an Overall App Experience score is required' }
  for (const f of template.features) {
    if (f.required && !cleanAnswers.some((a) => a.featureId === f.id && a.score !== null)) {
      return { ok: false, error: `"${f.label}" is required` }
    }
  }

  const submission = {
    id: 'sub_' + Date.now().toString(36) + '_' + randomBytes(4).toString('hex'),
    submittedAt: new Date().toISOString(),
    email: cleanEmail,
    answers: cleanAnswers,
  }
  return serialized(SUBMISSIONS_FILE, async () => {
    const data = await readSubmissions()
    data.submissions.push(submission)
    await writeJsonAtomic(SUBMISSIONS_FILE, data)
    return { ok: true, submission }
  })
}

// ── reporting ────────────────────────────────────────────────────────────────
/** Per-feature { featureId, label, count, avg } over every submission that
 *  answered it with a numeric score — computed against the template passed
 *  in (the CURRENT one, so a removed feature's historical answers still show
 *  under "(removed feature)" rather than vanishing silently). */
export function computeStats(template, submissions) {
  const byId = new Map(template.features.map((f) => [f.id, f]))
  const totals = new Map() // featureId -> { sum, count, label }
  for (const sub of submissions) {
    for (const a of sub.answers || []) {
      if (a.score === null || a.score === undefined) continue
      const feature = byId.get(a.featureId)
      const label = feature ? feature.label : `${a.featureId} (removed feature)`
      const cur = totals.get(a.featureId) || { sum: 0, count: 0, label }
      cur.sum += a.score
      cur.count += 1
      totals.set(a.featureId, cur)
    }
  }
  // Template order first (even ones with zero responses yet, so the editor
  // sees the full current question set), then any orphaned/removed ids.
  const rows = []
  for (const f of template.features) {
    const t = totals.get(f.id)
    rows.push({ featureId: f.id, label: f.label, count: t?.count ?? 0, avg: t ? t.sum / t.count : null })
    totals.delete(f.id)
  }
  for (const [featureId, t] of totals) rows.push({ featureId, label: t.label, count: t.count, avg: t.sum / t.count })
  return rows
}

// ── CSV export ───────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** One row per submission, one Score + Comments column pair per CURRENT
 *  template feature (in template order), plus a trailing catch-all column
 *  for any answer whose featureId no longer matches a live feature (a
 *  question the editor has since removed) so old data is never silently
 *  dropped from the export. */
export function buildCsv(template, submissions) {
  const header = ['Email', 'Submitted At']
  for (const f of template.features) header.push(`${f.label} — Score`, `${f.label} — Comments`)
  header.push('Other Answers')
  const lines = [header.map(csvCell).join(',')]
  const liveIds = new Set(template.features.map((f) => f.id))
  for (const sub of submissions) {
    const byId = new Map((sub.answers || []).map((a) => [a.featureId, a]))
    const row = [sub.email, sub.submittedAt]
    for (const f of template.features) {
      const a = byId.get(f.id)
      row.push(a?.score ?? '', a?.text ?? '')
    }
    const orphans = (sub.answers || []).filter((a) => !liveIds.has(a.featureId))
    row.push(orphans.map((a) => `${a.featureId}: ${a.score ?? ''} ${a.text ?? ''}`.trim()).join(' | '))
    lines.push(row.map(csvCell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
