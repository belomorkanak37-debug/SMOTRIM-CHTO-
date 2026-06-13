
/* ============================================================================
   «СМОТРИМ!ЧТО?» — логика прототипа
   ----------------------------------------------------------------------------
   Архитектура:
     1) Данные  — живая база TMDB + офлайн-резерв (ваша база), всё через DataAPI.
                  Реальные источники подключаются ТОЛЬКО внутри DataAPI,
                  остальной код менять не придётся.
     2) Состояние — единый объект state (вкладка, фильтры, выбранный день…).
     3) Рендер  — маленькие функции render*(), каждая отвечает за свой кусок.
     4) События — делегирование кликов на контейнерах, всё вешается в init().

   РЕАЛЬНАЯ БАЗА (готово): рандом-пул тайтлов
     - TMDB /discover/movie и /discover/tv, язык ru-RU, все 4 типа:
       аниме = keyword «anime» (210024), мультфильмы = Animation без аниме.
     - Добавьте бесплатный ключ в TMDB_API_KEY на Render — и пул станет
       практически бесконечным (до 10 000 тайтлов на каждую комбинацию
       фильтров, случайная страница × случайный тайтл).
     - Без ключа или при ошибке сети прототип берёт офлайн-резерв (вашу базу).
     - Альтернатива для аниме: AniList GraphQL (graphql.anilist.co,
       без ключа), но описания там на английском — поэтому по умолчанию
       аниме тоже идёт из TMDB ради русских описаний.

   TODO(Capacitor): упаковка в APK
     - этот файл положить как www/index.html (или public/ при Vite-сборке)
     - тряска: вместо window devicemotion использовать @capacitor/motion
     - сохранение «Смотрел»/«В список»: @capacitor/preferences или SQLite —
       сейчас это Set'ы в state.* только на время сессии (по ТЗ).
   ========================================================================== */
'use strict';

/* ───────────────────────── helpers ───────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
const esc = s => String(s).replace(/[&<>"]/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// русские множественные формы: plural(3, 'релиз','релиза','релизов')
function plural(n, one, few, many){
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ───────────────────────── справочники ───────────────────────── */
const TYPES = {
  film:    { name: 'Фильм',      low: 'фильм',      plural: 'Фильмы',      emoji: '🎬', c: 'sky'    },
  series:  { name: 'Сериал',     low: 'сериал',     plural: 'Сериалы',     emoji: '📺', c: 'peach'  },
  anime:   { name: 'Аниме',      low: 'аниме',      plural: 'Аниме',       emoji: '🌸', c: 'lilac'  },
  cartoon: { name: 'Мультфильм', low: 'мультфильм', plural: 'Мультфильмы', emoji: '🐥', c: 'butter' },
};

const GENRES = ['комедия','драма','фантастика','ужасы','романтика',
                'приключения','детектив','фэнтези','боевик'];

// цвета жанровых чипов крутим по кругу — палитра из CSS
const GENRE_C = ['butter','mint','sky','peach','lilac'];

/* ── фильтр по годам выпуска ── */
const ERAS = {
  any:    { label: 'Любой год', test: () => true },
  new:    { label: 'Новинки',   sub: '2020+',     min: 2020, max: 9999 },
  '10s':  { label: '2010-е',    sub: '2010–2019', min: 2010, max: 2019 },
  '00s':  { label: '2000-е',    sub: '2000–2009', min: 2000, max: 2009 },
  '90s':  { label: '90-е',      sub: '1990–1999', min: 1990, max: 1999 },
  retro:  { label: 'Ретро',     sub: 'до 1989',   min: 0,    max: 1989 },
};
const inEra = (year, era) => {
  const e = ERAS[era];
  if (!e || era === 'any') return true;
  const y = Number(year) || 0;
  return y >= e.min && y <= e.max;
};

/* ── фильтр по стране (русское / зарубежное) ── */
const ORIGINS = {
  any:     { label: 'Любое' },
  ru:      { label: 'Русское' },
  foreign: { label: 'Зарубежное' },
};
// «русское»: страны и языки, которые считаем своими
// (страна происхождения — самый точный фильтр TMDB; язык — подстраховка)
const RU_COUNTRIES = ['RU','SU','UA','BY','KZ']; // постсоветское пространство
const RU_LANGS = ['ru','uk','be','kk'];

