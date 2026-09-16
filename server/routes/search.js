// Поиск: быстрые результаты для выпадашки в шапке (/api/search) и полная
// страница с вкладками (/search). Что и как ищется — utils/search.js.
//
// Открыт гостю, как и всё, что можно просто посмотреть.

const express = require('express');
const router = express.Router();
const { asyncify } = require('../middleware/asyncRouter');
asyncify(router); // ошибки async-обработчиков уходят в next(), а не вешают запрос
const { commonDataMiddleware } = require('./streaming/shared');
const search = require('../utils/search');

// Вкладки страницы. all — по нескольку из каждого вида, остальные — один вид
// целиком. Порядок здесь — порядок вкладок на экране.
const TABS = ['all', 'people', 'streams', 'recordings', 'venues'];

// Сколько показываем: в выпадашке — три строки на вид, на вкладке «Всё» —
// по пять, на отдельной вкладке — сорок. Постраничной подгрузки нет: она
// понадобится, когда выдача перестанет умещаться, а не раньше.
const QUICK_LIMIT = 3;
const ALL_LIMIT = 5;
const TAB_LIMIT = 40;

// Выпадашка: одна строка запроса — один запрос сюда, результат группами.
// type сужает до одного вида (пересылке сообщения нужны только люди),
// limit поднимает потолок строк — до десяти, не больше.
router.get('/api/search', async (req, res) => {
  const type = search.TYPES.includes(req.query.type) ? [req.query.type] : search.TYPES;
  const asked = Number(req.query.limit);
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 10) : QUICK_LIMIT;
  res.json(await search.search(req.query.q, { limit, types: type }));
});

router.get('/search', commonDataMiddleware, async (req, res) => {
  const query = search.normalize(req.query.q);
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'all';

  // Пустой запрос — страница с одним полем: искать нечего, базу не трогаем.
  if (!query) {
    return res.render('search', {
      query: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '',
      tab: 'all',
      tabs: TABS,
      results: { people: [], streams: [], recordings: [], venues: [] },
      counts: { people: 0, streams: 0, recordings: 0, venues: 0, total: 0 },
      tooShort: !!(req.query.q || '').trim(),
    });
  }

  const [results, counts] = await Promise.all([
    search.search(query, {
      limit: tab === 'all' ? ALL_LIMIT : TAB_LIMIT,
      types: tab === 'all' ? search.TYPES : [tab],
    }),
    search.counts(query),
  ]);

  res.render('search', { query, tab, tabs: TABS, results, counts, tooShort: false });
});

module.exports = router;
