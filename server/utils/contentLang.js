// На каком языке написано содержимое людей — название и описание видео,
// текст поста, подпись фото, «о себе». На этом языке страница в индексе
// (docs/seo/LANGUAGES.md, §5.2): её версия на другом языке ведёт canonical
// сюда, в карте сайта только она.
//
// Считаем на лету, ничего не храним: текста мало, ответ мгновенный.
// Кириллица — ru. Латиницу делим на en, es, pt сами (шаг 4): библиотеки
// определения языка знают сотни языков и весят соответственно, а нам нужно
// различить три. Признаки — служебные слова и буквы, которых нет у соседей
// (ñ, ¿, ¡ и -ción — испанский; ã, õ, ç — португальский).
// Признаков нет (имя, «Daily vlog», эмодзи) — язык автора, если он латиницей,
// иначе основной.

const { BASE_LANG, isLang, toLang } = require('./langs');

const CYR = /[а-яё]/gi;
const LAT = /[a-zà-ÿ]/gi;
const MIN_LETTERS = 3;

// Служебные слова, которые редко встречаются у двух других. Общие или
// двусмысленные (de, que, para, como, se; «no», «o», «dos», «as», «do»,
// «son», «mas» — чужое слово или «más» без ударения) не считаем.
const WORDS = {
    en: 'the and of to is are was it you your my our we this that with for from at be have will not what how',
    es: 'el la los las y en del al un una es con muy más pero mi tu su lo hoy nuestro nuestra hay también donde cuando',
    pt: 'os da das e em na nas um uma é ao não você meu minha seu sua muito mais hoje nosso nossa tem também onde quando',
};
const VOCAB = new Map();
for (const [lang, list] of Object.entries(WORDS)) {
    for (const w of list.split(' ')) VOCAB.set(w, (VOCAB.get(w) || []).concat(lang));
}
// Буквы и окончания: вес как у трёх слов.
const MARKS = [
    [/[ñ¿¡]|ción\b|ciones\b/gi, 'es'],
    [/[ãõç]/gi, 'pt'],
];

// Язык латинского текста или '' — признаков нет.
function latinLang(s) {
    const score = Object.fromEntries(Object.keys(WORDS).map((l) => [l, 0]));
    for (const w of s.toLowerCase().match(/[a-zà-ÿ]+/g) || []) {
        const langs = VOCAB.get(w);
        if (langs) for (const l of langs) score[l] += 1 / langs.length;
    }
    for (const [rx, l] of MARKS) score[l] += 3 * (s.match(rx) || []).length;
    const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
    return best[1] > 0 && best[1] > second[1] && isLang(best[0]) ? best[0] : '';
}

function contentLang(texts, fallback) {
    const s = [].concat(texts).filter((x) => typeof x === 'string').join(' ');
    const cyr = (s.match(CYR) || []).length;
    const lat = (s.match(LAT) || []).length;
    if (cyr + lat < MIN_LETTERS) return toLang(fallback || BASE_LANG);
    if (cyr > lat) return toLang('ru');
    return latinLang(s) || (fallback in WORDS ? toLang(fallback) : toLang('en'));
}

// Одни правила для страницы и карты сайта (routes/seo.js), иначе в карте
// окажется не та версия, что объявляет canonical.
// Видео, запись, фото, пост: свой текст, без него — язык автора.
const itemLang = (item, author) => contentLang([item.title, item.description, item.caption, item.text], author && author.lang);
// Профиль и его вкладки: «о себе», без него — язык человека.
const profileLang = (user) => contentLang(user.bio, user.lang);
// Заведение и его вкладки: описание (название — чаще латиницей на любом языке).
const venueLang = (venue) => contentLang(venue.about);

module.exports = { contentLang, itemLang, profileLang, venueLang };