/* ── постер: реальный из TMDB или локальный дудл-постер ── */
const IMG_BASE = 'https://image.tmdb.org/t/p/'; // + размер + poster_path
function posterUrl(path, size = 'w342'){
  if (!path) return '';
  const src = String(path).trim();
  // Поддерживаем TMDB-пути вида /abc.jpg, готовые URL, data-uri и blob из своей базы.
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return IMG_BASE + size + (src.startsWith('/') ? src : '/' + src);
}
function posterLines(text, max = 14, limit = 4){
  const words = String(text || 'Без названия').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words){
    const next = line ? line + ' ' + w : w;
    if (next.length > max && line){ lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > limit){
    lines.length = limit;
    lines[limit - 1] = lines[limit - 1].replace(/…$/,'') + '…';
  }
  return lines;
}
function fallbackPoster(t, mini = false){
  const tp = TYPES[t.type] || TYPES.film;
  const title = posterLines(t.title, mini ? 10 : 14, mini ? 3 : 4);
  const year = t.year && t.year !== '????' ? t.year : '';
  const fs = mini ? 18 : 28;
  const y0 = mini ? 78 : 126;
  const titleSvg = title.map((line, i) =>
    `<text x="50%" y="${y0 + i * (fs + 8)}" text-anchor="middle" font-family="Comic Sans MS, Segoe Print, cursive" font-size="${fs}" font-weight="700" fill="#2E2B4D">${esc(line)}</text>`
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513" viewBox="0 0 342 513">
    <defs>
      <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2" fill="#2E2B4D" opacity=".12"/></pattern>
      <linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#DAD7F5"/><stop offset="1" stop-color="#F8C9A8"/></linearGradient>
    </defs>
    <rect width="342" height="513" rx="28" fill="#FBF6EC"/>
    <rect x="18" y="18" width="306" height="477" rx="24" fill="url(#g)" stroke="#2E2B4D" stroke-width="8"/>
    <rect x="18" y="18" width="306" height="477" rx="24" fill="url(#dots)"/>
    <text x="50%" y="86" text-anchor="middle" font-size="54">${tp.emoji || '🎬'}</text>
    ${titleSvg}
    <text x="50%" y="410" text-anchor="middle" font-family="Comic Sans MS, Segoe Print, cursive" font-size="22" fill="#2E2B4D" opacity=".74">${esc(tp.low)}${year ? ' · ' + esc(year) : ''}</text>
    <text x="50%" y="458" text-anchor="middle" font-family="Comic Sans MS, Segoe Print, cursive" font-size="38">🍿 🎬 📺</text>
  </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}
function posterInner(t, w){ // w: 'w185' (карточка) / 'w154' (список)
  const remote = posterUrl(t.poster, w);
  const fallback = fallbackPoster(t, w === 'w154');
  const src = remote || fallback;
  const cls = remote ? '' : ' generated';
  return `<img class="posterImg${cls}" src="${esc(src)}" data-fallback="${esc(fallback)}"
            alt="Постер: ${esc(t.title)}" loading="lazy" decoding="async"
            onerror="this.onerror=null;this.src=this.dataset.fallback;this.classList.add('generated');this.parentNode.classList.add('generated')">`;
}
const thumb = t => posterInner(t, 'w154');

/* ── ссылка «загуглить тайтл» ── */
function googleHref(t){
  const tp = TYPES[t.type];
  const kind = t.type === 'anime' ? 'аниме'
             : t.type === 'series' ? 'сериал'
             : t.type === 'cartoon' ? 'мультфильм' : 'фильм';
  const q = `${t.title} ${t.year !== '????' ? t.year : ''} ${kind} смотреть`;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q.trim());
}

/* ───────────────── РЕАЛЬНАЯ БАЗА: TMDB ─────────────────
   Как включить на Render:
     1) Бесплатный аккаунт на themoviedb.org
     2) Settings → API → «API Key (v3 auth)»
     3) Добавить ключ в переменную окружения TMDB_API_KEY.
   Без ключа на сервере живой TMDB недоступен, но интерфейс продолжит работать.

   Внимание: не публикуйте TMDB_KEY в браузерном коде. Для GitHub/Render
   используется серверный прокси /api/tmdb из server.js. */
const TMDB_PROXY = location.protocol !== 'file:';
const TMDB_KEY = ''; // На Render ключ хранится в TMDB_API_KEY и не попадает в GitHub.
// Если отключить прокси и вставить длинный v4-токен (начинается с eyJ…) — тоже сработает:
const TMDB_V4 = TMDB_KEY.startsWith('eyJ'); // v4 ходит через Bearer-заголовок
const TMDB_ENABLED = TMDB_PROXY || Boolean(TMDB_KEY);

const TMDB_BASE = TMDB_PROXY ? '/api/tmdb' : 'https://api.themoviedb.org/3';
const ANIME_KW = 210024; // id ключевого слова «anime» в TMDB

// наши жанры → id жанров TMDB (у кино и у сериалов справочники разные)
const G_MOVIE = { 'комедия':35, 'драма':18, 'фантастика':878, 'ужасы':27,
  'романтика':10749, 'приключения':12, 'детектив':9648, 'фэнтези':14, 'боевик':28 };
const G_TV = { 'комедия':35, 'драма':18, 'фантастика':10765, 'ужасы':9648,
  'романтика':18, 'приключения':10759, 'детектив':9648, 'фэнтези':10765, 'боевик':10759 };
// обратный словарь: id из ответа → подпись на карточке
const G_NAME = { 35:'комедия', 18:'драма', 878:'фантастика', 27:'ужасы',
  10749:'романтика', 12:'приключения', 9648:'детектив', 14:'фэнтези',
  28:'боевик', 10765:'фантастика', 10759:'приключения', 53:'детектив',
  80:'детектив', 10751:'семейное', 16:'анимация' };

const tmdbPages = new Map(); // кэш total_pages на каждую комбинацию фильтров

// собирает discover-URL под тип, жанры, страну и эпоху
function tmdbQuery(type, genres, origin, era){
  const isTV = type === 'series' || type === 'anime';
  const gmap = isTV ? G_TV : G_MOVIE;
  const ids = [...new Set(genres.map(g => gmap[g]).filter(Boolean))];
  // Порог по числу оценок отсекает мусор со «дна» базы. Но у русского кино
  // и у старых фильмов оценок объективно меньше, поэтому порог снижаем,
  // иначе пул схлопывается до пары тайтлов.
  let minVotes = type === 'anime' ? 40 : isTV ? 80 : 150;
  if (origin === 'ru') minVotes = isTV ? 8 : 20;
  if (era === 'retro' || era === '90s') minVotes = Math.min(minVotes, 25);
  const p = new URLSearchParams({
    language: 'ru-RU',
    include_adult: 'false',
    sort_by: 'popularity.desc',
    'vote_count.gte': String(minVotes),
  });
  if (TMDB_KEY && !TMDB_V4) p.set('api_key', TMDB_KEY); // v3-ключ едет в параметрах URL
  // в with_genres запятая = «И», вертикальная черта = «ИЛИ»
  if (type === 'cartoon'){
    p.set('with_genres', ids.length ? '16,' + ids.join('|') : '16');
    p.set('without_keywords', String(ANIME_KW)); // анимация, но не аниме
  } else {
    if (ids.length) p.set('with_genres', ids.join('|'));
    if (type === 'anime') p.set('with_keywords', String(ANIME_KW));
    else p.set('without_genres', '16'); // кино/сериалы без мультиков
  }
  // страна: самый точный способ в TMDB — with_origin_country (поддержан и для кино, и для сериалов)
  if (origin === 'ru'){
    // «ИЛИ» по странам происхождения: RU, SU (СССР), UA, BY, KZ
    p.set('with_origin_country', RU_COUNTRIES.join('|'));
  } else if (origin === 'foreign'){
    // зарубежное = исключаем наши языки (origin_country исключать нельзя — нет «without»)
    p.set('without_original_language', RU_LANGS.join('|'));
  }
  // эпоха: диапазон дат релиза (ключи дат у кино и сериалов разные)
  const e = ERAS[era];
  if (e && era !== 'any'){
    const gte = `${String(e.min).padStart(4, '0')}-01-01`;
    const lte = `${e.max >= 9999 ? '2100' : e.max}-12-31`;
    if (isTV){
      p.set('first_air_date.gte', gte); p.set('first_air_date.lte', lte);
    } else {
      p.set('primary_release_date.gte', gte); p.set('primary_release_date.lte', lte);
    }
  }
  return TMDB_BASE + (isTV ? '/discover/tv' : '/discover/movie') + '?' + p;
}

