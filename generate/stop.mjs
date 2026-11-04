#!/usr/bin/env node
/** Stops and removes the ComfyUI container (frees the GPU). */
import { stopContainer } from './lib/docker.mjs'

await stopContainer()
