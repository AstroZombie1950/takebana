#!/usr/bin/env bash
# Подложка карты заведений: плитки Protomaps на регион, шрифты подписей и
# значки. Всё ложится в server/media/basemap — в git не идёт, deploy.sh её
# не трогает, nginx отдаёт как /basemap/ (ops/nginx/takebana.conf).
#
#   bash ops/basemap/fetch.sh                             # Европа до масштаба 14, ~24 ГБ
#   BBOX=18.8,41.8,23.1,46.2 bash ops/basemap/fetch.sh    # Сербия, ~350 МБ — для разработки
#
# На сервере — из сессии takebana. Плитки вырезаются из свежей сборки
# планеты на build.protomaps.com диапазонными запросами: качается только
# регион, а не 138 ГБ планеты целиком. Новый файл пишется рядом со старым и
# подменяет его одним mv — карта во время обновления не ломается, но на это
# время на диске нужно место под оба файла. Обновлять раз в несколько
# месяцев: данные OpenStreetMap меняются медленно.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/server/media/basemap"
BBOX="${BBOX:--25,34,45,72}"   # Европа: запад, юг, восток, север
MAXZOOM="${MAXZOOM:-14}"       # дальше MapLibre растягивает сам; 15 — вдвое больше, ~48 ГБ
PMTILES_VERSION=1.31.2
ASSETS=https://raw.githubusercontent.com/protomaps/basemaps-assets/main

mkdir -p "$DEST"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ── Шрифты подписей и значки ──
# Noto Sans тремя начертаниями — ровно те, что называет стиль
# (server/public/map/style.*.json, собирается ops/basemap/style.mjs).
cfg="$work/assets.cfg"
for font in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
  mkdir -p "$DEST/fonts/$font"
  for ((s = 0; s < 65536; s += 256)); do
    printf 'url = "%s/fonts/%s/%d-%d.pbf"\noutput = "%s/fonts/%s/%d-%d.pbf"\n' \
      "$ASSETS" "${font// /%20}" "$s" $((s + 255)) "$DEST" "$font" "$s" $((s + 255))
  done
done > "$cfg"
mkdir -p "$DEST/sprites"
for f in dark.json dark.png dark@2x.json dark@2x.png; do
  printf 'url = "%s/sprites/v4/%s"\noutput = "%s/sprites/%s"\n' "$ASSETS" "$f" "$DEST" "$f"
done >> "$cfg"
curl -fsS -Z --parallel-max 32 -K "$cfg"
echo "Шрифты и значки: $(find "$DEST/fonts" -name '*.pbf' | wc -l | tr -d ' ') глифов"

# ── Утилита pmtiles ──
case "$(uname -s)_$(uname -m)" in
  Linux_x86_64)               asset="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
  Linux_aarch64|Linux_arm64)  asset="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
  Darwin_arm64)               asset="go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip" ;;
  Darwin_x86_64)              asset="go-pmtiles-${PMTILES_VERSION}_Darwin_x86_64.zip" ;;
  *) echo "Нет сборки pmtiles для $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL -o "$work/$asset" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/$asset"
case "$asset" in
  *.zip) unzip -q -o "$work/$asset" pmtiles -d "$work" ;;
  *)     tar -xzf "$work/$asset" -C "$work" pmtiles ;;
esac

# ── Плитки ──
build=$(curl -fsS https://build-metadata.protomaps.dev/builds.json \
  | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).at(-1).key))')
echo "Сборка $build, регион $BBOX, масштаб до $MAXZOOM"
"$work/pmtiles" extract "https://build.protomaps.com/$build" "$DEST/basemap.pmtiles.part" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"
mv -f "$DEST/basemap.pmtiles.part" "$DEST/basemap.pmtiles"

du -sh "$DEST/basemap.pmtiles" "$DEST/fonts" "$DEST/sprites"