async function tmdbJSON(url){
  const opts = TMDB_V4
    ? { headers: { Authorization: 'Bearer ' + TMDB_KEY, accept: 'application/json' } }
    : undefined;
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('TMDB ответил ' + r.status);
  return r.json();
}

// ответ TMDB → формат карточки приложения
function tmdbToTitle(x, type){
  const date = x.release_date || x.first_air_date || '';
  const genres = [...new Set((x.genre_ids || []).map(id => G_NAME[id]).filter(Boolean))];
  const lang = x.original_language || '';
  const countries = x.origin_country || []; // массив ISO-кодов стран
  const isRu = RU_LANGS.includes(lang) ||
               countries.some(c => RU_COUNTRIES.includes(c));
  return {
    id: 'tmdb-' + type + '-' + x.id,
    type,
    title: x.title || x.name || x.original_title || x.original_name || 'Без названия',
    year: Number(date.slice(0, 4)) || '????',
    genres: genres.slice(0, 3),
    rating: x.vote_average || 0,
    poster: x.poster_path || x.backdrop_path || null, // постер TMDB; если нет — берём фон как запас
    origin: isRu ? 'ru' : 'foreign',
    desc: x.overview || 'Русское описание ещё не подвезли. Загадка — тоже жанр.',
  };
}

/* Случайный тайтл из ВСЕЙ базы под фильтры.
   Хитрость «бесконечности»: discover отдаёт до 500 страниц по 20 тайтлов
   на каждую комбинацию фильтров; берём случайную страницу, на ней —
   случайный тайтл. total_pages кэшируем, чтобы не дёргать API лишний раз. */
async function tmdbRandom(types, genres, origin, era){
  const type = rnd(types.length ? types : Object.keys(TYPES));
  const base = tmdbQuery(type, genres, origin, era);
  let pages = tmdbPages.get(base);
  if (pages === undefined){
    const first = await tmdbJSON(base + '&page=1');
    pages = Math.min(first.total_pages || 0, 500); // больше 500 TMDB не отдаёт
    tmdbPages.set(base, pages);
  }
  if (!pages) return null; // под такие фильтры в базе пусто

  // Важно: не отдаём первый попавшийся результат, потому что у части тайтлов TMDB
  // нет poster_path. Сначала несколько раз ищем именно карточку с постером.
  let backup = null;
  for (let attempt = 0; attempt < 10; attempt++){
    const page = 1 + Math.floor(Math.random() * pages);
    const data = await tmdbJSON(base + '&page=' + page);
    const results = (data.results || []).filter(Boolean);
    if (!results.length) continue;
    backup = backup || rnd(results);
    const withRealPoster = results.filter(x => x.poster_path);
    if (withRealPoster.length) return tmdbToTitle(rnd(withRealPoster), type);
    const withBackdrop = results.filter(x => x.backdrop_path);
    if (withBackdrop.length && attempt > 4) return tmdbToTitle(rnd(withBackdrop), type);
  }
  return backup ? tmdbToTitle(backup, type) : null;
}

/* ─────────────────── ОФЛАЙН-БАЗА (заглушка) ───────────────────
   Моков больше нет. Сюда подгружается ваша собственная база —
   она используется ТОЛЬКО когда нет ключа TMDB или пропал интернет.

   Ожидаемый формат каждого тайтла (как у живых из TMDB):
   {
     id:     'строка-уникальный-id',
     type:   'film' | 'series' | 'anime' | 'cartoon',
     title:  'Название',
     year:    2023,                 // число или '????'
     genres:  ['комедия','драма'],  // из набора GENRES
     rating:  7.8,                  // число
     poster:  '/path.jpg' | null,   // путь TMDB или URL вашей картинки, либо null
     origin:  'ru' | 'foreign',     // для фильтра «Откуда»
     desc:    'Короткое описание.',
   }

   Как подключить вашу базу:
     - синхронно: впишите массив в OFFLINE_TITLES ниже;
     - с диска/сети: верните данные из DataAPI.getTitles()
       (например, await fetch('/db.json') или чтение из SQLite в Capacitor). */
const OFFLINE_TITLES = []; // ← сюда ляжет ваша офлайн-база

/* ───────────────────────── слой данных ─────────────────────────
   Единственное место, которое знает, ОТКУДА берутся данные. */
const DataAPI = {
  async getTitles(){
    // офлайн-резерв: пусто, пока вы не подгрузили свою базу в OFFLINE_TITLES
    // (или не вернули данные отсюда — fetch к вашему серверу, SQLite и т.п.)
    return OFFLINE_TITLES;
  },
  // случайный тайтл из живой базы TMDB; null = «база недоступна, бери офлайн-резерв»
  async getRandomTitle(types, genres, origin, era){
    if (!TMDB_ENABLED) return null;
    return tmdbRandom(types, genres, origin, era);
  },
};

/* ───────────────────────── состояние ───────────────────────── */
const state = {
  tab: 'random',
  typeFilters: new Set(),   // 'film' | 'series' | 'anime' | 'cartoon'
  genreFilters: new Set(),  // строки из GENRES
  origin: 'any',            // 'any' | 'ru' | 'foreign'
  era: 'any',               // ключ из ERAS
  current: null,            // показанный тайтл
  // списки переживают перезагрузку (localStorage); элемент:
  //   watched:  { t:<тайтл>, stars:0..5, note:'' }
  //   wishlist: { t:<тайтл> }
  watched: [],
  wishlist: [],
  rejected: new Set(),      // «Не хочу» — исключаются из пула до сброса
};
let ALL_TITLES = [];

