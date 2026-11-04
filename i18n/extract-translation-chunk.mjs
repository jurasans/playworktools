#!/usr/bin/env node
/**
 * Print one chunk of strings.csv rows as JSON {key: {en, he}} for translation.
 *
 *   node tools/i18n/extract-translation-chunk.mjs --count            # number of chunks
 *   node tools/i18n/extract-translation-chunk.mjs --chunk 1 [--size 100] > chunk1.in.json
 *   node tools/i18n/extract-translation-chunk.mjs --all > all.in.json
 *
 * Chunks are 1-based, in CSV row order.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractRows } from './csv-merge.mjs'

const CSV = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'locales', 'strings.csv')
const a = process.argv.slice(2)
const val = (f, d) => {
  const i = a.indexOf(f)
  return i >= 0 ? Number(a[i + 1]) : d
}
const size = val('--size', 100)
const rows = extractRows(readFileSync(CSV, 'utf8'), ['he'])
const chunks = Math.ceil(rows.length / size)

if (a.includes('--count')) {
  console.log(`${rows.length} rows, ${chunks} chunks of ${size}`)
  process.exit(0)
}
let slice = rows
if (!a.includes('--all')) {
  const n = val('--chunk', NaN)
  if (!Number.isInteger(n) || n < 1 || n > chunks) {
    console.error(`--chunk must be 1..${chunks}`)
    process.exit(2)
  }
  slice = rows.slice((n - 1) * size, n * size)
}
console.log(JSON.stringify(Object.fromEntries(slice.map((r) => [r.key, { en: r.en, he: r.he }])), null, 2))
