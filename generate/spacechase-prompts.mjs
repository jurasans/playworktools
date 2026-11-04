// Prompt templates for the Space Chase art, shared by spacechase-art.mjs (generation) and spec-web's Images tab (which shows the
// prompt a "Generate new options" round will use). Plain data and string handling only, so both can import it.

export const NEG = 'turnaround sheet, multiple views, concept sheet, top view, front view, ground, mountains, landscape, horizon, lake, trees, grass, text, letters, watermark, logo, signature, frame, border, grid, collage, multiple objects, human, weapons, guns, lasers, missiles, flames everywhere, explosion, blurry, photo, 3d render, harsh neon, strobing'
export const SPRITE = 'single object centered, 2D side-view game sprite, calm modern space arcade style, flat vector illustration with soft shading, clean outlines, plain white background, no text'

export const GROUPS = {
  player: {
    prompt: `{{VAR}}, one single friendly modern spaceship, only one ship, no turnaround sheet, strict side profile view flying horizontally to the right, nose pointing right, turquoise and soft blue palette, rounded sleek silhouette, no weapons, ${SPRITE}`,
    vars: ['player spaceship standard flight'],
    out: 'data/spacechase/player', w: 1024, h: 1024,
  },
  enemy: {
    prompt: `{{VAR}}, one single slightly larger angular spaceship, only one ship, no turnaround sheet, strict side profile view flying horizontally to the right, nose pointing right, deep navy hull with muted orange and red accents, intimidating but not frightening, no weapons, ${SPRITE}`,
    vars: ['enemy spaceship pursuit'],
    out: 'data/spacechase/enemy', w: 1024, h: 1024,
  },
  asteroid: {
    prompt: `{{VAR}}, space rock, muted gray-blue and purple tones, ${SPRITE}`,
    vars: ['asteroid round smooth', 'asteroid jagged angular', 'asteroid long oval', 'asteroid cratered large', 'asteroid small chunky'],
    out: 'data/spacechase/asteroid', w: 1024, h: 1024,
  },
  background: {
    prompt: `{{VAR}}, seamless horizontal 2D side-scrolling space game background, outer space only, deep navy and soft blue with muted purple and subtle turquoise, stars and cosmic dust filling the whole frame, no ground, no mountains, no horizon, no landscape, no text, no ships, no characters`,
    vars: ['background deep space with scattered stars', 'background purple nebula clouds in space', 'background ringed planet and moon in space', 'background distant asteroid belt in space', 'background distant spiral galaxy in space'],
    out: 'data/spacechase/background', w: 1344, h: 768,
  },
}

// "no wings", "too many flames", "I don't like the red", "remove the stripes" describe what to leave out. Image models do better
// with that as negative-prompt terms than as sentences in the positive prompt, so such clauses are moved over; the rest is kept
// as positive wording.
const NEGATIVE_LEAD = /^(?:i\s+)?(?:(?:do\s*not|don'?t)\s+(?:like|want|add|use|show|need)|no|without|remove|avoid|not|less|too\s+(?:many|much))\s+(?:the\s+|any\s+|a\s+|an\s+)?/i

export function splitNotes(notes) {
  const positive = [], negative = []
  for (const raw of String(notes || '').split(/[.;\n]+/)) {
    const clause = raw.replace(/\s+/g, ' ').trim()
    if (!clause) continue
    const m = NEGATIVE_LEAD.exec(clause)
    if (m && clause.length > m[0].length) negative.push(clause.slice(m[0].length).trim())
    else positive.push(clause)
  }
  return { positive: positive.join(', '), negative: negative.join(', ') }
}

/** The prompt a round for `subject` in `group` uses, with the person's notes folded in. `rewrite` ({positive, negative, source}) replaces the rule-based split. */
export function composePrompt(group, subject, notes, rewrite = null) {
  const g = GROUPS[group]
  if (!g) throw new Error(`unknown group ${group}`)
  const { positive, negative } = rewrite ? { positive: rewrite.positive || '', negative: rewrite.negative || '' } : splitNotes(notes)
  const base = g.prompt.replaceAll('{{VAR}}', subject)
  return {
    positive: positive ? `${base}, ${positive}` : base,
    negative: negative ? `${NEG}, ${negative}` : NEG,
    template: positive ? `${g.prompt}, ${positive}` : g.prompt,
    extraPositive: positive, extraNegative: negative, source: !String(notes || '').trim() ? 'none' : rewrite?.source || 'rules',
  }
}
