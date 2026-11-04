#!/usr/bin/env node
// Repairs numbering drift left by manual deletions under public/images/**
// (a numbering gap, or a lone `_N` survivor) by renaming files on disk, then
// regenerates src/assets/assetManifest.generated.ts via
// tools/build/gen-asset-manifest.mjs.
//
// The generated manifest — NOT a hand-maintained JSON — is now the single
// source of truth for variant counts (it replaced src/assets/imageVariants.json,
// which this script used to rewrite). This script therefore only fixes FILES:
//   * exactly 1 numbered file for a key  -> renamed to the bare `<key>.<ext>`
//     (pickVariant.ts's "count <= 1 => bare file" contract)
//   * 2+ files with gaps                 -> renumbered contiguously 1..N
//   * contiguous already                 -> untouched
// A key that ends up with zero files simply disappears from the manifest.
//
// Usage: node reindex-variants.mjs [--dry-run]

import { readdir, rename, unlink } from 'node:fs/promises'
import { resolve, extname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const IMAGES_ROOT = resolve(ROOT, 'public', 'images')
const GENERATOR = resolve(ROOT, 'tools', 'build', 'gen-asset-manifest.mjs')
const DRY_RUN = process.argv.includes('--dry-run')
const VARIANT_RE = /^(.*)_(\d+)$/

async function listDirs(dir) {
  const out = [dir]
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) out.push(...await listDirs(resolve(dir, e.name)))
  }
  return out
}

function toKey(dir, key) {
  const relDir = dir === IMAGES_ROOT ? '' : dir.slice(IMAGES_ROOT.length + 1).split(sep).join('/')
  return relDir ? `${relDir}/${key}` : key
}

async function main() {
  const changed = []

  for (const dir of await listDirs(IMAGES_ROOT)) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    const names = entries.filter((e) => e.isFile()).map((e) => e.name)
    const groups = new Map() // key -> [{name, ext, num}]
    for (const name of names) {
      const ext = extname(name)
      const m = basename(name, ext).match(VARIANT_RE)
      if (!m) continue
      const num = Number(m[2])
      if (!Number.isFinite(num)) continue
      if (!groups.has(m[1])) groups.set(m[1], [])
      groups.get(m[1]).push({ name, ext, num })
    }

    for (const [key, items] of groups) {
      const id = toKey(dir, key)
      items.sort((a, b) => a.num - b.num)
      const ext = items[0].ext
      const bareTarget = resolve(dir, key + ext)

      if (items.length === 1) {
        const src = resolve(dir, items[0].name)
        if (src !== bareTarget) {
          changed.push(`${id}: collapse to bare (${items[0].name} -> ${key}${ext})`)
          if (!DRY_RUN) { try { await unlink(bareTarget) } catch { /* no leftover bare file */ } await rename(src, bareTarget) }
        }
        continue
      }

      if (items.some((it, i) => it.num !== i + 1)) {
        changed.push(`${id}: renumber ${items.length} file(s) -> 1..${items.length}`)
        if (!DRY_RUN) {
          const tmpNames = []
          for (const it of items) {
            const tmp = resolve(dir, `__reindex_tmp_${Math.random().toString(36).slice(2)}${it.ext}`)
            await rename(resolve(dir, it.name), tmp)
            tmpNames.push(tmp)
          }
          for (let i = 0; i < tmpNames.length; i++) {
            await rename(tmpNames[i], resolve(dir, `${key}_${i + 1}${ext}`))
          }
          try { await unlink(bareTarget) } catch { /* no leftover bare file */ }
        }
      }
    }
  }

  console.log(changed.length ? changed.map((l) => `  ~ ${l}`).join('\n') : '  (no renumbering needed)')

  if (DRY_RUN) {
    console.log('\n--dry-run: no files were changed and the manifest was not regenerated.')
    return
  }
  const r = spawnSync(process.execPath, [GENERATOR], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