/* быстрые проверки «лежит ли тайтл в списке» */
const inWatched  = id => state.watched.some(x => x.t.id === id);
const inWishlist = id => state.wishlist.some(x => x.t.id === id);

/* сохранение/загрузка списков (TODO(Capacitor): заменить на Preferences/SQLite) */
const LS_KEY = 'chpzrt.lists.v1';
function saveLists(){
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      watched: state.watched, wishlist: state.wishlist,
    }));
  } catch (e){ /* приватный режим — переживём, просто не сохранится */ }
}
function loadLists(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.watched)) state.watched = d.watched.map(x =>
      ({ t: x.t, stars: x.stars || 0, note: x.note || '' }));
    if (Array.isArray(d.wishlist)) state.wishlist = d.wishlist.map(x => ({ t: x.t }));
  } catch (e){ /* битые данные — игнор */ }
}

/* ───────────────────────── тост ───────────────────────── */
let toastTimer = null;
function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ───────────────────────── дудл-искры ───────────────────────── */
// Расширенный набор тематических эмодзи для кино и ТВ
const SPARK_CHARS = [
  '🎬','📺','🎥','📹','🎞️','📽️','🎭','🍿','🎫','📼','📡','🕹️',
  '⭐','🌟','✨','💫','🏆','🏅','🥇','👀','👓','🕶️','🤓',
  '🎉','🎊','🎈','💥','⚡','✦','★','✺','✧','♡','♪'
];

function fxLayer(){
  let layer = $('#globalFx');
  if (!layer){
    layer = document.createElement('div');
    layer.id = 'globalFx';
    layer.className = 'globalFx';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

function animateSpark(el, startX, startY, endX, endY, duration, rot, delay = 0){
  const midX = startX + (endX - startX) * .22;
  const midY = startY + (endY - startY) * .22 - 32;

  // Web Animations API — основной путь: работает без CSS-переменных и calc(),
  // поэтому эмодзи реально разлетаются даже в капризных Android WebView.
  if (el.animate){
    const anim = el.animate([
      { transform:`translate(${startX}px, ${startY}px) translate(-50%, -50%) scale(.35) rotate(0deg)`, opacity:0, offset:0 },
      { transform:`translate(${midX}px, ${midY}px) translate(-50%, -50%) scale(1.28) rotate(${rot * .25}deg)`, opacity:1, offset:.16 },
      { transform:`translate(${endX}px, ${endY}px) translate(-50%, -50%) scale(.78) rotate(${rot}deg)`, opacity:0, offset:1 },
    ], {
      duration,
      delay,
      easing:'cubic-bezier(.16,.95,.18,1)',
      fill:'forwards',
    });
    anim.onfinish = () => el.remove();
    anim.oncancel = () => el.remove();
    return;
  }

  // Fallback без WAAPI: ручная анимация через requestAnimationFrame.
  const startedAt = performance.now() + delay;
  function easeOutBack(t){
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function tick(now){
    if (now < startedAt){
      requestAnimationFrame(tick);
      return;
    }
    const t = Math.min(1, (now - startedAt) / duration);
    const k = Math.min(1, Math.max(0, easeOutBack(t)));
    const x = startX + (endX - startX) * k;
    const y = startY + (endY - startY) * k;
    const scale = t < .16 ? .35 + (1.28 - .35) * (t / .16) : 1.28 + (.78 - 1.28) * ((t - .16) / .84);
    const opacity = t < .12 ? t / .12 : Math.max(0, 1 - (t - .55) / .45);
    el.style.opacity = String(opacity);
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale}) rotate(${rot * k}deg)`;
    if (t < 1) requestAnimationFrame(tick);
    else el.remove();
  }
  requestAnimationFrame(tick);
}

function cloudBurst(){
  // Раньше здесь был один общий span с набором эмодзи — в WebView он мог выглядеть
  // как «зависшая наклейка». Теперь это короткая дополнительная россыпь отдельных частиц.
  spawnSparks(18, 0, true);
}

function spawnSparks(count = 28, delay = 0, compact = false){
  if (reducedMotion) count = Math.min(count, compact ? 8 : 18);
  const layer = fxLayer(); // fixed-слой поверх всего: модалки, навигации и WebView
  const source = $('#rollBtn') || $('#app');
  const sr = source ? source.getBoundingClientRect() : null;
  const cx = sr ? sr.left + sr.width / 2 : window.innerWidth / 2;
  const cy = sr ? sr.top + sr.height / 2 : window.innerHeight * .45;
  const minSide = Math.min(window.innerWidth || 360, window.innerHeight || 640, 520);

  for (let i = 0; i < count; i++){
    const s = document.createElement('span');
    s.className = 'spark';
    s.textContent = rnd(SPARK_CHARS);

    const sizeRandom = Math.random();
    const fontSize = sizeRandom < 0.28
      ? (38 + Math.random() * 22)
      : sizeRandom < 0.82
        ? (22 + Math.random() * 17)
        : (14 + Math.random() * 10);

    const angle = Math.random() * Math.PI * 2;
    const distance = (compact ? 80 : 145) + Math.random() * (compact ? 115 : Math.max(210, minSide * .62));
    const startX = cx + (Math.random() * 28 - 14);
    const startY = cy + (Math.random() * 28 - 14);
    const endX = startX + Math.cos(angle) * distance;
    const endY = startY + Math.sin(angle) * distance - (compact ? 35 : 70);
    const rot = Math.random() * 1080 - 540;
    const duration = Math.round((compact ? 850 : 1180) + Math.random() * (compact ? 420 : 720));

    s.style.fontSize = fontSize.toFixed(0) + 'px';
    s.style.opacity = '0';
    s.style.transform = `translate(${startX}px, ${startY}px) translate(-50%, -50%) scale(.35)`;

    layer.appendChild(s);
    animateSpark(s, startX, startY, endX, endY, duration, rot, delay + Math.random() * 120);
    setTimeout(() => s.remove(), duration + delay + 900); // страховка
  }
}

function shakeEffects(){
  const app = $('#app');
  if (app && !reducedMotion){
    app.classList.remove('shakeImpact');
    void app.offsetWidth;
    app.classList.add('shakeImpact');
    setTimeout(() => app.classList.remove('shakeImpact'), 650);
  }
  cloudBurst();
  spawnSparks(54, 0);
  setTimeout(() => spawnSparks(42, 120), 80);
  setTimeout(() => spawnSparks(30, 260), 160);
}

/* ─────────────────── дудл-телевизор (SVG) ───────────────────
   kind: 'q' — знак вопроса (пустая карточка), 'sleep' — спящий (пустой день) */
function tvSVG(kind){
  const face = kind === 'sleep'
    ? `<path class="ln" d="M44 52 q7 7 14 0"/>
       <path class="ln" d="M74 52 q7 7 14 0"/>
       <path class="ln" d="M58 70 q8 5 16 0"/>
       <text x="112" y="20" font-size="14">z</text>
       <text x="120" y="10" font-size="18">Z</text>`
    : `<text x="66" y="68" font-size="36" text-anchor="middle">?</text>
       <path class="ln" d="M30 38 l5 5 M35 38 l-5 5" opacity=".55"/>`;
  return `
  <svg class="tv" viewBox="0 0 132 104" aria-hidden="true">
    <path class="ln" d="M44 22 Q54 8 32 4"/>
    <path class="ln" d="M84 22 Q76 6 98 3"/>
    <circle cx="31" cy="4" r="3.5" fill="var(--butter)" stroke="var(--ink)" stroke-width="2.5"/>
    <circle cx="99" cy="3" r="3.5" fill="var(--rose)" stroke="var(--ink)" stroke-width="2.5"/>
    <path d="M14 30 C12 24 18 21 24 21 L106 23 C114 23 119 27 118 34 L116 82 C116 89 111 92 104 92 L22 90 C15 90 11 86 12 79 Z"
          fill="#fff" stroke="var(--ink)" stroke-width="3.5" stroke-linejoin="round"/>
    <path class="ln" d="M32 92 l-5 9 M98 92 l6 9"/>
    ${face}
  </svg>`;
}

/* ═══════════════════════ ВКЛАДКА «РАНДОМ» ═══════════════════════ */

/* декоративные дудл-звёздочки и точки на фоне стартового экрана */
function paintDots(){
  const box = $('#dotsRandom');
  if (!box) return;
  const COL = ['var(--lilac-deep)','var(--rose)','var(--sky)','var(--butter)','var(--mint)'];
  const STAR = ['#C9C5F0','#AED4F2','#F6B4C6'];
  let html = '';
  for (let i = 0; i < 18; i++){
    const x = (Math.random() * 92 + 4).toFixed(1);
    const y = (Math.random() * 92 + 4).toFixed(1);
    if (Math.random() < 0.32){ // дудл-звёздочка
      const s = (12 + Math.random() * 8).toFixed(0);
      const c = rnd(STAR);
      html += `<svg style="position:absolute;left:${x}%;top:${y}%;width:${s}px;height:${s}px" viewBox="0 0 24 24">
        <path d="M12 2 L14.5 9 L22 9 L16 13.5 L18.5 21 L12 16.5 L5.5 21 L8 13.5 L2 9 L9.5 9 Z"
              fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
    } else { // точка
      const d = (4 + Math.random() * 5).toFixed(0);
      html += `<i style="left:${x}%;top:${y}%;width:${d}px;height:${d}px;border-radius:50%;background:${rnd(COL)}"></i>`;
    }
  }
  box.innerHTML = html;
}

