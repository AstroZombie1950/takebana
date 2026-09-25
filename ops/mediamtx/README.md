# Приёмник камер заведений: MediaMTX

**С 25.09.2026 (вариант А) MediaMTX — только приёмник.** Заведение вещает
сюда по WHIP; зрителям MediaMTX не отдаёт ничего. Поток с петли по RTSP
забирает наш ffmpeg, кладёт знак в кадр и режет HLS 480p/15 кадров
в `server/media/live` — зрители смотрят его через Bunny, как эфиры
(`server/utils/venueCam.js`). Камера вещает, только пока её смотрят:
страница владельца открыта весь день, видео уходит по просьбе сервера.

Почему так. Раздавать зрителям с нашего сервера — тратить наши 16 ТБ
в месяц, а сверх них Hostinger режет весь сервер до 10 Мбит/с. Мост через
Daily (как веб-эфир) стоит $1,14 в час на камеру — ~$8 200 в месяц на
20 камер по 12 часов. Наш приёмник + Bunny Volume — около $40 в месяц
за раздачу, а наш исходящий — одна копия на камеру, которую смотрят
(~0,36 ГБ в час), сколько бы ни было зрителей. Процессор — ~0,11 ядра
на такую камеру (замер 25.09).

Прежний расчёт (23.09, WHEP зрителям с нашего сервера) — в истории git
этого файла и в `docs/STATUS.md`.

## Установка

```bash
# Версия — та же, что проверена локально 23.09.2026.
V=1.21.1
cd /tmp
curl -fsSL -o mediamtx.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/download/v${V}/mediamtx_v${V}_linux_amd64.tar.gz
tar xzf mediamtx.tar.gz mediamtx
sudo install -o root -g root -m 0755 mediamtx /usr/local/bin/mediamtx

sudo mkdir -p /etc/mediamtx
sudo cp /srv/takebana/ops/mediamtx/mediamtx.yml /etc/mediamtx/mediamtx.yml
```

В `/etc/mediamtx/mediamtx.yml` дописать публичный адрес сервера — браузеру
нужно знать, куда слать медиа:

```yaml
webrtcAdditionalHosts: ['<внешний IP сервера>']
```

## Запуск

`/etc/systemd/system/mediamtx.service`:

```ini
[Unit]
Description=MediaMTX (камеры заведений)
After=network.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
Restart=always
RestartSec=3
User=takebana
Group=takebana
# Приёмник не должен съедать машину у приложения: камеры важны,
# но сайт важнее.
Nice=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
sudo systemctl status mediamtx --no-pager
```

## Порты

| Куда | Что | Открывать наружу |
|---|---|---|
| 8889/tcp | сигнализация WHIP | нет, только петля — наружу её выводит nginx на `/mtx/` |
| 8189/udp | звук и видео от заведения (ICE) | **да** |
| 8554/tcp | RTSP — поток для нашего ffmpeg | нет, только петля |
| 9997/tcp | API: какие камеры вещают, закрыть вещателя | нет, только петля |

Начало и конец публикации MediaMTX сообщает приложению сам
(`runOnAvailable` / `runOnUnavailable` в конфиге) — через `curl`
на `127.0.0.1:3000`; `curl` на сервере есть.

```bash
sudo ufw allow 8189/udp comment 'mediamtx ICE'
```

## Приложение

В `server/.env`:

```
MTX_PUBLIC=https://takebana.com/mtx
MTX_API=http://127.0.0.1:9997
```

Обе переменные вместе включают свой приём. Убрать их — и камеры сейчас же
возвращаются на комнаты Daily: движок выбирается на каждый запрос
(`server/routes/venueLive.js`), перезапуск приложения не нужен, идущие
показы просто закончатся. Это и есть откат.

## Проверка

```bash
# Из server/, на Node 24:
set -a && . ./.env && set +a && node ../temp/probe-venue-hls-0925.mjs
```

Зонд заводит своё заведение, включает камеру в одном браузере, открывает
страницу вторым: камера начинает вещать только при зрителе, зритель
получает HLS со знаком, уход зрителя гасит вещание, выключение — всё.

Руками:

```bash
curl -s http://127.0.0.1:9997/v3/paths/list | jq
journalctl -u mediamtx -n 50 --no-pager
```
