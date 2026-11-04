#!/usr/bin/env node
/** Unloads ComfyUI's models from the GPU and leaves the container running. */
import { unloadModels } from './lib/docker.mjs'

await unloadModels()
