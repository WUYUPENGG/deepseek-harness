// ============================================================================
// Jenkinsfile — DeepSeek Harness 桌面安装包 (Windows + macOS)
// ============================================================================
// 构建代理: 宿主机 macOS (Jenkins 节点 label = macos)
//   - macOS 安装包 (.dmg / .zip) 只能在 macOS 上构建
//   - Windows 安装包 (.exe: NSIS + portable) 由 electron-builder 在 macOS 上交叉构建
//
// 前置条件（详见 outputs/deepseek-harness-jenkins/接入指南.md）：
//   1. 把本仓库的桌面壳改动提交到 GitHub：
//      apps/desktop/、scripts/build-exe-for-web.ts、
//      apps/cli/src/bin.ts、apps/cli/src/profile-boot.ts、
//      packages/boot/app-boot/src/index.ts、pnpm-workspace.yaml、pnpm-lock.yaml、.gitignore
//   2. Jenkins 添加 label 为 macos 的 macOS agent（JDK 17 + Node 24 + pnpm）
//
// 用法：
//   - TARGETS: all = macOS + Windows; mac = 仅 macOS; win = 仅 Windows
//   - 首次构建较慢（electron-builder 需下载 Electron 双平台二进制），后续走缓存
// ============================================================================

pipeline {
    agent { label 'macos' }

    options {
        timestamps()
        timeout(time: 120, unit: 'MINUTES')
        disableConcurrentBuilds()   // 共享 workspace 与 electron-builder 缓存，禁止并发
    }

    parameters {
        choice(
            name: 'TARGETS',
            choices: ['all', 'mac', 'win'],
            description: '要构建的安装包：all = macOS + Windows，mac = 仅 macOS，win = 仅 Windows'
        )
        string(
            name: 'BRANCH',
            defaultValue: 'master',
            description: '要构建的分支'
        )
        booleanParam(
            name: 'SKIP_RUNTIME_BUILD',
            defaultValue: false,
            description: '跳过 pkg 单文件运行时构建（复用 workspace 已有的 dist-exe 产物，用于重试打包阶段）'
        )
    }

    environment {
        // 构建机（宿主 Mac）如需走本地代理访问 GitHub/npm，取消下面注释并按实际端口填写
        // HTTP_PROXY  = 'http://127.0.0.1:7897'
        // HTTPS_PROXY = 'http://127.0.0.1:7897'
        // NO_PROXY    = 'localhost,127.0.0.1,192.168.31.43'
        // 中国大陆网络下直连 GitHub 下载 Electron/NSIS 易超时，默认走 npmmirror 镜像；
        // 网络通畅时删除这两行可回落到官方源
        ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
        // electron-builder 下载缓存放 agent 主目录，跨构建复用
        ELECTRON_BUILDER_CACHE = "${env.HOME}/.cache/electron-builder"
    }

    stages {
        stage('检出代码') {
            steps {
                checkout scm
                sh "git checkout ${params.BRANCH} || true"
                sh 'git rev-parse --short HEAD'
            }
        }

        stage('环境检查') {
            steps {
                sh '''
                    set -e
                    echo "node: $(node --version)"
                    echo "git: $(git --version)"
                    corepack enable || true
                    pnpm --version || { echo "未找到 pnpm，请先安装：npm i -g pnpm@11.7.0"; exit 1; }
                '''
            }
        }

        stage('安装依赖并构建 dsh') {
            steps {
                sh 'pnpm install --frozen-lockfile'
                sh 'pnpm run build'
            }
        }

        stage('macOS 安装包 (.dmg/.zip)') {
            when { expression { params.TARGETS == 'all' || params.TARGETS == 'mac' } }
            steps {
                // 1) 构建 macOS (arm64) 单文件后端：node24-macos-arm64
                sh "pnpm exec tsx scripts/build-exe-for-web.ts ${params.SKIP_RUNTIME_BUILD ? '--skip-build' : ''}"
                // 2) 暂存 macOS 运行时（也可用 dist:mac 脚本：stage-runtime + electron-builder --mac）
                sh 'pnpm --filter @deepseek-ai/dsh-desktop exec node scripts/stage-runtime.mjs --platform=macos --arch=arm64'
                // 3) 打包 .dmg/.zip
                sh 'pnpm --filter @deepseek-ai/dsh-desktop exec electron-builder --mac --arm64'
                archiveArtifacts artifacts: 'apps/desktop/dist/*.dmg,apps/desktop/dist/*.zip,apps/desktop/dist/*.blockmap', fingerprint: true, allowEmptyArchive: true
            }
        }

        stage('Windows 安装包 (.exe NSIS/portable)') {
            when { expression { params.TARGETS == 'all' || params.TARGETS == 'win' } }
            steps {
                // 1) 在 macOS 上交叉构建 Windows x64 单文件后端（pkg 支持跨平台出 PE）
                sh "pnpm exec tsx scripts/build-exe-for-web.ts --targets=node24-win32-x64 ${params.SKIP_RUNTIME_BUILD ? '--skip-build' : ''}"
                // 2) 显式暂存 win32+x64 运行时 + electron-builder 打包 NSIS/portable
                //    （等价于 dist:win 脚本，这里显式指定架构避免默认架构不一致）
                sh 'pnpm --filter @deepseek-ai/dsh-desktop exec node scripts/stage-runtime.mjs --platform=win32 --arch=x64'
                sh 'pnpm --filter @deepseek-ai/dsh-desktop exec electron-builder --win --x64'
                archiveArtifacts artifacts: 'apps/desktop/dist/*.exe,apps/desktop/dist/*.blockmap', fingerprint: true, allowEmptyArchive: true
            }
        }

        stage('产物清单') {
            steps {
                sh '''
                    set -e
                    echo "=== 安装包清单 ==="
                    ls -lh apps/desktop/dist/ || true
                    shasum -a 256 apps/desktop/dist/*.dmg apps/desktop/dist/*.zip apps/desktop/dist/*.exe 2>/dev/null || true
                '''
            }
        }
    }

    post {
        success {
            echo '构建成功：安装包已归档到本次构建的 Artifacts 中。'
        }
        failure {
            echo '构建失败：请查看控制台日志；常见问题见 接入指南.md。'
        }
    }
}
