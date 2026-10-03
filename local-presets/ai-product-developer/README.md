# AI 产品开发工程师 — 用户自定义 Agent 预设

一个**声明式 Agent 预设 bundle**，把「需求澄清 → 规格综合 → TDD → 浏览器验收」四个阶段固化为一个可选的 Agent 角色。

## 角色内容

| 组成 | 说明 |
|---|---|
| persona | 开发阶段必须按 grill-me → to-spec → tdd 顺序推进；只有规格 `ready-for-agent` 才能改产品代码；TDD 必须保留同一测试的真实 Red 与 Green；最终必须用文件/Shell 工具做真实构建与浏览器验收 |
| 工具 | `tool-fs`、`tool-fs-search`、`tool-bash`(非 Windows)/`tool-pwsh`(Windows)、`tool-skill`、`tool-ask-user` |
| 技能 | `grill-me`、`to-spec`、`tdd` 三个 Skill（见 `skills/`） |
| 展示 | 名称「AI 产品开发工程师」，`order: 10` |

## 目录内容

```
cordis.patch.yml   预设声明（@deepseek-ai/dsh-agent-preset 行）
package.json       bundle 清单（dsh.bundle.patch 指向上面的声明）
skills/            三个技能的版本化源（grill-me / to-spec / tdd）
```

## 从旧目录式预设迁移

本 bundle 由旧的目录式预设 `$DSH_HOME/.agent-presets/ai-product-developer/` 迁移而来。官方 0.2.x 起**不再读取该目录**，预设改为声明式（写进 profile 的 patch 层）。逐项对应关系：

| 旧位置 | 新位置 |
|---|---|
| `preset.yml` 的 `name` / `description` / `order` | `cordis.patch.yml` 中声明的同名字段 |
| `agent.cordis.yml` 的插件列表 | 声明的 `config.plugins` |
| 目录名 `ai-product-developer` | 声明的 `config.id` |
| `persona.config.text` | `persona.config.prefix`（0.2.x 把单一 persona 段拆成 prefix/suffix） |
| `skill-filesystem.customSkillDirs` 的 `!!js new URL('skills/', baseUrl)` | `!!js dshHomePath('skills')` |

`customSkillDirs` 必须改指 `$DSH_HOME/skills`：声明式预设没有自己的目录，旧表达式里的 `baseUrl` 不再指向预设目录。

## 部署

技能放在用户技能根，由 harness 自动发现：

```sh
mkdir -p "$DSH_HOME/skills"        # DSH_HOME 默认 ~/.dsh
cp -R skills/grill-me skills/to-spec skills/tdd "$DSH_HOME/skills/"
```

`skills/` 是版本化源，`$DSH_HOME/skills/` 是运行时部署位置；改动技能后需重新复制。

bundle 需要被目标 profile 引用才会生效。在 profile 目录（`$DSH_HOME/profiles/<name>/`）中把它加为依赖并列入 `dsh.profile.bundles`：

```jsonc
// $DSH_HOME/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-preset-ai-product-developer": "file:/path/to/dsh-clone/local-presets/ai-product-developer"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-preset-ai-product-developer"
      ]
    }
  }
}
```

然后在 profile 目录执行安装：

```sh
cd "$DSH_HOME/profiles/desktop" && pnpm install
```

## 验证

命令行校验（推荐，可重复执行）：

```sh
cd /path/to/dsh-clone
node --import tsx local-presets/verify-preset-roster.ts preset-verify
```

脚本引导指定 profile 后读取预设注册表，逐条打印 `id / 名称 / order` 与挂载诊断。成功输出：

```
  - ai-product-developer   AI 产品开发工程师  order=10
  ✓ 已注册且挂载成功 —— AI 产品开发工程师 / order 10
```

挂载失败会在同一行打印原因（失败插件名 + 信息），例如：

```
  - bad-control  反向对照  order=99  BROKEN: bogus (@deepseek-ai/dsh-no-such-plugin): never started
```

该方法已用反向对照验证：故意引用不存在的插件时会被判为 `BROKEN`，因此干净记录代表真实挂载成功。

在界面里验证：

1. 启动 dsh Web 或 Desktop，打开 Agent 预设选择器，应出现「AI 产品开发工程师」。
2. 选中后确认技能可见：`grill-me`、`to-spec`、`tdd` 出现在技能列表。

注意：**只看启动日志不足以判断挂载结果**。挂载失败不阻止应用启动，且失败只在读取名单（`list()`）时通过审计暴露，不会在启动日志里打印。


## 说明

- 官方契约要求：预设不提供安全沙箱；用户覆盖会整体替换插件的子列表，而不是与内置预设逐项合并。
- 插件包名在 0.2.1 全部存在（`dsh-persona`、`dsh-agent-instructions`、`dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-bash`、`dsh-tool-pwsh`、`dsh-skill-filesystem`、`dsh-tool-skill`、`dsh-tool-ask-user`）；官方后续若重命名包，声明会在激活时报错而不是静默降级。
