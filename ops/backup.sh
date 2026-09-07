#!/usr/bin/env bash
#
# Бэкап Takebana: база и пользовательские файлы.
#
#   sudo bash ops/backup.sh                 снять бэкап сейчас
#   sudo bash ops/backup.sh --install-cron  поставить ежедневный в 04:15
#   sudo bash ops/backup.sh --list          что уже лежит
#   sudo bash ops/backup.sh --verify        восстановить последний в отдельную базу и сверить
#   sudo bash ops/backup.sh --restore DIR   развернуть указанный бэкап на боевую базу
#
# --verify не для галочки. Бэкап, который ни разу не разворачивали, — это не бэкап,
# а каталог файлов, про который никто не знает, читается он или нет. Проверка
# заливает дамп в отдельную базу takebana_verify, сверяет число документов
# по коллекциям и убирает её за собой. Боевую базу не трогает.

set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/takebana}"
KEEP_DAYS="${KEEP_DAYS:-14}"
UPLOADS_DIR="${UPLOADS_DIR:-$APP_DIR/server/public/uploads}"
ENV_FILE="${ENV_FILE:-$APP_DIR/server/.env}"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_step=$'\033[36m'; c_off=$'\033[0m'
step() { printf '\n%s── %s %s\n' "$c_step" "$*" "$c_off"; }
ok()   { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '\n%sОстановлено:%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

# ── URI базы: из .env, иначе умолчание приложения ────────────────────────────
mongo_uri() {
  local uri=""
  [[ -f "$ENV_FILE" ]] && uri=$(grep -E '^MONGODB_URI=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true)
  echo "${uri:-mongodb://127.0.0.1:27017/webcabar}"
}

db_name() {
  # Имя базы — последний сегмент пути, без строки параметров.
  local uri; uri="$(mongo_uri)"
  local tail="${uri##*/}"
  echo "${tail%%\?*}"
}

need() { command -v "$1" >/dev/null || die "нет команды $1 (пакет mongodb-database-tools ставится вместе с mongodb-org)"; }

# ─────────────────────────────────────────────────────────────────────────────
do_backup() {
  step "Бэкап"
  need mongodump

  local stamp dest
  stamp=$(date +%Y-%m-%d_%H%M)
  dest="$BACKUP_ROOT/$stamp"
  mkdir -p "$dest"

  local uri; uri="$(mongo_uri)"
  printf '  база: %s\n' "$(echo "$uri" | sed -E 's#//[^@]*@#//***:***@#')"

  # --gzip: дампы сжимаются на лету, диск на KVM не резиновый.
  mongodump --uri="$uri" --gzip --archive="$dest/db.archive.gz" --quiet
  ok "база: $(du -h "$dest/db.archive.gz" | cut -f1)"

  if [[ -d "$UPLOADS_DIR" ]] && [[ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]]; then
    tar -czf "$dest/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
    ok "файлы: $(du -h "$dest/uploads.tar.gz" | cut -f1)"
  else
    warn "uploads пуст или отсутствует — пропущено"
  fi

  # Слепок окружения без секретов: по нему потом понятно, из какой версии бэкап.
  {
    echo "date: $(date +%Y-%m-%dT%H:%M:%S%z)"
    echo "commit: $(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo '?')"
    echo "node: $(node -v 2>/dev/null || echo '?')"
    echo "mongo: $(mongod --version 2>/dev/null | head -1 || echo '?')"
  } > "$dest/manifest.txt"

  ok "готово: $dest"
  rotate
}

rotate() {
  step "Ротация: держим ${KEEP_DAYS} дней"
  local removed=0
  while IFS= read -r -d '' old; do
    rm -rf "$old"; removed=$((removed + 1))
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -print0 2>/dev/null)
  [[ $removed -gt 0 ]] && ok "удалено старых: $removed" || ok "удалять нечего"
  printf '  занято всего: %s\n' "$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)"
}

# ─────────────────────────────────────────────────────────────────────────────
do_list() {
  step "Бэкапы в $BACKUP_ROOT"
  [[ -d "$BACKUP_ROOT" ]] || die "каталога нет"
  local found=0
  while IFS= read -r d; do
    found=1
    printf '  %-22s %-8s %s\n' "$(basename "$d")" "$(du -sh "$d" | cut -f1)" \
      "$(grep '^commit:' "$d/manifest.txt" 2>/dev/null | cut -c9-15)"
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)
  [[ $found -eq 1 ]] || warn "пусто"
}

latest_backup() {
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -1
}

