#!/usr/bin/env bash
#
# Проверка живого сервера снаружи. Не «страница открылась», а список того,
# что уже ломалось в этом проекте и должно быть закрыто.
#
#   bash ops/smoke.sh https://takebana.com
#   bash ops/smoke.sh https://takebana.com 91.2.3.4    проверить НОВЫЙ сервер по домену
#                                                       до переключения DNS (curl --resolve)
#   bash ops/smoke.sh http://91.2.3.4:3000              приложение напрямую, мимо nginx
#
# Ключи:
#   --login       вход настоящим пользователем: главная проверка X-Forwarded-Proto
#   --ratelimit   сжигает лимит попыток входа на 15 минут с этого адреса
#   --rtmp        публикация в RTMP чужим ключом должна отбиваться (нужен ffmpeg)
#
# Переменные для --login:  SMOKE_EMAIL, SMOKE_PASSWORD
#
# Код возврата 0 — всё зелёное. Иначе число провалов.

set -uo pipefail

BASE="${1:-}"
[[ -n "$BASE" ]] || { echo "Использование: bash ops/smoke.sh https://takebana.com [IP] [--login] [--ratelimit] [--rtmp]"; exit 2; }
shift

RESOLVE_IP=""
DO_LOGIN=0; DO_RATELIMIT=0; DO_RTMP=0
for arg in "$@"; do
  case "$arg" in
    --login)     DO_LOGIN=1 ;;
    --ratelimit) DO_RATELIMIT=1 ;;
    --rtmp)      DO_RTMP=1 ;;
    -*)          echo "неизвестный ключ: $arg" >&2; exit 2 ;;
    *)           RESOLVE_IP="$arg" ;;
  esac
done

BASE="${BASE%/}"
SCHEME="${BASE%%://*}"
HOSTPORT="${BASE#*://}"; HOSTPORT="${HOSTPORT%%/*}"
HOST="${HOSTPORT%%:*}"

# --resolve: обращаемся по домену, а попадаем на указанный IP. Так новый сервер
# проверяется целиком, вместе с TLS и Host-заголовком, ещё до смены DNS.
CURL=(curl -sS --max-time 15)
if [[ -n "$RESOLVE_IP" ]]; then
  CURL+=(--resolve "${HOST}:443:${RESOLVE_IP}" --resolve "${HOST}:80:${RESOLVE_IP}")
  echo "  (${HOST} принудительно резолвится в ${RESOLVE_IP})"
fi
# Самоподписанный сертификат на стейджинге — не повод падать.
[[ "${SMOKE_INSECURE:-0}" == "1" ]] && CURL+=(-k)

