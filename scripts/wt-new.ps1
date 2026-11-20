<#
.SYNOPSIS
  为一个并行任务开一棵隔离工作树（git worktree），并装好依赖。

.DESCRIPTION
  零改动方案的第一步：工作台里「一个任务一个项目」，项目 path 就是这棵工作树 ——
  agent 阶段与脚本阶段的 cwd 都会落在这里（`task-effects.ts` 的 cwd 取项目 path），
  于是自测跑的是隔离树里的代码，不会在主干上出假绿。

  布局：<repo 的父目录>/.worktrees/<name>，分支 feat/<name>，从 <base> 切。
  放在仓库外面是有意的：放进仓库里 `git status` 会把整棵工作树当成未跟踪文件。

  幂等：目录已存在就直接报出来，不重复创建（内核不 stat 目录，幂等只能靠命令保证）。

.PARAMETER Name
  工作树短名，kebab-case（1–32 字符）。分支名 = feat/<Name>。

.PARAMETER Repo
  主仓路径，默认当前目录。

.PARAMETER Base
  基线分支，默认 main。

.PARAMETER Install
  建好后装依赖（按 lockfile 判定 pnpm / npm）。默认开；`-Install:$false` 关掉。

.EXAMPLE
  pwsh scripts/wt-new.ps1 -Name fix-label

.EXAMPLE
  pwsh scripts/wt-new.ps1 -Name feat-export -Repo D:\Codes\workbench -Base main
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Name,
  [string]$Repo = (Get-Location).Path,
  [string]$Base = 'main',
  [switch]$Install = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "wt-new: $message" -ForegroundColor Red
  exit 1
}

if ($Name -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') {
  Fail "工作树名只能是小写字母、数字和连字符，1–32 字符：$Name"
}

$repo = [System.IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath $repo)) { Fail "主仓不存在：$repo" }

git -C $repo rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { Fail "不是 git 仓库：$repo" }

git -C $repo rev-parse --verify --quiet "refs/heads/$Base" *> $null
if ($LASTEXITCODE -ne 0) { Fail "基线分支不存在：$Base" }

$root = Join-Path (Split-Path -Parent $repo) '.worktrees'
$dir = Join-Path $root $Name

if (Test-Path -LiteralPath $dir) {
  Write-Host "wt-new: 目录已存在，按已准备处理：$dir" -ForegroundColor Yellow
  $branch = (git -C $dir rev-parse --abbrev-ref HEAD).Trim()
  Write-Host "  分支：$branch"
  exit 0
}

New-Item -ItemType Directory -Force -Path $root | Out-Null

Write-Host "wt-new: 建工作树 $dir（分支 feat/$Name，基线 $Base）"
git -C $repo worktree add $dir -b "feat/$Name" $Base
if ($LASTEXITCODE -ne 0) { Fail "git worktree add 失败（分支 feat/$Name 可能已存在）" }

# 凭据泄漏检查：`git worktree add` 会把主仓的 include / credential 配置带进新树，
# 工作树一旦被挂到别人的仓库上，这些配置就是现成的推送凭证。
$leaked = git -C $dir config --local --get-regexp '^(credential|http)\.' 2>$null
if ($LASTEXITCODE -eq 0 -and $leaked) {
  Write-Host "wt-new: 警告：新工作树的本地配置里有 credential / http 项，先确认它不是主仓带进来的：" -ForegroundColor Yellow
  $leaked | ForEach-Object { Write-Host "  $_" }
}

if ($Install) {
  if (Test-Path -LiteralPath (Join-Path $dir 'pnpm-lock.yaml')) {
    Write-Host 'wt-new: pnpm install --frozen-lockfile'
    pnpm -C $dir install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Fail 'pnpm install 失败（目录已建好，修好依赖后重跑本脚本会直接报已存在）' }
  } elseif (Test-Path -LiteralPath (Join-Path $dir 'package-lock.json')) {
    Write-Host 'wt-new: npm ci'
    Push-Location $dir
    try { npm ci } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci 失败（目录已建好，修好依赖后重跑本脚本会直接报已存在）' }
  } else {
    Write-Host 'wt-new: 没有 lockfile，跳过装依赖'
  }
}

Write-Host ''
Write-Host '完成。工作台里新建项目并指向它：' -ForegroundColor Green
Write-Host "  名称：wt-$Name"
Write-Host "  路径：$dir"
Write-Host '然后把任务建在这个项目下 —— 项目 path 就是那次 run 的 cwd。'
