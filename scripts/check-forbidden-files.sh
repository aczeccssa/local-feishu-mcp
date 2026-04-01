#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Pre-commit: 禁止文件类型检查
# 快速在文件名层面拦截高危文件，避免走到后续检查
# ─────────────────────────────────────────────

FORBIDDEN_PATTERNS=(
  ".env"
  ".env.*"
  ".pem"
  ".key"
  "*.log"
  "*.pem"
  "*.key"
  "*.p8"
)

check_file() {
  local file="$1"

  # 允许 .env.example 等示例配置文件（危险的是包含真实凭证的 .env.local 等）
  if [[ "$file" == ".env.example" || "$file" == ".env.example.bak" ]]; then
    return 0
  fi

  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    case "$file" in
      $pattern)
        echo "❌ [forbidden-files] 禁止提交此文件类型: $file"
        echo "   提示: 将 $file 添加到 .gitignore（如果尚未添加）"
        exit 1
        ;;
    esac
  done

  # 文件大小检查 > 5MB
  if [[ -f "$file" ]]; then
    local size
    size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo 0)
    if (( size > 5242880 )); then
      echo "❌ [forbidden-files] 文件超过 5MB: $file (${size} bytes)"
      exit 1
    fi
  fi

  # dist/ 目录文件禁止提交
  if [[ "$file" == dist/* ]]; then
    echo "❌ [forbidden-files] dist/ 目录文件禁止提交: $file"
    echo "   提示: 将 dist/ 添加到 .gitignore，并在构建后提交产物"
    exit 1
  fi
}

echo "🔍 [forbidden-files] 检查暂存区文件..."

staged_files=$(git diff --cached --name-only --diff-filter=ACM)

if [[ -z "$staged_files" ]]; then
  echo "ℹ️  [forbidden-files] 没有暂存文件，跳过检查"
  exit 0
fi

errors=0
while IFS= read -r file; do
  if ! check_file "$file"; then
    ((errors++))
  fi
done <<< "$staged_files"

if (( errors > 0 )); then
  echo ""
  echo "❌ [forbidden-files] 发现 $errors 个禁止文件，提交被阻止"
  exit 1
fi

echo "✅ [forbidden-files] 通过"
