# Эксплуатация

Всё, что делается с сервером, — скриптами из этой папки, а не руками по памяти.
Каждый скрипт можно запускать повторно: они проверяют текущее состояние и
не переделывают уже сделанное.

| Файл | Что делает |
|---|---|
| `provision.sh` | Настройка чистого сервера: пакеты, пользователь, ssh, ufw, Node, pm2, MongoDB, nginx, ротация логов |
| `deploy.sh` | Деплой: код, зависимости, перезапуск pm2, проверка живости, автооткат |
| `backup.sh` | Бэкап базы и файлов, ротация, проверка восстановления |
| `smoke.sh` | Проверка живого сервера снаружи: 40 пунктов, каждый — из аудита |
| `browser-check.sh` | Открывает страницы живым Chrome и ловит то, чего не видит `smoke.sh` |
| `browser/` | Драйвер DevTools Protocol и обход страниц (без зависимостей, Node 22+) |
| `gen-secrets.sh` | Генерация `SESSION_SECRET` и `RTMP_PUBLISH_SECRET` |
| `ecosystem.config.js` | Конфиг pm2 |
| `nginx/` | Конфиг nginx и общие заголовки прокси |

## Порядок в день переезда

```bash
# 1. На сервере, от root
git clone <репозиторий> /srv/takebana
cd /srv/takebana
DOMAIN=takebana.com bash ops/provision.sh

# 2. Проверить вход в НОВОМ окне терминала, старое не закрывать
ssh takebana@<IP>

# 3. Окружение
sudo chown -R takebana:takebana /srv/takebana
sudo -u takebana -i
cd /srv/takebana
cp server/.env.example server/.env
bash ops/gen-secrets.sh --write server/.env    # SESSION_SECRET и RTMP_PUBLISH_SECRET
nano server/.env                               # START_SERVER=prod, ключи Daily и Google

# 4. Первый деплой
bash ops/deploy.sh

# 5. Первый админ — без него в /panel не попасть
cd server && npm run seed:admin -- --email you@example.com && cd ..

# 6. Бэкапы
sudo bash ops/backup.sh --install-cron
sudo bash ops/backup.sh && sudo bash ops/backup.sh --verify

# 7. Сертификат — ДО переключения DNS, проверка идёт через DNS Cloudflare
sudo CLOUDFLARE_API_TOKEN=<токен Zone:DNS:Edit> bash ops/provision.sh --tls

# 8. Проверка ДО переключения: домен принудительно резолвится в новый IP
bash ops/smoke.sh https://takebana.com <новый-IP> --login

# 9. Переключить A и AAAA в Cloudflare. mail и MX не трогать.

# 10. Проверка после переключения, теперь уже без подмены адреса
bash ops/smoke.sh https://takebana.com --login --rtmp
SMOKE_EMAIL=... SMOKE_PASSWORD=... bash ops/browser-check.sh https://takebana.com
```

Полный чек-лист с ответственными и проверками ведётся отдельно, вне репозитория.

## Два уровня проверки

`smoke.sh` смотрит на коды ответов: 401 там, где нужен вход, 404 у удалённых
маршрутов, заголовки, порты, сертификат. Быстро и без зависимостей.

Но страница может отдавать честный 200 и при этом не работать. Так и было со
страницей эфира: её JS падал на первой же строке, из-за чего не работали ни чат,
ни счётчик зрителей, — а `curl` видел 200 и был доволен. Для таких случаев есть
`browser-check.sh`: он открывает страницы настоящим Chrome в headless и ловит

- исключения в консоли,
- запросы, вернувшие 4xx/5xx (так нашёлся 404 на `/favicon.ico`),
- несостоявшиеся загрузки,
- блокирующие `alert()`, замораживающие страницу,
- битые картинки.

```bash
bash ops/browser-check.sh https://takebana.com
SMOKE_EMAIL=a@b.c SMOKE_PASSWORD=... bash ops/browser-check.sh http://127.0.0.1:3000
SHOTS=./shots bash ops/browser-check.sh http://127.0.0.1:3000   # ещё и скриншоты
```

Нужен установленный Chrome и Node 22+ — WebSocket в нём встроенный, поэтому
драйвер обходится без единой зависимости. Код возврата — число найденных проблем.

## Что стоит знать заранее

**Ubuntu 22.04, а не 24.04.** `mongoose@7` везёт драйвер `mongodb@5.9`, у которого
матрица поддержки заканчивается на MongoDB 7.0. Пакетов 7.0 под 24.04 (noble)
у MongoDB нет — там только 8.0. Работать будет, но вне поддерживаемого сочетания.
На 22.04 (jammy) ставится 7.0 и всё сходится. Локация и ОС выбираются при заказе
VPS, поэтому решение нужно до оплаты.

**RTMP-подпись нельзя проверить с самого сервера.** node-media-server снимает
проверку для соединений с localhost:

```js
// node_rtmp_session.js:1123
if (this.config.auth && this.config.auth.publish && !this.isLocal) { … }
// node_rtmp_session.js:143
this.isLocal = this.ip === '127.0.0.1' || this.ip === '::1' || this.ip == '::ffff:127.0.0.1';
```

Прогон `ffmpeg` с сервера пройдёт всегда — и с секретом, и без него. Проверять
только с другой машины, и обязательно ключом существующего эфира: на случайном
ключе публикацию отобьёт `rejectUnknownStreamKey`, а это второй рубеж, который
работает и при выключенной защите. `smoke.sh --rtmp` обе ловушки уже учитывает.

**Сертификат выпускается до переключения DNS.** При обычной проверке по HTTP это
невозможно: пока домен указывает на старый хостинг, Let's Encrypt стучится туда.
Получалось окно, в котором A-запись уже новая, а сертификата ещё нет, — и все,
кто пришёл по `https://`, видели ошибку. Поэтому `--tls` по умолчанию идёт через
проверку DNS Cloudflare (`--dns-cloudflare`): сертификат готов заранее, сайт
проверен по `https://` через `smoke.sh` с подменой адреса, и переключение
становится мгновенным. Нужен токен Cloudflare с правом `Zone:DNS:Edit` на зону.
Без токена скрипт откатывается на проверку по HTTP и требует, чтобы домен уже
указывал сюда.

**certbot не редактирует конфиг nginx.** Он запускается как `certonly`, а конфиг
собирается из `nginx/takebana.conf` — иначе следующий запуск `provision.sh`
затирал бы правки certbot шаблоном, и nginx оставался бы без `ssl_certificate`.

**Первый запуск `provision.sh` закрывает вход по паролю.** Пока не проверите
`ssh takebana@<IP>` в отдельном окне, текущую сессию не закрывайте.

**Бэкапы лежат на том же диске.** Это защита от ошибки, а не от потери сервера.
Отправку наружу (R2 или S3) добавляем отдельным шагом.

## Если что-то не так

```bash
pm2 status                       # что с процессом
pm2 logs takebana --lines 100    # логи приложения
bash ops/deploy.sh --rollback    # вернуть предыдущий коммит
sudo nginx -t                    # конфиг nginx
sudo journalctl -u mongod -n 50  # база
curl -s localhost:3000/healthz   # приложение живо? база подключена?
```

**Вход не работает вообще, ошибок нет.** Первый подозреваемый — `X-Forwarded-Proto`.
Приложение пишет об этом в лог при первом же таком запросе:
`[proxy] Запрос пришёл без признака HTTPS`. Лечится строкой из
`nginx/proxy_params_takebana`. `smoke.sh --login` ловит это снаружи: вход
отвечает 200, а cookie сессии не приходит.
