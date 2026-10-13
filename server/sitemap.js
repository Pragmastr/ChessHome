'use strict';
/**
 * Динамический sitemap для chesshome.pro
 *
 * Подключение в index.js (ДО express.static и до остальных роутов):
 *   const db = require('./db');
 *   app.use(require('./sitemap')({ db }));
 *
 * Отдаёт:
 *   /sitemap.xml            — индекс
 *   /sitemap-static.xml     — постоянные страницы
 *   /sitemap-<имя>-<N>.xml  — динамический контент из БД (блог, форум, клубы...)
 *
 * Кроме того, ставит заголовок X-Robots-Tag: noindex на приватные страницы
 * (inbox, settings и т.п.) — HTML править не нужно.
 *
 * ВАЖНО: удалите старый статический файл sitemap.xml из папки public,
 * иначе express.static отдаст его вместо этого роута.
 */
const express = require('express');

const SITE = 'https://chesshome.pro';
const CACHE_MS = 10 * 60 * 1000;   // кэш 10 минут — защита БД и RPS
const CHUNK = 40000;               // лимит Google — 50 000 URL на файл

// Приватные/служебные страницы → не индексировать
const NOINDEX_PREFIXES = ['/inbox', '/settings', '/report', '/appeal', '/online', '/followers', '/following'];

// Постоянные публичные страницы (без lastmod — честнее, чем фиктивная дата)
const STATIC_PAGES = [
  '/', '/lobby', '/vs-computer.html', '/tournaments', '/interclub-tournaments.html',
  '/puzzles', '/storm', '/clubs', '/blog', '/news', '/forum', '/dev-diary',
  '/analysis', '/editor', '/ai', '/stats', '/age', '/about', '/privacy', '/terms',
];

// ═══════════════════════════════════════════════════════════════════════════
// ★ ИСТОЧНИКИ ДИНАМИЧЕСКИХ СТРАНИЦ ★
// Названия колонок в вашей БД мне неизвестны, поэтому запросы — SELECT *,
// а нужные поля берутся с запасными вариантами (см. helpers ниже).
// При первом запуске в консоль сервера выводится строка
//   [sitemap] <имя>: колонки → ...
// по ней запросы можно позже сузить до конкретных колонок.
//   sql  — строка или массив запасных вариантов (берётся первый, что отработал и вернул строки)
//   path — функция, строящая путь страницы; вернёт null → запись пропускается
// ═══════════════════════════════════════════════════════════════════════════
const SOURCES = {
  blog: {
    sql:  `SELECT * FROM blog_posts LIMIT 50000`,
    path: r => r.id && `/blog/${r.id}`,
  },
  news: {
    sql:  [`SELECT * FROM news_posts LIMIT 50000`, `SELECT * FROM news LIMIT 50000`],
    path: r => r.id && `/news/${r.id}`,
  },
  forum: {
    // Адрес темы: /forum/<slug>, например golosovanie-za-perestrojku-interfejsa-pr-1364ef
    sql:  `SELECT * FROM forum_topics LIMIT 50000`,
    path: r => r.slug && `/forum/${encodeURIComponent(r.slug)}`,
  },
  clubs: {
    sql:  `SELECT * FROM clubs LIMIT 50000`,
    path: r => (r.slug || r.id) && `/clubs/${encodeURIComponent(r.slug || r.id)}`,
  },
  tournaments: {
    sql:  `SELECT * FROM tournaments LIMIT 50000`,
    path: r => r.id && `/tournament/${r.id}`,
  },
  // Профили: включайте только осмысленные (например, с сыгранными партиями),
  // иначе будут тысячи почти пустых страниц.
  // profiles: {
  //   sql:  `SELECT * FROM users WHERE games_played >= 20 LIMIT 50000`,
  //   path: r => r.username && `/profile/${encodeURIComponent(r.username)}`,
  // },
};

// ─── helpers ────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function fmtDate(d) {
  if (!d) return null;
  const x = new Date(d);
  return isNaN(x) ? null : x.toISOString().slice(0, 10);
}

