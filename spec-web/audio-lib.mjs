/**
 * Shared audio plumbing for the spec-web "Audio" tab (S-235) — used by
 * server.mjs (HTTP endpoints) AND tools/generate/audio-gen-runner.mjs (host-side
 * generation/promotion runner), so both agree on where files live, what a
 * file id means, and how the state/queue files are read and written.
 *
 * Zero dependencies (node: builtins only), same as the rest of spec-web.
 *
 * Roots (override with env; defaults work when running directly on the host,
 * and inside the spec-web container too since the whole repo is bind-mounted
 * at /repo):
 *   SPEC_WEB_AUDIO_LIVE_DIR  default <repo>/public/audio          (sfx/, music/)
 *   SPEC_WEB_AUDIO_GEN_DIR   default <repo>/tools/generate/data (versions/, audio-output/)
 *   SPEC_WEB_DATA_DIR        default <repo>/tools/spec-web/documentation/state   (state + queue files)
 *
 * File ids (what the state file and the API use — never raw paths):
 *   live/<sfx|music>/<file>                  the bundled, in-app file
 *   gen/versions/<name>/vN.<ext>             an older/newer version (generate-sound --wire-to)
 *   gen/audio-output/<...>/<file>            a raw generation output / review-batch variant
 */
import { resolve, dirname, relative, sep, extname, basename } from 'node:path'
import { readdir, stat, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CATALOG, CATALOG_BY_NAME } from './audio-catalog.mjs'
import { previewPrompt } from './audio-prompt.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')

export const LIVE_DIR = resolve(process.env.SPEC_WEB_AUDIO_LIVE_DIR || resolve(ROOT, 'public', 'audio'))
export const GEN_DIR = resolve(process.env.SPEC_WEB_AUDIO_GEN_DIR || resolve(ROOT, 'tools', 'generate', 'data'))
export const DATA_DIR = resolve(process.env.SPEC_WEB_DATA_DIR || resolve(HERE, 'documentation', 'state'))
export const STATE_FILE = resolve(DATA_DIR, 'audio-state.json')
export const QUEUE_FILE = resolve(DATA_DIR, 'audio-gen-queue.json')

export const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' }
// No "undecided" — a file/candidate is either the one kept option or it's rejected. A row
// with a stale legacy 'undecided' value (written before this changed) reads as rejected
// everywhere below (DECISION.has() rejects writing it back, and every reader treats
// anything !== 'keep' as reject) — no migration pass needed, it self-heals on next write.
export const DECISIONS = new Set(['keep', 'reject'])
export const JOB_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'cancelled'])

const ROOTS = {
  live: { dir: LIVE_DIR, allow: ['sfx', 'music'] },
  gen: { dir: GEN_DIR, allow: ['versions', 'audio-output'] },
}

const isAudio = (name) => extname(name).toLowerCase() in AUDIO_MIME
const slash = (p) => p.split(sep).join('/')

// ── ids ──────────────────────────────────────────────────────────────────────
/** id ('live/sfx/pickup.mp3') -> absolute path, or null if it escapes the
 *  allowed sub-roots / isn't an audio extension. Never touches the disk. */
export function resolveId(id) {
  if (typeof id !== 'string' || id.length > 400 || id.includes('\0')) return null
  const parts = id.split('/')
  const root = ROOTS[parts[0]]
  if (!root || parts.length < 3 || !root.allow.includes(parts[1])) return null
  const abs = resolve(root.dir, ...parts.slice(1))
  const sub = resolve(root.dir, parts[1])
  if (!abs.startsWith(sub + sep) || !isAudio(abs)) return null
  return abs
}

export function idFor(rootKey, abs) {
  return rootKey + '/' + slash(relative(ROOTS[rootKey].dir, abs))
}

// ── atomic json ──────────────────────────────────────────────────────────────
async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

// Writes within ONE process are serialized so two quick PUTs can't lose an
// update (read-modify-write interleaving). Cross-process races (server vs the
// host runner) are narrow and last-writer-wins on distinct fields; the runner
// re-reads right before each write.
const chains = new Map()
function serialized(file, fn) {
  const prev = chains.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(file, next.catch(() => {}))
  return next
}

// ── state file ───────────────────────────────────────────────────────────────
export const emptyState = () => ({ version: 1, updatedAt: null, files: {}, generationRequests: [] })

