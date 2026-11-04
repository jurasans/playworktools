/**
 * Merge an uploaded CSV into strings.csv (Localization tab's Import button).
 *
 * The upload needs a `key` column plus any subset of the language columns the
 * main file has (any order; unknown columns are ignored and reported). Rows
 * match by key; a blank cell means "not provided" and never overwrites. Bad
 * cells (placeholder mismatch, line break, unknown key) are skipped and
 * reported — they don't block the rest. Only edited cells are re-quoted; every
 * other byte and the file's line ending are preserved.
 *
 * Returns { fatal } or { text, changed, unchanged, skipped, unknownKeys, unknownCols, columns }.
 */
import { tokenizeRow, quoteField, samePlaceholders, placeholders } from '../../tools/i18n/csv-merge.mjs'

export function applyImport(csvText, uploadText) {
  const upLines = uploadText.replace(/^﻿/, '').split(/\r?\n/)
  if (!upLines[0]?.trim()) return { fatal: 'the uploaded file is empty' }
  const uh = tokenizeRow(upLines[0]).map((f) => f.value.trim())
  const kIdx = uh.indexOf('key')
  if (kIdx < 0) return { fatal: `no "key" column in the uploaded header (found: ${uh.join(', ')})` }
  const eol = csvText.includes('\r\n') ? '\r\n' : '\n'
  const lines = csvText.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const enCol = header.indexOf('en')
  const cols = uh.map((h, i) => ({ h, i, c: header.indexOf(h) })).filter((x) => x.i !== kIdx && x.c > 0)
  const unknownCols = uh.filter((h, i) => i !== kIdx && header.indexOf(h) < 1)
  if (!cols.length) return { fatal: `none of the uploaded columns match a language column (${header.slice(1).join(', ')}); found: ${uh.join(', ')}` }
  // en first, so other languages' placeholder checks run against the new English.
  cols.sort((a, b) => (a.h === 'en' ? -1 : b.h === 'en' ? 1 : 0))

  const lineOf = new Map()
  lines.forEach((l, i) => { if (i > 0 && l.trim() !== '') lineOf.set(tokenizeRow(l)[0].value.trim(), i) })
  const cache = new Map() // line index -> tokenized fields, mutated in place
  const changed = [], skipped = [], unknownKeys = []
  let unchanged = 0
  for (let n = 1; n < upLines.length; n++) {
    if (upLines[n].trim() === '') continue
    const uf = tokenizeRow(upLines[n])
    const key = uf[kIdx]?.value.trim()
    if (!key) continue
    const li = lineOf.get(key)
    if (li === undefined) { unknownKeys.push(key); continue }
    if (!cache.has(li)) cache.set(li, tokenizeRow(lines[li]))
    const fields = cache.get(li)
    if (fields.length !== header.length) { skipped.push({ key, col: '*', reason: `row has ${fields.length} columns, expected ${header.length}` }); continue }
    for (const { h, i, c } of cols) {
      const v = uf[i]?.value
      if (v === undefined || v.trim() === '') continue
      if (/[\r\n]/.test(v)) { skipped.push({ key, col: h, reason: 'contains a line break' }); continue }
      if (h !== 'en' && !samePlaceholders(fields[enCol].value, v)) {
        skipped.push({ key, col: h, reason: `placeholders differ — English has [${placeholders(fields[enCol].value).join(' ')}], import has [${placeholders(v).join(' ')}]` })
        continue
      }
      const before = fields[c].value
      if (before === v) { unchanged++; continue }
      changed.push({ key, col: h, before, after: v })
      fields[c] = { raw: quoteField(v), value: v }
    }
  }
  for (const [li, fields] of cache) lines[li] = fields.map((f) => f.raw).join(',')
  return { text: lines.join(eol), changed, unchanged, skipped, unknownKeys, unknownCols, columns: cols.map((x) => x.h) }
}
