// Git Bash, by full path. A scheduled task (the host-runner) has a clean logon PATH where plain `bash` is WSL's bash.exe, which
// has no /c/... paths, so build-android.sh could not find the JDK there. PLAYWORK_BASH overrides.
import { existsSync } from 'node:fs'

const CANDIDATES = [
  process.env.PLAYWORK_BASH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
]

export const GIT_BASH = CANDIDATES.find((p) => p && existsSync(p)) || 'bash'
