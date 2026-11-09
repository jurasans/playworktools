#!/usr/bin/env node
/**
 * Video generation pipeline against a local ComfyUI service using reference images.
 *
 * Supports two workflows:
 *   1) Stable Video Diffusion (SVD / SVD-XT) Image-to-Video: Takes a reference image
 *      (e.g. tactical radar map with jet vectors) and generates realistic 2D flight dynamics.
 *   2) SDXL Latent Frame Sequencing: Uses the local sd_xl_base_1.0.safetensors checkpoint
 *      with partial denoise and prompt guidance to generate frame sequences.
 *
 * Includes automatic FFmpeg-powered seamless loop post-processing (--loop), crossfading
 * the trailing frames back into the leading frames for an infinite, jump-free radar loop.
 *
 * Usage:
 *   node generate-video.mjs --image vars/radar-jets.png --prompt-file vars/radar-video-prompt.txt --loop
 *   node generate-video.mjs --workflow svd --motion-bucket 25 --frames 25 --fps 10
 *   node generate-video.mjs --workflow sdxl --ckpt sd_xl_base_1.0.safetensors --denoise 0.40
 *   node generate-video.mjs --dry-run
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync, spawn } from 'child_process'
import { startContainer, stopContainer, unloadModels, waitForReady, IMAGE_GEN_DIR } from './lib/docker.mjs'
import { queuePrompt, waitForOutputVideo, fetchOutputFile, uploadImage } from './lib/comfyClient.mjs'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  workflow:         'svd',                   // 'svd' | 'sdxl'
  image:            path.join(__dirname, 'vars', 'radar-jets.png'),
  ckpt:             'svd_xt.safetensors',
  sdxlCkpt:         'sd_xl_base_1.0.safetensors',
  promptFile:       path.join(__dirname, 'vars', 'radar-video-prompt.txt'),
  negativeFile:     path.join(__dirname, 'vars', 'radar-video-negative.txt'),
  prompt:           null,
  negative:         null,
  seed:             42,
  steps:            25,
  cfg:              2.5,                     // 2.5 for SVD; 6.5 for SDXL
  frames:           25,
  fps:              10,                      // Radar sweep scan rate
  motionBucket:     25,                      // 10-40: keeps 2D map rigid, only animates vector blips
  augmentation:     0.0,                     // 0.0: zero noise added to initial frame to preserve text/roads
  width:            1024,
  height:           576,                     // 16:9 standard, divisible by 64
  denoise:          0.40,                    // For SDXL img2img frame generation
  loop:             true,                    // Create a seamless looping video
  loopCrossfade:    4,                       // Number of crossfade frames
  out:              path.join(__dirname, 'data', 'video-output'),
  wireTo:           null,
  keepRunning:      false,
  stopContainer:    false,
  dryRun:           false,
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--help': case '-h': printHelp(); process.exit(0); break
      case '--workflow':     args.workflow = next(); break
      case '--image':        args.image = path.resolve(next()); break
      case '--ckpt':         args.ckpt = next(); break
      case '--prompt':       args.prompt = next(); break
      case '--prompt-file':  args.promptFile = path.resolve(next()); break
      case '--negative':     args.negative = next(); break
      case '--negative-file':args.negativeFile = path.resolve(next()); break
      case '--seed':         args.seed = parseInt(next(), 10); break
      case '--steps':        args.steps = parseInt(next(), 10); break
      case '--cfg':          args.cfg = parseFloat(next()); break
      case '--frames':       args.frames = parseInt(next(), 10); break
      case '--fps':          args.fps = parseInt(next(), 10); break
      case '--motion-bucket':args.motionBucket = parseInt(next(), 10); break
      case '--augmentation': args.augmentation = parseFloat(next()); break
      case '--denoise':      args.denoise = parseFloat(next()); break
      case '--width':        args.width = parseInt(next(), 10); break
      case '--height':       args.height = parseInt(next(), 10); break
      case '--loop':         args.loop = true; break
      case '--no-loop':      args.loop = false; break
      case '--loop-crossfade': args.loopCrossfade = parseInt(next(), 10); break
      case '--out':          args.out = path.resolve(next()); break
      case '--wire-to':      args.wireTo = path.resolve(next()); break
      case '--keep-running': args.keepRunning = true; break
      case '--stop-container': args.stopContainer = true; break
      case '--dry-run':      args.dryRun = true; break
      default:
        console.warn(`[generate-video] unrecognized argument: ${a}`)
    }
  }

  // Load prompts from files if not passed inline
  if (!args.prompt && args.promptFile && fs.existsSync(args.promptFile)) {
    args.prompt = fs.readFileSync(args.promptFile, 'utf-8').trim()
  }
  if (!args.negative && args.negativeFile && fs.existsSync(args.negativeFile)) {
    args.negative = fs.readFileSync(args.negativeFile, 'utf-8').trim()
  }

  return args
}

function printHelp() {
  console.log(`
Usage: node generate-video.mjs [options]

Options:
  --image <path>          Reference image (default: vars/radar-jets.png)
  --workflow <svd|sdxl>   Video generation workflow (default: ${DEFAULTS.workflow})
  --ckpt <filename>       Checkpoint to use (default: svd_xt.safetensors or sd_xl_base_1.0.safetensors)
  --prompt "<text>"       Positive prompt description
  --prompt-file <path>    Read positive prompt from file (default: vars/radar-video-prompt.txt)
  --negative "<text>"     Negative prompt
  --negative-file <path>  Read negative prompt from file (default: vars/radar-video-negative.txt)
  --frames <N>            Total frames to generate (default: ${DEFAULTS.frames})
  --fps <N>               Playback frame rate (default: ${DEFAULTS.fps})
  --motion-bucket <N>     SVD motion bucket 1-255 (default: ${DEFAULTS.motionBucket})
  --augmentation <N>      SVD initial augmentation (default: ${DEFAULTS.augmentation})
  --denoise <N>           SDXL sampling denoise (default: ${DEFAULTS.denoise})
  --seed <N>              Random seed (default: ${DEFAULTS.seed})
  --steps <N>             Sampling steps (default: ${DEFAULTS.steps})
  --cfg <N>               CFG scale (default: ${DEFAULTS.cfg})
  --width / --height <N>  Resolution (default: ${DEFAULTS.width}x${DEFAULTS.height})
  --loop / --no-loop      Make the output video seamlessly loopable (default: ${DEFAULTS.loop})
  --loop-crossfade <N>    Number of crossfade frames for loop (default: ${DEFAULTS.loopCrossfade})
  --out <dir>             Output directory (default: ${DEFAULTS.out})
  --wire-to <dir>         Wire final video into target directory
  --keep-running          Keep ComfyUI container running after job
  --stop-container        Explicitly stop ComfyUI container
  --dry-run               Print configuration and workflow without executing
`)
}

/**
 * Builds the ComfyUI API graph for SVD Image-to-Video.
 */
