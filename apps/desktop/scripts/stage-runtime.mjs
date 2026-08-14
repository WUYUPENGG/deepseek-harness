/**
 * Stage the built single-file dsh web runtime into apps/desktop/runtime-staging
 * so electron-builder's extraResources can copy it into the app bundle.
 * Resolves the platform-specific product from the repository's dist-exe/.
 *
 * Usage: node scripts/stage-runtime.mjs [--platform=macos|win32|linux] [--arch=x64|arm64]
 * Defaults to the host platform and arch. Cross-building an installer for
 * another platform (e.g. --win from macOS) stages that platform's runtime.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '..')
const repoRoot = resolve(desktop, '..', '..')
const staging = join(desktop, 'runtime-staging')

const argValue = (name) => {
  const arg = process.argv.find((candidate) => candidate.startsWith(`--${name}=`))
  return arg === undefined ? undefined : arg.slice(`--${name}=`.length)
}
const requested = argValue('platform')
const platform = requested ?? (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win32' : 'linux')
// Default arch follows electron-builder's default: x64 when cross-building
// (target != host) or on x64 hosts; host arch otherwise.
const hostArch = process.arch
const crossBuilding = requested !== undefined && requested !== (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win32' : 'linux')
const arch = argValue('arch') ?? (crossBuilding ? 'x64' : hostArch)
const isWindows = platform === 'win32'
const base = join(repoRoot, 'dist-exe', `dsh-web-${platform}-${arch}`)

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const entries = [
  [isWindows ? `${base}.exe` : base, join(staging, 'dsh-web')],
]
// macOS only: node-pty's spawn-helper sibling.
if (platform === 'macos') {
  entries.push([`${base}-spawn-helper`, join(staging, 'dsh-web-spawn-helper')])
}

for (const [source, target] of entries) {
  if (!existsSync(source)) {
    throw new Error(`stage-runtime: ${source} missing — run pnpm run build:runtime first.`)
  }
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  console.log(`stage-runtime: staged ${target}`)
}