# timeout есть в Ubuntu, в macOS его нет (там gtimeout из coreutils, и то не всегда).
# Без него просто выполняем команду как есть: ffmpeg ниже и сам ограничен -t.
if   command -v timeout  >/dev/null 2>&1; then LIMIT=(timeout)
elif command -v gtimeout >/dev/null 2>&1; then LIMIT=(gtimeout)
else LIMIT=(); fi
limited() { local sec="$1"; shift; if [[ ${#LIMIT[@]} -gt 0 ]]; then "${LIMIT[@]}" "$sec" "$@"; else "$@"; fi; }

c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_warn=$'\033[33m'; c_step=$'\033[36m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
PASS=0; FAIL=0; SKIP=0

step() { printf '\n%s── %s %s\n' "$c_step" "$*" "$c_off"; }
pass() { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  %s✗%s %s\n' "$c_bad" "$c_off" "$1"; [[ -n "${2:-}" ]] && printf '      %s%s%s\n' "$c_dim" "$2" "$c_off"; }
skip() { SKIP=$((SKIP+1)); printf '  %s·%s %s\n' "$c_warn" "$c_off" "$1"; }

# code МЕТОД ПУТЬ [доп. аргументы curl] → печатает HTTP-код
code() {
  local method="$1" path="$2"; shift 2
  "${CURL[@]}" -o /dev/null -w '%{http_code}' -X "$method" "$@" "${BASE}${path}" 2>/dev/null || echo "000"
}

# expect "описание" ОЖИДАЕМОЕ МЕТОД ПУТЬ [доп. аргументы curl]
# Ожидаемое — регулярка: "401" или "401|403".
expect() {
  local title="$1" want="$2" method="$3" path="$4"; shift 4
  local got; got=$(code "$method" "$path" "$@")
  if [[ "$got" =~ ^($want)$ ]]; then
    pass "$title ${c_dim}→ $got${c_off}"
  else
    fail "$title" "ждали $want, получили $got  ($method $path)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
step "Доступность"

expect "главная отвечает"        "200"     GET /
expect "/healthz отвечает"       "200"     GET /healthz

HEALTH=$("${CURL[@]}" "${BASE}/healthz" 2>/dev/null || echo "")
if [[ "$HEALTH" == *'"db":"connected"'* ]]; then
  pass "база подключена ${c_dim}${HEALTH}${c_off}"
elif [[ -n "$HEALTH" ]]; then
  fail "база не подключена" "$HEALTH"
else
  fail "/healthz не вернул тело" "старая версия приложения? маршрут добавлен вместе с этими скриптами"
fi

expect "страница входа"          "200"     GET /login
expect "условия использования"   "200"     GET /terms_of_service
expect "каталог эфиров"          "200|302" GET /streaming   # анониму отдаёт редирект — это штатно
expect "несуществующий путь 404" "404"     GET /такого-точно-нет-$RANDOM

# ═════════════════════════════════════════════════════════════════════════════
step "TLS и прокси"

if [[ "$SCHEME" == "https" ]]; then
  # Редирект с 80: certbot ставит его сам, но проверить дешевле, чем узнать потом.
  http_code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "http://${HOST}/" 2>/dev/null || echo 000)
  if [[ "$http_code" =~ ^30 ]]; then
    pass "HTTP редиректит на HTTPS ${c_dim}→ $http_code${c_off}"
  else
    fail "HTTP не редиректит на HTTPS" "код $http_code"
  fi

  # Срок сертификата: 30 дней запаса — сигнал, что автопродление не работает.
  target="${RESOLVE_IP:-$HOST}"
  end=$(echo | openssl s_client -servername "$HOST" -connect "${target}:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n "$end" ]]; then
    end_ts=$(date -d "$end" +%s 2>/dev/null || date -jf '%b %d %T %Y %Z' "$end" +%s 2>/dev/null || echo 0)
    if [[ "$end_ts" != "0" ]]; then
      days=$(( (end_ts - $(date +%s)) / 86400 ))
      if   (( days > 30 )); then pass "сертификат: ещё ${days} дней"
      elif (( days > 0 ));  then fail "сертификат истекает через ${days} дней" "проверьте systemctl status certbot.timer"
      else                       fail "сертификат просрочен"; fi
    else
      skip "срок сертификата не разобрал: $end"
    fi
  else
    fail "сертификат не отдаётся" "openssl не смог соединиться с ${target}:443"
  fi
else
  skip "TLS не проверяем: адрес по http"
fi

HEADERS=$("${CURL[@]}" -sI "${BASE}/login" 2>/dev/null || echo "")
for h in "x-content-type-options" "x-frame-options" "x-dns-prefetch-control"; do
  if grep -qi "^${h}:" <<<"$HEADERS"; then pass "заголовок ${h}"; else fail "нет заголовка ${h}" "helmet не применился"; fi
done
if grep -qi '^x-powered-by:' <<<"$HEADERS"; then
  fail "торчит X-Powered-By" "helmet должен его убирать"
else
  pass "X-Powered-By скрыт"
fi
if [[ "$SCHEME" == "https" ]]; then
  grep -qi '^strict-transport-security:' <<<"$HEADERS" \
    && pass "HSTS" || fail "нет HSTS" "helmet ставит его только когда видит HTTPS — снова X-Forwarded-Proto"
fi

# ═════════════════════════════════════════════════════════════════════════════
step "Закрытые маршруты: аноним не должен проходить"

# Каждая строка — воспроизведённая дыра из аудита 4 сентября.
expect "POST /api/create-room"            "401"     POST /api/create-room            -H 'Content-Type: application/json' -d '{}'
expect "POST /api/get-token"              "401"     POST /api/get-token              -H 'Content-Type: application/json' -d '{}'
expect "POST /api/venues/:id/live"        "401"     POST /api/venues/000000000000000000000000/live
expect "POST /api/venues/:id/watch"       "401"     POST /api/venues/000000000000000000000000/watch
expect "POST /api/calls/create"           "401"     POST /api/calls/create           -H 'Content-Type: application/json' -d '{}'
expect "PUT /updateEstablishment/:id"     "401"     PUT  /updateEstablishment/000000000000000000000000
expect "POST /register-establishment"     "401"     POST /register-establishment     -H 'Content-Type: application/json' -d '{}'
expect "GET /user-establishments"         "401|302" GET  /user-establishments        -H 'X-Requested-With: XMLHttpRequest'
expect "POST /profile/gallery"            "401"     POST /profile/gallery
expect "DELETE /profile/gallery/:name"    "401"     DELETE /profile/gallery/x.jpg
expect "POST /upload-thumbnail"           "401"     POST /upload-thumbnail
expect "POST /set-active"                 "401"     POST /set-active                 -H 'Content-Type: application/json' -d '{}'
expect "POST /set-inactive"               "401"     POST /set-inactive               -H 'Content-Type: application/json' -d '{}'
expect "POST /stream/:id/enter"           "401"     POST /stream/000000000000000000000000/enter -H 'Content-Type: application/json' -d '{"mode":"web"}'
expect "POST /chat/message"               "401"     POST /chat/message               -H 'Content-Type: application/json' -d '{}'
expect "GET /search-users"                "401|302" GET  /search-users               -H 'X-Requested-With: XMLHttpRequest'
expect "GET /api/presence"                "401"     GET  /api/presence?ids=000000000000000000000000
expect "GET /streaming/:category/grid"    "401"     GET  /streaming/popular/grid
# Маршрут открыт намеренно — эфир смотрят без входа. Проверяем не код ответа,
# а то, что в нём нет полей пользователя: populate отдавал сюда email,
# хеш пароля и streamKey любому желающему.
leak=$("${CURL[@]}" "${BASE}/api/chat/messages/new?streamId=000000000000000000000000" 2>/dev/null || echo "")
if [[ "$leak" == *'$2a$'* || "$leak" == *'$2b$'* || "$leak" == *'"email"'* || "$leak" == *'"password"'* ]]; then
  fail "чат отдаёт поля пользователя" "populate('userId') вернулся — утекают email и хеш пароля"
else
  pass "чат не отдаёт email и хеш пароля"
fi
expect "POST /admin/establishments"       "403"     POST /admin/establishments       -H 'Content-Type: application/json' -d '{}'
expect "PUT /admin/updEstablishment/:id"  "403"     PUT  /admin/updEstablishment/000000000000000000000000
expect "POST /admin/updatePassword"       "403"     POST /admin/updatePassword       -H 'Content-Type: application/json' -d '{}'

step "Удалённые маршруты: их не должно быть"
expect "/stream"        "404" GET /stream
expect "/video"         "404" GET /video
expect "/test-callback" "404" GET /test-callback
# Конвейер под wrtc вырезан целиком вместе с папкой server/streams.
# Ответ 200 здесь означал бы, что старый код вернулся.
expect "/segments"      "404" GET /segments
expect "/clear-segments" "404" POST /clear-segments -H 'Content-Type: application/json' -d '{}'
expect "/streams/x"     "404" GET /streams/x
# Комнаты Daily закрыты токенами: ни адрес, ни настройки комнаты больше не
# отдаются отдельно, а статус камеры заведения ставит только venueLive.
expect "/api/room-info/:name"             "404" GET  /api/room-info/x
expect "/api/get-stream-room/:id"         "404" GET  /api/get-stream-room/000000000000000000000000
expect "/updateEstablishmentOnlineStatus" "404" POST /updateEstablishmentOnlineStatus -H 'Content-Type: application/json' -d '{}'

step "Обход каталогов"
# Проверяются пути, которые берут имя файла от клиента и живы сейчас: раздача
# статики и HLS с диска. Ответ 200 здесь — авария.
# Маршруты /segment/:key/:file и /hls/* проверялись раньше здесь же; они удалены
# вместе со всем прежним конвейером, и их отсутствие проверяется шагом выше.
expect "статика ../../app.js"   "400|403|404" GET "/uploads/..%2F..%2Fapp.js"
expect "картинки ../../.env"    "400|403|404" GET "/img/..%2F..%2F.env"
expect "медиа ../../app.js"     "400|403|404" GET "/live/..%2F..%2Fapp.js"
expect "медиа ../server.log"    "400|403|404" GET "/live/..%2Fserver.log"

# ═════════════════════════════════════════════════════════════════════════════
step "Socket.IO"

# transports: ['websocket'] — если nginx не пробрасывает Upgrade, соединения нет
# вообще: ни чата, ни счётчика зрителей, ни звонков. Снаружи это видно только так.
# Соединение после 101 не закрывается, поэтому curl штатно выходит по таймауту.
# Код ответа он к этому моменту уже напечатал — берём первые три цифры,
# а ненулевой код возврата игнорируем.
#
# --http1.1 обязателен: сайт отдаёт HTTP/2, а в нём механизма Upgrade нет вовсе
# (websocket там — Extended CONNECT из RFC 8441, curl его не умеет). Без этого
# ключа curl уходит в h2 по ALPN и получает 400 от Socket.IO — ложный провал.
# Браузеры ведут себя так же: websocket всегда идёт отдельным HTTP/1.1.
ws_raw=$("${CURL[@]}" -o /dev/null -m 5 -w '%{http_code}' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "${BASE}/socket.io/?EIO=4&transport=websocket" 2>/dev/null)
ws_code="${ws_raw:0:3}"
ws_code="${ws_code:-000}"
if [[ "$ws_code" == "101" ]]; then
  pass "рукопожатие websocket ${c_dim}→ 101${c_off}"
else
  fail "websocket не поднялся" "код $ws_code, ждали 101. nginx: location /socket.io/ с Upgrade/Connection"
fi

# ═════════════════════════════════════════════════════════════════════════════
step "Порты"

# nc есть и в Ubuntu, и в macOS; timeout — только в Ubuntu, а запускать
# проверку почти всегда будут со своей машины.
port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 3 "$1" "$2" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1
  fi
}
probe="${RESOLVE_IP:-$HOST}"

if port_open "$probe" 1935; then
  pass "1935 открыт (RTMP, без него не подключится OBS)"
else
  fail "1935 закрыт" "ufw allow 1935/tcp и проверьте, что node-media-server поднялся"
fi

# Смысл проверки только при обращении к удалённой машине: на localhost порт
# базы открыт по определению, и красная строка здесь ничего не значила бы.
case "$probe" in
  localhost|127.0.0.1|::1|0.0.0.0)
    skip "27017: проверяется только с другой машины" ;;
  *)
    if port_open "$probe" 27017; then
      fail "27017 доступен снаружи" "база без аутентификации торчит в интернет. bindIp 127.0.0.1 и ufw"
    else
      pass "27017 снаружи закрыт"
    fi ;;
esac

# ═════════════════════════════════════════════════════════════════════════════
if [[ $DO_LOGIN -eq 1 ]]; then
  step "Вход настоящим пользователем"

  if [[ -z "${SMOKE_EMAIL:-}" || -z "${SMOKE_PASSWORD:-}" ]]; then
    skip "нет SMOKE_EMAIL / SMOKE_PASSWORD"
  else
    jar=$(mktemp)
    resp=$("${CURL[@]}" -i -c "$jar" -X POST "${BASE}/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}" 2>/dev/null || echo "")

    if grep -qi '^HTTP/.* 200' <<<"$resp"; then
      pass "/login отвечает 200"

      # Главная проверка всего переезда.
      # В режиме prod cookie уходит с флагом Secure, а express-session не отдаёт
      # такую cookie, пока не увидит X-Forwarded-Proto от nginx. Забыли заголовок —
      # /login отвечает 200, Set-Cookie не приходит, и войти не может никто,
      # причём в логах не появляется ни одной ошибки. Здесь это видно сразу.
      setcookie=$(grep -i '^set-cookie:.*connect\.sid' <<<"$resp" || true)
      if [[ -z "$setcookie" ]]; then
        fail "вход не выдал cookie сессии" "ровно тот случай: nginx не шлёт X-Forwarded-Proto \$scheme. Войти не может никто."
      else
        pass "cookie сессии выдана"
        grep -qi 'httponly' <<<"$setcookie" && pass "cookie HttpOnly" || fail "cookie без HttpOnly"
        if [[ "$SCHEME" == "https" ]]; then
          grep -qi 'secure'  <<<"$setcookie" && pass "cookie Secure" || fail "cookie без Secure" "START_SERVER должен быть prod"
        fi
        grep -qi 'samesite' <<<"$setcookie" && pass "cookie SameSite" || fail "cookie без SameSite"

        # Сессия должна действительно работать, а не просто выдаться.
        auth_code=$("${CURL[@]}" -b "$jar" -o /dev/null -w '%{http_code}' \
          -H 'X-Requested-With: XMLHttpRequest' "${BASE}/user-establishments" 2>/dev/null || echo 000)
        [[ "$auth_code" == "200" ]] && pass "с сессией /user-establishments отдаёт 200" \
          || fail "с сессией /user-establishments вернул $auth_code" "сессия не сохраняется — смотрите MongoDBStore"
      fi
    else
      fail "/login не принял пароль" "$(grep -i '^HTTP/' <<<"$resp" | head -1)"
    fi
    rm -f "$jar"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
if [[ $DO_RATELIMIT -eq 1 ]]; then
  step "Лимит попыток входа"
  printf '  %sпосле этой проверки вход с текущего адреса заблокирован на 15 минут%s\n' "$c_warn" "$c_off"

  limited=0
  for i in $(seq 1 14); do
    rc=$(code POST /login -H 'Content-Type: application/json' \
      -d '{"email":"smoke-'"$RANDOM"'@example.invalid","password":"неверный"}')
    [[ "$rc" == "429" ]] && { limited=$i; break; }
  done
  if (( limited > 0 )); then
    pass "429 после ${limited} попыток"
  else
    fail "за 14 попыток лимит не сработал" "RATE_LIMIT_LOGIN в .env; за nginx нужен trust proxy, иначе все адреса считаются одним"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
if [[ $DO_RTMP -eq 1 ]]; then
  step "RTMP: публикация без подписи"

  # node-media-server снимает проверку подписи для соединений с самой машины:
  #   node_rtmp_session.js:1123  if (this.config.auth.publish && !this.isLocal)
  #   node_rtmp_session.js:143   isLocal = ip === '127.0.0.1' || '::1' || '::ffff:127.0.0.1'
  # Значит, прогон этой проверки с сервера или против localhost всегда зелёный,
  # даже когда защиты нет вообще. Запускать только с другой машины.
  case "$probe" in
    localhost|127.0.0.1|::1|0.0.0.0) rtmp_local=1 ;;
    *) rtmp_local=0 ;;
  esac

  if [[ $rtmp_local -eq 1 ]]; then
    skip "RTMP не проверяем с localhost: node-media-server не проверяет подпись у локальных соединений"
    printf '      %sЗапустите со своей машины: bash ops/smoke.sh https://takebana.com --rtmp%s\n' "$c_dim" "$c_off"
  elif ! command -v ffmpeg >/dev/null; then
    skip "ffmpeg не установлен"
  else
    # Ключ трансляции виден каждому зрителю в исходнике страницы: по нему
    # собирается адрес воспроизведения. Без подписи вещать в чужой эфир мог
    # любой, кто этот эфир открыл. Проверяем, что теперь нельзя.
    #
    # Ключ нужен НАСТОЯЩИЙ, из существующего эфира. На случайном ключе
    # публикацию отобьёт rejectUnknownStreamKey в mediaServer.js — второй рубеж,
    # который работает и с пустым RTMP_PUBLISH_SECRET. То есть проверка на
    # случайном ключе была бы зелёной даже при выключенной защите.
    if [[ -z "${SMOKE_STREAM_KEY:-}" ]]; then
      skip "нет SMOKE_STREAM_KEY — проверка подписи невозможна"
      printf '      %sВозьмите ключ существующего эфира (без хвоста ?sign=) со страницы вещателя.%s\n' "$c_dim" "$c_off"
      printf '      %sНа случайном ключе сработал бы второй рубеж, и результат ничего бы не доказывал.%s\n' "$c_dim" "$c_off"
    else
      out=$(limited 20 ffmpeg -hide_banner -loglevel error \
        -f lavfi -i testsrc=size=320x240:rate=10 -t 3 \
        -c:v libx264 -preset ultrafast -f flv \
        "rtmp://${probe}:1935/live/${SMOKE_STREAM_KEY}" 2>&1 || true)

      if [[ -z "$out" ]]; then
        fail "публикация чужим ключом БЕЗ подписи прошла" \
             "RTMP_PUBLISH_SECRET пуст или не применён: вещать в чужой эфир может любой зритель"
      else
        pass "публикация без подписи отбита"
        printf '      %s%s%s\n' "$c_dim" "$(head -1 <<<"$out")" "$c_off"
        printf '      %sВ логе приложения должно быть [rtmp publish] Unauthorized, а не «ключ не найден».%s\n' "$c_dim" "$c_off"
      fi
    fi
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
printf '\n%s────────────────────────────────────────%s\n' "$c_step" "$c_off"
printf '  прошло: %s%d%s   провалов: %s%d%s   пропущено: %d\n' \
  "$c_ok" "$PASS" "$c_off" "$( ((FAIL>0)) && echo "$c_bad" || echo "$c_ok")" "$FAIL" "$c_off" "$SKIP"

if (( FAIL > 0 )); then
  printf '\n%sНе переключайте DNS, пока красное не станет зелёным.%s\n\n' "$c_bad" "$c_off"
  exit "$FAIL"
fi
printf '\n%sВсё зелёное.%s\n\n' "$c_ok" "$c_off"
