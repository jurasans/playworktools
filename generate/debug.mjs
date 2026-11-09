import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import sharp from 'sharp'

async function debugRun() {
  const { data: rawBase, info: rawInfo } = await sharp('b:/Computer2019/claude/new-playwork/tools/generate/vars/radar-base-4k.png')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const mp4Out = 'b:/Computer2019/claude/new-playwork/tools/generate/vars/debug4k.mp4'
  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${rawInfo.width}x${rawInfo.height}`,
    '-r', '30',
    '-i', 'pipe:0',
    '-vf', 'pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '15',
    '-preset', 'fast',
    mp4Out
  ]

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'inherit'] })

  console.log('FFmpeg spawned. Testing batching...')
  const BATCH_SIZE = 8
  for (let b = 0; b < 16; b += BATCH_SIZE) {
    console.log(`Rendering batch ${b}...`)
    const promises = []
    for (let f = b; f < b + BATCH_SIZE; f++) {
      const svg = `<svg width="3840" height="2092" viewBox="0 0 1024 558">
        <circle cx="${100 + f * 20}" cy="200" r="30" fill="red"/>
      </svg>`
      promises.push(
        sharp(rawBase, { raw: { width: rawInfo.width, height: rawInfo.height, channels: 4 } })
          .composite([{ input: Buffer.from(svg) }])
          .raw()
          .toBuffer()
      )
    }
    const frames = await Promise.all(promises)
    console.log(`Batch ${b} rendered. Writing ${frames.length} frames to stdin...`)
    for (const buf of frames) {
      if (!ffmpegProc.stdin.write(buf)) {
        console.log('Waiting for drain...')
        await new Promise(r => ffmpegProc.stdin.once('drain', r))
      }
    }
    console.log(`Batch ${b} written!`)
  }

  ffmpegProc.stdin.end()
  await new Promise(r => ffmpegProc.on('close', r))
  console.log('Complete!')
  fs.unlinkSync(mp4Out)
}

debugRun()
