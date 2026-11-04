#!/usr/bin/env node
// Asset-manifest code generator (S-235).
//
// Scans public/audio/**, public/images/** and public/videos/** and generates
// src/assets/assetManifest.generated.ts — the single source of truth for
// "which asset files exist" that runtime code (pickVariant.ts, audio/index.ts)
// and the validation tests (src/assets/assetManifest.test.ts) read from.
// It replaces the hand-maintained src/assets/imageVariants.json, which drifted
// from disk every time a file was deleted/renumbered by hand.
//
// Usage:
//   node tools/build/gen-asset-manifest.mjs           regenerate (writes the file)
//   node tools/build/gen-asset-manifest.mjs --check   exit 1 if the committed file is stale
//
// Variant semantics (identical to the old imageVariants.json + pickVariant.ts):
//   * `<stem>.webp` alone, or a single `<stem>_1.webp`  => not a variant family
//     (bare-file lookup) — a lone numbered file is reported as an ERROR because
//     the bare path pickVariant would resolve does not exist.
//   * `<stem>_1.webp` … `<stem>_N.webp` (N > 1, contiguous)  => IMAGE_VARIANTS[stem] = N
//   * numbering that does not run 1..N contiguously => ERROR (gap: a random pick
//     could land on a nonexistent file). Fix with tools/generate/reindex-variants.mjs.
//   * a bare `<stem>.webp` next to a numbered family => WARNING (the bare file is
//     unreachable for a family with N > 1).

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve, extname, basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
export const PUBLIC_DIR = resolve(ROOT, 'public')
export const OUT_PATH = resolve(ROOT, 'src', 'assets', 'assetManifest.generated.ts')

const VARIANT_RE = /^(.*)_(\d+)$/
const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.svg', '.gif'])
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov'])

