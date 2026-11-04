/**
 * Pure helpers for merging translated text into src/locales/strings.csv.
 * Used by tools/i18n/merge-translations.mjs and unit-tested from
 * src/locales/mergeTranslations.test.ts.
 *
 * The CSV is one record per line (no embedded newlines) and RFC 4180 quoted.
 * Untouched rows/cells are preserved byte-for-byte; only the target cell of a
 * changed row is re-serialised.
 */

/** Split one CSV line into fields, keeping each field's raw source text and its decoded value. */
export function tokenizeRow(line) {
  const fields = []
  let raw = ''
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      raw += ch
      if (ch === '"' && line[i + 1] === '"') { value += '"'; raw += '"'; i++ }
      else if (ch === '"') quoted = false
      else value += ch
    } else if (ch === '"') { quoted = true; raw += ch }
    else if (ch === ',') { fields.push({ raw, value }); raw = ''; value = '' }
    else { raw += ch; value += ch }
  }
  fields.push({ raw, value })
  return fields
}

/** RFC 4180 quoting: wrap when the value has `,` `"` or a line break. */
export function quoteField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Sorted list of `{n}` placeholders in a string. */
export function placeholders(text) {
  return (text.match(/\{\d+\}/g) ?? []).sort()
}

export function samePlaceholders(a, b) {
  const pa = placeholders(a)
  const pb = placeholders(b)
  return pa.length === pb.length && pa.every((p, i) => p === pb[i])
}

/**
 * Merge `updates` ({key: newText}) into the `lang` column of the CSV text.
 * Returns { text, changed, unchanged, errors }. If `errors` is non-empty the
 * caller must NOT write `text` (it is returned equal to the input).
 * `changed` = [{ key, before, after }].
 */
export function mergeTranslations(csvText, lang, updates) {
  const eol = csvText.includes('\r\n') ? '\r\n' : '\n'
  const lines = csvText.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const langCol = header.indexOf(lang)
  const enCol = header.indexOf('en')
  const errors = []
  if (langCol < 1) {
    return { text: csvText, changed: [], unchanged: [], errors: [`language column "${lang}" not found in CSV header (${header.join(',')})`] }
  }

  const wanted = new Map(Object.entries(updates))
  const changed = []
  const unchanged = []
  const seen = new Set()
  const outLines = lines.map((line, idx) => {
    if (idx === 0 || line.trim() === '') return line
    const fields = tokenizeRow(line)
    const key = fields[0].value.trim()
    if (!wanted.has(key)) return line
    seen.add(key)
    const next = wanted.get(key)
    if (typeof next !== 'string' || next.trim() === '') { errors.push(`${key}: value must be a non-empty string`); return line }
    if (/[\r\n]/.test(next)) { errors.push(`${key}: value contains a line break (CSV is one record per line)`); return line }
    if (fields.length !== header.length) { errors.push(`${key}: CSV row has ${fields.length} columns, expected ${header.length}`); return line }
    const en = fields[enCol].value
    if (!samePlaceholders(en, next)) {
      errors.push(`${key}: placeholders differ - English has [${placeholders(en).join(' ')}], new text has [${placeholders(next).join(' ')}]`)
      return line
    }
    const before = fields[langCol].value
    if (before === next) { unchanged.push(key); return line }
    changed.push({ key, before, after: next })
    fields[langCol] = { raw: quoteField(next), value: next }
    return fields.map((f) => f.raw).join(',')
  })

  for (const key of wanted.keys()) if (!seen.has(key)) errors.push(`${key}: key does not exist in strings.csv`)
  if (errors.length) return { text: csvText, changed: [], unchanged: [], errors }
  return { text: outLines.join(eol), changed, unchanged, errors }
}

/** Extract rows as [{ key, en, he, ... }] for building translation chunks. */
export function extractRows(csvText, extraLangs = ['he']) {
  const lines = csvText.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const cols = ['en', ...extraLangs].map((l) => [l, header.indexOf(l)])
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const f = tokenizeRow(lines[i])
    const row = { key: f[0].value.trim() }
    for (const [l, c] of cols) row[l] = f[c]?.value ?? ''
    rows.push(row)
  }
  return rows
}
