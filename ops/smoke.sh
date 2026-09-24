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

# moved "описание" СТАРЫЙ_ПУТЬ НОВЫЙ_ПУТЬ — постоянный редирект (301) именно туда.
# Одного кода мало: 301 на главную вместо документа тоже 301.
moved() {
  local title="$1" from="$2" to="$3"
  local got; got=$("${CURL[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "${BASE}${from}" 2>/dev/null || echo "000")
  local code="${got%% *}" target="${got#* }"
  if [[ "$code" == "301" && "$target" == *"$to" ]]; then
    pass "$title ${c_dim}→ 301 $to${c_off}"
  else
    fail "$title" "ждали 301 на $to, получили $got  (GET $from)"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
step "Доступность"

expect "главная (витрина) отвечает" "200"   GET /
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
# Документы с 17 сентября — /terms, /privacy, /cookies; прежние адреса
# ведут на них постоянным редиректом, чтобы не терять старые ссылки.
expect "условия использования"   "200"     GET /terms
expect "конфиденциальность"      "200"     GET /privacy
expect "файлы cookie"            "200"     GET /cookies
moved  "старый адрес условий"               /terms_of_service /terms
moved  "старый адрес соглашения"            /user_agreement /terms
moved  "старый адрес персональных данных"   /personal_data_processing /privacy
expect "о нас"                    "200"     GET /about
expect "раздел каталога"         "200"     GET /streaming/business   # гость смотрит без входа
expect "старый адрес популярного" "302"    GET /streaming           # ведёт на главную
expect "карта заведений"         "200"     GET /map
moved  "старый адрес карты"               /main /map
# SEO (docs/seo/): robots, карта сайта, подтверждение Вебмастера.
expect "robots.txt"               "200"     GET /robots.txt
expect "карта сайта"              "200"     GET /sitemap.xml
expect "файл Вебмастера"          "200"     GET /yandex_80b052bf060e4036.html
moved  "адрес страницы без хвостовой косой" /about/ /about
expect "страница поиска"         "200"     GET "/search?q=ab"
expect "авторы"                  "200"     GET /authors
expect "переписка без входа"     "302"     GET /chatsPage           # на вход с возвратом
expect "регистрация"             "200"     GET /register
expect "восстановление пароля"   "200"     GET /forgot-password
expect "проверка связи"          "200"     GET /check
expect "настройки без входа"     "302"     GET /settings
expect "загрузка без входа"      "302"     GET /upload
expect "студия без входа"        "302"     GET /studio
# Калькулятор расходов — только администратору (аудит 23.09, п. 1.9):
# гостя уводит на вход, вошедшего не-админа — «нет такой».
expect "/calc без входа"          "302"     GET /calc

# Несуществующее — страница сайта на языке интерфейса, а не голое
# «Cannot GET» от Express (аудит 23.09, п. 3.7).
NF=$("${CURL[@]}" -w '\n%{http_code}' -H 'Accept: text/html' "${BASE}/такого-точно-нет-$RANDOM" 2>/dev/null || echo "000")
if [[ "${NF##*$'\n'}" == "404" && "$NF" == *'missing.title'* ]]; then
  pass "404 — страницей сайта ${c_dim}→ 404${c_off}"
else
  fail "404 не страницей сайта" "код ${NF##*$'\n'}; нет missing.title — errors.js notFound не подключён?"
fi
expect "404 в API — JSON"        "404"     GET /api/такого-нет -H 'Accept: application/json'
CHECK_HEADERS=$("${CURL[@]}" -sI "${BASE}/check" 2>/dev/null || echo "")
grep -qi '^x-robots-tag:.*noindex' <<<"$CHECK_HEADERS" && pass "/check закрыт от поиска" || fail "/check без X-Robots-Tag noindex"

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
# Модуль карты: с типом application/octet-stream браузер его не исполняет,
# и карта падает «Failed to fetch dynamically imported module» (18.09.2026).
MJS_TYPE=$("${CURL[@]}" -sI "${BASE}/vendor/maplibre-gl-6.9.0/maplibre-gl.mjs" 2>/dev/null | grep -i '^content-type:' || echo "")
if grep -qi 'javascript' <<<"$MJS_TYPE"; then
  pass "модуль карты отдаётся как JavaScript"
else
  fail "модуль карты: ${MJS_TYPE:-нет ответа}" "в location /vendor/ у nginx нет types для mjs (ops/nginx/takebana.conf)"
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
expect "POST /start-stream"               "401"     POST /start-stream               -H 'Content-Type: application/json' -d '{}'
expect "POST /terminate-stream"           "401"     POST /terminate-stream           -H 'Content-Type: application/json' -d '{}'
expect "DELETE /recording/:id"            "401"     DELETE /recording/000000000000000000000000
expect "DELETE /profile/avatar"           "401"     DELETE /profile/avatar
expect "POST /chat/message"               "401"     POST /chat/message               -H 'Content-Type: application/json' -d '{}'
expect "GET /api/presence"                "401"     GET  /api/presence?ids=000000000000000000000000
# Переписка, звонки, контакты, загрузка — всё, что пишет от имени человека.
JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json')
OID=000000000000000000000000
expect "GET /api/badge"                   "401"     GET  /api/badge -H 'Accept: application/json'
expect "GET /api/dialogs"                 "401"     GET  "/api/dialogs?before=2026-01-01" -H 'Accept: application/json'
expect "GET /api/calls"                   "401"     GET  /api/calls -H 'Accept: application/json'
expect "POST /sendMessage"                "401"     POST /sendMessage "${JSON[@]}" -d "{\"recipientId\":\"$OID\",\"content\":\"x\"}"
expect "POST /start-conversation"         "401"     POST /start-conversation "${JSON[@]}" -d "{\"recipientId\":\"$OID\"}"
expect "POST /messages/delete"            "401"     POST /messages/delete "${JSON[@]}" -d "{\"ids\":[\"$OID\"]}"
expect "POST /conversations/delete"       "401"     POST /conversations/delete "${JSON[@]}" -d "{\"peerId\":\"$OID\"}"
expect "POST /messages/attach"            "401"     POST /messages/attach -H 'Accept: application/json'
expect "POST /api/contacts/add"           "401"     POST /api/contacts/add "${JSON[@]}" -d "{\"peerId\":\"$OID\"}"
expect "POST /upload/video"               "401"     POST /upload/video "${JSON[@]}" -d '{}'
expect "POST /api/reports"                "401"     POST /api/reports "${JSON[@]}" -d '{}'
expect "POST /api/push/subscribe"         "401"     POST /api/push/subscribe "${JSON[@]}" -d '{}'
expect "POST /api/age/confirm"            "401"     POST /api/age/confirm "${JSON[@]}"
expect "POST /api/moderation/streams/:id/stop" "401" POST "/api/moderation/streams/$OID/stop" "${JSON[@]}" -d '{}'
expect "POST /update-password"            "401"     POST /update-password "${JSON[@]}" -d '{"oldPassword":"x","newPassword":"xxxxxxxx"}'
# Эфир: новый ключ OBS и медленный режим чата (24.09.2026).
expect "POST /stream-key/rotate"          "401|302" POST /stream-key/rotate -H 'X-Requested-With: XMLHttpRequest'
expect "POST /chat/slow-mode"             "401|302" POST /chat/slow-mode -H 'X-Requested-With: XMLHttpRequest' "${JSON[@]}" -d "{\"streamId\":\"$OID\",\"seconds\":10}"
# Витрина, поиск людей и карта открыты гостю с 15 сентября 2026: смотреть
# и искать можно без входа. Поиск по почте при этом убран (profile.js).
expect "GET /streaming/:category/grid"    "200"     GET  /streaming/popular/grid
expect "GET /api/search"                  "200"     GET  "/api/search?q=ab"
# Маршрут открыт намеренно — эфир смотрят без входа. Проверяем не код ответа,
# а то, что в нём нет полей пользователя: populate отдавал сюда email,
# хеш пароля и streamKey любому желающему.
leak=$("${CURL[@]}" "${BASE}/api/chat/messages/new?streamId=000000000000000000000000" 2>/dev/null || echo "")
if [[ "$leak" == *'$2a$'* || "$leak" == *'$2b$'* || "$leak" == *'"email"'* || "$leak" == *'"password"'* ]]; then
  fail "чат отдаёт поля пользователя" "populate('userId') вернулся — утекают email и хеш пароля"
else
  pass "чат не отдаёт email и хеш пароля"
fi
# Оператор Mongo в строке запроса: ?streamId[$ne]= отдавал чаты всех эфиров
# (аудит 23.09, п. 1.1). Теперь строка запроса разбирается плоско.
expect "чат: ?streamId[\$ne]= не оператор" "404" GET "/api/chat/messages/new?streamId%5B%24ne%5D=$OID"
expect "чат несуществующего эфира"       "404" GET "/api/chat/messages/new?streamId=$OID"
# API панели (routes/admin): без входа — 401, у каждой вкладки своя проверка прав.
expect "GET /api/admin/summary"           "401"     GET  /api/admin/summary
expect "GET /api/admin/users"             "401"     GET  /api/admin/users
expect "GET /api/admin/audit"             "401"     GET  /api/admin/audit
expect "GET /api/admin/audit.csv"         "401"     GET  /api/admin/audit.csv
expect "GET /api/admin/system"            "401"     GET  /api/admin/system
expect "PUT /api/admin/venues/:id"        "401"     PUT  /api/admin/venues/000000000000000000000000
expect "POST /api/client-error"           "204"     POST /api/client-error           -H 'Content-Type: application/json' -d '{}'
# Свой предел тела 16 КБ (аудит 23.09, п. 3.10): раньше общий разбор JSON
# успевал раньше, и действовал его предел в 100 КБ.
BIG=$(head -c 20000 /dev/zero | tr '\0' 'x')
expect "client-error: 20 КБ отбиты"      "413"     POST /api/client-error -H 'Content-Type: application/json' -d "{\"message\":\"$BIG\"}"
# Права для MediaMTX — только ему, с петли: снаружи адреса нет (nginx — 404),
# напрямую в приложение — 401 (аудит 23.09, п. 3.9).
expect "POST /api/mtx/auth снаружи"      "401|404" POST /api/mtx/auth "${JSON[@]}" -d '{"path":"x","action":"publish"}'

step "Удалённые маршруты: их не должно быть"
expect "/stream"        "404" GET /stream
expect "/video"         "404" GET /video
# Выход — только POST из формы (аудит 23.09, п. 3.13): GET-ссылкой выйти
# человека заставляла любая картинка с этим адресом на чужой странице.
expect "GET /logout"    "404" GET /logout
expect "/test-callback" "404" GET /test-callback
# Конвейер под wrtc вырезан целиком вместе с папкой server/streams.
# Ответ 200 здесь означал бы, что старый код вернулся.
expect "/segments"      "404" GET /segments
# Прежняя админка (16 сентября 2026): список заведений по POST и смена пароля
# администратора — переехали в /api/admin или убраны.
expect "POST /admin/establishments" "404" POST /admin/establishments -H 'Content-Type: application/json' -d '{}'
expect "POST /admin/updatePassword" "404" POST /admin/updatePassword -H 'Content-Type: application/json' -d '{}'
expect "GET /api/moderation/reports" "404" GET /api/moderation/reports
expect "/clear-segments" "404" POST /clear-segments -H 'Content-Type: application/json' -d '{}'
expect "/streams/x"     "404" GET /streams/x
# Комнаты Daily закрыты токенами: ни адрес, ни настройки комнаты больше не
# отдаются отдельно, а статус камеры заведения ставит только venueLive.
expect "/api/room-info/:name"             "404" GET  /api/room-info/x
expect "/api/get-stream-room/:id"         "404" GET  /api/get-stream-room/000000000000000000000000
# 16 сентября 2026: пульт OBS и отметка входа на пульт стали одной студией
# (/studio), пауза — /set-inactive.
expect "/stream-obs/:id"                  "404" GET  /stream-obs/000000000000000000000000
expect "/stream/:id/enter"                "404" POST /stream/000000000000000000000000/enter -H 'Content-Type: application/json' -d '{"mode":"web"}'
expect "/api/pause-stream"                "404" POST /api/pause-stream -H 'Content-Type: application/json' -d '{}'
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
step "Запасная дорога к медиа"

# /m/ отдаёт файлы Bunny нашим адресом — для тех, у кого CDN заблокирован
# (server/utils/mediaFallback.js, блок /m/ в ops/nginx/takebana.conf).
# Проверяем на файле, который для проверок и положен: utils/netCheck.js
# кладёт /_check/probe.ts в обе зоны при старте.
#
# Проверка снаружи, поэтому она отвечает и на главный вопрос: доходит ли
# до Bunny сам сервер. Не доходит — запасная дорога бессмысленна, и знать
# об этом надо до того, как по ней пойдут люди.
PROBE_LEN=$("${CURL[@]}" -o /dev/null -w '%{http_code} %{size_download}' "${BASE}/m/_check/probe.ts" 2>/dev/null || echo "000 0")
PROBE_CODE="${PROBE_LEN%% *}"; PROBE_SIZE="${PROBE_LEN#* }"
if [[ "$PROBE_CODE" == "200" && "$PROBE_SIZE" == "98304" ]]; then
  pass "/m/ отдаёт файл Bunny ${c_dim}→ 98304 байта${c_off}"
elif [[ "$PROBE_CODE" == "200" ]]; then
  fail "/m/ отдал не тот объём" "ждали 98304 байта, получили $PROBE_SIZE"
elif [[ "$PROBE_CODE" == "404" ]]; then
  skip "/m/: пробного файла в зоне нет (хранилище Bunny не настроено?)"
else
  fail "/m/ не отдаёт файл Bunny" "код $PROBE_CODE — проверьте resolver и SNI в блоке /m/"
fi

# Перемотка по записи держится на Range: без него часовое видео можно было бы
# только смотреть с начала. proxy_buffering off это и обеспечивает.
RANGE_CODE=$(code GET "/m/_check/probe.ts" -H 'Range: bytes=0-99')
if [[ "$RANGE_CODE" == "206" ]]; then
  pass "/m/ пропускает Range ${c_dim}→ 206${c_off}"
elif [[ "$RANGE_CODE" == "404" ]]; then
  skip "/m/ Range: пробного файла нет"
else
  fail "/m/ не пропускает Range" "ждали 206, получили $RANGE_CODE — перемотка по записи не будет работать"
fi

# Выход за пределы зоны: /m/ — дорога к нашим файлам, а не открытый ретранслятор.
expect "/m/ наружу по ../"       "400|403|404" GET "/m/..%2F..%2Fetc%2Fpasswd"

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

        # Сессия — 30 дней и продлевается раз в сутки (аудит 23.09, п. 2.4).
        exp=$(grep -oi 'expires=[^;]*' <<<"$setcookie" | head -1 | cut -d= -f2-)
        exp_ts=$(date -d "$exp" +%s 2>/dev/null || date -jf '%a, %d %b %Y %T %Z' "$exp" +%s 2>/dev/null || echo 0)
        days=$(( (exp_ts - $(date +%s)) / 86400 ))
        (( days >= 29 )) && pass "cookie сессии на ${days} дн." || fail "cookie сессии на ${days} дн." "ждали 30: config/session.js"

        # Сессия должна действительно работать, а не просто выдаться.
        auth_code=$("${CURL[@]}" -b "$jar" -o /dev/null -w '%{http_code}' \
          -H 'X-Requested-With: XMLHttpRequest' "${BASE}/user-establishments" 2>/dev/null || echo 000)
        [[ "$auth_code" == "200" ]] && pass "с сессией /user-establishments отдаёт 200" \
          || fail "с сессией /user-establishments вернул $auth_code" "сессия не сохраняется — смотрите MongoDBStore"
        badge=$(code GET /api/badge -b "$jar" -H 'Accept: application/json')
        [[ "$badge" == "200" ]] && pass "с сессией /api/badge отдаёт 200" || fail "с сессией /api/badge вернул $badge"

        # Почта в другом регистре — тот же аккаунт (аудит 23.09, п. 3.1).
        upper=$(tr '[:lower:]' '[:upper:]' <<<"$SMOKE_EMAIL")
        jar2=$(mktemp)
        up_code=$(code POST /login -c "$jar2" -H 'Content-Type: application/json' \
          -d "{\"email\":\"${upper}\",\"password\":\"${SMOKE_PASSWORD}\"}")
        [[ "$up_code" == "200" ]] && pass "вход с почтой заглавными ${c_dim}→ 200${c_off}" \
          || fail "вход с почтой заглавными вернул $up_code" "почта не приведена к нижнему регистру: jobs/lowercaseEmails.js"

        # Выход — POST, сеанс после него закрыт.
        out_code=$(code POST /logout -b "$jar2")
        after=$(code GET /api/badge -b "$jar2" -H 'Accept: application/json')
        [[ "$out_code" == "303" && "$after" == "401" ]] && pass "POST /logout закрывает сеанс ${c_dim}→ $out_code, затем $after${c_off}" \
          || fail "выход не закрыл сеанс" "POST /logout → $out_code, затем /api/badge → $after"
        rm -f "$jar2"
      fi
    else
      fail "/login не принял пароль" "$(grep -i '^HTTP/' <<<"$resp" | head -1)"
    fi
    rm -f "$jar"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
if [[ $DO_RATELIMIT -eq 1 ]]; then
  step "Защита входа от подбора"
  # Три ошибки с адреса — дальше вход просит решить задачу (utils/loginGuard.js):
  # 428 и сама задача в ответе. Почты разные: паузу на пару это не трогает,
  # а счётчик адреса — да. Сам лимит 429 без решённых задач уже не достать.
  printf '  %sпосле этой проверки вход с текущего адреса сутки просит невидимую задачу%s\n' "$c_warn" "$c_off"

  asked=0
  for i in $(seq 1 6); do
    body=$("${CURL[@]}" -X POST "${BASE}/login" -H 'Content-Type: application/json' \
      -d '{"email":"smoke-'"$RANDOM"'@example.invalid","password":"неверный"}' -w '\n%{http_code}')
    [[ "${body##*$'\n'}" == "428" && "$body" == *'"task":"'* ]] && { asked=$i; break; }
  done
  if (( asked > 0 )); then
    pass "задача после $((asked - 1)) ошибок ${c_dim}→ 428${c_off}"
  else
    fail "за 6 попыток вход не попросил задачу" "utils/loginGuard.js; за nginx нужен trust proxy, иначе все адреса считаются одним"
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
