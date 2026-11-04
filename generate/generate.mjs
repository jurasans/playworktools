#!/usr/bin/env node
/**
 * Sequential batch image generation against a local ComfyUI (SDXL) service.
 *
 * Spins the Docker service up, queues one image per replacement variable
 * (substituting {{VAR}} into a prompt template), waits for each to finish
 * before starting the next (one job at a time — safe for 8GB-class GPUs),
 * saves each result named after its variable, then tears the container back
 * down. Built for the Memory Cards Match card-art batch (see CLAUDE.md's
 * S-38 stub) but generic — any --prompt/--vars pair works.
 *
 * Usage:
 *   node generate.mjs --prompt-file vars/style-prompt.txt --vars-file vars/memorycards-50.txt
 *   node generate.mjs --prompt "a red {{VAR}}, studio lighting" --vars "apple,banana,car" --seed 7
 *
 * Run `node generate.mjs --help` for the full flag list.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { startContainer, stopContainer, unloadModels, waitForReady, IMAGE_GEN_DIR } from './lib/docker.mjs'
import { queuePrompt, waitForOutputImages, fetchOutputImage } from './lib/comfyClient.mjs'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Defaults (tuned for an 8GB-class RTX card, base SDXL — no LoRA) ──
// The "Flat Illustration" (chatu) LoRA was tested and rejected: even at low
// weight it reliably produced a busy tiled grid of dozens of tiny subjects
// instead of one clean isolated icon (verified across 3 prompt/weight
// combinations). Base SDXL 1.0 alone, with an explicit anti-grid negative
// prompt, already produces a clean single-subject flat/bold-outline icon —
// see vars/style-prompt.txt. The --lora/--lora-weight flags are kept for
// anyone who wants to experiment with a different style LoRA later.
const DEFAULTS = {
  ckpt:       'sd_xl_base_1.0.safetensors',
  lora:       'flat-illustration-sdxl.safetensors',
  loraWeight: 0,
  negative:   null, // fall back to the workflow template's built-in negative prompt
  seed:       42,
  varySeed:   false,
  steps:      25,
  cfg:        7,
  sampler:    'dpmpp_2m',
  width:      1024,
  height:     1024,
  out:        path.join(__dirname, 'data', 'output'),
  wireTo:     null, // e.g. ../../public/images/memorycards — first image per key goes straight there
  keepRunning: false,
  stopContainer: false,
  variants:   1,    // >1 generates N seeded variants per subject for manual review (key_v1.png..vN.png)
  maxRetries: 2,    // per-image retries (container restart between attempts) before skipping and moving on
}

// ── CLI arg parsing (zero-dependency; this tool has no CLI-arg package installed) ──
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
      case '--seed':         args.seed = parseInt(next(), 10); break
      case '--vary-seed':    args.varySeed = true; break
      case '--steps':        args.steps = parseInt(next(), 10); break
      case '--cfg':           args.cfg = parseFloat(next()); break
      case '--sampler':      args.sampler = next(); break
      case '--negative':     args.negative = next(); break
      case '--lora':         args.lora = next(); break
      case '--lora-weight':  args.loraWeight = parseFloat(next()); break
      case '--ckpt':         args.ckpt = next(); break
      case '--width':        args.width = parseInt(next(), 10); break
      case '--height':       args.height = parseInt(next(), 10); break
      case '--out':          args.out = path.resolve(next()); break
      case '--wire-to':      args.wireTo = path.resolve(next()); break
      case '--keep-running': args.keepRunning = true; break
      case '--stop-container': args.stopContainer = true; break
      case '--variants':     args.variants = parseInt(next(), 10); break
      case '--max-retries':  args.maxRetries = parseInt(next(), 10); break
      default:
        console.warn(`[generate] unrecognized argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node generate.mjs --prompt-file <file> --vars-file <file> [options]

Required (one of each pair):
  --prompt "<template with {{VAR}}>"     Inline prompt template
  --prompt-file <path>                   Read the template from a file instead
  --vars "a,b,c"                         Inline comma-separated replacement values
  --vars-file <path>                     One replacement value per line instead

Optional:
  --count <N>            Only generate the first N values from --vars/--vars-file
  --seed <N>              Base seed (default ${DEFAULTS.seed}, reused for every image unless --vary-seed)
  --vary-seed             Increment the seed by 1 for each subsequent image
  --steps <N>             KSampler steps (default ${DEFAULTS.steps})
  --cfg <N>               KSampler CFG scale (default ${DEFAULTS.cfg})
  --sampler <name>        KSampler sampler_name (default ${DEFAULTS.sampler})
  --negative "<text>"     Override the default negative prompt
  --lora <filename>       LoRA file inside basedir/models/loras (default ${DEFAULTS.lora})
  --lora-weight <N>       LoRA strength, model+clip (default ${DEFAULTS.loraWeight})
  --ckpt <filename>       Checkpoint inside basedir/models/checkpoints (default ${DEFAULTS.ckpt})
  --width / --height <N>  Output resolution (default ${DEFAULTS.width}x${DEFAULTS.height})
  --out <dir>             Where finished images are saved, named per variable (default data/output)
  --wire-to <dir>         App-live folder for this asset (e.g. ../../public/images/memorycards). The
                          FIRST image generated for a given key is written straight there — no review
                          step needed. Every image generated after that for the same key (the file
                          already exists at --wire-to) is instead saved under
                          data/versions/<key>/v2.png, v3.png, ... and the live file is left untouched.
                          Ignored when --variants > 1 (nothing to auto-promote before manual review).
  --variants <N>          Generate N seeded variants per subject instead of one, saved as
                          <key>_v1.png .. <key>_vN.png (default 1 — unchanged single-image behavior).
                          Intended for "generate several, pick the best by hand" review workflows.
  --max-retries <N>       Per-image retry attempts on failure/timeout, restarting the container between
                          tries (default ${DEFAULTS.maxRetries}). After exhausting retries, that image is
                          logged as failed and the batch continues with the next one instead of aborting.
  --keep-running          Keep the models loaded when done (default: unload them; the container always stays up)
  --stop-container        Also stop and remove the container when done (frees all GPU memory)

Examples:
  node generate.mjs --prompt-file vars/style-prompt.txt --vars-file vars/memorycards-50.txt
  node generate.mjs --prompt "a {{VAR}}, flat vector icon" --vars "car,apple" --count 1
`)
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildWorkflow(template, { positiveText, negativeText, seed, steps, cfg, sampler, ckpt, lora, loraWeight, width, height, filenamePrefix }) {
  const wf = JSON.parse(JSON.stringify(template)) // deep clone
  wf['4'].inputs.ckpt_name = ckpt
  wf['10'].inputs.lora_name = lora
  wf['10'].inputs.strength_model = loraWeight
  wf['10'].inputs.strength_clip = loraWeight
  wf['5'].inputs.width = width
  wf['5'].inputs.height = height
  wf['6'].inputs.text = positiveText
  if (negativeText) wf['7'].inputs.text = negativeText
  wf['3'].inputs.seed = seed
  wf['3'].inputs.steps = steps
  wf['3'].inputs.cfg = cfg
  wf['3'].inputs.sampler_name = sampler
  wf['9'].inputs.filename_prefix = filenamePrefix
  return wf
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.prompt) { console.error('Error: --prompt or --prompt-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.vars || args.vars.length === 0) { console.error('Error: --vars or --vars-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.prompt.includes('{{VAR}}')) {
    console.warn('[generate] Warning: prompt template has no {{VAR}} placeholder — every image will be identical except for seed.')
  }

  let vars = args.vars
  if (args.count) vars = vars.slice(0, args.count)

  const templatePath = path.join(__dirname, 'workflow.api.json')
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  fs.mkdirSync(args.out, { recursive: true })

  const variants = Math.max(1, args.variants)
  const totalJobs = vars.length * variants
  console.log(`[generate] ${vars.length} subject(s) x ${variants} variant(s) = ${totalJobs} image(s) to produce, output -> ${path.relative(process.cwd(), args.out)}`)
  if (variants > 1 && args.wireTo) {
    console.log('[generate] --variants > 1: --wire-to is ignored (nothing to auto-promote before manual review).')
  }

  await startContainer()
  const failures = []
  try {
    await waitForReady()

    let jobIndex = 0
    for (let i = 0; i < vars.length; i++) {
      // Optional "key|description" format (same as generate-sound.mjs) — lets
      // the output filename (key) differ from the descriptive text fed to the
      // model. Plain "some text" lines (no "|") behave exactly as before.
      const raw = vars[i]
      const parts = raw.split('|').map((s) => s.trim())
      const [rawKey, desc] = parts.length >= 2 ? parts : [raw, raw]
      const slug = slugify(rawKey)
      const positiveText = args.prompt.replaceAll('{{VAR}}', desc)

      for (let v = 1; v <= variants; v++) {
        jobIndex++
        // Every variant gets its own seed so it's actually a different image,
        // even when --vary-seed wasn't passed (that flag's original purpose —
        // varying across *subjects* — is orthogonal to varying across a single
        // subject's own review candidates).
        const seed = args.seed + i * variants + (v - 1)
        const outName = variants > 1 ? `${slug}_v${v}` : slug
        const label = variants > 1 ? `${desc} (variant ${v}/${variants})` : desc

        console.log(`\n[generate] (${jobIndex}/${totalJobs}) "${label}" -> ${outName}.png  (seed=${seed})`)

        const workflow = buildWorkflow(template, {
          positiveText,
          negativeText: args.negative,
          seed,
          steps: args.steps,
          cfg: args.cfg,
          sampler: args.sampler,
          ckpt: args.ckpt,
          lora: args.lora,
          loraWeight: args.loraWeight,
          width: args.width,
          height: args.height,
          filenamePrefix: outName,
        })

        let attempt = 0
        let succeeded = false
        while (attempt <= args.maxRetries && !succeeded) {
          attempt++
          try {
            const promptId = await queuePrompt(workflow)
            const images = await waitForOutputImages(promptId)
            const bytes = await fetchOutputImage(images[0])
            const outPath = path.join(args.out, `${outName}.png`)
            fs.writeFileSync(outPath, bytes)
            console.log(`[generate]   saved ${path.relative(process.cwd(), outPath)}`)

            if (variants === 1 && args.wireTo) {
              const result = wireFile(bytes, args.wireTo, `${outName}.png`)
              console.log(`[generate]   ${describeWireResult(result)}`)
            }
            succeeded = true
          } catch (err) {
            console.error(`[generate]   attempt ${attempt}/${args.maxRetries + 1} failed for ${outName}: ${err.message}`)
            if (attempt <= args.maxRetries) {
              console.log('[generate]   restarting container and retrying...')
              try { await stopContainer() } catch { /* best-effort */ }
              await startContainer()
              await waitForReady()
            } else {
              console.error(`[generate]   giving up on ${outName} after ${attempt} attempts — continuing with the rest of the batch.`)
              failures.push(outName)
            }
          }
        }
      }
    }

    console.log(`\n[generate] Done — ${totalJobs - failures.length}/${totalJobs} image(s) written to ${args.out}`)
    if (failures.length) {
      console.log(`[generate] FAILED (skipped after retries): ${failures.join(', ')}`)
    }
  } finally {
    if (args.keepRunning) {
      console.log('[generate] --keep-running set, leaving the models loaded.')
    } else if (args.stopContainer) {
      await stopContainer()
    } else {
      await unloadModels()
    }
  }
}

main().catch((err) => {
  console.error('\n[generate] FAILED:', err.message)
  process.exit(1)
})