function renderResult(t){
  const tp = TYPES[t.type];
  const seen = inWatched(t.id);
  const listed = inWishlist(t.id);
  const yearTxt = t.year !== '????' ? t.year : '—';
  const posterSrc = posterUrl(t.poster, 'w342');
  const posterFallback = fallbackPoster(t, false);
  const posterImg = `<img class="posterImg${posterSrc ? '' : ' generated'}"
       src="${esc(posterSrc || posterFallback)}" data-fallback="${esc(posterFallback)}"
       alt="Постер: ${esc(t.title)}" loading="eager" decoding="async"
       onerror="this.onerror=null;this.src=this.dataset.fallback;this.classList.add('generated');this.parentNode.classList.add('generated')">`;

  // теги: тип (цвет), год (голубой), затем жанры (белые)
  const tags = [
    `<span class="tag t-type">${tp.low}</span>`,
    `<span class="tag t-year">${yearTxt}</span>`,
    ...t.genres.map(g => `<span class="tag">${esc(g)}</span>`),
  ].join('');

  $('#resultScroll').innerHTML = `
    <div class="rPoster${posterSrc ? '' : ' generated'}">
      ${posterImg}
      <svg class="rPosterStar" viewBox="0 0 42 42" aria-hidden="true">
        <path d="M21 3 L26 16 L39 16 L28 24 L32 38 L21 29 L10 38 L14 24 L3 16 L16 16 Z"
              fill="var(--butter)" stroke="var(--ink)" stroke-width="2.4" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="rSheet">
      <svg class="rHeart" viewBox="0 0 40 38" aria-hidden="true">
        <path d="M20 34 C6 24 4 14 11 9 C16 5 20 9 20 12 C20 9 24 5 29 9 C36 14 34 24 20 34 Z"
              fill="var(--rose)" stroke="var(--ink)" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M8 18 L4 18 M32 18 L36 18" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <a class="rTitle" href="${googleHref(t)}" target="_blank" rel="noopener"
      >${esc(t.title)} <span class="ext">↗</span></a>
      <div class="rMeta">• ${yearTxt} · <span class="star">★</span> ${Number(t.rating).toFixed(1)}</div>
      <div class="tags">${tags}</div>
      <p class="rDesc">${esc(t.desc)}</p>
      <div class="acts">
        <button class="act" data-act="seen" aria-pressed="${seen}">${seen ? 'Смотрел ✓' : 'Смотрел'}</button>
        <button class="act" data-act="list" aria-pressed="${listed}">${listed ? 'В очереди ⭐' : 'Посмотрю'}</button>
        <button class="act" data-act="skip" aria-pressed="false">Не хочу</button>
      </div>
    </div>`;
}

