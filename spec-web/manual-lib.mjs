/**
 * Manual translation tool backend (S-263 follow-up) — pure helpers + file I/O.
 *
 * The English manual is docs/manual/en/<slug>.md. A translator works one
 * SECTION at a time: section 0 is the H1 title line plus any intro text up to
 * the first H2, then one section per `##` block. Drafts live in
 * documentation/manual-i18n/<lang>.json (tracked in git, like the feedback
 * files) so a half-translated article never reaches the app. Once an article
 * has a title, a translated chapter name and EVERY section, docs/manual/<lang>/
 * <slug>.md is written (and rewritten on later edits); clearing a section
 * removes it again and the app falls back to English for that article.
 *
 * A translation must keep the same link targets (help:slug, /route, img:file)
 * as the English section and the same heading marker, so it cannot break the
 * app's links or the coverage test.
 */
import { readFile, writeFile, readdir, mkdir, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const MANUAL_LANGS = ['he', 'zh', 'zt', 'ja', 'es', 'fr', 'pl', 'lv']
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10)

/** Front matter + body, same rules as src/manual/articles.ts parseArticle. */
export function parseMd(raw) {
  const text = raw.replace(/\r\n/g, '\n')
  const meta = {}
  let body = text
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  return { meta, body: body.trim() }
}

/** Section 0 = everything before the first `##`; then one section per `##`. */
export function splitSections(body) {
  const lines = body.split('\n')
  const out = [{ heading: '', lines: [] }]
  let inCode = false
  for (const line of lines) {
    if (line.startsWith('```')) inCode = !inCode
    if (!inCode && /^## /.test(line)) out.push({ heading: line.slice(3).trim(), lines: [line] })
    else out[out.length - 1].lines.push(line)
  }
  return out.map((s, i) => ({
    id: i,
    heading: i === 0 ? 'Title and introduction' : s.heading,
    text: s.lines.join('\n').trim(),
  }))
}

export const linkTargets = (text) =>
  [...text.matchAll(/\]\(((?:help:|img:|\/)[^)]*)\)/g)].map((m) => m[1]).sort()

const headMarker = (text) => /^(#{1,3}) /.exec(text)?.[1] ?? ''

/** Returns an error string, or null when `target` is an acceptable translation of `source`. */
export function validateSection(source, target) {
  if (!target.trim()) return 'empty'
  if (headMarker(target) !== headMarker(source)) return `must start with the same heading marker (${headMarker(source) || 'none'})`
  const a = linkTargets(source), b = linkTargets(target)
  if (a.join('|') !== b.join('|')) return `links must be kept exactly: expected ${a.join(', ') || 'none'}; found ${b.join(', ') || 'none'}`
  return null
}

const stateDir = (root) => resolve(root, 'tools', 'spec-web', 'documentation', 'manual-i18n')
const enDir = (root) => resolve(root, 'docs', 'manual', 'en')
const outDir = (root, lang) => resolve(root, 'docs', 'manual', lang)

async function writeAtomic(path, text) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export async function loadEnglish(root) {
  const files = (await readdir(enDir(root))).filter((f) => f.endsWith('.md')).sort()
  const list = []
  for (const f of files) {
    const slug = f.slice(0, -3)
    const { meta, body } = parseMd(await readFile(resolve(enDir(root), f), 'utf8'))
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1]
    list.push({
      slug, title: meta.title || h1 || slug, group: meta.group || 'Other',
      order: Number(meta.order) || 0, trainer: meta.trainer === 'true', sections: splitSections(body),
    })
  }
  return list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export async function loadState(root, lang) {
  try {
    const s = JSON.parse(await readFile(resolve(stateDir(root), lang + '.json'), 'utf8'))
    return { groups: s.groups ?? {}, articles: s.articles ?? {} }
  } catch { return { groups: {}, articles: {} } }
}

async function saveState(root, lang, st) {
  await writeAtomic(resolve(stateDir(root), lang + '.json'), JSON.stringify(st, null, 2) + '\n')
}

const isDone = (art, en, st) => {
  const t = st.articles[en.slug]
  return !!(t?.title && st.groups[en.group] && en.sections.every((s) => t.sections?.[s.id]?.text))
}

/** Compose and write (or remove) the published article file for `en`. */
async function publish(root, lang, en, st) {
  const file = resolve(outDir(root, lang), en.slug + '.md')
  if (!isDone(null, en, st)) { await rm(file, { force: true }); return false }
  const t = st.articles[en.slug]
  const front = ['---', `title: ${t.title}`, `group: ${st.groups[en.group]}`, `order: ${en.order}`]
  if (en.trainer) front.push('trainer: true')
  front.push('covers:', '---', '')
  const body = en.sections.map((s) => t.sections[s.id].text).join('\n\n')
  await writeAtomic(file, front.join('\n') + body + '\n')
  return true
}

function checkLang(lang) { if (!MANUAL_LANGS.includes(lang)) throw Object.assign(new Error('unknown language'), { status: 400 }) }
function findArticle(list, slug) {
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error('bad slug'), { status: 400 })
  const en = list.find((a) => a.slug === slug)
  if (!en) throw Object.assign(new Error('no such article'), { status: 404 })
  return en
}

