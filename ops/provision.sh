#!/usr/bin/env bash
#
# Первичная настройка сервера Takebana. Ubuntu LTS, запускать от root на чистой машине:
#
#   ssh root@IP
#   git clone <репозиторий> /srv/takebana && cd /srv/takebana
#   DOMAIN=takebana.com bash ops/provision.sh
#
# Скрипт идемпотентный: повторный запуск ничего не ломает и не переделывает
# уже сделанное. Если что-то упало на середине — чините причину и запускайте снова.
#
# TLS выпускается отдельно, ПОСЛЕ переключения DNS на этот сервер:
#   bash ops/provision.sh --tls
# Раньше нельзя: Let's Encrypt проверяет домен по HTTP и постучится на старый сервер.
#
# Что делает:
#   пакеты · пользователь деплоя и ключи · sshd без пароля · ufw (22/80/443/1935)
#   swap · Node 24 · pm2 с автозапуском · MongoDB только на 127.0.0.1 · каталоги
#   nginx из ops/nginx · ротация логов приложения
#
# Чего НЕ делает: не ставит .env, не запускает приложение, не трогает DNS.
# Это ops/deploy.sh и чек-лист docs/MIGRATION.md.

set -Eeuo pipefail

# ── Параметры ────────────────────────────────────────────────────────────────
DOMAIN="${DOMAIN:-takebana.com}"
DEPLOY_USER="${DEPLOY_USER:-takebana}"
APP_DIR="${APP_DIR:-/srv/takebana}"
NODE_MAJOR="${NODE_MAJOR:-24}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
MONGO_PING_TIMEOUT="${MONGO_PING_TIMEOUT:-60}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Вывод ────────────────────────────────────────────────────────────────────
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_step=$'\033[36m'; c_off=$'\033[0m'
step() { printf '\n%s── %s %s\n' "$c_step" "$*" "$c_off"; }
ok()   { printf '  %s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
skip() { printf '  %s·%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '\n%sОстановлено:%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

trap 'die "ошибка на строке $LINENO. Исправьте причину и запустите скрипт заново."' ERR

# ── Только TLS ───────────────────────────────────────────────────────────────
TLS_ONLY=0
[[ "${1:-}" == "--tls" ]] && TLS_ONLY=1

# ─────────────────────────────────────────────────────────────────────────────
# Проверки до первого изменения
# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  step "Проверки"

  [[ $EUID -eq 0 ]] || die "нужен root: sudo bash ops/provision.sh"

  [[ -r /etc/os-release ]] || die "не Ubuntu: нет /etc/os-release"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "рассчитано на Ubuntu, здесь ${PRETTY_NAME:-неизвестно}"
  CODENAME="${VERSION_CODENAME:-}"
  ok "${PRETTY_NAME} (${CODENAME})"

  # MongoDB: версия под кодовое имя. Ставим ту, что поддерживает драйвер mongoose 7
  # (mongodb 5.9 — официально до сервера 7.0 включительно). На 24.04 пакетов 7.0 нет,
  # поэтому там придётся взять 8.0 — драйвер с ней работает, но это вне матрицы
  # поддержки. Предпочтительный вариант для этого проекта — Ubuntu 22.04.
  case "$CODENAME" in
    jammy) MONGO_VERSION="${MONGO_VERSION:-7.0}" ;;
    noble) MONGO_VERSION="${MONGO_VERSION:-8.0}"
           warn "Ubuntu 24.04: доступна только MongoDB 8.0, а mongoose 7 везёт драйвер 5.9 (матрица — до 7.0)."
           warn "Работать будет, но поддерживаемое сочетание — Ubuntu 22.04 + MongoDB 7.0." ;;
    *)     die "кодовое имя '${CODENAME}' не поддержано скриптом. Ожидались jammy (22.04) или noble (24.04)." ;;
  esac
  ok "MongoDB ${MONGO_VERSION}"

  [[ "$(dpkg --print-architecture)" == "amd64" ]] || warn "архитектура $(dpkg --print-architecture), репозитории ниже рассчитаны на amd64"

  [[ -f "$SCRIPT_DIR/nginx/takebana.conf" ]] || die "не вижу ops/nginx/takebana.conf рядом со скриптом ($SCRIPT_DIR)"

  ok "домен ${DOMAIN} · пользователь ${DEPLOY_USER} · каталог ${APP_DIR}"
}