/** Recursively lists files under `dir`, returning paths relative to it ('/'-separated, sorted). */
function walk(dir, rel = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const r = rel ? `${rel}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walk(full, r))
    else out.push(r)
  }
  return out
}

/** Groups relative file paths by their folder ('' => top level). */
function groupByFolder(files) {
  const map = {}
  for (const f of files) {
    const i = f.lastIndexOf('/')
    const folder = i === -1 ? '' : f.slice(0, i)
    const name = i === -1 ? f : f.slice(i + 1)
    ;(map[folder] ||= []).push(name)
  }
  for (const k of Object.keys(map)) map[k].sort()
  return map
}

function sortObj(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Scans public/ and returns everything the generator (and tests) need.
 * `errors` are irregularities that make the generator refuse to write;
 * `warnings` are informational.
 */
export function scanAssets(publicDir = PUBLIC_DIR) {
  const errors = []
  const warnings = []

  // ── audio ────────────────────────────────────────────────────────────────
  const audioFiles = groupByFolder(walk(resolve(publicDir, 'audio')))
  const sfx = {}
  const music = {}
  for (const [folder, names] of Object.entries(audioFiles)) {
    for (const n of names) {
      const ext = extname(n).toLowerCase()
      if (!AUDIO_EXTS.has(ext)) errors.push(`audio/${folder ? folder + '/' : ''}${n}: unexpected non-audio file type`)
    }
    if (folder !== 'sfx' && folder !== 'music') continue
    const target = folder === 'sfx' ? sfx : music
    for (const n of names) {
      const key = basename(n, extname(n))
      if (target[key]) errors.push(`audio/${folder}/${key}: duplicate basename (${basename(target[key])} and ${n})`)
      else target[key] = `/audio/${folder}/${n}`
    }
  }

  // ── images ───────────────────────────────────────────────────────────────
  const imageFiles = groupByFolder(walk(resolve(publicDir, 'images')))
  const variants = {}
  for (const [folder, names] of Object.entries(imageFiles)) {
    const families = new Map() // stem -> { nums: number[], bare: boolean }
    for (const n of names) {
      const ext = extname(n).toLowerCase()
      if (!IMAGE_EXTS.has(ext)) {
        errors.push(`images/${folder ? folder + '/' : ''}${n}: unexpected non-image file type`)
        continue
      }
      const stem = basename(n, extname(n))
      const m = stem.match(VARIANT_RE)
      const key = m ? m[1] : stem
      const fam = families.get(key) || { nums: [], bare: false }
      if (m) fam.nums.push(Number(m[2]))
      else fam.bare = true
      families.set(key, fam)
    }
    for (const [key, fam] of families) {
      const id = folder ? `${folder}/${key}` : key
      if (fam.nums.length === 0) continue
      fam.nums.sort((a, b) => a - b)
      const count = fam.nums.length
      const contiguous = fam.nums.every((v, i) => v === i + 1)
      if (!contiguous) {
        errors.push(`${id}: numbering gap — files are _${fam.nums.join(', _')} (expected _1.._${count}); run tools/generate/reindex-variants.mjs`)
        continue
      }
      if (count === 1) {
        if (!fam.bare) errors.push(`${id}: single numbered file ${key}_1 with no bare ${key} file — bare-path lookup would 404; run tools/generate/reindex-variants.mjs`)
        continue // single numbered + bare: bare wins, nothing to record
      }
      variants[id] = count
      if (fam.bare) warnings.push(`${id}: bare ${key} file exists next to ${count} numbered variants — bare file is unreachable`)
    }
  }

  // ── videos ───────────────────────────────────────────────────────────────
  const videoFiles = groupByFolder(walk(resolve(publicDir, 'videos')))
  for (const [folder, names] of Object.entries(videoFiles)) {
    for (const n of names) {
      if (!VIDEO_EXTS.has(extname(n).toLowerCase())) errors.push(`videos/${folder ? folder + '/' : ''}${n}: unexpected non-video file type`)
    }
  }

  return {
    sfx: sortObj(sfx),
    music: sortObj(music),
    audioFiles: sortObj(audioFiles),
    imageFiles: sortObj(imageFiles),
    videoFiles: sortObj(videoFiles),
    variants: sortObj(variants),
    errors,
    warnings,
  }
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const keyOf = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k))

function renderRecord(rec, indent = '  ') {
  const lines = Object.entries(rec).map(([k, v]) => `${indent}${keyOf(k)}: ${q(v)},`)
  return `{\n${lines.join('\n')}\n}`
}
function renderNumRecord(rec, indent = '  ') {
  const lines = Object.entries(rec).map(([k, v]) => `${indent}${keyOf(k)}: ${v},`)
  return `{\n${lines.join('\n')}\n}`
}
function renderFolderMap(rec) {
  const lines = Object.entries(rec).map(
    ([folder, names]) => `  ${q(folder)}: [\n${names.map((n) => `    ${q(n)},`).join('\n')}\n  ],`,
  )
  return `{\n${lines.join('\n')}\n}`
}

/** Renders the TypeScript source for a scan result (deterministic, LF-only). */
export function renderManifest(scan) {
  return `// GENERATED — do not edit. Regenerate with \`npm run gen:assets\`
// (tools/build/gen-asset-manifest.mjs). Verified up to date by \`npm run check:assets\`
// and src/assets/assetManifest.test.ts.
//
// Single source of truth for which audio / image / video files exist under
// public/. Replaces the hand-maintained imageVariants.json.

/** Sound effects: file basename (== SoundEffectName) -> public path. */
export const SFX_FILES = ${renderRecord(scan.sfx)} as const

/** Per-game background music: file basename (== GameName) -> public path. */
export const MUSIC_FILES = ${renderRecord(scan.music)} as const

/**
 * Image variant families with more than one accepted variant:
 * stem (path under /images/, no _N suffix / extension) -> N, files
 * \`<stem>_1.webp\` .. \`<stem>_N.webp\` all exist. A stem absent here resolves
 * to the bare \`<stem>.webp\` (see src/utils/pickVariant.ts).
 */
export const IMAGE_VARIANTS: Readonly<Record<string, number>> = ${renderNumRecord(scan.variants)}

/** Every file under public/audio, by folder ('' = top level). */
export const AUDIO_FILES: Readonly<Record<string, readonly string[]>> = ${renderFolderMap(scan.audioFiles)}

/** Every file under public/images, by folder relative to public/images. */
export const IMAGE_FILES: Readonly<Record<string, readonly string[]>> = ${renderFolderMap(scan.imageFiles)}

/** Every file under public/videos, by folder relative to public/videos. */
export const VIDEO_FILES: Readonly<Record<string, readonly string[]>> = ${renderFolderMap(scan.videoFiles)}
`
}

const norm = (s) => s.replace(/\r\n/g, '\n')

/** Returns { source, scan, upToDate } for the current disk state. */
export function generate() {
  const scan = scanAssets()
  const source = renderManifest(scan)
  const current = existsSync(OUT_PATH) ? norm(readFileSync(OUT_PATH, 'utf8')) : null
  return { source, scan, upToDate: current === source }
}

function main() {
  const check = process.argv.includes('--check')
  const { source, scan, upToDate } = generate()
  for (const w of scan.warnings) console.warn(`  warn  ${w}`)
  if (scan.errors.length) {
    for (const e of scan.errors) console.error(`  ERROR ${e}`)
    console.error(`\nasset manifest: ${scan.errors.length} irregularit${scan.errors.length === 1 ? 'y' : 'ies'} — not generated.`)
    process.exit(1)
  }
  const rel = OUT_PATH.slice(ROOT.length + 1).split(sep).join('/')
  if (check) {
    if (!upToDate) {
      console.error(`${rel} is stale — run \`npm run gen:assets\` and commit the result.`)
      process.exit(1)
    }
    console.log(`${rel} is up to date.`)
    return
  }
  if (upToDate) {
    console.log(`${rel} already up to date.`)
    return
  }
  writeFileSync(OUT_PATH, source)
  console.log(`Wrote ${rel} (${Object.keys(scan.sfx).length} sfx, ${Object.keys(scan.music).length} music, ${Object.keys(scan.variants).length} variant families).`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
