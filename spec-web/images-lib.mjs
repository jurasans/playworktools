/**
 * spec-web "Images" tab plumbing: review of generated art candidates (Space Chase, WI-1).
 * Candidates: <GEN_DIR>/spacechase/<group>/<asset>_v<N>.png (+ optional preview/<same>.webp thumbnails),
 * written by tools/generate/spacechase-art.mjs. One pick per asset is stored in images-state.json and
 * promoted into public/images/spacechase by tools/generate/spacechase-promote.mjs. Zero dependencies.
 */
import { resolve, dirname, extname, sep } from 'node:path'
import { readdir, readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { IMAGE_CATALOG, CATALOG_BY_ASSET } from './images-catalog.mjs'
import { composePrompt } from '../../tools/generate/spacechase-prompts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
export const IMG_DIR = resolve(process.env.SPEC_WEB_IMAGES_DIR || resolve(ROOT, 'tools', 'generate', 'data', 'spacechase'))
export const DATA_DIR = resolve(process.env.SPEC_WEB_DATA_DIR || resolve(HERE, 'documentation', 'state'))
export const IMG_STATE_FILE = resolve(DATA_DIR, 'images-state.json')
export const IMG_QUEUE_FILE = resolve(DATA_DIR, 'images-gen-queue.json')
export const GROUPS = ['player', 'enemy', 'asteroid', 'background']
export const IMG_MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' }

const FILE_RE = /^([a-z0-9_]+)_v(\d+)\.png$/

/** id 'group/file.png' or 'group/preview/file.webp' -> absolute path, or null when it escapes the allow-list. */
export function resolveImageId(id) {
  if (typeof id !== 'string' || id.length > 200 || id.includes('\0')) return null
  const p = id.split('/')
  if (!GROUPS.includes(p[0]) || p.length < 2 || p.length > 3) return null
  if (p.length === 3 && p[1] !== 'preview') return null
  const name = p[p.length - 1]
  if (!(extname(name).toLowerCase() in IMG_MIME) || name.includes('..')) return null
  const abs = resolve(IMG_DIR, ...p)
  return abs.startsWith(resolve(IMG_DIR, p[0]) + sep) ? abs : null
}

async function ls(dir) { try { return await readdir(dir) } catch { return [] } }

export async function listImages() {
  const found = new Map()
  for (const group of GROUPS) {
    const files = (await ls(resolve(IMG_DIR, group))).filter((f) => FILE_RE.test(f)).sort()
    const previews = new Set(await ls(resolve(IMG_DIR, group, 'preview')))
    for (const f of files) {
      const [, key, n] = FILE_RE.exec(f)
      const webp = f.replace(/\.png$/, '.webp')
      const st = await stat(resolve(IMG_DIR, group, f)).catch(() => null)
      const list = found.get(`${group}/${key}`) || []
      list.push({ id: `${group}/${f}`, preview: previews.has(webp) ? `${group}/preview/${webp}` : `${group}/${f}`, variant: Number(n), sizeKB: st ? Math.round(st.size / 1024) : 0, mtime: st ? st.mtime.toISOString() : null })
      found.set(`${group}/${key}`, list)
    }
  }
  // Cataloged assets first (in catalog order), even with no candidates yet; anything else on disk is listed after them.
  const keys = [...IMAGE_CATALOG.map((e) => e.asset), ...[...found.keys()].filter((k) => !CATALOG_BY_ASSET.has(k))]
  const assets = keys.map((asset) => {
    const meta = CATALOG_BY_ASSET.get(asset)
    const [group, key] = asset.split('/')
    return {
      asset, group, key, cataloged: !!meta, title: meta?.title || key.replace(/_/g, ' '), subject: meta?.subject || key.replace(/_/g, ' '),
      file: meta?.file || null, triggers: meta?.triggers || [], candidates: (found.get(asset) || []).sort((a, b) => a.variant - b.variant),
    }
  })
  return { dir: IMG_DIR, exists: assets.some((a) => a.candidates.length > 0), assets }
}

async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback } }

export async function readImageState() {
  const s = await readJson(IMG_STATE_FILE, null)
  return { version: 1, updatedAt: null, assets: s && typeof s.assets === 'object' && s.assets ? s.assets : {} }
}

/** One KEEP per asset unless the asset's `multi` box is ticked; `pick` mirrors the latest keep (what spacechase-promote.mjs reads). Mutates the entry. */
/** Turning `multi` off with several kept leaves only the latest pick kept. */
export function setMulti(entry, multi, now = new Date().toISOString()) {
  entry.multi = !!multi
  if (!entry.multi && entry.candidates) for (const [id, o] of Object.entries(entry.candidates)) if (o.decision === 'keep' && id !== entry.pick) { o.decision = 'reject'; o.updatedAt = now }
}

export function setDecision(entry, candidateId, decision, now = new Date().toISOString()) {
  entry.candidates = entry.candidates && typeof entry.candidates === 'object' ? entry.candidates : {}
  const c = (entry.candidates[candidateId] ||= { decision: 'reject', feedback: '' })
  c.decision = decision; c.updatedAt = now
  if (decision === 'keep') {
    if (!entry.multi) for (const [id, o] of Object.entries(entry.candidates)) if (id !== candidateId && o.decision === 'keep') { o.decision = 'reject'; o.updatedAt = now }
    entry.pick = candidateId
  } else if (entry.pick === candidateId) entry.pick = Object.entries(entry.candidates).filter(([, o]) => o.decision === 'keep').map(([id]) => id).pop() || null
  entry.updatedAt = now
}

