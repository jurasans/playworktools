#!/usr/bin/env node
/**
 * Manual machine-translation CLI (Ollama + TranslateGemma). The ONLY thing that writes non-English manual text:
 * agents write docs/manual/en only, and the last step of the nightly run calls `sync --lang all --save --prune`.
 *   node tools/i18n/manual-translate.mjs status     Ollama check (exit 1 when unreachable or the model is missing)
 *   node tools/i18n/manual-translate.mjs progress   per-language done/total
 *   node tools/i18n/manual-translate.mjs sync [--lang fr|all] [--save] [--check] [--prune]
 *        English changed? queue + retranslate only new/stale parts. --save writes through manual-lib (same
 *        validation as the spec-web tab); without it nothing is written. --check exits 1 when anything is pending.
 * Env: OLLAMA_URL (default http://localhost:11434; the Ollama container publishes 11434), MANUAL_MT_MODEL (default translategemma:12b).
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lib from '../spec-web/manual-lib.mjs'
import * as mt from '../spec-web/manual-mt.mjs'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const [cmd = 'help', ...rest] = process.argv.slice(2)
const flag = (n) => {
  const i = rest.indexOf('--' + n)
  if (i < 0) return undefined
  return rest[i + 1] == null || rest[i + 1].startsWith('--') ? true : rest[i + 1]
}
const save = !!flag('save')

if (cmd === 'progress') {
  for (const l of lib.MANUAL_LANGS) {
    const ov = (await lib.overview(ROOT, l)).articles
    const secs = ov.reduce((n, a) => n + a.done, 0), tot = ov.reduce((n, a) => n + a.total, 0)
    console.log(`${l}: ${ov.filter((a) => a.published).length}/${ov.length} articles live, ${secs}/${tot} sections`)
  }
} else if (cmd === 'sync') {
  const langs = !flag('lang') || flag('lang') === 'all' ? lib.MANUAL_LANGS : [flag('lang')]
  let pending = 0
  for (const lang of langs) {
    if (save) { const r = await lib.applyRealign(ROOT, lang, { prune: !!flag('prune') }); if (r.orphans.length) console.log(`${lang}: ${r.pruned ? 'removed' : 'orphan (use --prune)'}: ${r.orphans.join(', ')}`) }
    const plan = await lib.syncPlan(ROOT, lang)
    const n = plan.articles.reduce((k, a) => k + a.sections.length + (a.titleTodo ? 1 : 0), 0) + plan.groups.length
    pending += n
    console.log(`${lang}: ${n} item(s) to translate (${plan.articles.length} articles, ${plan.groups.length} chapters, ${plan.moved} re-indexed${plan.orphans.length ? ', orphans: ' + plan.orphans.join(',') : ''})`)
    for (const a of plan.articles) console.log(`  ${a.slug}: ${a.titleTodo ? 'title ' : ''}sections [${a.sections.join(',')}]`)
    if (!save) continue
    const list = await lib.loadEnglish(ROOT)
    for (const g of plan.groups) { const v = await mt.translatePlain(lang, g); console.log(`  chapter "${g}" -> ${v}`); await lib.saveGroup(ROOT, lang, g, v) }
    for (const a of plan.articles) {
      const en = list.find((x) => x.slug === a.slug)
      if (a.titleTodo) { const v = await mt.translatePlain(lang, en.title); console.log(`  ${a.slug} title -> ${v}`); await lib.saveTitle(ROOT, lang, a.slug, v) }
      for (const id of a.sections) {
        const r = await mt.translateSection(ROOT, lang, en.sections.find((s) => s.id === id).text)
        console.log(`  ${a.slug}[${id}] ${(r.ms / 1000).toFixed(1)}s ${r.error ? 'INVALID: ' + r.error : 'ok'}`)
        if (!r.error) await lib.saveSection(ROOT, lang, a.slug, id, r.text)
      }
    }
  }
  if (flag('check') && pending) process.exit(1)
} else if (cmd === 'status') {
  const st = await mt.ollamaStatus()
  console.log(JSON.stringify(st, null, 2))
  process.exit(st.ok && st.installed ? 0 : 1)
} else {
  console.log('Usage: status | progress | sync [--lang x|all] [--save] [--check] [--prune]')
}
