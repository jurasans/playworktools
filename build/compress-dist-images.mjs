#!/usr/bin/env node
/**
 * Re-encodes every .webp under dist/ to lossy WebP (quality 85) IN PLACE,
 * after `vite build` has already copied public/ into dist/ verbatim.
 *
 * public/images/**.webp stays lossless — it's the source of truth for the
 * asset pipeline (tools/generate/*) and must never be touched. This script
 * only ever reads/writes under dist/, which is a disposable build artifact
 * regenerated from public/ on every build.
 *
 * The app's ~750 card/icon illustrations are flat cartoon stickers (solid
 * colors, hard edges, transparent backgrounds) — lossy WebP at q85 is visually
 * indistinguishable from lossless for this kind of art while typically
 * cutting file size substantially, since lossless WebP on this content is
 * mostly re-encoding large flat color runs with little actual entropy to
 * compress away.
 *
 * Cache: since public/images/** rarely changes between builds but every build
 * re-copies it into dist/ verbatim (same bytes), re-encoding every file from
 * scratch on every single build is wasted work. A content-hash cache under
 * node_modules/.cache/compress-dist-images/q<QUALITY>/<sha1>.webp (gitignored
 * for free — it's under node_modules/) stores the already-compressed output
 * per source hash; a build where nothing changed just copies cached bytes
 * straight to dist/ instead of invoking sharp again. Bump QUALITY to
 * automatically invalidate the whole cache (it's namespaced by quality).
 *
 * Usage: node tools/build/compress-dist-images.mjs   (run after `vite build`)
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const DIST_DIR = path.join(ROOT, 'dist')
const QUALITY = 85
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'compress-dist-images', `q${QUALITY}`)

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile() && p.toLowerCase().endsWith('.webp')) out.push(p)
  }
  return out
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[compress-dist-images] SKIP — ${DIST_DIR} does not exist (run vite build first).`)
    process.exit(1)
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true })

  const files = walk(DIST_DIR)
  console.log(`[compress-dist-images] Found ${files.length} .webp file(s) under dist/ — re-encoding at quality ${QUALITY}...`)

  let beforeTotal = 0
  let afterTotal = 0
  let failed = 0
  let cacheHits = 0
  let cacheMisses = 0

  for (const file of files) {
    try {
      // Read into a Buffer rather than handing sharp the file path directly —
      // sharp/libvips keeps an OS-level handle open on a path input, and on
      // Windows writeFileSync to that same still-open path fails outright
      // ("unknown error, open"). Reading the bytes up front first means sharp
      // never touches the path at all, so the write-back can't collide.
      const input = fs.readFileSync(file)
      const before = input.length
      const hash = crypto.createHash('sha1').update(input).digest('hex')
      const cachePath = path.join(CACHE_DIR, `${hash}.webp`)

      let out
      if (fs.existsSync(cachePath)) {
        out = fs.readFileSync(cachePath)
        cacheHits++
      } else {
        out = await sharp(input).webp({ quality: QUALITY, lossless: false }).toBuffer()
        fs.writeFileSync(cachePath, out)
        cacheMisses++
      }

      fs.writeFileSync(file, out)
      beforeTotal += before
      afterTotal += out.length
    } catch (err) {
      failed++
      console.error(`[compress-dist-images] FAILED on ${path.relative(ROOT, file)}: ${err.message}`)
    }
  }

  const fmtMB = (n) => (n / 1024 / 1024).toFixed(2)
  const pct = beforeTotal > 0 ? (100 * (1 - afterTotal / beforeTotal)).toFixed(1) : '0.0'
  console.log(`[compress-dist-images] Done — ${files.length - failed}/${files.length} succeeded${failed ? `, ${failed} FAILED` : ''}.`)
  console.log(`[compress-dist-images] Cache: ${cacheHits} hit(s), ${cacheMisses} miss(es) (encoded fresh)`)
  console.log(`[compress-dist-images] ${fmtMB(beforeTotal)} MB -> ${fmtMB(afterTotal)} MB  (-${pct}%)`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n[compress-dist-images] FAILED:', err.message)
  process.exit(1)
})
