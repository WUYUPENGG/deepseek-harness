# DeepSeek Harness 桌面壳(Desktop Shell)

将 DeepSeek Harness Web GUI 打包为原生桌面应用的薄壳:Electron 窗口 + 内置的
`dsh-web` 单文件可执行后端。**目标机器无需安装 Node.js** —— 后端由
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) 打包,自带 Node 24 运行时与完整
workspace 依赖闭包。

## 架构

```
apps/desktop (Electron 壳,本目录)
  ├── electron/main.js       主进程:spawn dsh-web → 等就绪 URL → 开窗口
  ├── scripts/stage-runtime.mjs  把 dist-exe 产物暂存进 electron-builder extraResources
  └── package.json           electron-builder 三平台打包配置
scripts/build-exe-for-web.ts 把 `dsh web` 打成单文件可执行 (dist-exe/dsh-web-*)
```

Electron 主进程以 `--port 0` 启动后端(OS 分配空闲端口),监听 stdout 中的
`dsh web: http://127.0.0.1:PORT` 就绪行,然后加载该 URL。窗口关闭时向后端发送
SIGTERM,让会话有时间持久化。

**打包运行时解析**:主进程设 `DSH_PACKAGED_RUNTIME=1`,`apps/cli` 的 `bin.ts` 与
`profile-boot.ts` 据此把 loader 的 bare 插件解析指向快照内安装目录(通过
`bareModuleBaseUrl` 与 Loader baseUrl),并跳过仅源码模式可用的 watch-only HMR。
这些改动对源码模式零影响(`DSH_PACKAGED_RUNTIME` 未设置时行为与上游一致)。

## 构建安装包

### 前置

- Node.js 22.19+ / 24+、pnpm 11.7(corepack enable)
- 本仓库 `pnpm install` 已完成

### 1. 构建单文件后端(每个目标平台各跑一次)

```sh
# 本机构建(自动选择 node24-<os>-<arch>)
pnpm exec tsx scripts/build-exe-for-web.ts

# 指定目标平台(需在对应架构的机器/CI runner 上构建)
pnpm exec tsx scripts/build-exe-for-web.ts --targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64
```

产物:`dist-exe/dsh-web-<platform>-<arch>`(macOS 还有同名 `-spawn-helper` 伴随文件)。
单文件可执行自带 Node 运行时与全部依赖,是"安装包内嵌后端"。

> 构建脚本内含三个工作区环境的修复:deploy 用 `--config.ignore-scripts=true` 避免
> 根 postinstall 在 `install --production` 下因 lefthook(devDependency)链接被移除
> 而崩溃;staging 保持在仓库内稳定路径(避开 macOS /tmp 符号链接链导致 pkg 入口
> 路径错乱);deploy 后补齐 vendored 包(`link:` overrides 不会进 staging)、
> workspace 包(peer 依赖)与 node-pty 原生二进制。

### 2. 安装壳依赖并打包安装包

```sh
cd apps/desktop
pnpm install          # 安装 electron + electron-builder(仅此目录)
pnpm run dist:mac     # 产出 .dmg / .zip   (在 macOS 上运行)
pnpm run dist:win     # 产出 .exe (NSIS + portable) (在 Windows 上运行)
pnpm run dist:linux   # 产出 .AppImage / .deb (在 Linux 上运行)
pnpm run dist         # 当前平台默认目标
```

`pnpm run dist:*` 前的 `predist` 钩子自动执行 `scripts/stage-runtime.mjs`,把
`dist-exe/dsh-web-<platform>-<arch>` 复制到 `apps/desktop/runtime-staging/` 供
electron-builder 打进 app 的 `Contents/Resources/runtime/`。

安装包产物位于 `apps/desktop/dist/`。

### 本机开发调试(无需打包)

```sh
# 1) 构建后端单文件
pnpm exec tsx scripts/build-exe-for-web.ts
# 2) 以源码路径直接启动壳
cd apps/desktop && pnpm exec electron .
```

`electron/main.js` 优先使用打包资源里的 `resources/runtime/dsh-web`,源码环境下
回退到仓库根 `dist-exe/dsh-web-<platform>-<arch>`。

### CI 自动构建

仓库提供 `.github/workflows/desktop-installers.yml`,在 macOS/Windows/Linux runner
上自动构建对应安装包并上传 artifact。macOS/Linux 走 pkg 单文件后端;Windows 因
pkg 单文件为非目标(与上游一致),工作流给出系统 Node 承载的占位说明,实际发布前
请按需补充。

## 平台支持

| 目标 | 安装包 | 构建环境 | 说明 |
|---|---|---|---|
| macOS | `.dmg`、`.zip` | macOS (Apple Silicon/Intel) | 已验证:`.app` 独立运行 + `.zip` 分发 |
| Windows | `.exe` (NSIS/portable) | Windows(或 macOS 交叉构建) | 已构建验证:单文件后端为 PE32+ x64,pkg 交叉构建可用 |
| Linux | `.AppImage`、`.deb` | Linux (x64/arm64) | 依赖 Landlock 的沙箱能力为 Linux 专属,缺失时优雅降级 |

> Windows 单文件后端:上游 `build-exe-for-python-sdk.ts` 把 win32 列为文档化非目标
> (仅指其 CI 未覆盖),但 `@yao-pkg/pkg` 本身支持 Windows 目标 —— 本仓库
> `build-exe-for-web.ts` 已验证可交叉构建 `node24-win-x64`(PE 二进制),
> node-pty 的 win32 prebuilds(winpty.dll / winpty-agent.exe / conpty)会一并打进快照。
>
> 已知问题:
> - electron-builder 的 DMG 目标在本机系统 Python 3.14 下报
>   `plistlib.InvalidFileException`(dmgbuild 兼容问题);`.zip` 分发完全可用,
>   `.dmg` 请在 CI(macOS 官方 runner)或系统 Python ≤3.12 的环境构建。
> - 从 macOS 交叉构建 Windows 安装包时,需设置
>   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与
>   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
>   以绕过 GitHub 下载超时,并用 `--x64` 指定架构。

## 说明

- 本目录 + `scripts/build-exe-for-web.ts` 为新增文件;对现有代码的最小改动:
  - `apps/cli/src/bin.ts`、`apps/cli/src/profile-boot.ts`:`DSH_PACKAGED_RUNTIME=1`
    时传 `bareModuleBaseUrl`、Loader baseUrl 指向快照、跳过 watch-only HMR;
  - `packages/boot/app-boot/src/index.ts`:`boot()` 支持向 Loader 传 baseUrl
    (packaged runtime 的动态 entry 解析);
  - `pnpm-workspace.yaml`:`allowBuilds` 增加 electron / electron-winstaller。
- 后端启动时设置 `DSH_TELEMETRY_DISABLED=1`,与 CI 行为一致(不向生产遥测端点上报)。
