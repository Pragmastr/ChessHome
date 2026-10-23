// ═══════════════════════════════════════════════════════════════
//  chat_history.js — постраничная история общего чата
// ═══════════════════════════════════════════════════════════════
//  В БД (таблица chat_messages) сохраняются ВСЕ сообщения общего чата,
//  а в памяти сервера держатся только последние 500 (их отдаёт /api/chat).
//  Этот эндпоинт читает более старые сообщения прямо из БД, страницами:
//
//    GET /api/chat/history?before=<timestamp>&beforeId=<id>&limit=50
//    → { messages: [...от старых к новым], hasMore: true|false }
//
//  «before»/«beforeId» — курсор: timestamp и id самого старого сообщения,
//  которое клиент уже показал. id нужен для сообщений с одинаковым
//  временем, чтобы ни одно не потерялось на границе страниц.
//
//  Подключение: в index.js ПЕРЕД require('./routes'):
//      require('./chat_history');
//  (иначе универсальный app.get('*') перехватит запрос)
// ═══════════════════════════════════════════════════════════════

'use strict';

const { app, db, jwt, JWT_SECRET, getAuthToken, getUser, rateLimit, RateLimiter } = require('./core');

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

// 120 запросов в минуту с IP — с запасом для быстрой прокрутки, но не для скрейпинга
const historyLimit = rateLimit(new RateLimiter(60_000, 120));

// Без индекса по времени «старше X» — полный перебор таблицы при каждой подгрузке.
db('CREATE INDEX IF NOT EXISTS idx_chat_messages_ts ON chat_messages (timestamp DESC)')
  .catch(e => console.warn('[ChatHistory] index:', e.message));


app.get('/api/chat/history', historyLimit, async (req, res) => {
  try {
    const before = Number(req.query.before);
    if (!Number.isFinite(before) || before <= 0) {
      return res.status(400).json({ error: 'Некорректный параметр before' });
    }
    const beforeId = String(req.query.beforeId || '').slice(0, 64);
    const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || PAGE_DEFAULT));

    // Кто смотрит — как в /api/chat: сообщения теневого бана видят только их автор и админы
    let viewerLow = '';
    let isAdmin = false;
    const tok = getAuthToken(req);
    if (tok) {
      try {
        viewerLow = String(jwt.verify(tok, JWT_SECRET).username).toLowerCase();
        const caller = await getUser(viewerLow);
        isAdmin = caller?.role === 'admin';
      } catch { viewerLow = ''; }
    }

    // Берём на одно сообщение больше лимита — так узнаём, есть ли ещё что-то старее
    const r = await db(
      `SELECT id, username, message, role, timestamp, shadow_hidden, emoji, vip
         FROM chat_messages
        WHERE (timestamp < $1::bigint OR (timestamp = $1::bigint AND id::text < $2::text))
          AND (COALESCE(shadow_hidden, FALSE) = FALSE OR $3::boolean OR LOWER(username) = $4::text)
        ORDER BY timestamp DESC, id::text DESC
        LIMIT $5`,
      [before, beforeId, isAdmin, viewerLow, limit + 1]
    );

    const hasMore = r.rows.length > limit;
    const messages = r.rows.slice(0, limit).reverse().map(row => ({
      id: row.id,
      username: row.username,
      message: row.message,
      role: row.role,
      timestamp: Number(row.timestamp),
      shadowHidden: !!row.shadow_hidden,
      emoji: row.emoji || '',
      vip: !!row.vip,
    }));

    res.json({ messages, hasMore });
  } catch (e) {
    console.error('[ChatHistory]', e.message);
    res.status(500).json({ error: 'Ошибка загрузки истории' });
  }
});