function buildSvdWorkflow(args, uploadedImageName) {
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflow.svd.api.json'), 'utf-8'))
  template['1'].inputs.ckpt_name = args.ckpt || 'svd_xt.safetensors'
  template['2'].inputs.image = uploadedImageName
  template['3'].inputs.width = args.width
  template['3'].inputs.height = args.height
  template['3'].inputs.video_frames = args.frames
  template['3'].inputs.motion_bucket_id = args.motionBucket
  template['3'].inputs.fps = args.fps
  template['3'].inputs.augmentation_level = args.augmentation
  template['4'].inputs.seed = args.seed
  template['4'].inputs.steps = args.steps
  template['4'].inputs.cfg = args.cfg
  template['9'].inputs.fps = args.fps
  template['9'].inputs.filename_prefix = 'radar_svd'
  return template
}

/**
 * Builds the ComfyUI API graph for SDXL frame sequence.
 */
function buildSdxlWorkflow(args, uploadedImageName) {
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflow.video.api.json'), 'utf-8'))
  template['4'].inputs.ckpt_name = args.ckpt || args.sdxlCkpt || 'sd_xl_base_1.0.safetensors'
  template['40'].inputs.image = uploadedImageName
  template['6'].inputs.text = args.prompt || ''
  template['7'].inputs.text = args.negative || ''
  template['3'].inputs.seed = args.seed
  template['3'].inputs.steps = args.steps
  template['3'].inputs.cfg = args.cfg > 4 ? args.cfg : 6.5
  template['3'].inputs.denoise = args.denoise
  template['9'].inputs.filename_prefix = 'radar_frame'
  return template
}

/**
 * Converts a raw video or animated WebP into a seamless loop MP4 using FFmpeg.
 */
