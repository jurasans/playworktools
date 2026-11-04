/**
 * Machine translation assist for the in-app manual (Ollama + TranslateGemma).
 *
 * translateSection() takes one English manual section and returns a draft that
 * already passes manual-lib's validateSection: link targets are swapped for
 * placeholders before the model sees them, and **bold UI labels** are replaced
 * with the exact wording from that language's column in strings.csv (the
 * coverage rule for the app). The result is a DRAFT for a human to review and
 * save; nothing is written to the manual here.
 *
 * Config: OLLAMA_URL (default http://localhost:11434; inside the spec-web
 * container use http://host.docker.internal:11434), MANUAL_MT_MODEL
 * (default translategemma:12b).
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseGrid, LOC_REL } from './loc-lib.mjs'
import { validateSection, linkTargets } from './manual-lib.mjs'

export const MT_MODEL = process.env.MANUAL_MT_MODEL || 'translategemma:12b'
export const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '')

const LANGS = {
  he: ['Hebrew', 'he'], zh: ['Chinese (Simplified)', 'zh-Hans'], zt: ['Chinese (Traditional, Taiwan)', 'zh-Hant-TW'],
  ja: ['Japanese', 'ja'], es: ['Spanish', 'es'], fr: ['French', 'fr'], pl: ['Polish', 'pl'], lv: ['Latvian', 'lv'],
}

export async function ollamaStatus() {
  try {
    const r = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(4000) })
    const names = ((await r.json()).models || []).map((m) => m.name)
    return { ok: true, url: OLLAMA_URL, model: MT_MODEL, installed: names.includes(MT_MODEL), models: names }
  } catch (e) { return { ok: false, url: OLLAMA_URL, model: MT_MODEL, installed: false, error: String(e.message || e) } }
}

/** English label -> translated label for `lang`, from strings.csv. */
export async function labelMap(root, lang) {
  const { header, rows } = parseGrid(await readFile(resolve(root, LOC_REL), 'utf8'))
  const en = header.indexOf('en'), col = header.indexOf(lang)
  const map = new Map()
  if (en < 0 || col < 0) return map
  for (const r of rows) if (r[en] && r[col] && !map.has(r[en].trim())) map.set(r[en].trim(), r[col].trim())
  return map
}

/** Replace links and known bold labels with opaque tokens; returns text + restore(). */
function protect(text, labels) {
  const slots = []
  const tok = (v) => { slots.push(v); return `[[${slots.length - 1}]]` }
  let out = text.replace(/\]\(((?:help:|img:|\/)[^)]*)\)/g, (_, t) => `](${tok(t)})`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (m, l) => {
    const t = labels.get(l.trim())
    return t ? `**${tok(t)}**` : m
  })
  const restore = (s) => s.replace(/\[\[\s*(\d+)\s*\]\]/g, (m, i) => slots[+i] ?? m)
  return { out, restore, count: slots.length }
}

async function chat(lang, text, model, temperature = 0.1) {
  const [name, code] = LANGS[lang]
  const prompt = `You are a professional English (en) to ${name} (${code}) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to ${name} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${name} translation, without any additional explanations or commentary. Keep Markdown syntax exactly (#, ##, -, 1., >, **bold**, *italic*, backticks, [text](target)) and keep every [[n]] token unchanged. Please translate the following English text into ${name}:\n\n\n${text}`
  let r, lastErr
  for (let i = 0; i < 4; i++) {
    try {
      r = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, options: { temperature, num_ctx: 4096 }, messages: [{ role: 'user', content: prompt }] }),
      })
      if (r.ok) break
      lastErr = `ollama ${r.status}: ${(await r.text()).slice(0, 200)}`
    } catch (e) { lastErr = String(e.message || e) }
    r = null
    await new Promise((res) => setTimeout(res, 15000 * (i + 1))) // runner may be restarting; back off
  }
  if (!r) throw new Error(lastErr)
  return ((await r.json()).message?.content || '').trim()
}

/** Translate one section. Returns { text, error, ms } - error is a validation message when the draft is unusable as-is. */
export async function translateSection(root, lang, enText, { model = MT_MODEL } = {}) {
  if (!LANGS[lang]) throw new Error('unknown language ' + lang)
  const t0 = Date.now()
  const p = protect(enText, await labelMap(root, lang))
  let text = '', error = 'no attempt'
  for (let attempt = 0; attempt < 3 && error; attempt++) {
    let raw = await chat(lang, p.out, model, [0.1, 0.4, 0.7][attempt])
    raw = raw.replace(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/, '$1').trim()
    text = p.restore(raw)
    error = validateSection(enText, text)
  }
  // Long link lists make the model drop or mangle [[n]] tokens, so repair line by line, checking each line's own links.
  if (error) {
    const lines = []
    for (const line of p.out.split(/\r?\n/)) lines.push(await translateLine(lang, line, p.restore, model))
    text = lines.join(String.fromCharCode(10))
    error = validateSection(enText, text)
  }
  return { text, error, ms: Date.now() - t0 }
}

const LINK_SEG = /(!?\[[^\]]*\]\(\[\[\d+\]\]\))/
const LIST_PREFIX = /^(\s*(?:[-*]|\d+\.|>|#{1,3})\s+)/

/** One protected line -> restored translation whose link targets match the source line (last resort: translate link texts and gaps separately). */
async function translateLine(lang, line, restore, model) {
  if (!line.trim() || /^```/.test(line)) return line
  const want = linkTargets(restore(line)).join('|')
  const clean = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  for (let i = 0; i < 3; i++) {
    const out = restore(clean(await chat(lang, line, model, [0.1, 0.4, 0.7][i])))
    if (linkTargets(out).join('|') === want) return out
  }
  const prefix = LIST_PREFIX.exec(line)?.[1] ?? ''
  const parts = []
  for (const seg of line.slice(prefix.length).split(LINK_SEG)) {
    const m = /^(!?\[)([^\]]*)(\]\(\[\[\d+\]\]\))$/.exec(seg)
    const body = m ? m[2] : seg
    const lead = /^\s*/.exec(body)[0], trail = /\s*$/.exec(body)[0]
    const core = body.trim()
    const tr = /\p{L}/u.test(core.replace(/\[\[\d+\]\]/g, '')) ? clean(await chat(lang, core, model)) : core
    parts.push(m ? m[1] + tr + m[3] : lead + tr + trail)
  }
  return restore(prefix + parts.join(''))
}

/** Short plain string (chapter name, article title). */
export async function translatePlain(lang, s, { model = MT_MODEL } = {}) {
  return (await chat(lang, s, model)).replace(/^#+\s*/, '').split('\n')[0].trim().replace(/[.。]+$/, '')
}
