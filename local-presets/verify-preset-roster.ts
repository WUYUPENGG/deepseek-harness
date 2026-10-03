/**
 * 临时校验：引导 profile 后读取 Agent 预设注册表（含挂载诊断 broken）。
 * 用法: node --import tsx .verify-preset-roster.ts [profile]
 */
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '../apps/cli/src/profile-boot.ts'

const profile = process.argv[2] ?? 'preset-verify'

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args: [],
})

const roster = await ctx.agentPresets.remoteExportList()

console.log(`\n=== profile "${profile}" 的预设名单(${roster.presets.length} 个) ===`)
for (const p of roster.presets) {
  const flags = [p.isDefault ? 'default' : undefined, p.broken === undefined ? undefined : `BROKEN: ${p.broken}`]
    .filter((x) => x !== undefined)
    .join(' | ')
  console.log(`  - ${p.id.padEnd(22)} ${(p.name ?? '(无名称)').padEnd(18)} order=${String(p.order ?? '-').padEnd(4)} ${flags}`)
}

const target = roster.presets.find((p) => p.id === 'ai-product-developer')
console.log('\n=== 目标角色判定 ===')
if (target === undefined) {
  console.log('  ✗ 未出现在名单中')
} else if (target.broken !== undefined) {
  console.log(`  ✗ 已注册但挂载失败: ${target.broken}`)
} else {
  console.log(`  ✓ 已注册且挂载成功 —— ${target.name} / order ${target.order}`)
}

await shutdown.shutdown(0)
