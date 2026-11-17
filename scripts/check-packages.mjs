#!/usr/bin/env node
/**
 * 包边界守卫（apps + packages 拆分方案的机器化部分）。
 *
 * 拆分后「依赖方向」不再靠 eslint 里逐个 glob 记住，而是两条可判定的事实：
 *
 * 1. **manifest 边**：`packages/*\/<pkg>/package.json` 里声明的 `@workbench/*` 依赖，
 *    必须落在 ALLOWED 表允许的方向上；`apps/server` / `bundle/base` 的**传递闭包**
 *    不得含任何 `client/*`（服务端是产品本体，Web 只是可选的层）。
 * 2. **源码边**：包内 `src/**` 的相对 import 解析后必须仍在包目录内。跨包只能写包名，
 *    否则 `git mv` 之后照样能从 host 直接摸到 plugins 实现，manifest 声明的边界就成了装饰。
 *
 * 没有包目录时（拆分前的单包状态）脚本输出 0 个包并以 0 退出，可以先接进门禁。
 *
 * 用法：
 *   node scripts/check-packages.mjs           # 人读清单 + 违规以非 0 退出
 *   node scripts/check-packages.mjs --json    # 机器读
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SCOPE = '@workbench/'

/**
 * 允许的依赖方向（from → 允许的 to 域/包）。
 *
 * - 键可以是域（`core`）或精确包（`core/protocol`）；先查精确包，再落域。
 * - `compiler/runtime` 的实话：client 只能用 `core/protocol` 的类型，不能碰 kernel。
 * - 服务端侧（api/host/app:server/bundle）在 ALLOWED 里**不给 client**：Web 层永远是可插拔的。
 */
const ALLOWED = {
  core: ['core', 'util'],
  'core/kernel': ['core/protocol', 'core/kernel', 'util'],
  'core/protocol': ['core/protocol', 'util'],
  sdk: ['core', 'util'],
  contract: ['core/protocol', 'contract', 'util'],
  host: ['core', 'sdk', 'contract', 'plugins/registry', 'plugins/kit', 'host', 'util'],
  plugins: ['core', 'sdk', 'contract', 'plugins', 'util'],
  'plugins/registry': ['core', 'sdk', 'contract', 'plugins', 'util'],
  'plugins/kit': ['core', 'contract', 'util'],
  api: ['core', 'sdk', 'contract', 'host', 'plugins/registry', 'api', 'util'],
  bundle: ['core', 'sdk', 'contract', 'host', 'api', 'plugins', 'bundle', 'util'],
  client: ['core/protocol', 'contract', 'sdk', 'client', 'util'],
  util: ['util'],
  'test-support': ['*'],
  'app:server': ['core', 'sdk', 'contract', 'host', 'api', 'plugins', 'bundle', 'util'],
  'app:web': ['core/protocol', 'contract', 'client', 'util'],
  'app:cli': ['core', 'sdk', 'contract', 'host', 'api', 'plugins', 'bundle', 'util'],
}

/** 这些入口的传递闭包里出现 `client/*` 或 `app:web` 即违规：服务端必须能独立跑。 */
const HEADLESS_SURFACES = ['app:server', 'bundle/base']

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 收集仓库里的包：apps/<name>、packages/<domain>/<name>。 */
function listPackages() {
  const found = []
  const push = (dir) => {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = readJson(manifestPath)
    const rel = relative(ROOT, dir).split(sep).join('/')
    const segments = rel.split('/')
    const kind = segments[0] === 'apps' ? 'app' : 'pkg'
    const key = kind === 'app' ? `app:${segments[1]}` : segments.slice(1).join('/')
    const domain = kind === 'app' ? `app:${segments[1]}` : segments[1]
    found.push({
      dir,
      rel,
      kind,
      key,
      domain,
      name: manifest.name,
      manifest,
      deps: workspaceDeps(manifest),
    })
  }

  const walk = (base, depth, pattern) => {
    if (!existsSync(base)) return
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry)
      if (!statSync(dir).isDirectory()) continue
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      if (depth === 1) push(dir)
      else walk(dir, depth - 1, pattern)
    }
  }

  walk(join(ROOT, 'apps'), 1)
  walk(join(ROOT, 'packages'), 2)
  return found
}

/** manifest 里指向本仓库其它包的依赖（`@workbench/*`）。 */
function workspaceDeps(manifest) {
  const out = new Set()
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(SCOPE)) out.add(name)
    }
  }
  return [...out]
}

