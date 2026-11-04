import { randomUUID } from 'crypto'
import fs from 'fs'
import { COMFY_URL } from './docker.mjs'

/** Uploads a local file into ComfyUI's own input directory (required before a
 *  LoadImage node can reference it — LoadImage takes a filename resolved
 *  against ComfyUI's input folder, not an arbitrary host path). Returns the
 *  filename to use as LoadImage's `image` widget value. */
export async function uploadImage(filePath) {
  const buf = fs.readFileSync(filePath)
  const form = new FormData()
  form.append('image', new Blob([buf]), filePath.split(/[/\\]/).pop())
  const res = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`ComfyUI rejected the image upload (HTTP ${res.status}): ${await res.text()}`)
  const data = await res.json()
  return data.name
}

/** Submits a workflow (ComfyUI API-format prompt graph) to the queue. Returns prompt_id. */
export async function queuePrompt(workflow) {
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ComfyUI rejected the prompt (HTTP ${res.status}): ${body}`)
  }
  const data = await res.json()
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI node errors: ${JSON.stringify(data.node_errors)}`)
  }
  return data.prompt_id
}

/**
 * Polls /history/<prompt_id> until ComfyUI reports the job finished, then
 * returns the list of { filename, subfolder, type } produced by the
 * SaveImage node (node "9" in workflow.api.json).
 *
 * Default timeout is generous (15min) because the *very first* generation
 * after a boot pays a one-time cost for CUDA kernel JIT-compilation and
 * moving the checkpoint into VRAM on top of the actual sampling steps —
 * verified on an RTX 3070: first image took ~301s against a 25-step SDXL
 * workflow. Every generation after that in the same container session is
 * much faster (seconds, not minutes) since the model stays resident.
 */
export async function waitForOutputImages(promptId, opts = {}) {
  return waitForOutputFiles(promptId, { outputKey: 'images', saveNodeId: '9', ...opts })
}

/** Same polling contract as waitForOutputImages, for a SaveAudio*-family node
 *  whose history output key is "audio" instead of "images" (node "19" in
 *  workflow.audio.api.json). */
export async function waitForOutputAudio(promptId, opts = {}) {
  return waitForOutputFiles(promptId, { outputKey: 'audio', saveNodeId: '19', ...opts })
}

/**
 * Polls /history/<prompt_id> until ComfyUI reports the job finished, then
 * returns the list of { filename, subfolder, type } produced by the given
 * save node's output key.
 *
 * Default timeout is generous (15min) because the *very first* generation
 * after a boot pays a one-time cost for CUDA kernel JIT-compilation and
 * moving the checkpoint into VRAM on top of the actual sampling steps —
 * verified on an RTX 3070: first image took ~301s against a 25-step SDXL
 * workflow. Every generation after that in the same container session is
 * much faster (seconds, not minutes) since the model stays resident.
 */
async function waitForOutputFiles(promptId, { timeoutMs = 900_000, intervalMs = 1500, saveNodeId, outputKey } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${COMFY_URL}/history/${promptId}`)
    if (res.ok) {
      const history = await res.json()
      const entry = history[promptId]
      if (entry?.status?.completed) {
        const files = entry.outputs?.[saveNodeId]?.[outputKey]
        if (files?.length) return files
        throw new Error(`Job ${promptId} completed but produced no "${outputKey}" output — check the workflow's save node id.`)
      }
      if (entry?.status?.status_str === 'error') {
        throw new Error(`Job ${promptId} failed: ${JSON.stringify(entry.status)}`)
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for prompt ${promptId} to finish after ${timeoutMs}ms.`)
}

/** Fetches a generated file's raw bytes from ComfyUI's /view endpoint —
 *  works for images and audio alike, both use the same endpoint. */
export async function fetchOutputFile({ filename, subfolder, type }) {
  const params = new URLSearchParams({ filename, subfolder: subfolder ?? '', type: type ?? 'output' })
  const res = await fetch(`${COMFY_URL}/view?${params}`)
  if (!res.ok) throw new Error(`Failed to fetch output file ${filename} (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/** @deprecated kept as an alias for existing call sites — use fetchOutputFile */
export const fetchOutputImage = fetchOutputFile