/* открыть/закрыть модалку результата */
function openResult(){
  $('#resultBackdrop').hidden = false;
  $('#resultModal').hidden = false;
  $('#resultScroll').scrollTop = 0;
}
function closeResult(){
  $('#resultBackdrop').hidden = true;
  $('#resultModal').hidden = true;
}

// фильтр офлайн-резерва (жанры — по ИЛИ, плюс страна и эпоха)
function getPool(){
  return ALL_TITLES.filter(t =>
    !state.rejected.has(t.id) &&
    (state.typeFilters.size === 0 || state.typeFilters.has(t.type)) &&
    (state.genreFilters.size === 0 || t.genres.some(g => state.genreFilters.has(g))) &&
    (state.origin === 'any' || t.origin === state.origin) &&
    inEra(t.year, state.era)
  );
}

let rolling = false;
const wait = ms => new Promise(res => setTimeout(res, ms));

// один запрос случайного тайтла под все текущие фильтры
function pullRandom(){
  return DataAPI.getRandomTitle(
    [...state.typeFilters], [...state.genreFilters], state.origin, state.era);
}

async function roll(){
  if (rolling) return;
  rolling = true;
  const cloud = $('#rollBtn');

  // Визуальная реакция на тряску: экран дёргается, из облака и поверх экрана летят кино-эмодзи.
  shakeEffects();

  cloud.classList.add('rattle');
  // тряска идёт 0.8s — даём ей доиграть, пока в фоне грузится тайтл
  const minSpin = wait(reducedMotion ? 0 : 760);

  let t = null;
  if (TMDB_ENABLED){
    try {
      t = await pullRandom();
      // редкая коллизия с «Не хочу» или повтором — одна перекрутка
      if (t && (state.rejected.has(t.id) || (state.current && t.id === state.current.id))){
        t = (await pullRandom()) || t;
      }
    } catch (err){
      console.warn('TMDB недоступен, беру офлайн-резерв:', err);
      if (ALL_TITLES.length) toast('Интернет икнул — достаю из запасов 📦');
    }
  }

  if (!t){ // нет ключа, нет сети или TMDB пуст под фильтры → офлайн-резерв
    const pool = getPool();
    if (!pool.length){
      cloud.classList.remove('rattle');
      rolling = false;
      // отличаем «база пуста» от «фильтры слишком узкие»
      if (!ALL_TITLES.length){
        toast(TMDB_ENABLED
          ? 'Нет соединения с базой 📡 Проверь интернет'
          : 'Офлайн-база пока пуста — подключи TMDB или загрузи свою базу');
      } else {
        toast('Под такие фильтры пусто 😅 Сними пару или жми «Сбросить»');
      }
      return;
    }
    t = rnd(pool);
    if (pool.length > 1 && state.current){
      while (t.id === state.current.id) t = rnd(pool); // без повтора подряд
    }
  }

  await minSpin;
  state.current = t;
  cloud.classList.remove('rattle');
  renderResult(t);
  openResult();          // выезжает модалка с тайтлом
  spawnSparks(26);       // Третья волна при появлении результата
  rolling = false;
}

/* ── фильтры рандома ── */
function renderFilterChips(){
  $('#typeChips').innerHTML = Object.entries(TYPES).map(([key, tp]) =>
    `<button class="chip c-${tp.c}" data-kind="type" data-val="${key}"
             aria-pressed="false">${tp.emoji} ${tp.name}</button>`).join('');
  $('#genreChips').innerHTML = GENRES.map((g, i) =>
    `<button class="chip c-${GENRE_C[i % GENRE_C.length]}" data-kind="genre"
             data-val="${g}" aria-pressed="false">${g}</button>`).join('');
  // страна — одиночный выбор
  $('#originChips').innerHTML = Object.entries(ORIGINS).map(([key, o], i) =>
    `<button class="chip c-${['mint','sky','peach'][i]}" data-kind="origin" data-val="${key}"
             aria-pressed="${state.origin === key}">${o.label}</button>`).join('');
  // годы — одиночный выбор, с подписью диапазона
  $('#eraChips').innerHTML = Object.entries(ERAS).map(([key, e], i) =>
    `<button class="chip c-${GENRE_C[i % GENRE_C.length]}" data-kind="era" data-val="${key}"
             aria-pressed="${state.era === key}">${e.label}${e.sub ? ` <i style="font-style:normal;opacity:.7">${e.sub}</i>` : ''}</button>`).join('');
}

function renderStatus(){
  const parts = [
    ...[...state.typeFilters].map(k => TYPES[k].low),
    ...state.genreFilters,
  ];
  if (state.origin !== 'any') parts.push(ORIGINS[state.origin].label.toLowerCase());
  if (state.era !== 'any') parts.push(ERAS[state.era].label.toLowerCase());

  $('#statusLine').innerHTML = parts.length
    ? `Сейчас ищем: <b>${parts.map(esc).join(' + ')}</b>`
    : '<b>Всё подряд</b> — выбери, что хочется 👇';
  $('#resetBtn').disabled = parts.length === 0 && state.rejected.size === 0;

  // счётчик активных фильтров на шестерёнке
  const count = state.typeFilters.size + state.genreFilters.size
    + (state.origin !== 'any' ? 1 : 0) + (state.era !== 'any' ? 1 : 0);
  const badge = $('#fcount');
  badge.textContent = count;
  badge.hidden = count === 0;
  $('#filterBtn').classList.toggle('on', count > 0);
}

