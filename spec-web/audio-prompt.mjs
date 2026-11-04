/**
 * Prompt building for the spec-web Audio tab, shared by tools/generate/audio-gen-runner.mjs (generation) and the server (which shows the
 * prompt a "Generate new options" round will use). Moved out of the runner unchanged except that a Claude rewrite of the notes
 * ({ positive, negative }) replaces the rule-based complaint matching when one is given.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG_BY_NAME } from './audio-catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VARS_DIR = resolve(ROOT, 'scripts', 'image-gen', 'vars')

// ── prompt building ──────────────────────────────────────────────────────────
const MUSIC_STYLE_FALLBACK = '{{VAR}}, ambient instrumental background music loop, soft, pleasant, modern, gentle warm pads, airy, calm, high-fidelity, seamless, no vocals, no speech'
const MUSIC_NEGATIVE_FALLBACK = 'vocals, singing, lyrics, speech, distortion, clipping, 8-bit, chiptune, lo-fi, harsh, shrill, screaming, aggressive, noisy'

/** Newest-mtime vars file wins when several define the same key (later passes
 *  supersede earlier ones, e.g. game-over-celebratory.txt over sfx-9-effects.txt). */
function findVarsLine(name) {
  if (!existsSync(VARS_DIR)) return null
  const files = readdirSync(VARS_DIR).filter((f) => f.endsWith('.txt')).map((f) => ({ f, m: statSync(join(VARS_DIR, f)).mtimeMs })).sort((a, b) => b.m - a.m)
  for (const { f } of files) {
    for (const raw of readFileSync(join(VARS_DIR, f), 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [key, desc, secs] = line.split('|').map((s) => s.trim())
      if (key === name && desc) return { desc, seconds: secs ? parseFloat(secs) : undefined, source: `vars/${f}` }
    }
  }
  return null
}

const readIfExists = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)
const oneLine = (s, max) => String(s).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// Text-to-audio models can't act on "less 8-bit": naming a quality in the positive
// prompt attracts it. So complaints become NEGATIVE prompt terms plus a positive
// counter-description, and the offending words are scrubbed from the base description
// (the old vars lines say "8-bit chiptune ..." on purpose). The user's direction for
// this overhaul is global ("more pleasant, less 8-bit") so every SFX uses the soft template.
const COMPLAINTS = [
  { re: /8.?bit|chip.?tune|retro|arcade|synthwave/i, negative: '8-bit, chiptune, retro arcade, square wave, lo-fi', positive: 'polished, natural, smooth, modern' },
  { re: /hurt|shriek|scream|harsh|shrill|piercing|screech|loud|annoying|painful/i, negative: 'harsh, shrill, piercing, screeching, screaming, painful, distorted', positive: 'soft, gentle, pleasant, rounded' },
  { re: /distort|clip|crackl|glitch|noise|noisy|intermittent/i, negative: 'distortion, clipping, crackle, glitch, noise, artifacts', positive: 'clean, artifact-free' },
]
const SCRUB_RE = /\b(8.?bit|chip.?tune|retro(?:-futuristic)?(?: arcade)?|synthwave|arcade(?: console)?|80s analog synthesizer)\b,?\s*/gi
const SFX_SOFT_TEMPLATE = '{{VAR}}, soft modern game sound effect, gentle rounded synth and bell tones, warm, smooth, pleasant, polished, short one-shot, clean, no music, no vocals, no speech'
// Per-game energy words from the old catalog descriptions fight the ambient direction.
const ENERGY_RE = /\b(upbeat|playful|bouncy|energetic|driving|fast|punchy|carnival|arcade|groove)\b,?\s*/gi
const SFX_NEGATIVE_BASE = 'music, singing, vocals, lyrics, song, melody, band, orchestra, 8-bit, chiptune, harsh, shrill'

export function buildPrompt(job, rewrite = null) {
  const cat = CATALOG_BY_NAME.get(job.name)
  const kind = job.kind || cat?.kind || 'sfx'
  const found = findVarsLine(job.name)
  const baseDesc = found?.desc || cat?.promptDesc
  if (!baseDesc && !job.promptOverride) throw new Error(`no base prompt for "${job.name}" (not in vars/*.txt or audio-catalog.mjs) — set promptOverride on the job`)
  const seconds = found?.seconds || cat?.seconds || (kind === 'music' ? 12 : 1.5)

  const notes = [job.feedbackSnapshot, ...(job.candidateFeedback || []).map((c) => c.feedback)].filter(Boolean).map((s) => oneLine(s, 400))
  const hits = rewrite ? [] : COMPLAINTS.filter((c) => notes.some((n) => c.re.test(n)))
  const extraNeg = rewrite ? (rewrite.negative ? [rewrite.negative] : []) : hits.map((c) => c.negative)
  const counter = hits.map((c) => c.positive)
  // Keep every sentence of a note that names no known complaint (e.g. "should be a gaining
  // sound"); complaint sentences only feed the negative prompt.
  const keptNotes = rewrite ? (rewrite.positive ? [rewrite.positive] : []) : notes.flatMap((n) => n.split(/[.;]+/)).map((x) => x.trim()).filter((x) => x && !COMPLAINTS.some((c) => c.re.test(x)))

  let desc
  if (job.promptOverride) desc = oneLine(job.promptOverride, 800)
  else {
    const scrubbed = baseDesc.replace(SCRUB_RE, '')
    desc = kind === 'music'
      ? oneLine('soft ambient pleasant modern soundscape, ' + scrubbed.replace(ENERGY_RE, ''), 400)
      : oneLine(scrubbed, 400)
    const extras = [...counter, ...keptNotes]
    if (extras.length) desc += '. ' + oneLine(extras.join(', '), 600)
  }

  const template = kind === 'music'
    ? (readIfExists(join(VARS_DIR, 'music-style-prompt-v2.txt')) || MUSIC_STYLE_FALLBACK)
    : SFX_SOFT_TEMPLATE
  const baseNeg = kind === 'music' ? (readIfExists(join(VARS_DIR, 'music-negative-prompt.txt')) || MUSIC_NEGATIVE_FALLBACK) : SFX_NEGATIVE_BASE
  const negative = [baseNeg, ...extraNeg].join(', ')
  return { kind, template, negative, desc, seconds, cfg: kind === 'music' ? 3.5 : null, source: found?.source || 'audio-catalog.mjs (fallback)' }
}


/** What the page shows for a sound: the prompt its next round would use, with the notes (and their Claude rewrite) folded in. */
export function previewPrompt(name, kindHint, notes, rewrite = null) {
  try {
    const p = buildPrompt({ name, kind: kindHint, feedbackSnapshot: notes }, rewrite)
    return {
      positive: p.template.replaceAll('{{VAR}}', p.desc), negative: p.negative, seconds: p.seconds, source: p.source,
      extraPositive: rewrite ? rewrite.positive || '' : '', extraNegative: rewrite ? rewrite.negative || '' : '',
      rewrittenBy: !String(notes || '').trim() ? 'none' : rewrite?.source || 'rules',
    }
  } catch (e) { return { positive: '', negative: '', error: e.message, rewrittenBy: 'none' } }
}
