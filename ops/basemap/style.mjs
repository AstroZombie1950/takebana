// Стиль карты заведений: слои Protomaps Basemap в цветах Takebana.
//
// Результат — server/public/map/style.ru.json и style.en.json (тёмная тема),
// style.light.ru.json и style.light.en.json (светлая), они лежат в git.
// Адресов плиток, шрифтов и значков в стиле нет: их подставляет
// server/public/tk-map.js от адреса страницы, поэтому один стиль годится
// и для локального запуска, и для боя.
//
// Генератор в зависимости проекта не входит — он нужен только здесь:
//   npm i --prefix /tmp/pmb @protomaps/basemaps@5.7.2
//   node ops/basemap/style.mjs /tmp/pmb
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const prefix = process.argv[2];
if (!prefix) {
  console.error('Укажите каталог, куда поставлен @protomaps/basemaps (см. шапку файла)');
  process.exit(1);
}
const { layers, namedFlavor } = createRequire(path.join(path.resolve(prefix), 'package.json'))('@protomaps/basemaps');

// Палитра сайта — server/public/css/tk.css. Подложка тёплая и почти чёрная,
// чтобы маркеры заведений и красный акцент читались поверх неё.
const INK = '#0A0A0A';
const dark = {
  ...namedFlavor('dark'),
  background: INK,
  earth: '#131211',
  water: '#0C1013',
  park_a: '#141813', park_b: '#151A14',
  wood_a: '#141713', wood_b: '#141713',
  scrub_a: '#151614', scrub_b: '#151614',
  buildings: '#1B1917',
  pedestrian: '#171514',

  minor_service: '#24211F', minor_a: '#2A2724', minor_b: '#24211F',
  other: '#24211F', link: '#2E2A27', major: '#35312D', highway: '#45403B',
  bridges_other: '#24211F', bridges_minor: '#2A2724', bridges_link: '#2E2A27',
  bridges_major: '#35312D', bridges_highway: '#45403B',
  minor_service_casing: INK, minor_casing: INK, link_casing: INK,
  major_casing_early: INK, major_casing_late: INK,
  highway_casing_early: INK, highway_casing_late: INK,
  railway: '#2E2A27',
  boundaries: '#5A4A42',

  city_label: '#C9C2B7', city_label_halo: INK,
  subplace_label: '#8A827C', subplace_label_halo: INK,
  state_label: '#5E5650', state_label_halo: INK,
  country_label: '#8A827C',
  roads_label_major: '#8A827C', roads_label_major_halo: INK,
  roads_label_minor: '#6E6660', roads_label_minor_halo: INK,
  address_label: '#6E6660', address_label_halo: INK,
  ocean_label: '#4E5A60',
};

// Светлая тема: бумага сайта, дороги белее неё, подписи — серые тёмной
// темы наоборот. Маркеры заведений тёмные в обеих темах (css/tk-map.css),
// поэтому зелень и вода приглушены — не спорят с ними.
const PAPER = '#F5F1EA';
const light = {
  ...namedFlavor('light'),
  background: PAPER,
  earth: '#F0EBE2',
  water: '#D3DCDF',
  park_a: '#E2E7D8', park_b: '#D9E2CD',
  wood_a: '#E0E6D6', wood_b: '#D6E0CA',
  scrub_a: '#E5E8DA', scrub_b: '#DCE3D0',
  hospital: '#EEE3DE', industrial: '#E8E4DD', school: '#EEE6DA',
  sand: '#EFE8D9', beach: '#F0E8D3', pedestrian: '#EDE7DD',
  buildings: '#E4DCD0',

  minor_service: '#FBF8F3', minor_a: '#FDFBF7', minor_b: '#FFFFFF',
  other: '#FBF8F3', link: '#FFFFFF', major: '#FFFFFF', highway: '#FBEBD8',
  bridges_other: '#FBF8F3', bridges_minor: '#FFFFFF', bridges_link: '#FFFFFF',
  bridges_major: '#FFFFFF', bridges_highway: '#FBEBD8',
  minor_service_casing: '#E2D9CD', minor_casing: '#E2D9CD', link_casing: '#DDD3C6',
  major_casing_early: '#DDD3C6', major_casing_late: '#DDD3C6',
  highway_casing_early: '#E0CDB5', highway_casing_late: '#E0CDB5',
  railway: '#C9BFB3',
  boundaries: '#B8A99D',

  city_label: '#3A3733', city_label_halo: PAPER,
  subplace_label: '#6B635C', subplace_label_halo: PAPER,
  state_label: '#9A918A', state_label_halo: PAPER,
  country_label: '#6B635C',
  roads_label_major: '#6B635C', roads_label_major_halo: '#FFFFFF',
  roads_label_minor: '#8A827C', roads_label_minor_halo: '#FFFFFF',
  address_label: '#8A827C', address_label_halo: '#FFFFFF',
  ocean_label: '#7F8E96',
  landcover: {
    grassland: '#E4E9D9', barren: '#F2EADB', urban_area: '#EDE7DD', farmland: '#E8EBDB',
    glacier: '#FAF8F4', scrub: '#E7EADC', forest: '#DCE4D2',
  },
};

const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'server', 'public', 'map');
fs.mkdirSync(out, { recursive: true });

for (const [suffix, flavor] of [['', dark], ['.light', light]]) for (const lang of ['ru', 'en']) {
  const style = {
    version: 8,
    name: 'Takebana',
    sources: { protomaps: { type: 'vector', attribution: ATTRIBUTION } },
    // Встроенные точки интереса убраны: на этой карте точки — наши заведения.
    layers: layers('protomaps', flavor, { lang }).filter((l) => l.id !== 'pois'),
  };
  const file = path.join(out, `style${suffix}.${lang}.json`);
  fs.writeFileSync(file, JSON.stringify(style));
  console.log(`${path.relative(process.cwd(), file)}: ${style.layers.length} слоёв, ${(fs.statSync(file).size / 1024).toFixed(0)} КБ`);
}
