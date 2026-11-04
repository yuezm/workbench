#!/usr/bin/env node
// 只读导出 ai-workflow 数据库的全部业务表为 JSON。
// 用法: node scripts/export-db.mjs --db <数据库文件> --out <输出文件>
// 输出确定（表按名排序、行按主键排序、无时间戳），供 M1 前的对账与回滚。
// 只读连接不写主库；WAL 库会生成/更新 -wal、-shm 侧车（允许）。
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const USAGE = `用法: node scripts/export-db.mjs --db <数据库文件> --out <输出文件>

只读导出 ai-workflow 数据库的全部业务表为 JSON（user_version + 每表行数 + 行数据）：
  --db   数据库文件路径（应用退出后运行）
  --out  输出 JSON 文件路径（覆盖写入）

退出码: 0 成功 / 1 导出失败 / 2 参数或输入错误`

function failWithUsage(message) {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { db: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg !== '--db' && arg !== '--out') failWithUsage(`未知参数：${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) failWithUsage(`缺少 ${arg} 的值`)
    args[arg.slice(2)] = value
    i++
  }
  if (args.db === null) failWithUsage('缺少 --db')
  if (args.out === null) failWithUsage('缺少 --out')
  return args
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`
}

function primaryKeyColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
  return rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name)
}

function readTable(db, table) {
  const pk = primaryKeyColumns(db, table)
  // 业务表都有主键；只有 rowid 的表用 rowid 兜底，保证行序稳定
  const orderBy = (pk.length > 0 ? pk : ['rowid']).map(quoteIdentifier).join(', ')
  const rows = db
    .prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }))
  return { name: table, rowCount: rows.length, rows }
}

function exportDatabase(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
  const version = db.prepare('PRAGMA user_version').get()
  return {
    userVersion: Number(version.user_version),
    tables: tables.map((table) => readTable(db, table)),
  }
}

const { db: dbPath, out: outPath } = parseArgs(process.argv.slice(2))
if (!existsSync(dbPath)) failWithUsage(`数据库文件不存在：${dbPath}`)
if (!statSync(dbPath).isFile()) failWithUsage(`--db 不是文件：${dbPath}`)
// 防止误把导出结果写回主库（只读承诺只覆盖 --db，不覆盖用户把 --out 指错的情况）
if (resolve(dbPath) === resolve(outPath)) failWithUsage('--out 不能与 --db 相同')

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (error) {
  console.error(`无法以只读方式打开数据库：${dbPath}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

try {
  const payload = exportDatabase(db)
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  const totalRows = payload.tables.reduce((sum, table) => sum + table.rowCount, 0)
  console.log(`已导出 ${payload.tables.length} 张表（${totalRows} 行）→ ${outPath}`)
} catch (error) {
  console.error(`导出失败：${dbPath} -> ${outPath}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  db.close()
}