export async function readState() {
  const s = await readJson(STATE_FILE, null)
  if (!s || typeof s !== 'object') return emptyState()
  return { ...emptyState(), ...s, files: s.files && typeof s.files === 'object' ? s.files : {}, generationRequests: Array.isArray(s.generationRequests) ? s.generationRequests : [] }
}

/** mutator(state) may mutate in place; returns whatever it returns. */
export function updateState(mutator) {
  return serialized(STATE_FILE, async () => {
    const state = await readState()
    const result = await mutator(state)
    state.updatedAt = new Date().toISOString()
    await writeJsonAtomic(STATE_FILE, state)
    return result
  })
}

export function fileEntry(state, name) {
  const cur = state.files[name]
  if (cur && typeof cur === 'object') {
    cur.candidates = cur.candidates && typeof cur.candidates === 'object' ? cur.candidates : {}
    return cur
  }
  return (state.files[name] = { decision: 'reject', feedback: '', updatedAt: null, candidates: {} })
}

/**
 * Enforces "only one KEEP per sound" — across the live file AND every one of its
 * generation candidates. Call this right after setting some target's decision to
 * 'keep'; it flips every OTHER target for the same sound's `entry` back to 'reject'.
 * `keptCandidateId` is the candidate id that should stay kept, or `null` when the
 * live file itself is the one being kept (in which case every candidate is rejected).
 * Mutates `entry` in place; caller is responsible for persisting it (via updateState).
 */
export function enforceSingleKeep(entry, keptCandidateId, now = new Date().toISOString()) {
  if (entry.multi) return // the multi-select switch allows several kept clips; the latest keep is the one promoted
  if (keptCandidateId !== null && entry.decision === 'keep') { entry.decision = 'reject'; entry.updatedAt = now }
  for (const [id, c] of Object.entries(entry.candidates || {})) {
    if (id !== keptCandidateId && c?.decision === 'keep') { c.decision = 'reject'; c.updatedAt = now }
  }
}

// ── queue file ───────────────────────────────────────────────────────────────
export async function readQueue() {
  const q = await readJson(QUEUE_FILE, null)
  return { jobs: Array.isArray(q?.jobs) ? q.jobs : [] }
}

export function updateQueue(mutator) {
  return serialized(QUEUE_FILE, async () => {
    const q = await readQueue()
    const result = await mutator(q)
    await writeJsonAtomic(QUEUE_FILE, q)
    return result
  })
}

export function newJobId() {
  return 'job-' + Date.now().toString(36) + '-' + createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 4)
}

// ── listing ──────────────────────────────────────────────────────────────────
const hashCache = new Map() // abs -> { key, hash }
async function hashOf(abs, st) {
  const key = `${st.size}:${st.mtimeMs}`
  const hit = hashCache.get(abs)
  if (hit && hit.key === key) return hit.hash
  const hash = createHash('md5').update(await readFile(abs)).digest('hex')
  hashCache.set(abs, { key, hash })
  return hash
}

async function walkAudio(dir, depth = 6) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const abs = resolve(dir, e.name)
    if (e.isDirectory() && depth > 0) out.push(...await walkAudio(abs, depth - 1))
    else if (e.isFile() && isAudio(e.name)) out.push(abs)
  }
  return out
}

/** Maps a generation-folder file to the sound it belongs to, or null.
 *  versions/<name>/vN.ext  -> { name, version: N }
 *  audio-output/**\/<name>.ext | <name>_vN.ext -> { name, variant: N|null } */
function classify(rootRel, known) {
  const parts = rootRel.split('/')
  if (parts[0] === 'versions' && parts.length === 3) {
    const m = /^v(\d+)\./i.exec(parts[2])
    if (known.has(parts[1]) && m) return { origin: 'version', name: parts[1], version: Number(m[1]) }
    return null
  }
  if (parts[0] === 'audio-output') {
    const stem = basename(parts[parts.length - 1], extname(parts[parts.length - 1]))
    const m = /^(.+?)_v(\d+)$/.exec(stem)
    if (m && known.has(m[1])) return { origin: 'output', name: m[1], variant: Number(m[2]) }
    if (known.has(stem)) return { origin: 'output', name: stem, variant: null }
  }
  return null
}

