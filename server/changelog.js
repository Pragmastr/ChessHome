// ═══════════════════════════════════════════════════════════════
//  changelog.js — журнал обновлений (/changelog)
// ═══════════════════════════════════════════════════════════════
//  • Записи (по месяцам, текст в Markdown) создаёт/правит/удаляет ТОЛЬКО
//    владелец сайта — аккаунт ChessHome. Другие админы не могут.
//  • Реакции, просмотры и комментарии — только от аккаунтов (анонимы не
//    считаются и не могут писать).
//  • Просмотр = один аккаунт один раз на запись.
//  • Таблицы создаются сами (CREATE TABLE IF NOT EXISTS).
//
//  Подключение: в routes.js, рядом с require('./botmoderator'):
//      require('./changelog');
//  (должно быть ДО универсального app.get('*'), иначе /changelog не сработает)
// ═══════════════════════════════════════════════════════════════

'use strict';

const {
  app, db, path, jwt, JWT_SECRET, getAuthToken, getUser,
  authMiddleware, rateLimit, RateLimiter, isSiteAdmin, logAdminAction,
} = require('./core');
const moderation = require('./moderation');

// Единственный, кто может публиковать
const OWNER = 'chesshome';
const isOwner = (username) => !!username && String(username).toLowerCase() === OWNER;

const ALLOWED_EMOJIS = ['👍', '❤️', '🔥', '😂', '🤯'];
const TITLE_MAX   = 100;
const CONTENT_MAX = 30000;
const COMMENT_MAX = 500;
const COMMENTS_PER_PAGE = 20;
const COMMENTS_PER_DAY  = 10;
const ENTRIES_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Лимит запросов на запись (реакции, комментарии, правки) — на IP
const limiterWrite = new RateLimiter(60_000, 40);
const writeLimit = rateLimit(limiterWrite);


