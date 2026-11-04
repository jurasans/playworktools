#!/usr/bin/env node
// Thumbnails for spec-web's Images tab: data/spacechase/<group>/preview/<name>.webp (480px wide).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'spacechase')
for (const group of ['player', 'enemy', 'asteroid', 'background']) {
  const dir = path.join(root, group)
  if (!fs.existsSync(dir)) continue
  fs.mkdirSync(path.join(dir, 'preview'), { recursive: true })
  for (const f of fs.readdirSync(dir).filter((n) => /_v\d+\.png$/.test(n))) {
    await sharp(path.join(dir, f)).resize(480).webp({ quality: 80 }).toFile(path.join(dir, 'preview', f.replace(/\.png$/, '.webp')))
  }
}
console.log('[previews] done')