function createSeamlessLoopVideo(inputPath, outputPath, fps, crossfadeFrames = 4) {
  console.log(`[generate-video] creating seamless loop with FFmpeg (crossfading ${crossfadeFrames} frames)...`)
  try {
    // Strategy: Split video into lead segment and trailing segment, crossfade trailing back into lead
    // for a perfectly seamless infinite loop.
    const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`).toString().trim()
    const duration = parseFloat(durationStr)
    const xfadeSec = Math.max(0.2, (crossfadeFrames / fps)).toFixed(2)
    const offset = Math.max(0.1, duration - parseFloat(xfadeSec)).toFixed(2)

    // Using FFmpeg xfade filter
    const cmd = `ffmpeg -y -i "${inputPath}" -filter_complex "[0:v]split=2[v1][v2];[v1]trim=0:${offset},setpts=PTS-STARTPTS[main];[v2]trim=${offset}:${duration},setpts=PTS-STARTPTS[tail];[tail][main]xfade=transition=fade:duration=${xfadeSec}:offset=0[outv]" -map "[outv]" -c:v libx264 -pix_fmt yuv420p -r ${fps} "${outputPath}"`
    execSync(cmd, { stdio: 'inherit' })
    console.log(`[generate-video] seamless loop created successfully: ${outputPath}`)
    return true
  } catch (err) {
    console.warn(`[generate-video] FFmpeg loop crossfade failed (${err.message}). Falling back to direct conversion...`)
    try {
      execSync(`ffmpeg -y -i "${inputPath}" -c:v libx264 -pix_fmt yuv420p -r ${fps} "${outputPath}"`, { stdio: 'inherit' })
      return true
    } catch (e) {
      console.error(`[generate-video] FFmpeg conversion failed: ${e.message}`)
      return false
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.stopContainer) {
    await stopContainer()
    return
  }

  if (!fs.existsSync(args.image)) {
    throw new Error(`Reference image not found at ${args.image}`)
  }

  console.log(`[generate-video] initializing video generation pipeline:`)
  console.log(`  workflow:        ${args.workflow.toUpperCase()}`)
  console.log(`  reference image: ${args.image}`)
  console.log(`  frames:          ${args.frames} @ ${args.fps} fps`)
  console.log(`  motion bucket:   ${args.motionBucket}`)
  console.log(`  seamless loop:   ${args.loop ? 'enabled' : 'disabled'}`)
  console.log(`  prompt:          ${(args.prompt || '').slice(0, 80)}...`)

  if (args.dryRun) {
    console.log('[generate-video] --dry-run mode requested. Dry run complete.')
    return
  }

  // Ensure output dir exists
  fs.mkdirSync(args.out, { recursive: true })

  // 1. Ensure ComfyUI service is running
  await startContainer()
  await waitForReady()

  // 2. Upload reference image to ComfyUI input folder
  console.log(`[generate-video] uploading reference image to ComfyUI...`)
  const uploadedImageName = await uploadImage(args.image)
  console.log(`[generate-video] uploaded reference image as "${uploadedImageName}".`)

  // 3. Prepare ComfyUI prompt graph
  const workflow = args.workflow === 'svd' 
    ? buildSvdWorkflow(args, uploadedImageName)
    : buildSdxlWorkflow(args, uploadedImageName)

  // 4. Queue generation job
  console.log(`[generate-video] submitting video generation job to ComfyUI queue...`)
  const promptId = await queuePrompt(workflow)
  console.log(`[generate-video] queued job ${promptId}. Waiting for frames...`)

  // 5. Wait for results
  const files = await waitForOutputVideo(promptId, { saveNodeId: '9' })
  if (!files || files.length === 0) {
    throw new Error(`[generate-video] generation finished but no output files returned.`)
  }

  console.log(`[generate-video] received ${files.length} output file(s) from ComfyUI.`)
  const baseName = `radar_flight_${Date.now()}`
  const rawFile = files[0]
  const rawExt = path.extname(rawFile.filename) || '.webp'
  const rawBytes = await fetchOutputFile(rawFile)
  const rawPath = path.join(args.out, `${baseName}_raw${rawExt}`)
  fs.writeFileSync(rawPath, rawBytes)
  console.log(`[generate-video] saved raw ComfyUI output to ${rawPath}`)

  // 6. Post-process into seamless looping MP4
  const finalMp4Path = path.join(args.out, `${baseName}_loop.mp4`)
  if (args.loop) {
    createSeamlessLoopVideo(rawPath, finalMp4Path, args.fps, args.loopCrossfade)
  } else {
    execSync(`ffmpeg -y -i "${rawPath}" -c:v libx264 -pix_fmt yuv420p -r ${args.fps} "${finalMp4Path}"`, { stdio: 'inherit' })
  }

  // 7. Wire to destination if requested
  if (args.wireTo) {
    fs.mkdirSync(args.wireTo, { recursive: true })
    const wireTarget = path.join(args.wireTo, 'radar-flight-loop.mp4')
    fs.copyFileSync(finalMp4Path, wireTarget)
    console.log(`[generate-video] wired video to ${wireTarget}`)
  }

  // 8. Lifecycle cleanup
  if (!args.keepRunning) {
    console.log('[generate-video] unloading models from GPU...')
    await unloadModels()
  }

  console.log(`[generate-video] video pipeline finished successfully!`)
}

main().catch((err) => {
  console.error(`[generate-video] ERROR:`, err)
  process.exit(1)
})
