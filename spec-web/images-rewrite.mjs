/**
 * Rewrites a person's notes about a generated image into prompt wording with the Claude CLI (Sonnet 5.5, medium effort). The CLI only
 * exists on the host, so inside Docker spec-web asks the host-runner (POST /prompt/rewrite), which calls rewriteWithClaude() below.
 * Returns { positive, negative, source: 'claude' }, or null when the CLI is unreachable or answers badly; the caller then falls
 * back to the rule-based split in spacechase-prompts.mjs.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

export const REWRITE_MODEL = 'claude-sonnet-5-5'
export const REWRITE_EFFORT = 'medium'
const TIMEOUT_MS = 120000

const INSTRUCTIONS = `You turn a reviewer's feedback about an AI-generated game image into text for a Stable Diffusion XL prompt.
Reply with ONE JSON object and nothing else: {"positive": "...", "negative": "..."}.
- "positive": short comma-separated visual descriptors to ADD to the prompt (what the picture should look like). No sentences, no "not", no "no".
- "negative": short comma-separated visual terms to AVOID (what the picture must not contain). Nouns and adjectives only, no sentences.
- Turn complaints into the opposite descriptor in "positive" when there is a clear one (for example "too dark" -> "bright lighting"), and also list the unwanted thing in "negative".
- Keep only what the feedback asks for. Do not repeat the base prompt. Use an empty string when a field has nothing.
Example. Feedback: "too dark, no wings, rounder nose" -> {"positive": "bright lighting, rounded nose", "negative": "dark, wings"}`

const AUDIO_INSTRUCTIONS = `You turn a reviewer's feedback about an AI-generated game sound into text for a text-to-audio model prompt.
Reply with ONE JSON object and nothing else: {"positive": "...", "negative": "..."}.
- "positive": short comma-separated sound descriptors to ADD to the prompt (timbre, mood, tempo, instruments). No sentences, no "not", no "no".
- "negative": short comma-separated sound qualities to AVOID. Nouns and adjectives only, no sentences.
- Turn complaints into the opposite descriptor in "positive" when there is a clear one (for example "too harsh" -> "soft, gentle"), and also list the unwanted quality in "negative".
- Keep only what the feedback asks for. Do not repeat the base prompt. Use an empty string when a field has nothing.
Example. Feedback: "too shrill, sounds 8-bit, longer tail" -> {"positive": "soft, smooth, long reverb tail", "negative": "shrill, 8-bit, chiptune"}`

// One shell line on Windows (claude is a .cmd shim there), so the arguments carry no spaces or quotes; the prompt goes in on stdin.
function askClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', REWRITE_MODEL, '--effort', REWRITE_EFFORT, '--output-format', 'text', '--no-session-persistence', '--disable-slash-commands'],
      { cwd: tmpdir(), shell: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } resolve(null) }, TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null) })
    child.stdin.on('error', () => { /* the CLI exited before reading */ })
    child.stdin.end(prompt)
  })
}

/** Runs on the machine that has the Claude CLI. */
export async function rewriteWithClaude({ subject, basePrompt, notes, mustAvoid = [], kind = 'image' }) {
  if (!String(notes || '').trim()) return null
  const raw = await askClaude(`${kind === 'audio' ? AUDIO_INSTRUCTIONS : INSTRUCTIONS}\n\n${kind === 'audio' ? 'Sound' : 'Image subject'}: ${subject}\nBase prompt (do not repeat it): ${basePrompt}\nReviewer feedback: ${notes}\n`)
  const json = raw && /\{[\s\S]*\}/.exec(raw)
  if (!json) return null
  let out
  try { out = JSON.parse(json[0]) } catch { return null }
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s.]+$/g, '').slice(0, 400) : '')
  const positive = clean(out.positive), negative = clean(out.negative)
  if (!positive && !negative) return null
  // Whatever the notes plainly say to leave out is forced into the negative list and stripped from the positive one.
  const avoid = mustAvoid.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
  const pos = positive.split(',').map((t) => t.trim()).filter((t) => t && !avoid.some((a) => t.toLowerCase().includes(a)))
  const neg = negative.split(',').map((t) => t.trim()).filter(Boolean)
  for (const a of avoid) if (!neg.some((t) => t.toLowerCase().includes(a))) neg.push(a)
  return { positive: pos.join(', '), negative: neg.join(', '), source: 'claude' }
}

/** What spec-web calls: via the host-runner when in Docker (`viaHost` = { url, token }), else straight to the CLI. */
export async function rewriteNotes(args, viaHost = null) {
  if (!viaHost) return rewriteWithClaude(args)
  try {
    const r = await fetch(`${viaHost.url}/prompt/rewrite`, {
      method: 'POST', headers: { 'x-runner-token': viaHost.token, 'content-type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(TIMEOUT_MS + 10000),
    })
    return r.ok ? (await r.json()).result || null : null
  } catch { return null }
}
