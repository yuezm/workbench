#!/usr/bin/env node
/**
 * 包路径生成器（拆分方案 §5）：`@workbench/*` 的解析只有一份真相源——各包的 package.json。
 *
 * 产出两份派生文件，谁都不许手写：
 *   - `tsconfig.paths.json`：给 `tsconfig.node.json` / `tsconfig.web.json` extends；
 *   - `scripts/workspace-aliases.mjs`：同样的映射，给 vite（server/web）与 vitest 的 `resolve.alias`。
 *
 * 包入口约定：
 *   - 包内有 `src/index.ts` → 额外提供根导入 `@workbench/<包>`；
 *   - 任何包都提供子路径导入 `@workbench/<包>/<文件>`（等价于 `src/<文件>`），
 *     这样 `protocol/commands` 这类细分契约不必挤进一个 barrel（避免重名冲突）。
 *
 * 用法：
 *   node scripts/gen-workspace-paths.mjs           # 写入派生文件
 *   node scripts/gen-workspace-paths.mjs --check   # 只比对，漂移即 exit 1（接进 check:fast）
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SCOPE = '@workbench/'
const TS_PATHS_FILE = join(ROOT, 'tsconfig.paths.json')
const TS_PATHS_EXTRA = join(ROOT, 'tsconfig.paths.extra.json')
const ALIAS_FILE = join(ROOT, 'scripts/workspace-aliases.mjs')
const CHECK = process.argv.includes('--check')

/** 收集 `apps/*`、`packages/<域>/<包>` 里带 package.json 的包。 */
function collect() {
  const entries = []
  const scan = (base, depth) => {
    if (!existsSync(base)) return
    for (const name of readdirSync(base)) {
      const dir = join(base, name)
      if (name === 'node_modules' || name.startsWith('.') || !statSync(dir).isDirectory()) continue
      if (depth > 1) scan(dir, depth - 1)
      else add(dir)
    }
  }
  const add = (dir) => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
    if (typeof name !== 'string' || !name.startsWith(SCOPE)) {
      throw new Error(`${relative(ROOT, manifestPath)}: name 必须以 ${SCOPE} 开头`)
    }
    if (!existsSync(join(dir, 'src'))) {
      throw new Error(`${relative(ROOT, manifestPath)}: 缺少 src/ 目录`)
    }
    const srcDir = join(dir, 'src')
    // 前端包可能是 `.tsx` 入口（app 插件），两种都算
    const indexFile = existsSync(join(srcDir, 'index.ts'))
      ? 'index.ts'
      : existsSync(join(srcDir, 'index.tsx'))
        ? 'index.tsx'
        : null
    entries.push({
      name,
      dir,
      src: relative(ROOT, srcDir).split(sep).join('/'),
      indexFile,
      hasIndex: indexFile !== null,
    })
  }
  scan(join(ROOT, 'apps'), 1)
  scan(join(ROOT, 'packages'), 2)
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

const header =
  '// 由 scripts/gen-workspace-paths.mjs 生成，不要手改；改包清单后跑 `pnpm gen:paths`。\n'

function renderTsPaths(entries) {
  // 手写条目（如 `@renderer/*`）放在 extra 里并入：tsconfig 的 paths 是整体覆盖而非合并，
  // 所以两边不能各写一份，只能在这里拼成一个对象。
  const extra = existsSync(TS_PATHS_EXTRA)
    ? (JSON.parse(readFileSync(TS_PATHS_EXTRA, 'utf8')).compilerOptions?.paths ?? {})
    : {}
  const paths = { ...extra }
  for (const entry of entries) {
    if (entry.hasIndex) paths[entry.name] = [`./${entry.src}/${entry.indexFile}`]
    paths[`${entry.name}/*`] = [`./${entry.src}/*`]
  }
  return `${header}${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`
}

/** 正则转义：`/` 必须转义——包名里的 `@scope/name` 若原样进字面量会提前结束正则。 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function renderAliases(entries) {
  if (entries.length === 0) {
    return [
      header,
      '',
      "import { resolve } from 'node:path'",
      '',
      "const ROOT = resolve(import.meta.dirname, '..')",
      '',
      '/** vite / vitest 共用的包别名；每项都是正则，避免前缀匹配吞掉子路径。 */',
      'export const workspaceAliases = []',
      '',
    ].join('\n')
  }
  const rows = []
  for (const entry of entries) {
    // 子路径在前、根在后：两个都是 `^...$` 正则，其实互不干扰，但保持可读顺序
    rows.push(
      `  { find: /^${escapeRegExp(entry.name)}\\/(.*)$/, replacement: resolve(ROOT, '${entry.src}/$1') },`,
    )
    if (entry.hasIndex) {
      rows.push(
        `  { find: /^${escapeRegExp(entry.name)}$/, replacement: resolve(ROOT, '${entry.src}/${entry.indexFile}') },`,
      )
    }
  }
  return [
    header,
    "import { resolve } from 'node:path'",
    '',
    "const ROOT = resolve(import.meta.dirname, '..')",
    '',
    '/** vite / vitest 共用的包别名；每项都是正则，避免前缀匹配吞掉子路径。 */',
    'export const workspaceAliases = [',
    ...rows,
    ']',
    '',
  ].join('\n')
}

function emit(file, content) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (current === content) return false
  if (CHECK) {
    throw new Error(`${relative(ROOT, file)} 与包清单不一致，跑 \`pnpm gen:paths\``)
  }
  writeFileSync(file, content)
  return true
}

try {
  const entries = collect()
  const tsChanged = emit(TS_PATHS_FILE, renderTsPaths(entries))
  const aliasChanged = emit(ALIAS_FILE, renderAliases(entries))
  console.log(
    CHECK
      ? `[paths] ${entries.length} 个包，派生文件一致`
      : `[paths] ${entries.length} 个包，${tsChanged || aliasChanged ? '已更新' : '无变化'}`,
  )
} catch (error) {
  console.error(`[paths] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
