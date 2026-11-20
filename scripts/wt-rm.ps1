<#
.SYNOPSIS
  回收一棵任务工作树，并清理 git 元数据。

.DESCRIPTION
  对应方案 §3.8 的三条护栏，缺一不删：

  1. 目录里有未提交改动（`git status --porcelain` 非空）→ 不删
  2. 分支没合进 <base>，且没有显式 -Force → 不删
  3. 目录不存在 → 直接成功（幂等）

  只回收目录与 `git worktree` 元数据，**不删分支**：分支留给合并流程与人判断。

.PARAMETER Name
  工作树短名（与 wt-new 一致）。

.PARAMETER Path
  直接给工作树目录；与 -Name 二选一。

.PARAMETER Repo
  主仓路径，默认当前目录。

.PARAMETER Base
  判定「已合并」用的分支，默认 main。

.PARAMETER Force
  显式放弃这条改动：跳过「已合并」检查（未提交改动仍然拦）。

.EXAMPLE
  pwsh scripts/wt-rm.ps1 -Name fix-label
#>
[CmdletBinding()]
param(
  [string]$Name,
  [string]$Path,
  [string]$Repo = (Get-Location).Path,
  [string]$Base = 'main',
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  Write-Host "wt-rm: $message" -ForegroundColor Red
  exit 1
}

if (-not $Name -and -not $Path) { Fail '要么给 -Name，要么给 -Path' }
if ($Name -and $Path) { Fail '-Name 与 -Path 只能给一个' }

$repo = [System.IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath $repo)) { Fail "主仓不存在：$repo" }

if ($Path) {
  $dir = [System.IO.Path]::GetFullPath($Path)
} else {
  $dir = Join-Path (Join-Path (Split-Path -Parent $repo) '.worktrees') $Name
}

if (-not (Test-Path -LiteralPath $dir)) {
  Write-Host "wt-rm: 目录不存在，按已回收处理：$dir" -ForegroundColor Yellow
  git -C $repo worktree prune
  exit 0
}

# 护栏 1：未提交改动
$dirty = git -C $dir status --porcelain
if ($LASTEXITCODE -ne 0) { Fail "读不到工作树状态：$dir" }
if ($dirty) {
  Write-Host "wt-rm: 有未提交改动，不删：" -ForegroundColor Red
  $dirty | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  exit 1
}

# 护栏 2：分支是否已合并（-Force 表示人明确放弃）
$branch = (git -C $dir rev-parse --abbrev-ref HEAD).Trim()
if (-not $Force) {
  $merged = git -C $repo branch --merged $Base --format='%(refname:short)'
  if ($LASTEXITCODE -ne 0) { Fail "判定已合并失败：读不到 $Base" }
  if ($merged -notcontains $branch) {
    Write-Host "wt-rm: 分支 $branch 还没合进 $Base，不删。确认要放弃就加 -Force" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "wt-rm: -Force，跳过已合并检查（分支 $branch）" -ForegroundColor Yellow
}

Write-Host "wt-rm: 回收 $dir"
git -C $repo worktree remove $dir
if ($LASTEXITCODE -ne 0) { Fail 'git worktree remove 失败（目录可能被编辑器或终端占着）' }

git -C $repo worktree prune
if ($LASTEXITCODE -ne 0) { Fail 'git worktree prune 失败' }

Write-Host "完成。分支 $branch 保留在仓库里，没合就还在。" -ForegroundColor Green
