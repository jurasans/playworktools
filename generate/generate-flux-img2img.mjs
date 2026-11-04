#!/usr/bin/env node
/**
 * Image-to-image batch generation against the local FLUX.1 [schnell] service —
 * same CLI shape as generate-flux.mjs, but starts from an uploaded reference
 * photo (partial denoise) instead of an empty latent, to fix the anatomical
 * precision that pure text-to-image kept getting wrong across many rounds
 * (missing limbs, wrong proportions, torso creeping into cropped shots).
 *
 * Reference photos: a CC0 (public domain) anatomy reference photo from
 * Wikimedia Commons (upload.wikimedia.org/wikipedia/commons/8/82/Human_Body.jpg,
 * "Caucasian Female / Asian male, front and back") was cropped into 4 regions
 * — torso front/back, legs front/back (groin area blurred out; not needed for
 * pose/proportion reference and this repo avoids unnecessary explicit
 * content even in private working assets) — see basedir/input/anatomy-ref/.
 *
 * Vars format extends generate-flux.mjs's "key|description" with a required
 * third field: "key|description|refImageFilename" — refImageFilename must be
 * one of the files in basedir/input/anatomy-ref/ (or any path passed via
 * --ref-dir). Each run uploads the referenced file into ComfyUI's own input
 * folder via the /upload/image API (LoadImage resolves by filename against
 * ComfyUI's input dir, not an arbitrary host path).
 *
 * Usage:
 *   node generate-flux-img2img.mjs --prompt-file vars/icon-style-green.txt --vars-file vars/icons-green.txt --denoise 0.6
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { startContainer, stopContainer, unloadModels, waitForReady } from './lib/docker.mjs'
import { queuePrompt, waitForOutputImages, fetchOutputImage, uploadImage } from './lib/comfyClient.mjs'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  ckpt:       'flux1-schnell-fp8.safetensors',
  negative:   '',
  seed:       42,
  varySeed:   false,
  steps:      4,
  cfg:        1,
  sampler:    'euler',
  scheduler:  'simple',
  denoise:    0.65,  // lower = closer to the reference photo's pose/proportions, higher = more restyled
  refDir:     path.join(__dirname, 'basedir', 'input', 'anatomy-ref'),
  out:        path.join(__dirname, 'data', 'output'),
  wireTo:     null, // e.g. ../../public/images/othertests — first image per key goes straight there
  keepRunning: false,
  stopContainer: false,
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
      case '--vars-file':    args.vars = fs.readFileSync(path.resolve(next()), 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); break
      case '--count':        args.count = parseInt(next(), 10); break
      case '--seed':         args.seed = parseInt(next(), 10); break
      case '--vary-seed':    args.varySeed = true; break
      case '--steps':        args.steps = parseInt(next(), 10); break
      case '--cfg':          args.cfg = parseFloat(next()); break
      case '--sampler':      args.sampler = next(); break
      case '--scheduler':    args.scheduler = next(); break
      case '--denoise':      args.denoise = parseFloat(next()); break
      case '--negative':     args.negative = next(); break
      case '--ckpt':         args.ckpt = next(); break
      case '--ref-dir':      args.refDir = path.resolve(next()); break
      case '--out':          args.out = path.resolve(next()); break
      case '--wire-to':      args.wireTo = path.resolve(next()); break
      case '--keep-running': args.keepRunning = true; break
      case '--stop-container': args.stopContainer = true; break
      default:
        console.warn(`[generate-flux-img2img] unrecognized argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node generate-flux-img2img.mjs --prompt-file <file> --vars-file <file> [options]

--vars-file lines must be "key|description|refImageFilename" (refImageFilename
resolved inside --ref-dir, default basedir/input/anatomy-ref/).

Optional:
  --count <N>            Only generate the first N values from --vars-file
  --seed <N> / --vary-seed
  --steps <N>             KSampler steps (default ${DEFAULTS.steps})
  --cfg <N>               KSampler CFG (default ${DEFAULTS.cfg} — schnell ignores negative prompts above 1)
  --sampler / --scheduler <name>
  --denoise <N>           0-1, lower = closer to reference photo (default ${DEFAULTS.denoise})
  --negative "<text>"     No effect unless --cfg > 1
  --ckpt <filename>
  --ref-dir <path>        Where refImageFilename values are resolved from (default ${DEFAULTS.refDir})
  --out <dir>
  --wire-to <dir>         App-live folder for this asset. The FIRST image generated for a given key is
                          written straight there — no review step needed. Every image generated after
                          that for the same key (the file already exists at --wire-to) is instead saved
                          under data/versions/<key>/v2.png, v3.png, ... and the live file is untouched.
  --keep-running
`)
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function buildWorkflow(template, { positiveText, negativeText, seed, steps, cfg, sampler, scheduler, denoise, ckpt, refImageName, filenamePrefix }) {
  const wf = JSON.parse(JSON.stringify(template))
  wf['30'].inputs.ckpt_name = ckpt
  wf['40'].inputs.image = refImageName
  wf['6'].inputs.text = positiveText
  wf['33'].inputs.text = negativeText || ''
  wf['31'].inputs.seed = seed
  wf['31'].inputs.steps = steps
  wf['31'].inputs.cfg = cfg
  wf['31'].inputs.sampler_name = sampler
  wf['31'].inputs.scheduler = scheduler
  wf['31'].inputs.denoise = denoise
  wf['9'].inputs.filename_prefix = filenamePrefix
  return wf
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.prompt) { console.error('Error: --prompt or --prompt-file is required.\n'); printHelp(); process.exit(1) }
  if (!args.vars || args.vars.length === 0) { console.error('Error: --vars-file is required (key|description|refImage lines).\n'); printHelp(); process.exit(1) }

  let vars = args.vars
  if (args.count) vars = vars.slice(0, args.count)

  const templatePath = path.join(__dirname, 'workflow.flux.img2img.api.json')
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))

  fs.mkdirSync(args.out, { recursive: true })

  console.log(`[generate-flux-img2img] ${vars.length} image(s) to produce, output -> ${path.relative(process.cwd(), args.out)}`)

  await startContainer()
  try {
    await waitForReady()

    for (let i = 0; i < vars.length; i++) {
      const raw = vars[i]
      const parts = raw.split('|').map((s) => s.trim())
      if (parts.length < 3) throw new Error(`Line "${raw}" is missing the refImage field — expected "key|description|refImageFilename"`)
      const [rawKey, desc, refImageFile] = parts
      const slug = slugify(rawKey)
      const seed = args.varySeed ? args.seed + i : args.seed
      const positiveText = args.prompt.replaceAll('{{VAR}}', desc)
      const refPath = path.join(args.refDir, refImageFile)

      console.log(`\n[generate-flux-img2img] (${i + 1}/${vars.length}) "${desc}" (ref: ${refImageFile}) -> ${slug}.png  (seed=${seed}, denoise=${args.denoise})`)

      const refImageName = await uploadImage(refPath)

      const workflow = buildWorkflow(template, {
        positiveText,
        negativeText: args.negative,
        seed,
        steps: args.steps,
        cfg: args.cfg,
        sampler: args.sampler,
        scheduler: args.scheduler,
        denoise: args.denoise,
        ckpt: args.ckpt,
        refImageName,
        filenamePrefix: slug,
      })

      const promptId = await queuePrompt(workflow)
      const images = await waitForOutputImages(promptId)

      const bytes = await fetchOutputImage(images[0])
      const outPath = path.join(args.out, `${slug}.png`)
      fs.writeFileSync(outPath, bytes)
      console.log(`[generate-flux-img2img]   saved ${path.relative(process.cwd(), outPath)}`)

      if (args.wireTo) {
        const result = wireFile(bytes, args.wireTo, `${slug}.png`)
        console.log(`[generate-flux-img2img]   ${describeWireResult(result)}`)
      }
    }

    console.log(`\n[generate-flux-img2img] Done — ${vars.length} image(s) written to ${args.out}`)
  } finally {
    if (args.keepRunning) {
      console.log('[generate-flux-img2img] --keep-running set, leaving the models loaded.')
    } else if (args.stopContainer) {
      await stopContainer()
    } else {
      await unloadModels()
    }
  }
}

main().catch((err) => {
  console.error('\n[generate-flux-img2img] FAILED:', err.message)
  process.exit(1)
})
