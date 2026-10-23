// ═══════════════════════════════════════════════════════════════
//  index.js — точка входа
// ═══════════════════════════════════════════════════════════════

require('./chat_history');   // история чата из БД — ДО routes (там универсальный app.get('*'))
require('./routes');
require('./sockets');

const { main } = require('./core');

main().catch(e => { console.error('❌ Ошибка запуска:', e); process.exit(1); });