// Не публиковать черновики/удалённое/скрытое (названия флагов угаданы по типичным схемам)
const BAD_STATUS = new Set(['draft', 'deleted', 'hidden', 'removed', 'banned', 'pending', 'archived', 'rejected']);
function isPublic(r) {
  if (r.deleted || r.is_deleted || r.deleted_at || r.hidden || r.is_hidden || r.draft || r.is_draft) return false;
  if (r.published === false || r.is_published === false) return false;
  if (r.status && BAD_STATUS.has(String(r.status).toLowerCase())) return false;
  return true;
}

// Дата последнего изменения — первая найденная из типичных колонок
const modDate = r => fmtDate(r.updated_at || r.edited_at || r.last_activity_at || r.last_reply_at || r.created_at);

const urlTag = u =>
  `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`;

const urlset = list =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  list.map(urlTag).join('\n') + `\n</urlset>\n`;

// ─── router ─────────────────────────────────────────────────────────────────
module.exports = function createSitemapRouter({ db, sources = SOURCES } = {}) {
  const router = express.Router();

  // Адаптер под разные драйверы БД: pg, mysql2, better-sqlite3
  async function rows(sql) {
    if (typeof db.prepare === 'function') return db.prepare(sql).all();  // better-sqlite3
    const r = await db.query(sql);
    if (Array.isArray(r)) return Array.isArray(r[0]) ? r[0] : r;        // mysql2: [rows, fields]
    return (r && r.rows) || [];                                          // pg
  }

  // noindex для приватных страниц
  router.use((req, res, next) => {
    const p = req.path;
    if (NOINDEX_PREFIXES.some(x => p === x || p.startsWith(x + '/') || p.startsWith(x + '.'))) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
  });

  // Кэш + защита от параллельных пересборок
  let cache = null, building = null;
  const logged = new Set();
  async function load() {
    if (cache && Date.now() - cache.ts < CACHE_MS) return cache.data;
    if (building) return building;
    building = (async () => {
      const data = {};
      await Promise.all(Object.entries(sources).map(async ([name, s]) => {
        let list = [], lastErr = null;
        for (const sql of [].concat(s.sql)) {
          try { list = await rows(sql); lastErr = null; if (list.length) break; }
          catch (e) { lastErr = e; }
        }
        if (lastErr && !list.length) {
          console.error(`[sitemap] ${name}: ${lastErr.message}`);
          data[name] = (cache && cache.data[name]) || [];     // при ошибке — прошлая версия
          return;
        }
        if (list.length && !logged.has(name)) {
          logged.add(name);
          console.log(`[sitemap] ${name}: колонки → ${Object.keys(list[0]).join(', ')}`);
        }
        const out = [];
        for (const r of list) {
          if (!isPublic(r)) continue;
          const p = s.path(r);
          if (p) out.push({ loc: SITE + p, lastmod: modDate(r) });
        }
        if (list.length && !out.length) {
          console.warn(`[sitemap] ${name}: ${list.length} строк, но ни одной подходящей — проверьте колонки (см. строку «колонки →»)`);
        }
        data[name] = out;
      }));
      cache = { ts: Date.now(), data };
      return data;
    })().finally(() => { building = null; });
    return building;
  }

  function send(res, xml) {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  }

  // Индекс
  router.get('/sitemap.xml', async (req, res, next) => {
    try {
      const data = await load();
      const maps = [`${SITE}/sitemap-static.xml`];
      for (const [name, list] of Object.entries(data)) {
        const pages = Math.ceil(list.length / CHUNK);
        for (let i = 1; i <= pages; i++) maps.push(`${SITE}/sitemap-${name}-${i}.xml`);
      }
      send(res,
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        maps.map(m => `  <sitemap><loc>${esc(m)}</loc></sitemap>`).join('\n') +
        `\n</sitemapindex>\n`);
    } catch (e) { next(e); }
  });

  // Статические страницы
  router.get('/sitemap-static.xml', (req, res) => {
    send(res, urlset(STATIC_PAGES.map(p => ({ loc: SITE + p }))));
  });

  // Динамические части
  router.get(/^\/sitemap-([a-z]+)-(\d+)\.xml$/, async (req, res, next) => {
    try {
      const data = await load();
      const list = data[req.params[0]];
      const page = parseInt(req.params[1], 10);
      if (!list || page < 1) return res.status(404).end();
      const slice = list.slice((page - 1) * CHUNK, page * CHUNK);
      if (!slice.length) return res.status(404).end();
      send(res, urlset(slice));
    } catch (e) { next(e); }
  });

  return router;
};