/** 域级 key；带 `/` 的是精确包，`app:` 前缀的是应用入口。 */
const DOMAINS = new Set([
  'core',
  'sdk',
  'contract',
  'host',
  'plugins',
  'api',
  'bundle',
  'client',
  'util',
  'test-support',
])

const domainOf = (key) => (key.startsWith('app:') ? key : key.split('/')[0])

/**
 * from 允许哪些 to：精确包 key 优先，其次域 key。
 *
 * 表里带 `/` 或 `app:` 的条目按精确包匹配，其余按域匹配——`plugins/registry`
 * 这种「只准摸注册表」的收窄规则才能表达出来。
 */
function allows(fromKey, toKey) {
  const table = ALLOWED[fromKey] ?? ALLOWED[domainOf(fromKey)]
  if (!table) return false
  if (table.includes('*')) return true
  const targetDomain = domainOf(toKey)
  return table.some((entry) =>
    entry.startsWith('app:')
      ? entry === targetDomain
      : DOMAINS.has(entry)
        ? entry === targetDomain
        : entry === toKey,
  )
}

/** 源码里所有相对 import 的说明符。 */
function relativeImports(file) {
  const text = readFileSync(file, 'utf8')
  const specs = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].startsWith('.')) specs.push(match[1])
    }
  }
  return specs
}

function walkSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      walkSources(full, out)
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/u.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const inside = (dir, target) => target === dir || target.startsWith(dir + sep)

function main() {
  const json = process.argv.includes('--json')
  const packages = listPackages()
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const problems = []

  for (const pkg of packages) {
    if (!pkg.name?.startsWith(SCOPE)) {
      problems.push(`${pkg.rel}: package.json 的 name 必须以 ${SCOPE} 开头（当前「${pkg.name}」）`)
    }
    for (const dep of pkg.deps) {
      const target = byName.get(dep)
      if (!target) {
        problems.push(`${pkg.rel}: 依赖了不存在的仓库内包 ${dep}`)
        continue
      }
      if (!allows(pkg.key, target.key)) {
        problems.push(
          `${pkg.rel} (${pkg.name}) → ${target.rel} (${target.name})：依赖方向不允许（${pkg.key} 不得依赖 ${target.key}）`,
        )
      }
    }
    for (const file of walkSources(join(pkg.dir, 'src'))) {
      for (const spec of relativeImports(file)) {
        const target = resolve(dirname(file), spec)
        if (!inside(pkg.dir, target)) {
          problems.push(
            `${relative(ROOT, file).split(sep).join('/')}: 相对 import「${spec}」越过包边界，跨包请写包名`,
          )
        }
      }
    }
  }

  /** 传递闭包（只跟仓库内包的 manifest 边）。 */
  const closure = (startName) => {
    const seen = new Set()
    const queue = [startName]
    while (queue.length > 0) {
      const name = queue.shift()
      if (seen.has(name)) continue
      seen.add(name)
      const pkg = byName.get(name)
      if (!pkg) continue
      for (const dep of pkg.deps) if (byName.has(dep)) queue.push(dep)
    }
    return seen
  }

  for (const surface of HEADLESS_SURFACES) {
    const entry = packages.find((pkg) => pkg.key === surface)
    if (!entry) continue
    for (const name of closure(entry.name)) {
      const pkg = byName.get(name)
      if (!pkg || pkg.name === entry.name) continue
      if (pkg.domain === 'client' || pkg.key === 'app:web') {
        problems.push(
          `${entry.rel}: 传递依赖里出现 ${pkg.rel}——服务端装配必须能在没有 Web 端的情况下启动`,
        )
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          packages: packages.map(({ name, rel, key, deps }) => ({ name, rel, key, deps })),
          problems,
        },
        null,
        2,
      ),
    )
  } else if (packages.length === 0) {
    console.log('[packages] 尚无 apps/packages 目录，跳过边界检查（拆分前状态）')
  } else {
    const width = Math.max(...packages.map((pkg) => pkg.name.length))
    console.log(`[packages] ${packages.length} 个包`)
    for (const pkg of packages.sort((a, b) => a.key.localeCompare(b.key))) {
      const deps = pkg.deps.length === 0 ? '—' : pkg.deps.join(', ')
      console.log(`  ${pkg.name.padEnd(width)}  ${pkg.rel.padEnd(34)} ${deps}`)
    }
  }

  if (problems.length > 0) {
    console.error(`\n[packages] ${problems.length} 处边界违规：`)
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    process.exitCode = 1
  }
}

main()