let chain = Promise.resolve()
export function updateImageState(mutator) {
  const run = async () => {
    const state = await readImageState()
    const result = await mutator(state)
    state.updatedAt = new Date().toISOString()
    await mkdir(dirname(IMG_STATE_FILE), { recursive: true })
    const tmp = `${IMG_STATE_FILE}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(tmp, IMG_STATE_FILE)
    return result
  }
  const next = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

// ── generation queue (a host-side runner, tools/generate-runner.mjs, consumes it; this server never drives docker) ──
export async function readImageQueue() {
  const q = await readJson(IMG_QUEUE_FILE, null)
  return { jobs: Array.isArray(q?.jobs) ? q.jobs : [] }
}
let qchain = Promise.resolve()
export function updateImageQueue(mutator) {
  const run = async () => {
    const q = await readImageQueue()
    const result = await mutator(q)
    await mkdir(dirname(IMG_QUEUE_FILE), { recursive: true })
    const tmp = `${IMG_QUEUE_FILE}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(q, null, 2) + '\n', 'utf8')
    await rename(tmp, IMG_QUEUE_FILE)
    return result
  }
  const next = qchain.then(run, run)
  qchain = next.catch(() => {})
  return next
}
export const newImageJobId = () => 'img-' + Date.now().toString(36) + '-' + createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 4)

// ── prompt, integration and the folder metadata an agent reads ───────────────────────────────────────────────────────
export const keptKey = (entry) => Object.entries(entry?.candidates || {}).filter(([, c]) => c?.decision === 'keep').map(([id]) => id).sort().join('|')

/** Every note that steers the next round: the asset's own, plus the notes on versions that were not kept. */
export function notesFor(entry) {
  return [entry?.feedback, ...Object.values(entry?.candidates || {}).filter((c) => c?.feedback && c.decision !== 'keep').map((c) => c.feedback)]
    .filter(Boolean).join('. ')
}

/** What the page shows for an asset: the prompt its next round would use, and whether the kept version is integrated or completed. */
export function assetMeta(asset, entry) {
  const key = keptKey(entry)
  const integrated = !!key && entry?.integratedKey === key
  return {
    prompt: composePrompt(asset.group, asset.subject, notesFor(entry), entry?.rewrite && entry.rewrite.notes === notesFor(entry) ? entry.rewrite : null),
    kept: key ? key.split('|') : [],
    integrated, integratedAt: integrated ? entry.integratedAt : null,
    completed: integrated && !!entry.completedAt, completedAt: integrated ? entry.completedAt || null : null,
  }
}

/** Marks the assets' current kept versions as integrated into the game (the promote script calls this after writing the files). */
export function markIntegrated(assetIds) {
  return updateImageState((state) => {
    const done = []
    for (const id of assetIds) {
      const e = state.assets[id]
      if (!e || !keptKey(e)) continue
      e.integratedKey = keptKey(e); e.integratedAt = new Date().toISOString(); e.completedAt = null
      done.push(id)
    }
    return done
  })
}

/** Completing is only possible once the kept version is integrated; it clears the asset from the tab. */
export function setComplete(entry, complete) {
  if (complete && !(keptKey(entry) && entry.integratedKey === keptKey(entry))) throw new Error('the kept version is not integrated yet')
  entry.completedAt = complete ? new Date().toISOString() : null
}

/**
 * IMG_DIR/selection.json: the metadata next to the assets themselves. An agent that has to put the art into the game reads it
 * to see which versions are selected (status "selected" = chosen, not yet integrated), where they go, and what was already done.
 */
export async function writeSelectionManifest() {
  const listing = await listImages()
  const state = await readImageState()
  const assets = listing.assets.filter((a) => a.cataloged).map((a) => {
    const e = state.assets[a.asset] || {}
    const m = assetMeta(a, e)
    return {
      asset: a.asset, title: a.title, group: a.group, target: a.file ? `public/images/spacechase/${a.file}` : null,
      status: m.completed ? 'completed' : m.integrated ? 'integrated' : m.kept.length ? 'selected' : 'unselected',
      selected: m.kept.map((id) => ({ id, source: `tools/generate/data/spacechase/${id}`, inUse: id === e.pick })),
      multiSelect: !!e.multi, integratedAt: m.integratedAt, completedAt: m.completedAt,
      notes: notesFor(e) || null,
    }
  })
  const out = {
    generatedAt: new Date().toISOString(),
    howToIntegrate: 'Assets with status "selected" are chosen and not yet in the game. Run `node tools/generate/spacechase-promote.mjs` (writes the in-use version of each to `target` and marks it integrated), commit the webp files, and wire any new asset into the game code. A person then presses Complete in spec-web Assets -> Images.',
    assets,
  }
  await mkdir(IMG_DIR, { recursive: true })
  const file = resolve(IMG_DIR, 'selection.json')
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return out
}
