#!/usr/bin/env bash
#
# Генерация секретов приложения.
#
#   bash ops/gen-secrets.sh                    напечатать строки для .env
#   bash ops/gen-secrets.sh --write server/.env  вписать в файл (существующие не трогает)
#   bash ops/gen-secrets.sh --write server/.env --force   перезаписать существующие
#
# Генерируются только те секреты, которые мы создаём сами. Ключи Daily, Google
# и прочих сервисов выпускаются в их панелях — здесь их нет и быть не может.
#
# Смена SESSION_SECRET разлогинивает всех, смена RTMP_PUBLISH_SECRET обнуляет
# выданные вещателям ключи OBS. Оба — разовая операция при заведении сервера.

set -Eeuo pipefail

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_off=$'\033[0m'

gen() { openssl rand -hex 32; }

TARGET=""; FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --write) TARGET="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) printf '%sнеизвестный аргумент: %s%s\n' "$c_err" "$1" "$c_off" >&2; exit 2 ;;
  esac
done

SESSION_SECRET="$(gen)"
RTMP_PUBLISH_SECRET="$(gen)"

if [[ -z "$TARGET" ]]; then
  cat <<OUT
# Сгенерировано ops/gen-secrets.sh $(date +%Y-%m-%d)
SESSION_SECRET=${SESSION_SECRET}
RTMP_PUBLISH_SECRET=${RTMP_PUBLISH_SECRET}
OUT
  printf '\n%sЭто секреты. В репозиторий они не идут ни в каком виде.%s\n' "$c_warn" "$c_off" >&2
  exit 0
fi

[[ -f "$TARGET" ]] || { printf '%sнет файла %s%s\n' "$c_err" "$TARGET" "$c_off" >&2; exit 1; }

set_key() {
  local key="$1" value="$2"
  local current
  current=$(grep -E "^${key}=" "$TARGET" | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true)

  if [[ -n "$current" && $FORCE -eq 0 ]]; then
    printf '  %s·%s %s уже задан, не трогаю (--force чтобы перезаписать)\n' "$c_warn" "$c_off" "$key"
    return
  fi

  if grep -qE "^${key}=" "$TARGET"; then
    # Значение подставляем через awk: в hex-строке нет спецсимволов, но sed с
    # произвольным значением — известный способ испортить файл.
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$TARGET" > "$TARGET.tmp"
    mv "$TARGET.tmp" "$TARGET"
  else
    printf '%s=%s\n' "$key" "$value" >> "$TARGET"
  fi
  printf '  %s✓%s %s записан\n' "$c_ok" "$c_off" "$key"
}

cp "$TARGET" "$TARGET.bak.$(date +%s)"
set_key SESSION_SECRET "$SESSION_SECRET"
set_key RTMP_PUBLISH_SECRET "$RTMP_PUBLISH_SECRET"
chmod 600 "$TARGET"
printf '\n%sГотово.%s Копия прежнего файла рядом, с меткой времени. Права 600.\n' "$c_ok" "$c_off"
printf 'После смены RTMP_PUBLISH_SECRET вещателям надо заново скопировать ключ со страницы эфира.\n'