# ─────────────────────────────────────────────────────────────────────────────
packages() {
  step "Системные пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    ca-certificates curl gnupg git ufw nginx logrotate rsync \
    build-essential python3 \
    ffmpeg \
    certbot python3-certbot-nginx >/dev/null
  # build-essential и python3 — на случай, если bcrypt не найдёт готовую сборку
  # под эту версию Node и полезет собирать нативный модуль через node-gyp.
  # ffmpeg — для проверки RTMP-публикации (ops/smoke.sh --rtmp) и будущего транскода.
  ok "пакеты установлены"
}

# ─────────────────────────────────────────────────────────────────────────────
deploy_user() {
  step "Пользователь деплоя: ${DEPLOY_USER}"

  if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
    skip "уже существует"
  else
    adduser --disabled-password --gecos "Takebana app" "$DEPLOY_USER" >/dev/null
    ok "создан"
  fi

  local home ssh_dir
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  ssh_dir="$home/.ssh"

  # Ключи копируем от root: тем же ключом, которым вы сейчас вошли.
  if [[ -s /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ssh_dir"
    if [[ -s "$ssh_dir/authorized_keys" ]] && cmp -s /root/.ssh/authorized_keys "$ssh_dir/authorized_keys"; then
      skip "ключи уже на месте"
    else
      # Дописываем, а не перетираем: у пользователя могли быть свои ключи.
      touch "$ssh_dir/authorized_keys"
      cat /root/.ssh/authorized_keys "$ssh_dir/authorized_keys" | sort -u > "$ssh_dir/authorized_keys.new"
      mv "$ssh_dir/authorized_keys.new" "$ssh_dir/authorized_keys"
      chmod 600 "$ssh_dir/authorized_keys"
      chown -R "$DEPLOY_USER:$DEPLOY_USER" "$ssh_dir"
      ok "ключи скопированы от root"
    fi
  else
    warn "у root нет authorized_keys — вход по ключу для ${DEPLOY_USER} не настроен"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
ssh_hardening() {
  step "sshd: вход только по ключу"

  local home keys
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  keys="$home/.ssh/authorized_keys"

  # Страховка от запирания снаружи: выключаем пароли, только если ключ реально лежит
  # и у root он тоже есть. Иначе следующая же попытка входа окажется последней.
  if [[ ! -s "$keys" ]]; then
    warn "пропущено: нет ${keys}. Сначала положите ключ, потом запустите скрипт снова."
    return 0
  fi

  install -d -m 755 /etc/ssh/sshd_config.d
  local drop=/etc/ssh/sshd_config.d/60-takebana.conf
  local want
  want=$(cat <<'SSHD'
# Поставлено ops/provision.sh. Вход по паролю закрыт — только ключи.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
)
  if [[ -f "$drop" ]] && [[ "$(cat "$drop")" == "$want" ]]; then
    skip "уже настроено"
    return 0
  fi

  printf '%s\n' "$want" > "$drop"
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    ok "пароли выключены, root — только по ключу"
    warn "НЕ ЗАКРЫВАЙТЕ текущую сессию, пока не проверите вход в новом окне: ssh ${DEPLOY_USER}@<IP>"
  else
    rm -f "$drop"
    die "sshd -t не принял конфиг, изменения откачены"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
firewall() {
  step "Файрвол"

  ufw allow 22/tcp   >/dev/null   # ssh
  ufw allow 80/tcp   >/dev/null   # http, он же проверка Let's Encrypt
  ufw allow 443/tcp  >/dev/null   # https
  ufw allow 1935/tcp >/dev/null   # RTMP: без него OBS не подключится

  if ufw status | grep -q '^Status: active'; then
    skip "уже включён"
  else
    ufw --force enable >/dev/null
    ok "включён"
  fi
  ufw status numbered | sed 's/^/    /'
}

# ─────────────────────────────────────────────────────────────────────────────
swap() {
  step "Swap"
  if swapon --show | grep -q .; then
    skip "уже есть: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
    return 0
  fi
  # Не ради постоянной работы в свопе, а чтобы npm ci и возможная сборка bcrypt
  # не упирались в OOM на машине с малой памятью.
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "${SWAP_SIZE} подключено"
}

# ─────────────────────────────────────────────────────────────────────────────
nodejs() {
  step "Node ${NODE_MAJOR}"

  if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
    skip "уже стоит $(node -v)"
  else
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    chmod 644 /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
    ok "$(node -v), npm $(npm -v)"
  fi

  # Версия должна совпадать с .nvmrc, иначе локально и на проде разный рантайм.
  if [[ -f "$SCRIPT_DIR/../.nvmrc" ]]; then
    local want; want="$(tr -dc '0-9.' < "$SCRIPT_DIR/../.nvmrc")"
    [[ "$(node -v)" == v${want}* ]] || warn ".nvmrc просит ${want}, на сервере $(node -v)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
pm2_setup() {
  step "pm2"

  if command -v pm2 >/dev/null 2>&1; then
    skip "уже стоит $(pm2 -v)"
  else
    npm install -g pm2 >/dev/null
    ok "$(pm2 -v)"
  fi

  # Автозапуск от имени пользователя деплоя: без этого приложение не поднимется
  # после перезагрузки сервера, а узнаётся это в самый неудачный момент.
  if systemctl list-unit-files | grep -q "^pm2-${DEPLOY_USER}\.service"; then
    skip "автозапуск pm2-${DEPLOY_USER} настроен"
  else
    local home; home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
    env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "$home" >/dev/null
    ok "автозапуск включён (pm2 save сделает ops/deploy.sh)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
mongodb() {
  step "MongoDB ${MONGO_VERSION}"

  if command -v mongod >/dev/null 2>&1; then
    skip "уже стоит $(mongod --version | head -1)"
  else
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_VERSION}.asc" \
      | gpg --dearmor --yes -o /etc/apt/keyrings/mongodb-server.gpg
    chmod 644 /etc/apt/keyrings/mongodb-server.gpg
    echo "deb [ arch=amd64,arm64 signed-by=/etc/apt/keyrings/mongodb-server.gpg ] https://repo.mongodb.org/apt/ubuntu ${CODENAME}/mongodb-org/${MONGO_VERSION} multiverse" \
      > /etc/apt/sources.list.d/mongodb-org.list
    apt-get update -qq
    apt-get install -y -qq mongodb-org >/dev/null
    ok "установлена"
  fi

  # Наружу порт 27017 торчать не должен ни при каких условиях: аутентификации в базе
  # нет, приложение ходит с localhost. Файрвол его и так не пускает, но bindIp —
  # вторая линия и не зависит от того, включён ли ufw.
  if grep -qE '^\s*bindIp:\s*127\.0\.0\.1\s*$' /etc/mongod.conf; then
    skip "слушает только 127.0.0.1"
  else
    cp -n /etc/mongod.conf /etc/mongod.conf.orig
    sed -i -E 's/^(\s*bindIp:).*/\1 127.0.0.1/' /etc/mongod.conf
    ok "bindIp приведён к 127.0.0.1"
  fi

  systemctl enable --now mongod >/dev/null 2>&1 || systemctl restart mongod
  systemctl is-active --quiet mongod && ok "служба работает" || die "mongod не запустился: journalctl -u mongod -n 50"

  # Проверка не для галочки: пакет ставится и на процессорах без AVX,
  # а падает уже при старте.
  #
  # Ждём, а не стучимся сразу: юнит mongod — Type=simple, systemd считает службу
  # активной с первой секунды, а WiredTiger в это время ещё поднимает файлы и
  # порт не слушает. Без ожидания первый запуск на чистой машине падает здесь.
  if command -v mongosh >/dev/null 2>&1; then
    local deadline=$((SECONDS + MONGO_PING_TIMEOUT))
    while (( SECONDS < deadline )); do
      if mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then
        ok "ping проходит"
        return 0
      fi
      sleep 2
    done
    die "mongod активен, но за ${MONGO_PING_TIMEOUT}с не ответил на ping: journalctl -u mongod -n 50"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
directories() {
  step "Каталоги"

  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 /var/log/takebana
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 /var/backups/takebana

  # Пользовательский контент и сегменты эфира: их пишет приложение, а не git.
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR/server/public/uploads"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$APP_DIR/server/media"

  # nginx отдаёт статику с диска сам, значит должен проходить внутрь по пути.
  chmod o+x /srv "$APP_DIR" 2>/dev/null || true

  ok "${APP_DIR}, /var/log/takebana, /var/backups/takebana"
}

# ─────────────────────────────────────────────────────────────────────────────
nginx_setup() {
  step "nginx"

  install -m 644 "$SCRIPT_DIR/nginx/proxy_params_takebana" /etc/nginx/proxy_params_takebana
  install -d -m 755 /var/www/html   # сюда certbot кладёт файл проверки
  ok "proxy_params_takebana"

  local target=/etc/nginx/sites-available/takebana
  local tmp; tmp="$(mktemp)"

  # Домен и путь подставляются здесь, чтобы в репозитории лежал один шаблон.
  sed -e "s/takebana\.com/${DOMAIN}/g" \
      -e "s#/srv/takebana#${APP_DIR}#g" \
      "$SCRIPT_DIR/nginx/takebana.conf" > "$tmp"

  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    # Сертификат есть: блок 80 отдаёт редирект, блок 443 работает.
    awk '
      /#HTTP_ONLY_BEGIN/ { skip = 1; next }
      /#HTTP_ONLY_END/   { skip = 0; next }
      skip { next }
      { sub(/^[[:space:]]*#HTTPS_REDIRECT: /, "    "); print }
    ' "$tmp" > "$tmp.out"
    ok "вариант с TLS: 80 редиректит на 443"
  else
    # Сертификата нет: блок 443 не пройдёт проверку, оставляем только 80.
    awk 'BEGIN { n = 0 }
      /^server \{/ { n++ }
      n < 2 { sub(/^[[:space:]]*#HTTPS_REDIRECT: .*$/, ""); print }
    ' "$tmp" > "$tmp.out"
    warn "сертификата нет: только HTTP. Выпустить — bash ops/provision.sh --tls"
  fi
  # Метки в готовый конфиг не попадают.
  grep -v '#HTTP_ONLY_\|#HTTPS_REDIRECT' "$tmp.out" > "$tmp.final"
  rm -f "$tmp" "$tmp.out"

  if [[ -f "$target" ]] && cmp -s "$target" "$tmp.final"; then
    rm -f "$tmp.final"
    skip "конфиг не изменился"
  else
    install -m 644 "$tmp.final" "$target"
    rm -f "$tmp.final"
    ok "конфиг обновлён"
  fi

  ln -sfn "$target" /etc/nginx/sites-enabled/takebana
  # Дефолтный сайт перехватывает запросы без Host — на проде он только мешает.
  rm -f /etc/nginx/sites-enabled/default

  nginx -t 2>&1 | sed 's/^/    /'
  systemctl reload nginx
  ok "проверен и перезагружен"
}

# ─────────────────────────────────────────────────────────────────────────────
# Параметры TLS, на которые ссылается шаблон nginx.
#
# certbot кладёт их сам, но только в режиме --nginx, а мы им не пользуемся:
# он переписывает конфиг, а конфиг у нас свой, из ops/nginx. Раньше файл
# скачивался из репозитория certbot — ссылка умерла, когда там переставили
# каталоги, и провижининг падал уже после выпуска сертификата. Четыре
# директивы дешевле держать у себя, чем зависеть от чужого дерева файлов.
# Значения — Mozilla intermediate, те же, что кладёт certbot.
tls_params() {
  if [[ ! -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    cat > /etc/letsencrypt/options-ssl-nginx.conf <<'NGINX_TLS'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;

ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305";
NGINX_TLS
    ok "options-ssl-nginx.conf записан"
  fi

  # Нужен из-за DHE-шифров в списке выше. Генерация занимает секунды и делается
  # один раз: файл переживает перевыпуск сертификата.
  if [[ ! -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048 2>/dev/null
    ok "ssl-dhparams.pem сгенерирован"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
tls() {
  step "TLS: сертификат Let's Encrypt"

  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    skip "сертификат уже есть, перевыпуск не нужен"
    certbot certificates 2>/dev/null | grep -E "Certificate Name|Expiry" | sed 's/^/    /'
    tls_params
    nginx_setup
    return 0
  fi

  local args=(certonly --agree-tos --non-interactive -d "$DOMAIN" -d "www.$DOMAIN")
  if [[ -n "$LETSENCRYPT_EMAIL" ]]; then
    args+=(-m "$LETSENCRYPT_EMAIL")
  else
    args+=(--register-unsafely-without-email)
    warn "LETSENCRYPT_EMAIL не задан — писем об истечении сертификата не будет"
  fi

  # ── Проверка через DNS: работает ДО переключения домена на этот сервер ──────
  #
  # Так снимается дыра в порядке переезда. При обычной проверке по HTTP
  # сертификат нельзя выпустить, пока домен указывает на старый хостинг, —
  # значит, между сменой A-записи и выпуском сертификата сайт какое-то время
  # доступен только по HTTP, а пришедшие по https видят ошибку. С проверкой
  # через DNS сертификат готов заранее, и переключение становится мгновенным.
  #
  # Нужен токен Cloudflare с правом Zone:DNS:Edit на эту зону:
  #   CLOUDFLARE_API_TOKEN=xxx bash ops/provision.sh --tls
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" || -f /root/.secrets/cloudflare.ini ]]; then
    if ! dpkg -s python3-certbot-dns-cloudflare >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-certbot-dns-cloudflare >/dev/null
    fi
    local creds=/root/.secrets/cloudflare.ini
    if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
      install -d -m 700 /root/.secrets
      printf 'dns_cloudflare_api_token = %s
' "$CLOUDFLARE_API_TOKEN" > "$creds"
      chmod 600 "$creds"
    fi
    ok "проверка через DNS Cloudflare — домен может ещё указывать на старый сервер"
    # Пауза: записи должны разойтись по DNS до того, как Let's Encrypt их спросит.
    certbot "${args[@]}" --dns-cloudflare --dns-cloudflare-credentials "$creds" \
      --dns-cloudflare-propagation-seconds 30
  else
    # ── Запасной путь: проверка по HTTP ────────────────────────────────────────
    # Требует, чтобы домен уже указывал сюда, иначе Let's Encrypt постучится на
    # старый сервер, получит 404 и сожжёт одну из пяти попыток в неделю.
    local server_ip domain_ip
    server_ip="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
    domain_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"

    [[ -n "$domain_ip" ]] || die "${DOMAIN} не резолвится. Либо DNS, либо задайте CLOUDFLARE_API_TOKEN для проверки через DNS."
    if [[ -n "$server_ip" && "$server_ip" != "$domain_ip" ]]; then
      die "${DOMAIN} указывает на ${domain_ip}, а этот сервер ${server_ip}.
    Выпуск отменён: у Let's Encrypt 5 попыток в неделю.
    Чтобы выпустить сертификат заранее, не дожидаясь переключения DNS:
      CLOUDFLARE_API_TOKEN=<токен Zone:DNS:Edit> bash ops/provision.sh --tls"
    fi
    ok "${DOMAIN} → ${domain_ip}, это мы"
    certbot "${args[@]}" --webroot -w /var/www/html
  fi

  ok "сертификат выпущен"

  tls_params

  systemctl is-enabled --quiet certbot.timer && ok "автопродление: certbot.timer активен" \
    || warn "certbot.timer выключен — сертификат не продлится сам"

  # Перезагрузка nginx после продления: сам certbot об этом не знает.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  ok "после продления nginx перезагружается сам"

  # Теперь конфиг пересобирается в варианте с TLS.
  nginx_setup
}

# ─────────────────────────────────────────────────────────────────────────────
logrotate_setup() {
  step "Ротация логов приложения"

  # pm2 пишет в /var/log/takebana и сам ничего не крутит: за месяц эфиров
  # out.log съедает диск, а «на сервере кончилось место» выглядит как что угодно.
  cat > /etc/logrotate.d/takebana <<ROTATE
/var/log/takebana/*.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su ${DEPLOY_USER} ${DEPLOY_USER}
}
ROTATE
  ok "14 дней, ежедневно"
}

# ─────────────────────────────────────────────────────────────────────────────
summary() {
  step "Готово"
  cat <<SUMMARY

  Сервер настроен. Дальше по docs/MIGRATION.md, фаза 4:

    1. Проверить вход в НОВОМ окне, не закрывая это:
         ssh ${DEPLOY_USER}@$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<IP>')

    2. Код и .env:
         sudo chown -R ${DEPLOY_USER}:${DEPLOY_USER} ${APP_DIR}
         sudo -u ${DEPLOY_USER} -i
         cd ${APP_DIR} && cp server/.env.example server/.env && nano server/.env

       Обязательно: START_SERVER=prod · NODE_ENV=production · SESSION_SECRET
       Ключи генерирует ops/gen-secrets.sh.

    3. Первый деплой:
         bash ops/deploy.sh

    4. Первый админ (без него в /panel не попасть):
         cd server && npm run seed:admin -- --email you@example.com

    5. Бэкапы:
         sudo bash ops/backup.sh --install-cron

    6. После переключения DNS — сертификат:
         sudo bash ops/provision.sh --tls

    7. Проверка снаружи:
         bash ops/smoke.sh https://${DOMAIN}

SUMMARY
}

# ─────────────────────────────────────────────────────────────────────────────
main() {
  preflight
  if [[ $TLS_ONLY -eq 1 ]]; then
    tls
    printf '\n%sСертификат на месте.%s Проверьте: bash ops/smoke.sh https://%s\n\n' "$c_ok" "$c_off" "$DOMAIN"
    exit 0
  fi
  packages
  deploy_user
  ssh_hardening
  firewall
  swap
  nodejs
  pm2_setup
  mongodb
  directories
  nginx_setup
  logrotate_setup
  summary
}

main "$@"
