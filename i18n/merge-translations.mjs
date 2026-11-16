#!/usr/bin/env node
/**
 * Merge translated strings into one language column of src/locales/strings.csv.
 *
 *   node tools/i18n/merge-translations.mjs <file.json> --lang <en|he|zh|zt|ja|es|fr|pl|lv> [--dry-run]
 *
 * <file.json> is a flat map { "key": "new text" }. Only the named column of the
 * named keys is rewritten; everything else stays byte-for-byte. The whole run is
 * refused (nothing written) if a key doesn't exist or a `{0}`/`{1}` placeholder
 * set differs from the English cell.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeTranslations } from './csv-merge.mjs'

const LANGS = ['en', 'he', 'zh', 'zt', 'ja', 'es', 'fr', 'pl', 'lv', 'uk', 'ko']
const CSV = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'locales', 'strings.csv')

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const li = args.indexOf('--lang')
const lang = li >= 0 ? args[li + 1] : undefined
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang')

if (!file || !lang || !LANGS.includes(lang)) {
  console.error(`Usage: node tools/i18n/merge-translations.mjs <file.json> --lang <${LANGS.join('|')}> [--dry-run]`)
  process.exit(2)
}

let updates
try {
  updates = JSON.parse(readFileSync(resolve(file), 'utf8'))
} catch (e) {
  console.error(`Cannot read/parse ${file}: ${e.message}`)
  process.exit(2)
}
if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
  console.error('Input must be a flat JSON object { key: text }')
  process.exit(2)
}

const { text, changed, unchanged, errors } = mergeTranslations(readFileSync(CSV, 'utf8'), lang, updates)

if (errors.length) {
  console.error(`REFUSED - ${errors.length} problem(s), nothing written:`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}

console.log(`${dry ? '[dry-run] ' : ''}${lang}: ${changed.length} changed, ${unchanged.length} already identical (of ${Object.keys(updates).length} keys)`)
for (const c of changed) console.log(`  ${c.key}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`)
if (!dry && changed.length) {
  writeFileSync(CSV, text)
  console.log('strings.csv updated.')
}