export async function overview(root, lang) {
  checkLang(lang)
  const [list, st] = await Promise.all([loadEnglish(root), loadState(root, lang)])
  const groups = [...new Set(list.map((a) => a.group))].map((g) => ({ name: g, target: st.groups[g] ?? '' }))
  const articles = list.map((a) => {
    const t = st.articles[a.slug]
    const done = a.sections.filter((s) => t?.sections?.[s.id]?.text).length
    const stale = a.sections.filter((s) => t?.sections?.[s.id]?.text && t.sections[s.id].src !== hash(s.text)).length
    return {
      slug: a.slug, title: a.title, group: a.group, trainer: a.trainer,
      total: a.sections.length, done, stale: stale + (t?.titleSrc && t.titleSrc !== hash(a.title) ? 1 : 0), titleDone: !!t?.title, published: isDone(null, a, st),
    }
  })
  return { lang, groups, articles }
}

export async function article(root, lang, slug) {
  checkLang(lang)
  const [list, st] = await Promise.all([loadEnglish(root), loadState(root, lang)])
  const en = findArticle(list, slug)
  const t = st.articles[slug] ?? {}
  return {
    slug, group: en.group, groupTarget: st.groups[en.group] ?? '',
    title: { en: en.title, target: t.title ?? '' },
    sections: en.sections.map((s) => {
      const cur = t.sections?.[s.id]
      return { id: s.id, heading: s.heading, en: s.text, target: cur?.text ?? '', stale: !!cur?.text && cur.src !== hash(s.text) }
    }),
  }
}

let queue = Promise.resolve()
const serial = (fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r }

export function saveSection(root, lang, slug, id, text) {
  return serial(async () => {
    checkLang(lang)
    const [list, st] = await Promise.all([loadEnglish(root), loadState(root, lang)])
    const en = findArticle(list, slug)
    const sec = en.sections.find((s) => s.id === Number(id))
    if (!sec) throw Object.assign(new Error('no such section'), { status: 404 })
    const t = (st.articles[slug] ??= { sections: {} })
    t.sections ??= {}
    const value = String(text ?? '').replace(/\r\n/g, '\n').trim()
    if (!value) delete t.sections[sec.id]
    else {
      const err = validateSection(sec.text, value)
      if (err) throw Object.assign(new Error(err), { status: 400 })
      t.sections[sec.id] = { text: value, src: hash(sec.text) }
    }
    await saveState(root, lang, st)
    return { ok: true, published: await publish(root, lang, en, st) }
  })
}

export function saveTitle(root, lang, slug, title) {
  return serial(async () => {
    checkLang(lang)
    const [list, st] = await Promise.all([loadEnglish(root), loadState(root, lang)])
    const en = findArticle(list, slug)
    const v = String(title ?? '').replace(/\s+/g, ' ').trim()
    if (v.length > 120) throw Object.assign(new Error('title too long'), { status: 400 })
    const t = (st.articles[slug] ??= { sections: {} })
    if (v) { t.title = v; t.titleSrc = hash(en.title) } else { delete t.title; delete t.titleSrc }
    await saveState(root, lang, st)
    return { ok: true, published: await publish(root, lang, en, st) }
  })
}

