#!/bin/sh
# 发布 dsh-tier-router：定版 -> 测试 -> 提交 -> 打 tag -> 推 GitHub -> 发 npm -> 校验。
#
# 本仓库的发布约定：CHANGELOG.md 先写好目标版本的条目，再跑这个脚本定版。
# 脚本会拒绝在「CHANGELOG 里没有该版本条目」时继续，避免 package.json 与
# CHANGELOG 漂移。
#
# 用法：
#   scripts/release.sh 0.5.1                 # 显式版本
#   scripts/release.sh patch                 # 0.5.0 -> 0.5.1
#   scripts/release.sh minor                 # 0.5.0 -> 0.6.0
#   scripts/release.sh 0.6.0 --dry-run       # 只做检查和测试，不写盘、不推送
#   scripts/release.sh 0.6.0 --skip-npm      # 只推 GitHub
#
# npm 凭据（按顺序取第一个能用的）：
#   $NPM_TOKEN  ->  ~/.npm-publish-token  ->  ~/.npmrc 里的 _authToken
# 说明：npm 官网的「网页登录」不会给 CLI 写 token，必须 `npm login` 或手动建
# Automation token。
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO}"

BUMP=""
DRY_RUN=0
SKIP_NPM=0
SKIP_TESTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数: $1" >&2; exit 2 ;;
    *) BUMP="$1"; shift ;;
  esac
done

if [ -z "${BUMP}" ]; then
  echo "用法: scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run] [--skip-npm]" >&2
  exit 2
fi

# 跑一条命令，回显它最后 N 行，并如实返回它自己的退出码。
#
# 为什么需要：POSIX sh 里 `cmd | tail` 的退出码是 tail 的（恒为 0），会把测试
# 失败 / push 失败 / publish 失败统统吞掉 —— `set -e` 也就拦不住了。发布链路上
# 任何一次"看起来成功"的失败都会送出一个坏版本出去，所以这里必须绕开管道。
run_show() {
  _lines="$1"; shift
  _log="$(mktemp "${TMPDIR:-/tmp}/release-log.XXXXXX")"
  "$@" >"${_log}" 2>&1
  _rc=$?
  tail -n "${_lines}" "${_log}"
  rm -f "${_log}"
  return "${_rc}"
}

# 从 stdin 的 JSON 里取一个点分路径字段；取不到就打印 ?。
# （避免用 heredoc 把大段 JSON 插进 node -e 的源码里）
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const v = process.argv[1].split(".").reduce((a, k) => a?.[k], JSON.parse(s));
        console.log(v === undefined ? "?" : typeof v === "string" ? v : JSON.stringify(v));
      } catch { console.log("?"); }
    });
  ' "$1"
}

CURRENT="$(node -p "require('${REPO}/package.json').version")"

case "${BUMP}" in
  patch|minor|major)
    TARGET="$(node -e "
      const [maj, min, pat] = '${CURRENT}'.split('.').map(Number);
      const kind = '${BUMP}';
      const next = kind === 'major' ? [maj + 1, 0, 0]
                 : kind === 'minor' ? [maj, min + 1, 0]
                 : [maj, min, pat + 1];
      console.log(next.join('.'));
    ")"
    ;;
  [0-9]*.[0-9]*.[0-9]*) TARGET="${BUMP}" ;;
  *) echo "✗ 版本参数无法识别: ${BUMP}" >&2; exit 2 ;;
esac

echo "== 发布 ${CURRENT} -> ${TARGET} =="

echo "== 1/7 前置检查 =="
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${BRANCH}" != "main" ]; then
  echo "✗ 当前分支 ${BRANCH}，发布应在 main 上" >&2
  exit 1
fi
echo "   分支: main"

# 允许 CHANGELOG.md / package.json 处于未提交状态（发布提交会把它们一起带上），
# 其余已跟踪文件的改动必须先提交 —— 否则发布提交会夹带无关改动。
DIRTY="$( { git diff --name-only; git diff --cached --name-only; } | sort -u \
          | grep -vE '^(CHANGELOG\.md|package\.json)$' || true)"
