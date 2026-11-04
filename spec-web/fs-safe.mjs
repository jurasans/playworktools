// Atomic-ish file write that survives Windows file locks. Replacing a file with rename() fails with EPERM/EBUSY/EACCES while
// another process (the spec-web server polling run state, the Docker bind mount, an antivirus scan) has the target open, which
// used to kill a headless run mid-way. Retry briefly, then fall back to overwriting in place: a reader that catches the short
// partial write fails its JSON.parse and treats the file as "not readable yet", which every caller here already tolerates.
import { writeFileSync, renameSync, readFileSync, rmSync } from 'node:fs'

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function atomicWriteFile(file, text, io = { writeFileSync, renameSync, readFileSync, rmSync }) {
  const tmp = `${file}.${process.pid}.tmp`
  io.writeFileSync(tmp, text)
  for (let i = 0; i < 6; i++) {
    try { io.renameSync(tmp, file); return } catch (e) {
      if (!RETRYABLE.has(e && e.code)) { try { io.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ } throw e }
      sleep(15 * 2 ** i)
    }
  }
  io.writeFileSync(file, io.readFileSync(tmp))
  try { io.rmSync(tmp, { force: true }) } catch { /* stray tmp is harmless */ }
}
