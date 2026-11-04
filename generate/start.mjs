#!/usr/bin/env node
/** Starts the ComfyUI container and waits until its API is reachable, then
 *  leaves it running — for manual/adhoc use via the web UI at
 *  http://127.0.0.1:8188. Pair with `node stop.mjs` when done. */
import { startContainer, waitForReady, COMFY_URL } from './lib/docker.mjs'

await startContainer()
await waitForReady()
console.log(`\nComfyUI is up: ${COMFY_URL}`)
console.log('Stop it later with: node stop.mjs')