/** Chapter names are translated once and applied to every article in that chapter. */
export function saveGroup(root, lang, group, value) {
  return serial(async () => {
    checkLang(lang)
    const [list, st] = await Promise.all([loadEnglish(root), loadState(root, lang)])
    if (!list.some((a) => a.group === group)) throw Object.assign(new Error('no such chapter'), { status: 404 })
    const v = String(value ?? '').replace(/\s+/g, ' ').trim()
    if (v.length > 80) throw Object.assign(new Error('name too long'), { status: 400 })
    if (v) st.groups[group] = v; else delete st.groups[group]
    await saveState(root, lang, st)
    for (const en of list.filter((a) => a.group === group)) await publish(root, lang, en, st)
    return { ok: true }
  })
}

/**
 * Re-key stored translations after English edits. Sections are stored by index, so inserting or
 * removing one would mark every later section stale; match by source hash first, then keep an
 * in-place edit (same index, new hash) as stale. Pure: returns a new state plus counters.
 */
export function realignState(list, st) {
  const next = { groups: st.groups, articles: {} }
  let moved = 0
  const orphans = []
  for (const [slug, t] of Object.entries(st.articles)) {
    const en = list.find((a) => a.slug === slug)
    if (!en) { orphans.push(slug); next.articles[slug] = t; continue }
    const old = t.sections ?? {}
    const claimed = new Set(), out = {}
    for (const s of en.sections) { // same index first, so duplicate sections keep their place
      if (old[s.id]?.src === hash(s.text)) { out[s.id] = old[s.id]; claimed.add(String(s.id)) }
    }
    for (const s of en.sections) {
      if (out[s.id]) continue
      const k = Object.keys(old).find((k) => !claimed.has(k) && old[k].src === hash(s.text))
      if (k != null) { out[s.id] = old[k]; claimed.add(k); moved++ }
    }
    for (const s of en.sections) { // edited in place: keep the old text, it shows as stale
      if (!out[s.id] && old[s.id]?.text && !claimed.has(String(s.id))) { out[s.id] = old[s.id]; claimed.add(String(s.id)) }
    }
    next.articles[slug] = { ...t, sections: out }
  }
  return { st: next, moved, orphans }
}

/** What still needs translating for `lang` once state is realigned. */
export async function syncPlan(root, lang) {
  checkLang(lang)
  const [list, st0] = await Promise.all([loadEnglish(root), loadState(root, lang)])
  const { st, moved, orphans } = realignState(list, st0)
  const groups = [...new Set(list.map((a) => a.group))].filter((g) => !st.groups[g])
  const articles = []
  for (const en of list) {
    const t = st.articles[en.slug]
    const titleTodo = !t?.title || (!!t.titleSrc && t.titleSrc !== hash(en.title))
    const sections = en.sections.filter((s) => !t?.sections?.[s.id]?.text || t.sections[s.id].src !== hash(s.text)).map((s) => s.id)
    if (titleTodo || sections.length) articles.push({ slug: en.slug, titleTodo, sections })
  }
  return { lang, groups, articles, moved, orphans, realigned: st, original: st0 }
}

/** Persist a realigned state (and republish every article); `prune` also drops articles English no longer has. */
export function applyRealign(root, lang, { prune = false } = {}) {
  return serial(async () => {
    checkLang(lang)
    const [list, st0] = await Promise.all([loadEnglish(root), loadState(root, lang)])
    const { st, orphans } = realignState(list, st0)
    if (prune) for (const slug of orphans) { delete st.articles[slug]; await rm(resolve(outDir(root, lang), slug + '.md'), { force: true }) }
    await saveState(root, lang, st)
    for (const en of list) await publish(root, lang, en, st)
    return { orphans, pruned: prune }
  })
}