/* ── панель фильтров: открыть/закрыть ── */
function openFilters(){
  $('#sheetBackdrop').hidden = false;
  $('#filterSheet').hidden = false;
}
function closeFilters(){
  $('#sheetBackdrop').hidden = true;
  $('#filterSheet').hidden = true;
}

function onChipToggle(e){
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const kind = chip.dataset.kind;
  const val = chip.dataset.val;

  if (kind === 'type' || kind === 'genre'){
    const set = kind === 'type' ? state.typeFilters : state.genreFilters;
    set.has(val) ? set.delete(val) : set.add(val);
    chip.setAttribute('aria-pressed', String(set.has(val)));
  } else { // origin / era — одиночный выбор
    state[kind] = val;
    const box = kind === 'origin' ? '#originChips' : '#eraChips';
    document.querySelectorAll(`${box} .chip`).forEach(c =>
      c.setAttribute('aria-pressed', String(c.dataset.val === val)));
  }
  tmdbPages.clear();   // фильтры сменились — пересчитать число страниц заново
  renderStatus();
}

function resetFilters(){
  state.typeFilters.clear();
  state.genreFilters.clear();
  state.rejected.clear();
  state.origin = 'any';
  state.era = 'any';
  tmdbPages.clear();
  renderFilterChips(); // перерисовать с дефолтными состояниями
  renderStatus();
  toast('Фильтры сброшены');
}

/* ── действия на карточке результата ── */
function onCardAction(e){
  const btn = e.target.closest('.act');
  if (!btn || !state.current) return;
  const t = state.current;
  const id = t.id;
  const act = btn.dataset.act;

  if (act === 'seen'){
    if (inWatched(id)){
      state.watched = state.watched.filter(x => x.t.id !== id);
      toast('Убрали из «Просмотрено»');
    } else {
      state.watched.unshift({ t, stars: 0, note: '' });
      // если был в очереди — убираем оттуда, тайтл «досмотрен»
      state.wishlist = state.wishlist.filter(x => x.t.id !== id);
      toast('В «Просмотрено» 👀 Звёзды поставишь во вкладке');
    }
    saveLists();
    renderResult(t);
  } else if (act === 'list'){
    if (inWishlist(id)){
      state.wishlist = state.wishlist.filter(x => x.t.id !== id);
      toast('Убрали из очереди');
    } else {
      state.wishlist.unshift({ t });
      toast('В очереди ⭐ «Буду смотреть»');
    }
    saveLists();
    renderResult(t);
  } else if (act === 'skip'){
    state.rejected.add(id);
    renderStatus(); // активируем «Сбросить»
    toast('Понял, не твоё. Крутим ещё! 🎲');
    setTimeout(roll, 420);
  }
}

/* ── тряска телефоном ──
   TODO(Capacitor): в APK заменить на @capacitor/motion */
let lastShake = 0;
let lastAcc = null;
function onMotion(e){
  if (state.tab !== 'random') return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  if (lastAcc){
    const delta = Math.abs(a.x - lastAcc.x)
                + Math.abs(a.y - lastAcc.y)
                + Math.abs(a.z - lastAcc.z);
    const now = Date.now();
    if (delta > 27 && now - lastShake > 1200){
      lastShake = now;
      roll();
    }
  }
  lastAcc = { x: a.x, y: a.y, z: a.z };
}

function initShake(){
  if (!('DeviceMotionEvent' in window)) return; // десктоп — только кнопка
  if (typeof DeviceMotionEvent.requestPermission === 'function'){
    // iOS 13+: нужен явный жест пользователя
    const btn = $('#motionBtn');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      try{
        const res = await DeviceMotionEvent.requestPermission();
        if (res === 'granted'){
          window.addEventListener('devicemotion', onMotion);
          btn.hidden = true;
          toast('Тряска включена! 📳');
        } else {
          toast('Без разрешения — только кнопкой 🙃');
        }
      } catch {
        toast('Не вышло включить тряску 😬');
      }
    });
  } else {
    window.addEventListener('devicemotion', onMotion);
  }
}

/* ═══════════════ ВКЛАДКИ «ПРОСМОТРЕНО» И «БУДУ СМОТРЕТЬ» ═══════════════ */

function itemHead(t){
  const hasPoster = Boolean(posterUrl(t.poster, 'w154'));
  return `
    <a class="ithumb${hasPoster ? '' : ' generated'}" href="${googleHref(t)}" target="_blank" rel="noopener"
       aria-label="Открыть поиск по тайтлу">${thumb(t)}</a>`;
}

function itemTitle(t){
  return `<a class="ititle" href="${googleHref(t)}" target="_blank"
            rel="noopener">${esc(t.title)} ↗</a>`;
}

function itemMeta(t){
  const tp = TYPES[t.type];
  return `<div class="imeta">${tp.emoji} ${tp.low} · ${t.year} · ★ ${Number(t.rating).toFixed(1)}</div>`;
}

/* ── «Просмотрено»: звёзды + заметка ── */
function renderWatched(){
  const wrap = $('#watchedList');
  const n = state.watched.length;
  $('#subWatched').textContent = n
    ? `${n} ${plural(n, 'тайтл', 'тайтла', 'тайтлов')}. Ставь звёзды и оставляй пару слов на память.`
    : 'Всё, что ты уже видел. Ставь звёзды и оставляй пару слов на память.';
  if (!n){
    wrap.innerHTML = `
      <div class="lempty">
        ${tvSVG('q')}
        <div class="big">Пока пусто.</div>
        <div>Жми «Смотрел» в «Рандоме» — тут соберётся твоя коллекция.</div>
      </div>`;
    return;
  }
  wrap.innerHTML = state.watched.map(en => `
    <article class="item" data-id="${en.t.id}">
      ${itemHead(en.t)}
      <div class="ibody">
        ${itemTitle(en.t)}
        ${itemMeta(en.t)}
        <div class="stars" aria-label="Твоя оценка">
          ${[1,2,3,4,5].map(v =>
            `<button class="${v <= en.stars ? 'on' : ''}" data-star="${v}"
                     aria-label="Оценка ${v} из 5">★</button>`).join('')}
        </div>
        <textarea class="note" data-note rows="2" maxlength="200"
          placeholder="Заметка: пара слов на память…">${esc(en.note)}</textarea>
        <div class="irow">
          <button class="ibtn del" data-rm>✖ Убрать</button>
        </div>
      </div>
    </article>`).join('');
}