if [ -n "${DIRTY}" ]; then
  echo "✗ 除 CHANGELOG.md / package.json 外还有未提交的已跟踪改动，先提交:" >&2
  echo "${DIRTY}" | sed 's/^/   /' >&2
  exit 1
fi
echo "   已跟踪文件干净（CHANGELOG.md / package.json 可待提交）"

if [ "${TARGET}" = "${CURRENT}" ]; then
  echo "✗ 目标版本与当前版本相同（${CURRENT}）" >&2
  exit 1
fi

if ! grep -q "^## \[${TARGET}\]" CHANGELOG.md; then
  echo "✗ CHANGELOG.md 里没有 '## [${TARGET}]' 条目" >&2
  echo "  先写 CHANGELOG（含日期），再发布。现有最新条目：" >&2
  grep -m 3 "^## \[" CHANGELOG.md >&2
  exit 1
fi
echo "   CHANGELOG 有 [${TARGET}] 条目"

if git rev-parse -q --verify "refs/tags/v${TARGET}" >/dev/null; then
  echo "✗ tag v${TARGET} 已存在" >&2
  exit 1
fi
echo "   tag v${TARGET} 未被占用"

# npm 上是否已存在该版本（避免发布才发现 403/409）
if [ "${SKIP_NPM}" -eq 0 ]; then
  if curl -sS -m 15 "https://registry.npmjs.org/dsh-tier-router/${TARGET}" 2>/dev/null | grep -q '"version"'; then
    echo "✗ npm 上已存在 ${TARGET}" >&2
    exit 1
  fi
  echo "   npm 上尚无 ${TARGET}"
fi

echo "== 2/7 测试 =="
if [ "${SKIP_TESTS}" -eq 1 ]; then
  echo "   （--skip-tests 跳过）"
else
  if ! run_show 8 npm test; then
    echo "✗ 测试未通过，中止发布（没有定版、没有推送、没有 publish）" >&2
    exit 1
  fi
  echo "   ✓ 测试通过"
fi

echo "== 3/7 定版（package.json）=="
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "   [dry-run] 会把 version 写为 ${TARGET}"
else
  node -e "
    const fs = require('fs');
    const p = '${REPO}/package.json';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '${TARGET}';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
  echo "   ✓ package.json version = ${TARGET}"
fi

echo "== 4/7 提交 + 打 tag =="
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "   [dry-run] commit 'release: ${TARGET}' + tag v${TARGET}"
else
  SUMMARY="$(grep -A 1 "^## \[${TARGET}\]" CHANGELOG.md | tail -1 | sed 's/^[[:space:]]*//')"
  [ -n "${SUMMARY}" ] || SUMMARY="release ${TARGET}"
  git add package.json CHANGELOG.md
  git commit -m "${TARGET}: ${SUMMARY}"
  git tag -a "v${TARGET}" -m "${TARGET}: ${SUMMARY}"
  echo "   ✓ commit $(git rev-parse --short HEAD) + tag v${TARGET}"
fi

echo "== 5/7 推 GitHub =="
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "   [dry-run] git push origin main --follow-tags"
else
  if ! run_show 5 git push origin main --follow-tags; then
    echo "✗ push 失败。commit 与 tag v${TARGET} 已在本地，修好远端后重跑：" >&2
    echo "   git push origin main --follow-tags" >&2
    echo "   （npm 尚未发布；重跑本脚本会因 tag 已存在而停下，用 --skip-npm 分段处理）" >&2
    exit 1
  fi
  echo "   ✓ 已推送"
fi

echo "== 6/7 发 npm =="
if [ "${SKIP_NPM}" -eq 1 ]; then
  echo "   （--skip-npm 跳过）"
elif [ "${DRY_RUN}" -eq 1 ]; then
  echo "   [dry-run] npm publish --access public"