/**
 * Everything the Audio tab needs about the sounds themselves (no screenshots
 * here — the server resolves those, it owns the e2e-artifacts path).
 * `roots` reports which directories exist so the UI can say *why* a list is
 * empty (e.g. container without the mounts).
 */
export async function listAudio() {
  const liveFiles = new Map() // name -> { id, abs, kind, st }
  for (const kind of ROOTS.live.allow) {
    for (const abs of await walkAudio(resolve(LIVE_DIR, kind), 1)) {
      const name = basename(abs, extname(abs))
      liveFiles.set(`${kind}/${name}`, { abs, kind, name, id: idFor('live', abs), st: await stat(abs) })
    }
  }

  const known = new Set(CATALOG.map((c) => c.name))
  for (const l of liveFiles.values()) known.add(l.name)

  // live hash lookup per sound
  const liveHash = new Map()
  for (const l of liveFiles.values()) liveHash.set(l.name, await hashOf(l.abs, l.st))

  const genRoots = ROOTS.gen.allow.map((sub) => resolve(GEN_DIR, sub))
  const genFiles = []
  for (const dir of genRoots) genFiles.push(...await walkAudio(dir))

  const folderCounts = new Map()
  const byName = new Map() // name -> { versions:[], candidates:[] }
  const unmatched = []
  for (const abs of genFiles.sort()) {
    const rel = slash(relative(GEN_DIR, abs))
    const folder = idFor('gen', dirname(abs))
    folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1)
    const c = classify(rel, known)
    if (!c) { unmatched.push(idFor('gen', abs)); continue }
    const st = await stat(abs)
    const hash = await hashOf(abs, st)
    const slot = byName.get(c.name) || byName.set(c.name, { versions: [], candidates: [] }).get(c.name)
    const item = {
      id: idFor('gen', abs),
      folder: slash(relative(GEN_DIR, dirname(abs))),
      file: basename(abs),
      sizeKB: Math.round(st.size / 102.4) / 10,
      mtime: new Date(st.mtimeMs).toISOString(),
      isLive: liveHash.get(c.name) === hash,
    }
    if (c.origin === 'version') slot.versions.push({ ...item, version: c.version })
    else slot.candidates.push({ ...item, variant: c.variant })
  }
  for (const s of byName.values()) s.versions.sort((a, b) => a.version - b.version)

  const sounds = []
  const seen = new Set()
  const build = (name, kind, cat) => {
    const live = liveFiles.get(`${kind}/${name}`)
    const gen = byName.get(name) || { versions: [], candidates: [] }
    sounds.push({
      name,
      kind,
      title: cat?.title || name,
      cataloged: !!cat,
      triggers: cat?.triggers || [],
      request: cat?.request || null,
      screens: cat?.screens || [],
      placeholderOf: live ? [...liveFiles.values()].filter((o) => o !== live && liveHash.get(o.name) === liveHash.get(name)).map((o) => o.name) : [],
      live: live ? { id: live.id, sizeKB: Math.round(live.st.size / 102.4) / 10, mtime: new Date(live.st.mtimeMs).toISOString() } : null,
      versions: gen.versions,
      candidates: gen.candidates,
    })
    seen.add(`${kind}/${name}`)
  }
  for (const cat of CATALOG) build(cat.name, cat.kind, cat)
  for (const l of liveFiles.values()) if (!seen.has(`${l.kind}/${l.name}`)) build(l.name, l.kind, CATALOG_BY_NAME.get(l.name))

  // folders that actually contain audio — the tab never lists empty ones
  const folders = [
    ...ROOTS.live.allow.map((sub) => ({ id: `live/${sub}`, count: [...liveFiles.values()].filter((l) => l.kind === sub).length })),
    ...[...folderCounts].map(([id, count]) => ({ id, count })),
  ].filter((f) => f.count > 0).sort((a, b) => a.id.localeCompare(b.id))

  const exists = async (p) => { try { await stat(p); return true } catch { return false } }
  return {
    sounds,
    folders,
    unmatchedCount: unmatched.length,
    roots: {
      live: { dir: LIVE_DIR, exists: await exists(LIVE_DIR) },
      gen: { dir: GEN_DIR, exists: await exists(GEN_DIR) },
    },
  }
}

export function knownNames() {
  return new Set(CATALOG.map((c) => c.name))
}

