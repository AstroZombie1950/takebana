#!/usr/bin/env bash
#
# Проверка страниц живым браузером. Второй уровень после ops/smoke.sh.
#
#   bash ops/browser-check.sh https://takebana.com
#   SMOKE_EMAIL=a@b.c SMOKE_PASSWORD=... bash ops/browser-check.sh http://127.0.0.1:3000
#   SMOKE_ADMIN=1 ... — учётка с правами: добавляет к проверке /panel
#   SMOKE_PAGES=/userPage/<id>,/stream/<id> — разовые страницы с идентификатором
#   RUNNER=audit.mjs ... — вместо проверки работоспособности прогнать аудит вёрстки
#   SHOTS=./shots bash ops/browser-check.sh http://127.0.0.1:3000
#
# smoke.sh смотрит на коды ответов. Но страница может отдавать честный 200 и при
# этом не работать: так и было со страницей эфира — весь её JS падал на первой
# строке, чат и счётчик зрителей не работали, а curl видел 200 и был доволен.
# Здесь страницы реально открываются в Chrome, и ловятся исключения в консоли,
# ответы 4xx/5xx, несостоявшиеся загрузки, блокирующие alert() и битые картинки.
#
# Нужен установленный Chrome и Node 22+ (WebSocket встроенный, зависимостей нет).

set -Eeuo pipefail

BASE="${1:-http://127.0.0.1:3000}"
CDP_PORT="${CDP_PORT:-9222}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$(mktemp -d)"

c_bad=$'\033[31m'; c_warn=$'\033[33m'; c_off=$'\033[0m'
die() { printf '\n%sОстановлено:%s %s\n' "$c_bad" "$c_off" "$*" >&2; exit 2; }

# ── Chrome ───────────────────────────────────────────────────────────────────
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)" \
  "$(command -v chromium-browser || true)"
do
  [[ -n "$candidate" && -x "$candidate" ]] && { CHROME="$candidate"; break; }
done
[[ -n "$CHROME" ]] || die "не нашёл Chrome. Установите его или задайте путь в переменной CHROME."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || die "нужен Node 22+ (в нём встроен WebSocket), сейчас $(node -v)"

cleanup() {
  if [[ -n "${CHROME_PID:-}" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
    # Дожидаемся: Chrome ещё пишет в профиль, и rm на живом процессе ругается
    wait "$CHROME_PID" 2>/dev/null || true
  fi
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT

"$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" --disable-gpu \
          --hide-scrollbars --no-first-run --no-default-browser-check \
          --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 &
CHROME_PID=$!

# Ждём, пока поднимется отладочный порт
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 \
  || die "Chrome не открыл отладочный порт ${CDP_PORT}"

printf '  проверяем %s\n' "$BASE"
[[ -n "${SMOKE_EMAIL:-}" ]] || printf '  %s·%s без SMOKE_EMAIL / SMOKE_PASSWORD страницы за входом пропускаются\n' "$c_warn" "$c_off"

# Какой сценарий гонять: walk.mjs проверяет, что страницы работают,
# audit.mjs — что они сделаны (адаптив, кликабельность, ссылки, вес).
CDP_PORT="$CDP_PORT" node "$SCRIPT_DIR/browser/${RUNNER:-walk.mjs}" "$BASE"