// ── Схема БД ──────────────────────────────────────────────────
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS changelog_entries (
     id           TEXT PRIMARY KEY,
     title        TEXT   NOT NULL,
     content      TEXT   NOT NULL,
     author       TEXT   NOT NULL,
     published_at BIGINT NOT NULL,
     created_at   BIGINT NOT NULL,
     updated_at   BIGINT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_changelog_entries_pub ON changelog_entries (published_at DESC)`,

  `CREATE TABLE IF NOT EXISTS changelog_reactions (
     entry_id     TEXT   NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
     username_low TEXT   NOT NULL,
     emoji        TEXT   NOT NULL,
     created_at   BIGINT NOT NULL,
     PRIMARY KEY (entry_id, username_low)
   )`,

  `CREATE TABLE IF NOT EXISTS changelog_views (
     entry_id     TEXT   NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
     username_low TEXT   NOT NULL,
     created_at   BIGINT NOT NULL,
     PRIMARY KEY (entry_id, username_low)
   )`,

  `CREATE TABLE IF NOT EXISTS changelog_comments (
     id           TEXT PRIMARY KEY,
     entry_id     TEXT   NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
     username     TEXT   NOT NULL,
     username_low TEXT   NOT NULL,
     content      TEXT   NOT NULL,
     created_at   BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_changelog_comments_entry ON changelog_comments (entry_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_changelog_comments_user  ON changelog_comments (username_low, created_at)`,
];

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA_SQL) await db(sql);
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
// Создаём заранее; если БД ещё не готова — повторим при первом запросе.
ensureSchema().catch(e => console.error('[Changelog] schema:', e.message));


// ── Хелперы ───────────────────────────────────────────────────
// async-хендлеры Express 4 сами ошибки не ловят — оборачиваем.
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch(e => {
    console.error('[Changelog]', req.method, req.path, e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' });
  });
};

// Логин из токена, если он есть и валиден (для публичных GET)
function viewerName(req) {
  const tok = getAuthToken(req);
  if (!tok) return null;
  try { return String(jwt.verify(tok, JWT_SECRET).username).toLowerCase(); } catch { return null; }
}

// Только владелец: возвращает пользователя или отвечает 403 и возвращает null
async function requireOwner(req, res) {
  const user = await getUser(String(req.user.username).toLowerCase());
  if (!user || !isOwner(user.username)) {
    res.status(403).json({ error: 'Публиковать обновления может только владелец сайта' });
    return null;
  }
  return user;
}

function parsePublishedAt(v) {
  if (v === undefined || v === null || v === '') return Date.now();
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < Date.UTC(2020, 0, 1) || n > Date.now() + 31 * 24 * 3600 * 1000) return null;
  return Math.round(n);
}

function validateEntryBody(body) {
  const title = String(body && body.title || '').trim();
  const content = String(body && body.content || '').trim();
  if (!title) return { error: 'Введите название (например, «Сентябрь 2026»)' };
  if (title.length > TITLE_MAX) return { error: `Название не длиннее ${TITLE_MAX} символов` };
  if (!content) return { error: 'Введите текст обновления' };
  if (content.length > CONTENT_MAX) return { error: `Текст не длиннее ${CONTENT_MAX} символов` };
  const publishedAt = parsePublishedAt(body.publishedAt);
  if (publishedAt === null) return { error: 'Некорректная дата публикации' };
  return { title, content, publishedAt };
}

// Счётчики реакций по записям: { entryId: { emoji: count } }
async function reactionCounts(ids) {
  const out = {};
  if (!ids.length) return out;
  const r = await db(
    `SELECT entry_id, emoji, COUNT(*) AS cnt FROM changelog_reactions WHERE entry_id = ANY($1::text[]) GROUP BY entry_id, emoji`,
    [ids]
  );
  for (const row of r.rows) (out[row.entry_id] ||= {})[row.emoji] = parseInt(row.cnt, 10);
  return out;
}

async function myReactions(ids, userLow) {
  const out = {};
  if (!userLow || !ids.length) return out;
  const r = await db(
    `SELECT entry_id, emoji FROM changelog_reactions WHERE username_low = $1 AND entry_id = ANY($2::text[])`,
    [userLow, ids]
  );
  for (const row of r.rows) out[row.entry_id] = row.emoji;
  return out;
}

const ENTRY_SELECT = `
  SELECT e.id, e.title, e.author, e.published_at, e.updated_at,
         (SELECT COUNT(*) FROM changelog_views v WHERE v.entry_id = e.id) AS views,
         (SELECT COUNT(*) FROM changelog_comments c
            WHERE c.entry_id = e.id AND c.username_low <> ALL($1::text[])) AS comments
  FROM changelog_entries e`;

function mapEntry(row, reacts, mine) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    publishedAt: Number(row.published_at),
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
    views: parseInt(row.views, 10),
    comments: parseInt(row.comments, 10),
    reactions: reacts[row.id] || {},
    myEmoji: mine[row.id] || null,
  };
}


// ── Страница ──────────────────────────────────────────────────
app.get('/changelog', (req, res) => res.sendFile(path.join(__dirname, '../public/changelog.html')));


// ── Список записей ────────────────────────────────────────────
// Текст отдаём только у самой свежей записи (она открыта сразу);
// остальные месяцы подгружаются при раскрытии — страница остаётся лёгкой.
app.get('/api/changelog', wrap(async (req, res) => {
  await ensureSchema();
  const viewer = viewerName(req);
  const hidden = await moderation.commentExclusions(req);

  const rows = (await db(
    `${ENTRY_SELECT} ORDER BY e.published_at DESC, e.created_at DESC LIMIT ${ENTRIES_LIMIT}`,
    [hidden]
  )).rows;

  const ids = rows.map(r => r.id);
  const [reacts, mine] = await Promise.all([reactionCounts(ids), myReactions(ids, viewer)]);
  const entries = rows.map(r => mapEntry(r, reacts, mine));

  if (entries.length) {
    const c = await db(`SELECT content FROM changelog_entries WHERE id = $1`, [entries[0].id]);
    entries[0].content = c.rows[0] ? c.rows[0].content : '';
  }
  res.json({ entries, isOwner: isOwner(viewer) });
}));


// ── Одна запись (с текстом) ───────────────────────────────────
app.get('/api/changelog/:id', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  await ensureSchema();
  const viewer = viewerName(req);
  const hidden = await moderation.commentExclusions(req);

  const r = await db(`${ENTRY_SELECT} WHERE e.id = $2`, [hidden, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Запись не найдена' });

  const [reacts, mine, body] = await Promise.all([
    reactionCounts([req.params.id]),
    myReactions([req.params.id], viewer),
    db(`SELECT content FROM changelog_entries WHERE id = $1`, [req.params.id]),
  ]);
  res.json({ ...mapEntry(r.rows[0], reacts, mine), content: body.rows[0].content });
}));


// ── Создание / правка / удаление (только владелец) ────────────
app.post('/api/changelog', authMiddleware, writeLimit, wrap(async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const v = validateEntryBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await ensureSchema();

  const id = require('crypto').randomUUID();
  await db(
    `INSERT INTO changelog_entries (id, title, content, author, published_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, v.title, v.content, owner.username, v.publishedAt, Date.now()]
  );
  await logAdminAction(owner.username, 'changelog_create', id, { title: v.title }).catch(() => {});
  res.json({ ok: true, id });
}));

