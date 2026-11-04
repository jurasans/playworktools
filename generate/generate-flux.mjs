#!/usr/bin/env node
/**
 * Sequential batch image generation against a local ComfyUI (FLUX.1 [schnell])
 * service — same CLI shape as generate.mjs (SDXL), different model/workflow.
 *
 * Why a separate script rather than extending generate.mjs: FLUX.1 uses a
 * structurally different graph (no LoRA node in this setup, no separate
 * width/height-only latent — EmptySD3LatentImage, different node ids) and
 * fundamentally different sampler defaults (schnell is a distilled 4-step
 * model with cfg=1 — a real negative prompt has no effect at cfg=1, unlike
 * SDXL's cfg=7 default). Reusing generate.mjs's buildWorkflow would need a
 * pile of if/else branching for two incompatible graphs; a parallel script
 * mirroring the same flags is clearer.
 *
 * Model: FLUX.1 [schnell] (Apache 2.0 — commercial-safe, unlike FLUX.1 [dev]
 * which requires a paid commercial license from Black Forest Labs). Chosen
 * for meaningfully better prompt adherence than SDXL for compositionally
 * specific prompts (exact background/accent colors, "outline only, no fill")
 * that SDXL kept only partially following across several iterations.
 * All-in-one fp8 checkpoint from the official Comfy-Org mirror (same ungated-
 * mirror pattern already used for Stable Audio Open this session) — no
 * separate UNET/CLIP/VAE files needed.
 *
 * Usage:
 *   node generate-flux.mjs --prompt-file vars/test-icon-style.txt --vars-file vars/test-icons-10.txt --count 2
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { startContainer, stopContainer, unloadModels, waitForReady } from './lib/docker.mjs'
import { queuePrompt, waitForOutputImages, fetchOutputImage } from './lib/comfyClient.mjs'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  ckpt:       'flux1-schnell-fp8.safetensors',
  negative:   '',
  seed:       42,
  varySeed:   false,
  steps:      4,     // schnell is distilled for very few steps
  cfg:        1,     // schnell/dev have no real negative-prompt guidance — must be 1
  sampler:    'euler',
  scheduler:  'simple',
  width:      1024,
  height:     1024,
  out:        path.join(__dirname, 'data', 'output'),
  wireTo:     null, // e.g. ../../public/images/othertests — first image per key goes straight there
  keepRunning: false,
  stopContainer: false,
  variants:   1,    // >1 generates N seeded variants per subject for manual review (key_v1.png..vN.png)
  maxRetries: 2,    // per-image retries (container restart between attempts) before skipping and moving on
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
      case '--seed':         args.seed = parseInt(next(), 10); break
      case '--vary-seed':    args.varySeed = true; break
      case '--steps':        args.steps = parseInt(next(), 10); break
      case '--cfg':          args.cfg = parseFloat(next()); break
      case '--sampler':      args.sampler = next(); break
      case '--scheduler':    args.scheduler = next(); break
      case '--negative':     args.negative = next(); break
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
        console.warn(`[generate-flux] unrecognized argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node generate-flux.mjs --prompt-file <file> --vars-file <file> [options]

Required (one of each pair):
  --prompt "<template with {{VAR}}>"     Inline prompt template
  --prompt-file <path>                   Read the template from a file instead
  --vars "a,b,c"                         Inline comma-separated replacement values
  --vars-file <path>                     One replacement value per line instead ("key|desc" supported)

Optional:
  --count <N>            Only generate the first N values from --vars/--vars-file
  --seed <N>              Base seed (default ${DEFAULTS.seed}, reused for every image unless --vary-seed)
  --vary-seed             Increment the seed by 1 for each subsequent image
  --steps <N>             KSampler steps (default ${DEFAULTS.steps} — schnell is distilled for very few steps)
  --cfg <N>               KSampler CFG scale (default ${DEFAULTS.cfg} — schnell/dev ignore negative prompts above 1)
  --sampler <name>        KSampler sampler_name (default ${DEFAULTS.sampler})
  --scheduler <name>      KSampler scheduler (default ${DEFAULTS.scheduler})
  --negative "<text>"     Negative prompt text (no effect unless --cfg > 1)
  --ckpt <filename>       Checkpoint inside basedir/models/checkpoints (default ${DEFAULTS.ckpt})
  --width / --height <N>  Output resolution (default ${DEFAULTS.width}x${DEFAULTS.height})
  --out <dir>             Where finished images are saved, named per variable (default data/output)
  --wire-to <dir>         App-live folder for this asset. The FIRST image generated for a given key is
                          written straight there — no review step needed. Every image generated after
                          that for the same key (the file already exists at --wire-to) is instead saved
                          under data/versions/<key>/v2.png, v3.png, ... and the live file is untouched.
                          Ignored when --variants > 1 (nothing to auto-promote before manual review).
  --variants <N>          Generate N seeded variants per subject instead of one, saved as
                          <key>_v1.png .. <key>_vN.png (default 1 — unchanged single-image behavior).
  --max-retries <N>       Per-image retry attempts on failure/timeout, restarting the container between
                          tries (default ${DEFAULTS.maxRetries}). After exhausting retries, that image is
                          logged as failed and the batch continues with the next one instead of aborting.
  --keep-running          Keep the models loaded when done (default: unload them; the container always stays up)
  --stop-container        Also stop and remove the container when done (frees all GPU memory)
`)
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildWorkflow(template, { positiveText, negativeText, seed, steps, cfg, sampler, scheduler, ckpt, width, height, filenamePrefix }) {
  const wf = JSON.parse(JSON.stringify(template)) // deep clone
  wf['30'].inputs.ckpt_name = ckpt
  wf['27'].inputs.width = width
  wf['27'].inputs.height = height
  wf['6'].inputs.text = positiveText
  wf['33'].inputs.text = negativeText || ''
  wf['31'].inputs.seed = seed
  wf['31'].inputs.steps = steps
  wf['31'].inputs.cfg = cfg
  wf['31'].inputs.sampler_name = sampler
  wf['31'].inputs.scheduler = scheduler
  wf['9'].inputs.filename_prefix = filenamePrefix
  return wf
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.prompt) { console.error('Error: --prompt or --prompt-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.vars || args.vars.length === 0) { console.error('Error: --vars or --vars-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.prompt.includes('{{VAR}}')) {
    console.warn('[generate-flux] Warning: prompt template has no {{VAR}} placeholder — every image will be identical except for seed.')
  }

  let vars = args.vars
  if (args.count) vars = vars.slice(0, args.count)

  const templatePath = path.join(__dirname, 'workflow.flux.api.json')
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  fs.mkdirSync(args.out, { recursive: true })

  const variants = Math.max(1, args.variants)
  const totalJobs = vars.length * variants
  console.log(`[generate-flux] ${vars.length} subject(s) x ${variants} variant(s) = ${totalJobs} image(s) to produce, output -> ${path.relative(process.cwd(), args.out)}`)
  if (variants > 1 && args.wireTo) {
    console.log('[generate-flux] --variants > 1: --wire-to is ignored (nothing to auto-promote before manual review).')
  }

  await startContainer()
  const failures = []
  try {
    await waitForReady()

    let jobIndex = 0
    for (let i = 0; i < vars.length; i++) {
      const raw = vars[i]
      const parts = raw.split('|').map((s) => s.trim())
      const [rawKey, desc] = parts.length >= 2 ? parts : [raw, raw]
      const slug = slugify(rawKey)
      const positiveText = args.prompt.replaceAll('{{VAR}}', desc)

      for (let v = 1; v <= variants; v++) {
        jobIndex++
        const seed = args.seed + i * variants + (v - 1)
        const outName = variants > 1 ? `${slug}_v${v}` : slug
        const label = variants > 1 ? `${desc} (variant ${v}/${variants})` : desc

        console.log(`\n[generate-flux] (${jobIndex}/${totalJobs}) "${label}" -> ${outName}.png  (seed=${seed})`)

        const workflow = buildWorkflow(template, {
          positiveText,
          negativeText: args.negative,
          seed,
          steps: args.steps,
          cfg: args.cfg,
          sampler: args.sampler,
          scheduler: args.scheduler,
          ckpt: args.ckpt,
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
            console.log(`[generate-flux]   saved ${path.relative(process.cwd(), outPath)}`)

            if (variants === 1 && args.wireTo) {
              const result = wireFile(bytes, args.wireTo, `${outName}.png`)
              console.log(`[generate-flux]   ${describeWireResult(result)}`)
            }
            succeeded = true
          } catch (err) {
            console.error(`[generate-flux]   attempt ${attempt}/${args.maxRetries + 1} failed for ${outName}: ${err.message}`)
            if (attempt <= args.maxRetries) {
              console.log('[generate-flux]   restarting container and retrying...')
              try { await stopContainer() } catch { /* best-effort */ }
              await startContainer()
              await waitForReady()
            } else {
              console.error(`[generate-flux]   giving up on ${outName} after ${attempt} attempts — continuing with the rest of the batch.`)
              failures.push(outName)
            }
          }
        }
      }
    }

    console.log(`\n[generate-flux] Done — ${totalJobs - failures.length}/${totalJobs} image(s) written to ${args.out}`)
    if (failures.length) {
      console.log(`[generate-flux] FAILED (skipped after retries): ${failures.join(', ')}`)
    }
  } finally {
    if (args.keepRunning) {
      console.log('[generate-flux] --keep-running set, leaving the models loaded.')
    } else if (args.stopContainer) {
      await stopContainer()
    } else {
      await unloadModels()
    }
  }
}

main().catch((err) => {
  console.error('\n[generate-flux] FAILED:', err.message)
  process.exit(1)
})
