#!/usr/bin/env node
/**
 * Sequential batch sound-effect generation against a local ComfyUI (Stable
 * Audio Open 1.0) service — the audio counterpart to generate.mjs. Same
 * container, same lifecycle (start → generate one at a time → stop unless
 * --keep-running), same {{VAR}} templating over a vars list, just a
 * different model + workflow graph (workflow.audio.api.json).
 *
 * Model: Stable Audio Open 1.0 (Stability AI Community License — free
 * commercial use under $1M annual revenue) + a T5 text encoder. Chosen over
 * ACE-Step for this because Stability AI's own framing is "text-to-music
 * AND sound design" — a better fit for short discrete SFX (pickup dings,
 * button clicks, level-up chimes) than a music-foundation model. See
 * CLAUDE.md's Sound & Music section for the actual SoundEffectName list
 * this is meant to eventually replace (currently synthesized Web Audio
 * tones in src/audio/index.ts).
 *
 * Usage:
 *   node generate-sound.mjs --prompt "coin pickup chime, bright, short" --vars "pickup" --seconds 1.5
 *   node generate-sound.mjs --prompt-file vars/sfx-style-prompt.txt --vars-file vars/sfx-names.txt
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { startContainer, stopContainer, unloadModels, waitForReady } from './lib/docker.mjs'
import { queuePrompt, waitForOutputAudio, fetchOutputFile } from './lib/comfyClient.mjs'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  ckpt:     'stable-audio-open-1.0.safetensors',
  clip:     't5-base.safetensors',
  negative: 'music, singing, vocals, lyrics, song, melody, band, orchestra',
  seed:     42,
  varySeed: false,
  steps:    50,
  cfg:      4.98,
  sampler:  'dpmpp_3m_sde_gpu',
  scheduler: 'exponential',
  seconds:  2.0,   // short discrete SFX default — not a music/loop duration
  out:      path.join(__dirname, 'data', 'audio-output'),
  wireTo:   null,  // e.g. ../../public/audio/sfx — first clip per key goes straight there, no wait
  keepRunning: false,
  stopContainer: false,
  variants:   1,    // >1 generates N seeded variants per subject for manual review (key_v1.mp3..vN.mp3)
  maxRetries: 2,    // per-clip retries (container restart between attempts) before skipping and moving on
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--help': case '-h': printHelp(); process.exit(0); break
      case '--prompt':       args.prompt = next(); break
      case '--prompt-file':  args.prompt = fs.readFileSync(path.resolve(next()), 'utf-8').trim(); break
      case '--vars':         args.vars = next().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--vars-file':    args.vars = fs.readFileSync(path.resolve(next()), 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); break
      case '--count':        args.count = parseInt(next(), 10); break
      case '--seconds':      args.seconds = parseFloat(next()); break
      case '--seed':         args.seed = parseInt(next(), 10); break
      case '--vary-seed':    args.varySeed = true; break
      case '--steps':        args.steps = parseInt(next(), 10); break
      case '--cfg':          args.cfg = parseFloat(next()); break
      case '--sampler':      args.sampler = next(); break
      case '--scheduler':    args.scheduler = next(); break
      case '--negative':     args.negative = next(); break
      case '--ckpt':         args.ckpt = next(); break
      case '--clip':         args.clip = next(); break
      case '--out':          args.out = path.resolve(next()); break
      case '--wire-to':      args.wireTo = path.resolve(next()); break
      case '--keep-running': args.keepRunning = true; break
      case '--stop-container': args.stopContainer = true; break
      case '--variants':     args.variants = parseInt(next(), 10); break
      case '--max-retries':  args.maxRetries = parseInt(next(), 10); break
      default:
        console.warn(`[generate-sound] unrecognized argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node generate-sound.mjs --prompt-file <file> --vars-file <file> [options]

Required (one of each pair):
  --prompt "<template with {{VAR}}>"     Inline prompt template
  --prompt-file <path>                   Read the template from a file instead
  --vars "a,b,c"                         Inline comma-separated replacement values
  --vars-file <path>                     One replacement value per line instead

Optional:
  --count <N>             Only generate the first N values from --vars/--vars-file
  --seconds <N>           Clip duration in seconds (default ${DEFAULTS.seconds} — short SFX, not a music loop)
  --seed <N>              Base seed (default ${DEFAULTS.seed}, reused for every clip unless --vary-seed)
  --vary-seed             Increment the seed by 1 for each subsequent clip
  --steps <N>             KSampler steps (default ${DEFAULTS.steps})
  --cfg <N>               KSampler CFG scale (default ${DEFAULTS.cfg})
  --sampler <name>        KSampler sampler_name (default ${DEFAULTS.sampler})
  --scheduler <name>      KSampler scheduler (default ${DEFAULTS.scheduler})
  --negative "<text>"     Override the default negative prompt
  --ckpt <filename>       Checkpoint inside basedir/models/checkpoints (default ${DEFAULTS.ckpt})
  --clip <filename>       T5 text encoder inside basedir/models/text_encoders (default ${DEFAULTS.clip})
  --out <dir>             Where finished clips are saved, named per variable (default data/audio-output)
  --wire-to <dir>         App-live folder for this asset (e.g. ../../public/audio/sfx). The FIRST clip
                          generated for a given key is written straight there — no review step needed.
                          Every clip generated after that for the same key (the file already exists at
                          --wire-to) is instead saved under data/versions/<key>/v2.mp3, v3.mp3, ... and
                          the live file is left untouched. Ignored when --variants > 1.
  --variants <N>          Generate N seeded variants per subject instead of one, saved as
                          <key>_v1.mp3 .. <key>_vN.mp3 (default 1 — unchanged single-clip behavior).
  --max-retries <N>       Per-clip retry attempts on failure/timeout, restarting the container between
                          tries (default ${DEFAULTS.maxRetries}). After exhausting retries, that clip is
                          logged as failed and the batch continues with the next one instead of aborting.
  --keep-running          Keep the models loaded when done (default: unload them; the container always stays up)
  --stop-container        Also stop and remove the container when done (frees all GPU memory)

Examples:
  node generate-sound.mjs --prompt "{{VAR}}, game sound effect, short, clean, no music" --vars "coin pickup chime,button click,level up fanfare"
  node generate-sound.mjs --prompt-file vars/sfx-style-prompt.txt --vars-file vars/sfx-9-effects.txt --wire-to ../../public/audio/sfx
`)
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildWorkflow(template, { positiveText, negativeText, seed, steps, cfg, sampler, scheduler, ckpt, clip, seconds, filenamePrefix }) {
  const wf = JSON.parse(JSON.stringify(template)) // deep clone
  wf['4'].inputs.ckpt_name = ckpt
  wf['10'].inputs.clip_name = clip
  wf['6'].inputs.text = positiveText
  if (negativeText) wf['7'].inputs.text = negativeText
  wf['11'].inputs.seconds = seconds
  wf['3'].inputs.seed = seed
  wf['3'].inputs.steps = steps
  wf['3'].inputs.cfg = cfg
  wf['3'].inputs.sampler_name = sampler
  wf['3'].inputs.scheduler = scheduler
  wf['19'].inputs.filename_prefix = filenamePrefix
  return wf
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.prompt) { console.error('Error: --prompt or --prompt-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.vars || args.vars.length === 0) { console.error('Error: --vars or --vars-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.prompt.includes('{{VAR}}')) {
    console.warn('[generate-sound] Warning: prompt template has no {{VAR}} placeholder — every clip will be identical except for seed.')
  }

  let vars = args.vars
  if (args.count) vars = vars.slice(0, args.count)

  const templatePath = path.join(__dirname, 'workflow.audio.api.json')
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  fs.mkdirSync(args.out, { recursive: true })

  const variants = Math.max(1, args.variants)
  const totalJobs = vars.length * variants
  console.log(`[generate-sound] ${vars.length} subject(s) x ${variants} variant(s) = ${totalJobs} clip(s) to produce, output -> ${path.relative(process.cwd(), args.out)}`)
  if (variants > 1 && args.wireTo) {
    console.log('[generate-sound] --variants > 1: --wire-to is ignored (nothing to auto-promote before manual review).')
  }

  await startContainer()
  const failures = []
  try {
    await waitForReady()

    let jobIndex = 0
    for (let i = 0; i < vars.length; i++) {
      // Optional "key|description|seconds" format — lets the output filename
      // (key, e.g. matching src/audio/types.ts's SoundEffectName) differ from
      // the descriptive text actually fed to the model, and optionally overrides
      // --seconds per-clip. Plain "some text" lines (no "|") behave exactly as
      // before: slug is derived from the text itself, --seconds applies to all.
      const raw = vars[i]
      const parts = raw.split('|').map((s) => s.trim())
      const [rawKey, desc, durStr] = parts.length >= 2 ? parts : [raw, raw, undefined]
      const slug = slugify(rawKey)
      const seconds = durStr ? parseFloat(durStr) : args.seconds
      const positiveText = args.prompt.replaceAll('{{VAR}}', desc)

      for (let v = 1; v <= variants; v++) {
        jobIndex++
        const seed = args.seed + i * variants + (v - 1)
        const outName = variants > 1 ? `${slug}_v${v}` : slug
        const label = variants > 1 ? `${desc} (variant ${v}/${variants})` : desc

        console.log(`\n[generate-sound] (${jobIndex}/${totalJobs}) "${label}" -> ${outName}.mp3  (seed=${seed}, ${seconds}s)`)

        const workflow = buildWorkflow(template, {
          positiveText,
          negativeText: args.negative,
          seed,
          steps: args.steps,
          cfg: args.cfg,
          sampler: args.sampler,
          scheduler: args.scheduler,
          ckpt: args.ckpt,
          clip: args.clip,
          seconds,
          filenamePrefix: outName,
        })

        let attempt = 0
        let succeeded = false
        while (attempt <= args.maxRetries && !succeeded) {
          attempt++
          try {
            const promptId = await queuePrompt(workflow)
            const files = await waitForOutputAudio(promptId)
            const bytes = await fetchOutputFile(files[0])
            const outPath = path.join(args.out, `${outName}.mp3`)
            fs.writeFileSync(outPath, bytes)
            console.log(`[generate-sound]   saved ${path.relative(process.cwd(), outPath)}`)

            if (variants === 1 && args.wireTo) {
              const result = wireFile(bytes, args.wireTo, `${outName}.mp3`)
              console.log(`[generate-sound]   ${describeWireResult(result)}`)
            }
            succeeded = true
          } catch (err) {
            console.error(`[generate-sound]   attempt ${attempt}/${args.maxRetries + 1} failed for ${outName}: ${err.message}`)
            if (attempt <= args.maxRetries) {
              console.log('[generate-sound]   restarting container and retrying...')
              try { await stopContainer() } catch { /* best-effort */ }
              await startContainer()
              await waitForReady()
            } else {
              console.error(`[generate-sound]   giving up on ${outName} after ${attempt} attempts — continuing with the rest of the batch.`)
              failures.push(outName)
            }
          }
        }
      }
    }

    console.log(`\n[generate-sound] Done — ${totalJobs - failures.length}/${totalJobs} clip(s) written to ${args.out}`)
    if (failures.length) {
      console.log(`[generate-sound] FAILED (skipped after retries): ${failures.join(', ')}`)
    }
  } finally {
    if (args.keepRunning) {
      console.log('[generate-sound] --keep-running set, leaving the models loaded.')
    } else if (args.stopContainer) {
      await stopContainer()
    } else {
      await unloadModels()
    }
  }
}

main().catch((err) => {
  console.error('\n[generate-sound] FAILED:', err.message)
  process.exit(1)
})