async function handleUpdate(req, res) {
  const owner = await requireOwner(req, res); if (!owner) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  const v = validateEntryBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await ensureSchema();

  const r = await db(
    `UPDATE changelog_entries SET title=$1, content=$2, published_at=$3, updated_at=$4 WHERE id=$5`,
    [v.title, v.content, v.publishedAt, Date.now(), req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Запись не найдена' });
  await logAdminAction(owner.username, 'changelog_update', req.params.id, { title: v.title }).catch(() => {});
  res.json({ ok: true });
}
async function handleDelete(req, res) {
  const owner = await requireOwner(req, res); if (!owner) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  await ensureSchema();
  const r = await db(`DELETE FROM changelog_entries WHERE id = $1`, [req.params.id]); // реакции/просмотры/комментарии — каскадом
  if (!r.rowCount) return res.status(404).json({ error: 'Запись не найдена' });
  await logAdminAction(owner.username, 'changelog_delete', req.params.id, {}).catch(() => {});
  res.json({ ok: true });
}
// PUT/DELETE — основной вариант, POST — резервный (хостинг может резать методы)
app.put('/api/changelog/:id',         authMiddleware, writeLimit, wrap(handleUpdate));
app.post('/api/changelog/:id/update', authMiddleware, writeLimit, wrap(handleUpdate));
app.delete('/api/changelog/:id',      authMiddleware, writeLimit, wrap(handleDelete));
app.post('/api/changelog/:id/delete', authMiddleware, writeLimit, wrap(handleDelete));


// ── Просмотры (только аккаунты, один раз на запись) ───────────
app.post('/api/changelog/:id/view', authMiddleware, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  await ensureSchema();
  const exists = await db(`SELECT 1 FROM changelog_entries WHERE id = $1`, [req.params.id]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Запись не найдена' });

  await db(
    `INSERT INTO changelog_views (entry_id, username_low, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [req.params.id, String(req.user.username).toLowerCase(), Date.now()]
  );
  const c = await db(`SELECT COUNT(*) AS n FROM changelog_views WHERE entry_id = $1`, [req.params.id]);
  res.json({ ok: true, views: parseInt(c.rows[0].n, 10) });
}));


// ── Реакции (только аккаунты; повторный клик снимает, другой эмодзи заменяет) ──
app.post('/api/changelog/:id/reactions', authMiddleware, writeLimit, wrap(async (req, res) => {
  const { emoji } = req.body || {};
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Недопустимый эмодзи' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  await ensureSchema();

  const exists = await db(`SELECT 1 FROM changelog_entries WHERE id = $1`, [req.params.id]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Запись не найдена' });

  const low = String(req.user.username).toLowerCase();
  const cur = await db(`SELECT emoji FROM changelog_reactions WHERE entry_id=$1 AND username_low=$2`, [req.params.id, low]);
  if (cur.rows[0] && cur.rows[0].emoji === emoji) {
    await db(`DELETE FROM changelog_reactions WHERE entry_id=$1 AND username_low=$2`, [req.params.id, low]);
  } else {
    await db(
      `INSERT INTO changelog_reactions (entry_id, username_low, emoji, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (entry_id, username_low) DO UPDATE SET emoji = EXCLUDED.emoji`,
      [req.params.id, low, emoji, Date.now()]
    );
  }
  const [counts, mine] = await Promise.all([reactionCounts([req.params.id]), myReactions([req.params.id], low)]);
  res.json({ ok: true, counts: counts[req.params.id] || {}, myEmoji: mine[req.params.id] || null });
}));


// ── Комментарии ───────────────────────────────────────────────
app.get('/api/changelog/:id/comments', wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  await ensureSchema();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * COMMENTS_PER_PAGE;
  // Комментарии забаненных и тенево-забаненных видит только их автор и админы
  const hidden = await moderation.commentExclusions(req);

  const total = parseInt((await db(
    `SELECT COUNT(*) AS n FROM changelog_comments WHERE entry_id=$1 AND username_low <> ALL($2::text[])`,
    [req.params.id, hidden]
  )).rows[0].n, 10);

  const rows = (await db(
    `SELECT id, username, content, created_at FROM changelog_comments
     WHERE entry_id=$1 AND username_low <> ALL($2::text[])
     ORDER BY created_at ASC LIMIT $3 OFFSET $4`,
    [req.params.id, hidden, COMMENTS_PER_PAGE, offset]
  )).rows;

  res.json({
    comments: rows.map(r => ({ id: r.id, username: r.username, content: r.content, createdAt: Number(r.created_at) })),
    total, page, totalPages: Math.max(1, Math.ceil(total / COMMENTS_PER_PAGE)),
  });
}));

app.post('/api/changelog/:id/comments', authMiddleware, writeLimit, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Запись не найдена' });
  const user = await getUser(String(req.user.username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Не авторизован' });

  const content = String(req.body && req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Пустой комментарий' });
  if (content.length > COMMENT_MAX) return res.status(400).json({ error: `Комментарий не длиннее ${COMMENT_MAX} символов` });
  await ensureSchema();

  const exists = await db(`SELECT 1 FROM changelog_entries WHERE id = $1`, [req.params.id]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Запись не найдена' });

  const low = user.username.toLowerCase();
  const cnt = await db(
    `SELECT COUNT(*) AS n FROM changelog_comments WHERE username_low=$1 AND created_at > $2`,
    [low, Date.now() - 24 * 3600 * 1000]
  );
  if (parseInt(cnt.rows[0].n, 10) >= COMMENTS_PER_DAY) {
    return res.status(429).json({ error: `Лимит ${COMMENTS_PER_DAY} комментариев в сутки исчерпан` });
  }

  // Бан/теневой бан: человеку об этом не говорим — комментарий публикуется,
  // но видит его только он сам и админы (фильтрация — в GET выше).
  moderation.record({ username: user.username, channel: 'changelog', text: content });

  const id = require('crypto').randomUUID();
  const now = Date.now();
  await db(
    `INSERT INTO changelog_comments (id, entry_id, username, username_low, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, req.params.id, user.username, low, content, now]
  );
  res.json({ ok: true, id, username: user.username, content, createdAt: now });
}));

async function handleDeleteComment(req, res) {
  const user = await getUser(String(req.user.username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  await ensureSchema();

  const r = await db(`SELECT username_low FROM changelog_comments WHERE id = $1`, [req.params.commentId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Комментарий не найден' });

  const mine = r.rows[0].username_low === user.username.toLowerCase();
  if (!mine && !isOwner(user.username) && !isSiteAdmin(user.username) && user.role !== 'admin') {
    return res.status(403).json({ error: 'Нет прав' });
  }
  await db(`DELETE FROM changelog_comments WHERE id = $1`, [req.params.commentId]);
  if (!mine) await logAdminAction(user.username, 'changelog_comment_delete', r.rows[0].username_low, { commentId: req.params.commentId }).catch(() => {});
  res.json({ ok: true });
}
app.delete('/api/changelog/comments/:commentId',      authMiddleware, writeLimit, wrap(handleDeleteComment));
app.post('/api/changelog/comments/:commentId/delete', authMiddleware, writeLimit, wrap(handleDeleteComment));


module.exports = { ensureSchema };