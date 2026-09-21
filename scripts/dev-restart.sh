#!/bin/sh
# 重启 dsh web，让 profile 加载当前这棵 checkout 的插件代码。
#
# 为什么必须重启：dsh 用 Node 的模块缓存加载插件，改完 lib/*.js 后进程不会
# 重新读盘。cordis 的 patchReload 只覆盖 cordis.patch.yml 这类配置变更，覆盖不到
# 插件自身的实现文件。
#
# 用法：
#   scripts/dev-restart.sh                 # 立即重启
#   scripts/dev-restart.sh --check         # 只校验，不重启：确认运行中的进程是不是这棵
#                                          # checkout 的代码（线上 schema 键齐全则退出 0）
#   scripts/dev-restart.sh --delay 45      # 延迟 45 秒再重启（让当前这一轮回复先送达）
#   PROFILE=web PORT=3080 scripts/dev-restart.sh
#   DSH_BIN=/path/to/dsh scripts/dev-restart.sh
#
# 退出码：0 = 新进程就绪，且线上配置里能看到本机 schema 的全部设置键
#         （即确实跑的是本地代码）；1 = 启动失败或校验不通过。
set -eu

PROFILE="${PROFILE:-web}"
PORT="${PORT:-3080}"
DELAY=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --delay) DELAY="${2:?--delay 需要一个秒数}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（可用: --delay N | --check）" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
LOG="${HOME}/.dsh/web-${PROFILE}.log"
PIDFILE="${HOME}/.dsh/web-${PROFILE}.pid"
API="http://127.0.0.1:${PORT}/tier-router/api/config"

DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
if [ -z "${DSH_BIN}" ]; then
  echo "✗ 找不到 dsh 可执行文件；用 DSH_BIN=/path/to/dsh 指定。" >&2
  exit 1
fi

WANT="$(node -p "require('${REPO}/package.json').version")"

if [ "${DELAY}" -gt 0 ] 2>/dev/null; then
  echo "== 延迟 ${DELAY}s 后重启（这一轮回复会先返回）=="
  sleep "${DELAY}"
fi

echo "== 1/5 确认 profile 指向这棵 checkout =="
SPEC="$(node -p "require('${PROFILE_DIR}/package.json').dependencies['dsh-tier-router'] ?? '(未声明)'" 2>/dev/null || echo '(读不到)')"
echo "   package.json 声明 : ${SPEC}"
LINKED="$(node -p "require('${PROFILE_DIR}/node_modules/dsh-tier-router/package.json').version" 2>/dev/null || echo 'MISSING')"
echo "   profile 实际解析到: ${LINKED}"
if [ "${LINKED}" != "${WANT}" ]; then
  echo "✗ profile 解析到的版本(${LINKED}) ≠ 这棵 checkout(${WANT})" >&2
  echo "  先执行: dsh plugin --profile ${PROFILE} add link:${REPO}" >&2
  exit 1
fi
echo "   ✓ ${LINKED}"

# 版本无关的「新代码是否真的加载」校验：线上配置暴露的就是当前生效 schema 的键。
# 本地 schema 若有任何一个键没出现在线上，说明进程读的还是旧代码。
verify_loaded() {
  node --input-type=module -e "
const REPO = process.argv[1], API = process.argv[2];
const { SETTINGS_SCHEMA } = await import(REPO + '/lib/schema.js');
const want = Object.keys(SETTINGS_SCHEMA.dict);
let live;
try {
  const res = await fetch(API);
  live = Object.keys((await res.json()).config);
} catch {
  console.log('   ✗ 读不到 ${API}（服务没起来？）');
  process.exit(1);
}
const missing = want.filter((k) => !live.includes(k));
console.log('   本地 schema 键 ' + want.length + ' 个，线上 ' + live.length + ' 个');
if (missing.length === 0) {
  console.log('   ✓ 线上配置含本地 schema 的全部键 —— 跑的是这棵 checkout 的代码');
} else {
  console.log('   ✗ 线上缺少本地新增的键: ' + missing.join(', '));
  console.log('     进程读的还是旧代码（或插件未加载）。日志: ${LOG}');
  process.exit(1);
}
" "${REPO}" "${API}"
}

if [ "${CHECK_ONLY}" -eq 1 ]; then
  echo "== --check：只校验，不重启 =="
  if verify_loaded; then
    echo "   → 运行中的进程已经是这棵 checkout 的代码，无需重启。"
    exit 0
  fi
  echo "   → 需要重启：跑 scripts/dev-restart.sh（不加 --check）"
  exit 1
fi

echo "== 2/5 停掉占用 ${PORT} 的旧进程 =="
PIDS="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "${PIDS}" ]; then
  echo "   SIGTERM -> ${PIDS}"
  # shellcheck disable=SC2086
  kill ${PIDS} 2>/dev/null || true
  i=0
  while [ "${i}" -lt 30 ]; do
    if ! lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
    sleep 1; i=$((i + 1))
  done
  if lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    PIDS="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t 2>/dev/null || true)"
    echo "   30s 未退出，SIGKILL -> ${PIDS}"
    # shellcheck disable=SC2086
    kill -9 ${PIDS} 2>/dev/null || true
    sleep 2
  fi
  echo "   ✓ 端口已释放"
else
  echo "   端口本来就空闲"
fi

echo "== 3/5 清理孤儿锁 =="
# dsh 用 `wx` 创建 <文件>.lock 做原子写；持有者被 kill 后锁不会回收，新进程会
# 卡在 "timed out waiting for the writer lock"。这里只在锁内记录的 PID 确实
# 已不存在时才删 —— 持有者仍存活就保留，不动别人正在用的锁。
FOUND=0
for L in "${HOME}/.dsh"/*.lock "${HOME}/.dsh"/*/*.lock; do
  [ -e "${L}" ] || continue
  FOUND=1
  HOLDER="$(tr -dc '0-9' <"${L}" 2>/dev/null || true)"
  if [ -n "${HOLDER}" ] && kill -0 "${HOLDER}" 2>/dev/null; then
    echo "   保留（持有者 PID ${HOLDER} 仍存活）: ${L}"
  else
    rm -f "${L}"
    echo "   已删孤儿锁（锁内 PID ${HOLDER:-空} 已不存在）: ${L}"
  fi
done
[ "${FOUND}" -eq 0 ] && echo "   无残留锁"
echo "   ✓"

echo "== 4/5 启动（cwd=${HOME}，日志 ${LOG}）=="
if [ -f "${PIDFILE}" ]; then
  OLD_PID="$(cat "${PIDFILE}" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "   旧 pidfile 记录的进程 ${OLD_PID} 仍存活，先停掉"
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 2
  fi
fi
cd "${HOME}"
# 用 nohup + 重定向脱离当前 shell，否则这个脚本退出会把服务带走。
nohup "${DSH_BIN}" --profile "${PROFILE}" --no-open >"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"
echo "   pid $(cat "${PIDFILE}")"

echo "== 5/5 健康检查 =="
READY=0
i=0
while [ "${i}" -lt 120 ]; do
  sleep 1; i=$((i + 1))
  CODE="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "${API}" 2>/dev/null || echo 000)"
  if [ "${CODE}" = "200" ]; then READY=1; break; fi
done
if [ "${READY}" -ne 1 ]; then
  echo "✗ ${i}s 内 ${API} 未就绪（最后 HTTP ${CODE}）" >&2
  echo "  看日志尾部:" >&2
  tail -20 "${LOG}" >&2 || true
  exit 1
fi
echo "   ✓ 服务就绪（${i}s）"

verify_loaded
