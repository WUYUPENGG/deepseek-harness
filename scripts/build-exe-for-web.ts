/**
 * Build the `dsh web` desktop runtime executable with @yao-pkg/pkg.
 *
 * The desktop shell (apps/desktop) is a thin Electron window over the dsh Web
 * GUI: the Electron main process spawns the single-file executable produced
 * here (which embeds Node 24 plus the full workspace dependency closure), waits
 * for the `dsh web: http://127.0.0.1:PORT` readiness line on stdout, then loads
 * that URL in a BrowserWindow. The executable is self-contained, so the
 * installer does not require a Node.js installation on the target machine.
 *
 * The staging closure is symlink-free (pnpm deploy --legacy), and whole-tree
 * assets cover both Cordis's runtime bare-package imports and the built Web
 * frontend dist (html/css/js) that pkg cannot discover statically.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh'
/** The closed-runtime app entry inside the deployed closure. */
const ENTRY_BIN = 'lib/bin.js'
/**
 * Vendored packages resolved through `overrides: { link: vendor/<name> }`.
 * pnpm deploy does not materialize them into the staging closure because they
 * are not listed as dependencies of the deploy root; the harness runtime
 * imports them (cordis → cosmokit, schemastery, the cordis-plugin-* family),
 * so every vendor package is copied in. The map is vendor directory name →
 * published package name (they differ for the cordis-plugin-* family).
 */
