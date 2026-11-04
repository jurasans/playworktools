/**
 * Localization tab backend — pure grid helpers + the git base lookup.
 *
 * The whole tab is one file, src/locales/strings.csv. "What changed" is always
 * measured against git's INDEX (`git show :path`, i.e. the unstaged area —
 * falling back to HEAD if the file isn't in the index), so a staged/committed
 * cell is "unmodified" (green) and anything edited since is "changed" (red).
 * The cell/word comparison itself happens client-side from that base text;
 * git is only asked for the base, never fed the working file, so the container's
 * CRLF/filemode/stat quirks on a bind-mounted Windows checkout cannot produce
 * false diffs.
 *
 * Writes never re-serialise the whole file: only the one edited cell of one
 * row is re-quoted (tools/i18n/csv-merge.mjs's tokenizer), everything else
 * stays byte-for-byte, and the file's own line ending is kept.
 */
import { execFile } from 'node:child_process'
import { tokenizeRow, quoteField, samePlaceholders, placeholders } from '../../tools/i18n/csv-merge.mjs'

export const LOC_REL = 'src/locales/strings.csv'

/** Parse CSV text to { header, rows } where rows are arrays of decoded cell values. */
export function parseGrid(text) {
  const lines = text.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    rows.push(tokenizeRow(lines[i]).map((f) => f.value))
  }
  return { header, rows }
}

/**
 * Set one cell. Returns { text, before } on success or { error, status }.
 * `expected` (optional) is the value the editor last saw — if the file has
 * moved on since, refuse with 409 instead of clobbering someone else's edit.
 */
export function setCell(csvText, key, col, next, expected) {
  const eol = csvText.includes('\r\n') ? '\r\n' : '\n'
  const lines = csvText.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const c = header.indexOf(col)
  if (c < 1) return { error: `column "${col}" is not editable (or does not exist)`, status: 400 }
  if (typeof next !== 'string' || next.trim() === '') return { error: 'value must be a non-empty string', status: 400 }
  if (/[\r\n]/.test(next)) return { error: 'value contains a line break (the CSV is one record per line)', status: 400 }
  const idx = lines.findIndex((l, i) => i > 0 && tokenizeRow(l)[0]?.value.trim() === key)
  if (idx < 0) return { error: `key "${key}" does not exist in strings.csv`, status: 404 }
  const fields = tokenizeRow(lines[idx])
  if (fields.length !== header.length) return { error: `row ${key} has ${fields.length} columns, expected ${header.length}`, status: 400 }
  const before = fields[c].value
  if (expected !== undefined && expected !== before) return { error: 'this cell changed since you loaded it — reload the tab', status: 409, current: before }
  if (col !== 'en') {
    const en = fields[header.indexOf('en')].value
    if (!samePlaceholders(en, next)) {
      return { error: `placeholders differ — English has [${placeholders(en).join(' ')}], new text has [${placeholders(next).join(' ')}]`, status: 400 }
    }
  }
  if (before === next) return { text: csvText, before, unchanged: true }
  fields[c] = { raw: quoteField(next), value: next }
  lines[idx] = fields.map((f) => f.raw).join(',')
  return { text: lines.join(eol), before }
}

/**
 * A copy of the CSV holding only the `key` column plus the requested languages
 * (original column order, original raw quoting, original line ending). Unknown
 * language names are ignored; if none are valid returns { error }.
 */
export function subsetCsv(csvText, langs) {
  const eol = csvText.includes('\r\n') ? '\r\n' : '\n'
  const lines = csvText.split(/\r?\n/)
  const header = tokenizeRow(lines[0]).map((f) => f.value.trim())
  const keep = header.map((h, i) => (i === 0 || langs.includes(h) ? i : -1)).filter((i) => i >= 0)
  if (keep.length < 2) return { error: `no valid language selected (available: ${header.slice(1).join(', ')})` }
  const text = lines.map((l) => (l.trim() === '' ? l : (() => { const f = tokenizeRow(l); return keep.map((i) => f[i]?.raw ?? '').join(',') })())).join(eol)
  return { text, columns: keep.map((i) => header[i]) }
}

/** The file as git's index (falling back to HEAD) has it — the "unmodified" baseline. */
export function gitBase(root) {
  const run = (spec) => new Promise((resolve) => {
    execFile('git', ['-c', 'safe.directory=*', 'show', spec], { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve(err ? { error: String(stderr || err.message).trim() } : { text: stdout }))
  })
  return (async () => {
    const idx = await run(`:${LOC_REL}`)
    if (idx.text != null) return { text: idx.text, ref: 'index' }
    const head = await run(`HEAD:${LOC_REL}`)
    if (head.text != null) return { text: head.text, ref: 'HEAD' }
    return { error: head.error || idx.error || 'git unavailable' }
  })()
}