# ─────────────────────────────────────────────────────────────────────────────
do_verify() {
  step "Проверка восстановления"
  need mongorestore
  need mongosh

  local src; src="${1:-$(latest_backup)}"
  [[ -n "$src" && -f "$src/db.archive.gz" ]] || die "не нашёл дамп для проверки: ${src:-нет бэкапов}"
  ok "проверяем $(basename "$src")"

  local uri live verify
  uri="$(mongo_uri)"
  live="$(db_name)"
  verify="${live}_verify"

  # Разворачиваем в отдельную базу: боевая не затрагивается ничем.
  mongorestore --uri="$uri" --gzip --archive="$src/db.archive.gz" \
    --nsFrom="${live}.*" --nsTo="${verify}.*" --drop --quiet

  local report
  report=$(mongosh "$uri" --quiet --eval "
    const live = db.getSiblingDB('${live}');
    const test = db.getSiblingDB('${verify}');
    const names = live.getCollectionNames().filter(n => !n.startsWith('system.')).sort();
    let bad = 0, lines = [];
    for (const n of names) {
      const a = live.getCollection(n).countDocuments();
      const b = test.getCollection(n).countDocuments();
      if (a !== b) bad++;
      lines.push((a === b ? '    ok   ' : '    ПЛОХО') + '  ' + n.padEnd(24) + ' боевая=' + a + ' из_бэкапа=' + b);
    }
    print(lines.join('\n'));
    print('VERDICT ' + (bad === 0 ? 'OK' : 'MISMATCH ' + bad));
  ")

  echo "$report" | grep -v '^VERDICT' || true

  # Убираем за собой в любом случае: лишняя база на диске никому не нужна.
  mongosh "$uri" --quiet --eval "db.getSiblingDB('${verify}').dropDatabase()" >/dev/null
  ok "временная база ${verify} удалена"

  if echo "$report" | grep -q '^VERDICT OK'; then
    printf '\n%sБэкап читается, число документов сходится.%s\n\n' "$c_ok" "$c_off"
  else
    # Расхождение не всегда авария: между дампом и проверкой в базу могли писать.
    warn "числа разошлись — это нормально, если после снятия дампа шла запись."
    warn "повторите на свежем бэкапе; если расходится снова — разбирайтесь с дампом."
    exit 1
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
do_restore() {
  local src="${1:-}"
  [[ -n "$src" ]] || die "укажите каталог: ops/backup.sh --restore /var/backups/takebana/2026-09-09_0415"
  [[ -f "$src/db.archive.gz" ]] || die "в $src нет db.archive.gz"

  step "ВОССТАНОВЛЕНИЕ НА БОЕВУЮ БАЗУ"
  local live; live="$(db_name)"
  printf '\n  %sЭто перезапишет базу %s данными из %s.%s\n' "$c_warn" "$live" "$(basename "$src")" "$c_off"
  printf '  Приложение лучше остановить: pm2 stop takebana\n\n'
  read -r -p "  Введите имя базы для подтверждения [${live}]: " confirm
  [[ "$confirm" == "$live" ]] || die "не подтверждено"

  mongorestore --uri="$(mongo_uri)" --gzip --archive="$src/db.archive.gz" --drop
  ok "база восстановлена"

  if [[ -f "$src/uploads.tar.gz" ]]; then
    tar -xzf "$src/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")"
    ok "файлы восстановлены"
  fi
  printf '\n  Запустить обратно: pm2 start takebana\n\n'
}

# ─────────────────────────────────────────────────────────────────────────────
install_cron() {
  step "Ежедневный бэкап"
  [[ $EUID -eq 0 ]] || die "нужен root"

  cat > /etc/cron.d/takebana-backup <<CRON
# Ежедневный бэкап Takebana. Поставлено ops/backup.sh --install-cron.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 4 * * *   root  APP_DIR=${APP_DIR} bash ${APP_DIR}/ops/backup.sh >> /var/log/takebana/backup.log 2>&1
# Раз в неделю — проверка, что последний бэкап действительно разворачивается.
40 4 * * 0   root  APP_DIR=${APP_DIR} bash ${APP_DIR}/ops/backup.sh --verify >> /var/log/takebana/backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/takebana-backup
  mkdir -p /var/log/takebana
  ok "04:15 ежедневно, проверка по воскресеньям в 04:40"
  ok "лог: /var/log/takebana/backup.log"
  warn "бэкапы лежат на том же диске. Отправку наружу (R2/S3) добавляем отдельно — пока это защита от ошибки, а не от потери сервера."
}

# ─────────────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_ROOT"
case "${1:-}" in
  ""|--now)       do_backup ;;
  --list)         do_list ;;
  --verify)       do_verify "${2:-}" ;;
  --restore)      do_restore "${2:-}" ;;
  --install-cron) install_cron ;;
  *)              die "неизвестный аргумент: $1" ;;
esac