const VENDOR_PACKAGES: Readonly<Record<string, string>> = {
  cordis: '@deepseek-ai/cordis',
  cosmokit: '@deepseek-ai/cosmokit',
  group: '@deepseek-ai/cordis-plugin-group',
  hmr: '@deepseek-ai/cordis-plugin-hmr',
  include: '@deepseek-ai/cordis-plugin-include',
  loader: '@deepseek-ai/cordis-plugin-loader',
  'logger-console': '@deepseek-ai/cordis-plugin-logger-console',
  schemastery: '@deepseek-ai/schemastery',
  timer: '@deepseek-ai/cordis-plugin-timer',
}
const OUTPUT_BASENAME = 'dsh-web'
/** Default Node major; SEA mode requires at least Node 22. */
const DEFAULT_NODE_RANGE = 'node24'
/** Pinned for reproducible builds. */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const OUT_DIR = 'dist-exe'

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see, plus the built Web frontend dist (index.html,
 * assets/*.js|css|svg) that the web-app bundle resolves through
 * `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')`.
 */
const ASSET_GLOBS = [
  'package.json',
  // The deploy root materializes at the staging root, so its lib/ entry
  // (lib/bin.js) lives outside node_modules and must be covered explicitly.
  'lib/**',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
  // Native shared libraries (sharp/libvips and similar) must ship alongside
  // their .node addons for dlopen to resolve them at runtime.
  'node_modules/**/*.dylib',
  'node_modules/**/*.so',
  'node_modules/**/*.so.*',
  'node_modules/**/*.dll',
  'node_modules/**/dist/**/*.html',
  'node_modules/**/dist/**/*.css',
  'node_modules/**/dist/**/*.svg',
  'node_modules/**/dist/**/*.png',
  'node_modules/**/dist/**/*.ico',
  'node_modules/**/dist/**/*.webmanifest',
  'node_modules/**/cordis.patch.yml',
  'node_modules/**/*.yml',
  'config/**/*',
]

const PLATFORMS = ['linux', 'macos', 'win'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

/** pkg platform tag → electron-builder file basename platform. */
function outputPlatform(platform: Platform): string {
  return platform === 'win' ? 'win32' : platform
}

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 * @param nodeRange - pkg Node range (`node<major>`).
 * @param platform - pkg platform tag (`win`, `linux`, `macos`; Windows is
 * supported for cross-builds — upstream only lists it as a CI non-goal, pkg
 * itself produces PE binaries).
 * @param arch - pkg CPU tag.
 */
class Target {
  private constructor(
    readonly nodeRange: string,
    readonly platform: Platform,
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-web: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-web: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-web: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-web: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /** Resolve the host-platform default on Node 24. */
  static host(): Target {
    const platform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : 'linux'
    const arch: Arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/** Render a command for logs and errors, quoting arguments with spaces. */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

interface BuildCli {
  targets: Target[]
  skipBuild: boolean
  dryRun: boolean
}

const BuildCli = {
  parse(argv: string[]): BuildCli {
    const parsed = parseArgs({
      args: argv,
      options: {
        targets: { type: 'string', default: '' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    })
    const rawTargets = parsed.values.targets ?? ''
    const targets = rawTargets === ''
      ? [Target.host()]
      : rawTargets.split(',').map(raw => raw.trim()).filter(Boolean).map(Target.parse)
    return {
      targets,
      skipBuild: parsed.values['skip-build'] === true,
      dryRun: parsed.values['dry-run'] === true,
    }
  },
}

/**
 * Sequential build pipeline. Subprocesses inherit stdio and errors include
 * the command; dry runs print commands and filesystem changes.
 */
class SingleExeBuild {
  /**
   * The cleared deploy target and pkg input. Kept inside the repository on a
   * stable absolute path: /tmp on macOS is a symlink chain (/tmp →
   * /private/tmp → /var/folders/.../T) that makes pkg record entry paths the
   * SEA runtime cannot resolve at boot. `--config.ignore-scripts=true` on the
   * deploy avoids the workspace-root postinstall (lefthook) running inside
   * the deploy's `install --production`, which would otherwise remove the
   * devDependency links it needs.
   */
  readonly staging = join(root, 'dist-desktop-runtime')
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-web: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Clear and deploy the runtime closure into the staging directory. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-web: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-web: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      // The deploy runs `install --production` inside the workspace; without
      // this, the root postinstall (install-lefthook) fails because the
      // production install removed the lefthook devDependency link.
      '--config.ignore-scripts=true',
      this.staging,
    ])
    // The deploy's internal `install --production` removes devDependency
    // links from the workspace root (including lefthook). Restore them so a
    // later `pnpm` invocation's postinstall does not fail.
    await this.restoreWorkspaceDevDeps()
    await this.restoreVendorPackages()
    await this.restoreWorkspacePackages()
    await this.restoreNativeBinaries()
    await this.materializeStagedLinks()
  }

  /**
   * Re-link workspace-root devDependencies that the deploy's internal
   * `install --production` removed. A plain `pnpm install` restores them from
   * the content-addressable store without re-resolving the lockfile.
   */
  private async restoreWorkspaceDevDeps(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-web: [dry-run] pnpm install (restore workspace devDeps)')
      return
    }
    await this.run('restore workspace devDeps', pnpmBin(), ['install'])
  }

  /**
   * Copy any workspace package the deploy did not materialize (peer
   * dependencies are not installed by `deploy --prod`). Scans the workspace
   * for `@deepseek-ai/dsh-*` packages and copies the ones missing from the
   * staged closure, preserving each package's own node_modules exclusion so
   * links do not leak into the payload.
   */
  private async restoreWorkspacePackages(): Promise<void> {
    const stagedScope = join(this.staging, 'node_modules', '@deepseek-ai')
    const staged = new Set<string>()
    try {
      for (const entry of await readdir(stagedScope, { withFileTypes: true })) {
        if (entry.isDirectory()) staged.add(entry.name)
      }
    } catch {
      // stagedScope absent — every workspace package is missing.
    }
    const workspacePackages = join(root, 'packages')
    const groups = await readdir(workspacePackages, { withFileTypes: true })
    const missing: string[] = []
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const groupDir = join(workspacePackages, group.name)
      for (const entry of await readdir(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const packageDir = join(groupDir, entry.name)
        const manifestPath = join(packageDir, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
        const name = manifest.name
        if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
        const shortName = name.slice('@deepseek-ai/'.length)
        if (staged.has(shortName)) continue
        missing.push(shortName)
        const destination = join(stagedScope, shortName)
        if (this.cli.dryRun) {
          console.log(`build-exe-for-web: [dry-run] cp -R ${packageDir} ${destination}`)
          continue
        }
        await mkdir(dirname(destination), { recursive: true })
        const nestedNodeModules = join(packageDir, 'node_modules')
        await cp(packageDir, destination, {
          recursive: true,
          dereference: true,
          filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        })
      }
    }
    if (missing.length > 0 && !this.cli.dryRun) {
      console.log(`build-exe-for-web: restored workspace packages: ${missing.join(', ')}`)
    }
  }

  /**
   * Restore native addons whose install scripts the deploy skipped
   * (`ignore-scripts`). node-pty ships prebuilds per platform; the workspace
   * package keeps them in `prebuilds/<platform>-<arch>/` (macOS) or builds
   * into `build/Release/` (Linux). Copy the pty addon so the staging closure
   * is self-contained on this host's architecture.
   */
  private async restoreNativeBinaries(): Promise<void> {
    const ptyPackage = join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty')
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch
    const candidates = [
      join(ptyPackage, 'prebuilds', `${platform}-${arch}`, 'pty.node'),
      join(ptyPackage, 'build', 'Release', 'pty.node'),
    ]
    const source = candidates.find(candidate => existsSync(candidate))
    if (source === undefined) {
      throw new Error('build-exe-for-web: node-pty pty.node not found in workspace package; run pnpm install first.')
    }
    const destination = join(this.staging, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    if (existsSync(destination)) return
    if (this.cli.dryRun) {
      console.log(`build-exe-for-web: [dry-run] cp ${source} ${destination}`)
      return
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    console.log(`build-exe-for-web: restored node-pty pty.node (${platform}-${arch}) into staging`)
  }

  /**
   * Copy vendored packages (resolved via `link:` overrides, which pnpm deploy
   * does not materialize) into the staged closure. Each vendor package ships
   * its built `lib/`, so copying the package directory yields a runnable
   * package.
   */
  private async restoreVendorPackages(): Promise<void> {
    for (const [directory, packageName] of Object.entries(VENDOR_PACKAGES)) {
      const destination = join(this.staging, 'node_modules', ...packageName.split('/'))
      if (existsSync(destination)) continue
      const source = join(root, 'vendor', directory)
      if (!existsSync(source)) {
        throw new Error(`build-exe-for-web: vendored package ${source} missing.`)
      }
      if (this.cli.dryRun) {
        console.log(`build-exe-for-web: [dry-run] cp -R ${source} ${destination}`)
        continue
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      console.log(`build-exe-for-web: restored vendored package ${packageName}`)
    }
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-web: [dry-run] materialize staged package links')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /** Return the first symbolic link below a directory, if one exists. */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Add the executable entry and pkg assets to the staged manifest. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-web: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-web: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, ENTRY_BIN))) {
      throw new Error(`build-exe-for-web: ${join(this.staging, ENTRY_BIN)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-for-web: injected pkg config into ${manifestPath}`)
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable path and, on macOS, its helper path.
   */
  async pack(target: Target): Promise<string[]> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${outputPlatform(target.platform)}-${target.arch}`)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin(), [
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    // pkg appends .exe for win targets even when --output has no extension.
    const actual = target.platform === 'win' ? `${product}.exe` : product
    if (!this.cli.dryRun && !existsSync(actual)) {
      throw new Error(`build-exe-for-web: product ${actual} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    if (target.platform !== 'macos') return [actual]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-web: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [actual, spawnHelper]
  }

  /**
   * Put the target node-pty addon in the staged closure. Linux npm installs
   * build it from source, but legacy deploy omits that side-effect directory.
   * @param target - the pkg target whose native addon is being staged.
   */
  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-for-web: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-web: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-for-web: build the Linux runtime on its target architecture; '
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Print each product path and, outside dry-run mode, its size.
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-web: [dry-run] would produce:' : 'build-exe-for-web: products:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-web: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-web: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-web: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-web: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-web: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-web: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  pipeline.printProducts(products)
}

await main()