function onWatchedClick(e){
  const item = e.target.closest('.item');
  if (!item) return;
  const id = item.dataset.id;
  const en = state.watched.find(x => x.t.id === id);
  if (!en) return;

  const star = e.target.closest('[data-star]');
  if (star){
    const v = Number(star.dataset.star);
    en.stars = en.stars === v ? 0 : v; // повторный тап по той же звезде — сброс
    // обновляем звёзды на месте, чтобы не сбрасывать фокус с заметки
    item.querySelectorAll('[data-star]').forEach(b =>
      b.classList.toggle('on', Number(b.dataset.star) <= en.stars));
    saveLists();
    return;
  }
  if (e.target.closest('[data-rm]')){
    state.watched = state.watched.filter(x => x.t.id !== id);
    saveLists();
    renderWatched();
    if (state.current && state.current.id === id) renderResult(state.current);
    toast('Убрали из «Просмотрено»');
  }
}

function onWatchedInput(e){
  if (!e.target.matches('[data-note]')) return;
  const item = e.target.closest('.item');
  const en = state.watched.find(x => x.t.id === item.dataset.id);
  if (en){
    en.note = e.target.value;
    saveLists();
  }
}

/* ── «Буду смотреть»: очередь + переезд в «Просмотрено» ── */
function renderWishlist(){
  const wrap = $('#watchlistList');
  const n = state.wishlist.length;
  $('#subList').textContent = n
    ? `${n} в очереди. Посмотрел — жми «✓ Посмотрел», и тайтл переедет в «Просмотрено».`
    : 'Очередь на вечера. Посмотрел — жми «✓ Посмотрел», и тайтл переедет в «Просмотрено».';
  if (!n){
    wrap.innerHTML = `
      <div class="lempty">
        ${tvSVG('q')}
        <div class="big">Очередь пуста.</div>
        <div>Жми «Посмотрю» в «Рандоме» — соберём план на вечера.</div>
      </div>`;
    return;
  }
  wrap.innerHTML = state.wishlist.map(en => `
    <article class="item" data-id="${en.t.id}">
      ${itemHead(en.t)}
      <div class="ibody">
        ${itemTitle(en.t)}
        ${itemMeta(en.t)}
        <p class="idesc">${esc(en.t.desc)}</p>
        <div class="irow">
          <button class="ibtn go" data-done>✓ Посмотрел</button>
          <button class="ibtn del" data-rm>✖ Убрать</button>
        </div>
      </div>
    </article>`).join('');
}

function onWishlistClick(e){
  const item = e.target.closest('.item');
  if (!item) return;
  const id = item.dataset.id;
  const en = state.wishlist.find(x => x.t.id === id);
  if (!en) return;

  if (e.target.closest('[data-done]')){
    state.wishlist = state.wishlist.filter(x => x.t.id !== id);
    state.watched.unshift({ t: en.t, stars: 0, note: '' });
    saveLists();
    renderWishlist();
    if (state.current && state.current.id === id) renderResult(state.current);
    toast('Переехал в «Просмотрено» ✓ Не забудь звёзды!');
  } else if (e.target.closest('[data-rm]')){
    state.wishlist = state.wishlist.filter(x => x.t.id !== id);
    saveLists();
    renderWishlist();
    if (state.current && state.current.id === id) renderResult(state.current);
    toast('Убрали из очереди');
  }
}

/* ═══════════════════════ ВКЛАДКИ И ПАСХАЛКА ═══════════════════════ */

const TABS = {
  random:    { sec: '#tab-random',    nav: '#navRandom'  },
  watched:   { sec: '#tab-watched',   nav: '#navWatched' },
  watchlist: { sec: '#tab-watchlist', nav: '#navList'    },
};

function setTab(tab){
  if (state.tab === tab) return;
  state.tab = tab;
  for (const [key, ref] of Object.entries(TABS)){
    const on = key === tab;
    $(ref.sec).hidden = !on;
    const nav = $(ref.nav);
    nav.classList.toggle('active', on);
    if (on) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  if (tab === 'watched') renderWatched();
  if (tab === 'watchlist') renderWishlist();
  $('#main').scrollTop = 0;
}

/* ═══════════════════════ СТАРТ ═══════════════════════ */

async function init(){
  loadLists();                       // поднять сохранённые списки
  ALL_TITLES = await DataAPI.getTitles();

  // первый рендер
  paintDots();
  renderFilterChips();
  renderStatus();

  // события — «Рандом»
  $('#rollBtn').addEventListener('click', roll);
  $('#resultScroll').addEventListener('click', onCardAction);
  $('#resultClose').addEventListener('click', closeResult);
  $('#resultBackdrop').addEventListener('click', closeResult);

  // панель фильтров
  $('#resetBtn').addEventListener('click', resetFilters);
  $('#typeChips').addEventListener('click', onChipToggle);
  $('#genreChips').addEventListener('click', onChipToggle);
  $('#originChips').addEventListener('click', onChipToggle);
  $('#eraChips').addEventListener('click', onChipToggle);
  $('#filterBtn').addEventListener('click', openFilters);
  $('#filterClose').addEventListener('click', closeFilters);
  $('#sheetBackdrop').addEventListener('click', closeFilters);

  // события — списки
  $('#watchedList').addEventListener('click', onWatchedClick);
  $('#watchedList').addEventListener('input', onWatchedInput);
  $('#watchlistList').addEventListener('click', onWishlistClick);

  // навигация
  $('#navRandom').addEventListener('click', () => setTab('random'));
  $('#navWatched').addEventListener('click', () => setTab('watched'));
  $('#navList').addEventListener('click', () => setTab('watchlist'));

  // Escape закрывает то, что открыто
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#resultModal').hidden) closeResult();
    else if (!$('#filterSheet').hidden) closeFilters();
  });

  initShake();
}

init();

