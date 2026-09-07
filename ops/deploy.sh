#!/usr/bin/env bash
#
# Деплой Takebana. Запускать на сервере от пользователя деплоя, не от root:
#
#   sudo -u takebana -i
#   cd /srv/takebana && bash ops/deploy.sh
#
# Что делает: забирает main, ставит зависимости, перезапускает pm2 и ждёт,
# пока приложение действительно ответит. Не ответило — откатывает на предыдущий
# коммит и поднимает его обратно.
#
#   bash ops/deploy.sh              обычный деплой из origin/main
#   bash ops/deploy.sh --no-fetch   перезапуск того, что уже лежит (правка .env)
#   bash ops/deploy.sh --rollback   вернуть предыдущий коммит вручную
#
# Пользовательский контент (server/public/uploads) не трогается: git reset
# не удаляет неотслеживаемые файлы, а git clean здесь не вызывается никогда.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-45}"
PM2_APP="${PM2_APP:-takebana}"
PREV_FILE="$APP_DIR/.deploy-prev"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_step=$'\033[36m'; c_off=$'\033[0m'
step() { printf '\n%s── %s %s\n' "$c_step" "$*" "$c_off"; }
ok()   { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '\n%sОстановлено:%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

MODE=deploy
case "${1:-}" in
  --no-fetch) MODE=nofetch ;;
  --rollback) MODE=rollback ;;
  "")         ;;
  *)          die "неизвестный аргумент: $1" ;;
esac

cd "$APP_DIR"

# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  step "Проверки"

  [[ $EUID -ne 0 ]] || die "не от root. Приложение должно работать от обычного пользователя: sudo -u takebana -i"
  [[ -d .git ]] || die "$APP_DIR — не git-репозиторий"
  command -v pm2 >/dev/null || die "pm2 не найден. Сначала ops/provision.sh"

  local env_file="$APP_DIR/server/.env"
  [[ -f "$env_file" ]] || die "нет server/.env. Скопируйте .env.example и заполните."

  # Читаем переменные, не выполняя файл: в .env могут быть значения со спецсимволами.
  local start_server session_secret rtmp_secret
  start_server=$(grep -E '^START_SERVER=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true)
  session_secret=$(grep -E '^SESSION_SECRET=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true)
  rtmp_secret=$(grep -E '^RTMP_PUBLISH_SECRET=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true)

  # Эти две проверки — про молчаливые поломки, которые уже случались:
  # без prod вход не работает за nginx, без секрета сессии подделываются.
  [[ "$start_server" == "prod" ]] || die "START_SERVER='${start_server:-пусто}', на сервере должно быть prod (TLS терминирует nginx)"
  [[ -n "$session_secret" ]] || die "SESSION_SECRET пуст — приложение откажется стартовать. Сгенерировать: bash ops/gen-secrets.sh"
  ok "START_SERVER=prod, SESSION_SECRET задан"

  # Не блокер, но без него вещать в чужой эфир может любой зритель.
  [[ -n "$rtmp_secret" ]] || warn "RTMP_PUBLISH_SECRET пуст: публикация в RTMP никак не защищена (docs/MIGRATION.md, фаза 4)"
}

# ─────────────────────────────────────────────────────────────────────────────
fetch_code() {
  step "Код"

  local before; before=$(git rev-parse HEAD)
  echo "$before" > "$PREV_FILE"

  git fetch --prune origin "$BRANCH"
  local after; after=$(git rev-parse "origin/$BRANCH")

  if [[ "$before" == "$after" ]]; then
    ok "уже на $(git log -1 --format='%h %s' HEAD)"
  else
    # reset, а не merge: сервер — не место для разрешения конфликтов.
    # Неотслеживаемые файлы (uploads) reset не удаляет.
    git reset --hard "origin/$BRANCH"
    ok "$(git log -1 --format='%h %s' HEAD)"
    git --no-pager log --oneline "$before..$after" | sed 's/^/    /' || true
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
install_deps() {
  step "Зависимости"
  cd "$APP_DIR/server"

  # npm ci, а не install: ставит ровно package-lock.json, без сюрпризов от ^.
  # --omit=dev: nodemon на проде не нужен.
  if npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 | sed 's/^/    /'; then
    ok "npm ci"
  else
    die "npm ci упал"
  fi

  local vuln; vuln=$(npm audit --omit=dev --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).metadata.vulnerabilities;console.log(`${v.critical} critical, ${v.high} high, ${v.moderate} moderate`)}catch(e){console.log("")}})' || true)
  [[ -n "$vuln" ]] && printf '    npm audit: %s\n' "$vuln"

  cd "$APP_DIR"
}

# ─────────────────────────────────────────────────────────────────────────────
restart_app() {
  step "Запуск"

  # startOrReload: первый раз стартует, дальше перезапускает без падения в ошибку,
  # если процесса ещё нет.
  pm2 startOrReload "$APP_DIR/ops/ecosystem.config.js" --env production --update-env 2>&1 | tail -n +2 | sed 's/^/    /'
  pm2 save --force >/dev/null
  ok "pm2 перезапустил ${PM2_APP}, список сохранён"
}

# ─────────────────────────────────────────────────────────────────────────────
health() {
  step "Проверка живости"

  local deadline=$((SECONDS + HEALTH_TIMEOUT)) code=""
  while (( SECONDS < deadline )); do
    code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
    if [[ "$code" == "200" ]]; then
      local body; body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
      ok "отвечает: ${body}"
      # Приложение живо, но база могла не подняться — из pm2 это не видно.
      if [[ "$body" == *'"db":"connected"'* ]]; then
        ok "база подключена"
      else
        warn "приложение отвечает, но база не подключена. journalctl / pm2 logs ${PM2_APP}"
      fi
      return 0
    fi
    sleep 2
  done

  warn "за ${HEALTH_TIMEOUT}с приложение так и не ответило на ${HEALTH_URL} (последний код: ${code:-нет ответа})"
  pm2 logs "$PM2_APP" --lines 30 --nostream 2>/dev/null | sed 's/^/    /' || true
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
rollback_to() {
  local sha="$1"
  step "Откат на ${sha:0:7}"
  git reset --hard "$sha"
  (cd "$APP_DIR/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || warn "npm ci при откате не прошёл"
  pm2 startOrReload "$APP_DIR/ops/ecosystem.config.js" --env production --update-env >/dev/null 2>&1 || true
  if health; then
    warn "откат удался: работает предыдущая версия $(git log -1 --format='%h %s')"
  else
    die "откат не помог — приложение не отвечает и на предыдущем коммите. Смотрите pm2 logs ${PM2_APP}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
main() {
  if [[ "$MODE" == rollback ]]; then
    [[ -s "$PREV_FILE" ]] || die "нечего откатывать: нет $PREV_FILE"
    rollback_to "$(cat "$PREV_FILE")"
    exit 0
  fi

  preflight
  [[ "$MODE" == nofetch ]] || fetch_code
  install_deps
  restart_app

  if health; then
    printf '\n%sДеплой прошёл.%s %s\n' "$c_ok" "$c_off" "$(git log -1 --format='%h %s')"
    printf 'Проверка снаружи: bash ops/smoke.sh https://takebana.com\n\n'
  else
    if [[ "$MODE" != nofetch && -s "$PREV_FILE" ]] && [[ "$(cat "$PREV_FILE")" != "$(git rev-parse HEAD)" ]]; then
      rollback_to "$(cat "$PREV_FILE")"
      exit 1
    fi
    die "приложение не поднялось, откатывать не на что"
  fi
}

main "$@"
