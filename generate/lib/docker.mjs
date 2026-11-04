import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const IMAGE_GEN_DIR = path.resolve(__dirname, '..')
export const COMFY_URL = 'http://127.0.0.1:8188'

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // MSYS_NO_PATHCONV: Git Bash on Windows rewrites unix-style paths in `-v`
    // arguments before they reach docker.exe, mangling bind-mount sources
    // (e.g. producing a stray "run;C" directory instead of mounting "run").
    // Harmless to set unconditionally, including on native Linux/mac shells.
    const env = { ...process.env, MSYS_NO_PATHCONV: '1', ...opts.env }
    const child = spawn(cmd, args, { cwd: IMAGE_GEN_DIR, stdio: 'inherit', shell: true, ...opts, env })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
    child.on('error', reject)
  })
}

/** Bind-mounted host folders the ComfyUI image expects to own as uid:gid 1000:1000
 *  (WANTED_UID/WANTED_GID in docker-compose.yml). On Windows/WSL2, fresh host
 *  directories are typically root-owned, which makes the container's startup
 *  script refuse to run — so this fixes ownership before every start. Runs
 *  recursively (`-R`) every time, not just once: any file added to basedir/
 *  from outside the container (e.g. manually dropping a downloaded model
 *  into basedir/models/checkpoints) is root-owned again and will fail the
 *  same way on the next boot otherwise. Cheap and idempotent. */
async function fixMountOwnership() {
  const fs = await import('fs')
  const path = await import('path')
  for (const dir of ['run', 'basedir']) {
    fs.mkdirSync(path.join(IMAGE_GEN_DIR, dir), { recursive: true })
  }
  await run('docker', [
    'run', '--rm',
    '-v', `${IMAGE_GEN_DIR}/run:/data/run`,
    '-v', `${IMAGE_GEN_DIR}/basedir:/data/basedir`,
    'alpine', 'sh', '-c', '"chown -R 1000:1000 /data/run /data/basedir"',
  ])
}

/** True when ComfyUI already answers: the container is left running between jobs, so there is nothing to start. */
export async function isContainerUp() {
  try { return (await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(2500) })).ok } catch { return false }
}

/** Frees the GPU without touching the container: ComfyUI drops its loaded models and cached memory. */
export async function unloadModels() {
  try {
    const res = await fetch(`${COMFY_URL}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
    console.log(res.ok ? '[docker] models unloaded, container left running.' : `[docker] could not unload models (HTTP ${res.status}).`)
  } catch (e) { console.log(`[docker] could not unload models: ${e.message}`) }
}

/** `docker compose up -d` for the ComfyUI service (a no-op when it is already up). */
export async function startContainer() {
  if (await isContainerUp()) { console.log('[docker] ComfyUI container already running.'); return }
  await fixMountOwnership()
  console.log('[docker] starting playwork-comfyui container...')
  await run('docker', ['compose', 'up', '-d'])
}

/** `docker compose down` — stops and removes the container, frees the GPU. */
export async function stopContainer() {
  console.log('[docker] stopping playwork-comfyui container...')
  await run('docker', ['compose', 'down'])
}

/** Polls ComfyUI's HTTP API until it responds, or throws after timeoutMs.
 *  Default is generous (20min) because the *first* boot ever clones ComfyUI,
 *  builds a venv, and pip-installs torch+CUDA (multi-GB) before the server
 *  starts listening — every boot after that is quick (seconds), since the
 *  venv and ComfyUI checkout persist in the bind-mounted basedir/. */
export async function waitForReady(timeoutMs = 1_200_000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs
  console.log('[docker] waiting for ComfyUI API to come up...')
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${COMFY_URL}/system_stats`)
      if (res.ok) {
        console.log('[docker] ComfyUI is ready.')
        return
      }
    } catch {
      // not up yet — expected while the container boots / model manager installs deps
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `ComfyUI did not respond at ${COMFY_URL} within ${timeoutMs}ms. ` +
    `Check container logs: docker compose logs -f (from ${IMAGE_GEN_DIR})`,
  )
}
