/**
 * DeepSeek Harness desktop shell — Electron main process.
 *
 * Boots the bundled single-file `dsh web` runtime as a child process, waits
 * for its `dsh web: http://127.0.0.1:PORT` readiness line on stdout, then
 * opens a BrowserWindow on that URL. The runtime executable embeds Node 24 and
 * the full workspace closure, so no Node.js installation is required on the
 * target machine.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'

/** Readiness line printed by the web-app bundle once the server binds. */
const READY_RE = /dsh web: (http:\/\/[^\s]+)/

/** Runtime executable resolved from packaged resources. */
function runtimePath() {
  // Packaged: extraResources copies the exe to resources/runtime/dsh-web.
  const packaged = join(process.resourcesPath, 'runtime', 'dsh-web')
  if (existsSync(packaged)) return packaged
  // Source checkout: dist-exe/dsh-web-<platform>-<arch> (and its spawn helper
  // sibling) built by scripts/build-exe-for-web.ts.
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win32' : 'linux'
  const arch = process.arch
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const source = join(app.getAppPath(), '..', '..', 'dist-exe', `dsh-web-${platform}-${arch}${suffix}`)
  if (existsSync(source)) return source
  throw new Error(
    'dsh-web runtime executable not found. Build it first: pnpm --filter @deepseek-ai/dsh-desktop run build:runtime',
  )
}

let backend
let mainWindow

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(url)

  // Open external http(s) links in the system browser instead of the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    void shutdown(0)
  })
}

/** Kill the backend child if it is still alive. */
async function shutdown(exitCode) {
  if (backend !== undefined && !backend.killed) {
    const child = backend
    backend = undefined
    const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit()))
    child.kill('SIGTERM')
    // Give the tree a moment to persist sessions, then force-kill.
    await Promise.race([exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3000))])
    if (!child.killed) child.kill('SIGKILL')
  }
  app.exit(exitCode)
}

/** Fail loudly when the runtime cannot be spawned or never becomes ready. */
function fatal(message, error) {
  console.error(`[desktop] ${message}`, error ?? '')
  void dialog.showErrorBox('DeepSeek Harness', message)
  void shutdown(1)
}

async function boot() {
  let runtime
  try {
    runtime = runtimePath()
  } catch (error) {
    fatal(String(error))
    return
  }

  // Port 0 lets the OS pick a free port; the readiness line reports it.
  const child = spawn(runtime, ['web', '--port', '0', '--trusted-host', 'localhost'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_TELEMETRY_DISABLED: '1',
      // Packaged runtime: bare plugins resolve from the snapshot-embedded
      // closure rather than the profile-directory module fallback.
      DSH_PACKAGED_RUNTIME: '1',
    },
  })
  backend = child

  const timeout = setTimeout(() => {
    fatal('Timed out waiting for the dsh web server to start.')
  }, 60_000)

  const settle = () => clearTimeout(timeout)

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    process.stdout.write(text)
    const match = READY_RE.exec(text)
    if (match !== null) {
      settle()
      createWindow(match[1])
    }
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
  })

  child.once('error', (error) => {
    settle()
    fatal(`Failed to start the dsh web runtime: ${error.message}`)
  })

  child.once('exit', (code, signal) => {
    settle()
    if (backend !== undefined) {
      // Unexpected exit while the app is alive.
      backend = undefined
      fatal(`The dsh web runtime exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`)
    }
  })
}

app.whenReady().then(() => void boot())

app.on('window-all-closed', () => {
  // shutdown(0) is invoked from the window 'closed' handler; keep the app
  // alive until then so the backend can persist.
})

app.on('before-quit', (event) => {
  if (backend !== undefined) {
    event.preventDefault()
    void shutdown(0)
  }
})