else
  # --- 找一个能用的凭据 ---
  TOKEN="$(printenv NPM_TOKEN 2>/dev/null || true)"
  if [ -z "${TOKEN}" ] && [ -s "${HOME}/.npm-publish-token" ]; then
    TOKEN="$(tr -d '\n\r' <"${HOME}/.npm-publish-token")"
    case "${TOKEN}" in *"_authToken="*) TOKEN="${TOKEN##*_authToken=}" ;; esac
  fi
  if [ -z "${TOKEN}" ] && [ -s "${HOME}/.npmrc" ]; then
    TOKEN="$(grep -m 1 '_authToken=' "${HOME}/.npmrc" 2>/dev/null | sed 's/.*_authToken=//' || true)"
  fi

  if [ -z "${TOKEN}" ]; then
    echo "✗ 找不到 npm 凭据。三选一：" >&2
    echo "   1) npm login            （浏览器授权，会把 token 写进 ~/.npmrc）" >&2
    echo "   2) 在 npmjs.com 建 Automation token，写入 ~/.npm-publish-token" >&2
    echo "   3) 本次临时：NPM_TOKEN=npm_xxx scripts/release.sh ${TARGET}" >&2
    exit 1
  fi

  TMPRC="$(mktemp "${TMPDIR:-/tmp}/npmrc-publish.XXXXXX")"
  chmod 600 "${TMPRC}"
  trap 'rm -f "${TMPRC}"' EXIT INT TERM
  printf '//registry.npmjs.org/:_authToken=%s\n' "${TOKEN}" >"${TMPRC}"

  # 判定凭据是否有效要用 npm whoami 的退出码，不要匹配它的输出文本
  # —— 早期版本按 *E* 匹配，任何含大写 E 的用户名/提示都会被误判为失败。
  WHO="$(npm whoami --userconfig "${TMPRC}" 2>/dev/null || true)"
  if [ -z "${WHO}" ]; then
    echo "✗ npm 凭据无效或已过期。npm whoami 的原始输出：" >&2
    npm whoami --userconfig "${TMPRC}" 2>&1 | tail -3 >&2 || true
    echo "  重新 npm login，或换一个 Automation token。" >&2
    exit 1
  fi
  echo "   npm 身份: ${WHO}"
  if ! run_show 10 npm publish --access public --userconfig "${TMPRC}"; then
    echo "✗ npm publish 失败。GitHub 侧已推送（tag v${TARGET} 已在远端），" >&2
    echo "  修好凭据后只补发布即可：" >&2
    echo "   npm publish --access public" >&2
    exit 1
  fi
  echo "   ✓ publish 已提交"
fi

echo "== 7/7 校验 registry =="
if [ "${SKIP_NPM}" -eq 1 ] || [ "${DRY_RUN}" -eq 1 ]; then
  echo "   （跳过）"
else
  # 新版本不是立刻可见，轮询版本端点比读根文档（CDN 缓存滞后）可靠。
  OK=0
  i=0
  while [ "${i}" -lt 12 ]; do
    sleep 10; i=$((i + 1))
    V="$(curl -sS -m 15 "https://registry.npmjs.org/dsh-tier-router/${TARGET}" 2>/dev/null || true)"
    if echo "${V}" | grep -q '"version"'; then
      SHASUM="$(printf '%s' "${V}" | json_field dist.shasum)"
      echo "   ✓ npm 上有 ${TARGET}（shasum ${SHASUM}）"
      OK=1
      break
    fi
    echo "   ...等待 registry 生效（第 ${i} 次）"
  done
  if [ "${OK}" -ne 1 ]; then
    echo "⚠ 提交了 publish，但 120s 内没在 registry 上看到 ${TARGET}；稍后手动确认：" >&2
    echo "  curl -s https://registry.npmjs.org/dsh-tier-router | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s).versions)))\"" >&2
  fi
  TAGS="$(curl -sS -m 15 https://registry.npmjs.org/dsh-tier-router 2>/dev/null | json_field dist-tags)"
  echo "   dist-tags: ${TAGS}"
fi

echo
echo "== 完成: ${TARGET} =="
echo "提示：发布后若要本机生效，跑 scripts/dev-restart.sh"