/** Adds any live file names (uncataloged sounds) to knownNames(). */
export async function knownNamesWithLive() {
  const s = knownNames()
  for (const kind of ROOTS.live.allow) {
    for (const abs of await walkAudio(resolve(LIVE_DIR, kind), 1)) s.add(basename(abs, extname(abs)))
  }
  return s
}


// ── prompt, integration and the metadata an agent reads ──────────────────────────────────────────────────────────────
/** The kept generated clips of a sound, as one comparable string. Keeping only the bundled live file is not a selection. */
export const audioKeptKey = (entry) => Object.entries(entry?.candidates || {}).filter(([, c]) => c?.decision === 'keep').map(([id]) => id).sort().join('|')

/** Every note that steers the next round: the sound's own, plus the notes on clips that were not kept. */
export function audioNotes(entry) {
  return [entry?.feedback, ...Object.values(entry?.candidates || {}).filter((c) => c?.feedback && c.decision !== 'keep').map((c) => c.feedback)]
    .filter(Boolean).join('. ')
}

/** What the page shows for a sound. Keeping the live file means nothing to integrate, so that counts as integrated. */
// hasLive: the bundled file exists. Keeping a sound that has no live file and no clip keeps nothing, so it never counts as integrated.
export function audioMeta(name, kind, entry, hasLive = true) {
  const key = audioKeptKey(entry)
  const liveKept = !key && entry?.decision === 'keep' && hasLive
  const integrated = key ? entry?.integratedKey === key : liveKept
  const notes = audioNotes(entry)
  return {
    prompt: previewPrompt(name, kind, notes, entry?.rewrite && entry.rewrite.notes === notes ? entry.rewrite : null),
    kept: key ? key.split('|') : [], liveKept, integrated,
    integratedAt: integrated && key ? entry.integratedAt || null : null,
    completed: integrated && !!entry?.completedAt, completedAt: integrated ? entry?.completedAt || null : null,
  }
}

/** The promote step calls this after copying the kept clips into the app. */
export function markAudioIntegrated(names) {
  return updateState((state) => {
    const done = []
    for (const name of names) {
      const e = state.files[name]
      if (!e || !audioKeptKey(e)) continue
      e.integratedKey = audioKeptKey(e); e.integratedAt = new Date().toISOString(); e.completedAt = null
      done.push(name)
    }
    return done
  })
}

export function setAudioComplete(entry, name, kind, complete, hasLive = true) {
  if (complete && !audioKeptKey(entry) && !hasLive) throw new Error('this sound is empty: there is no live file or clip to complete')
  if (complete && !audioMeta(name, kind, entry, hasLive).integrated) throw new Error('the kept clip is not integrated yet')
  entry.completedAt = complete ? new Date().toISOString() : null
}

/**
 * GEN_DIR/audio-output/selection.json: the metadata next to the clips. An agent that has to wire sounds into the app reads it to
 * see which clips are selected ("selected" = chosen, not yet promoted), where they go, and what was already done.
 */
export async function writeAudioSelectionManifest() {
  const [listing, state] = await Promise.all([listAudio(), readState()])
  const sounds = listing.sounds.map((snd) => {
    const e = state.files[snd.name] || {}
    const m = audioMeta(snd.name, snd.kind, e, !!snd.live)
    return {
      name: snd.name, title: snd.title, kind: snd.kind, target: `public/audio/${snd.kind}/${snd.name}.mp3`,
      status: m.completed ? 'completed' : m.kept.length ? (m.integrated ? 'integrated' : 'selected') : 'unselected',
      selected: m.kept.map((id) => ({ id, source: resolveId(id) ? relative(ROOT, resolveId(id)).split(sep).join('/') : id })),
      multiSelect: !!e.multi, integratedAt: m.integratedAt, completedAt: m.completedAt, notes: audioNotes(e) || null,
    }
  }).filter((x) => x.status !== 'unselected' || x.notes)
  const out = {
    generatedAt: new Date().toISOString(),
    howToIntegrate: 'Sounds with status "selected" are chosen and not yet in the app. Run `node tools/generate/audio-gen-runner.mjs --promote` (copies the newest selected clip over `target`, backs up the old file and marks the sound integrated), then rebuild. A person presses Complete in spec-web Assets -> Audio.',
    sounds,
  }
  const file = resolve(GEN_DIR, 'audio-output', 'selection.json')
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
  return out
}
