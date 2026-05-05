// bot.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const archiver = require('archiver');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DOMAIN = (process.env.DOMAIN || 'http://localhost:3000').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const TTL_MS = 60 * 60 * 1000; // 1 час

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не указан в .env');
  process.exit(1);
}

// ---------- БАЗА ДАННЫХ ----------
const db = new Database('packs.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS packs (
    slug        TEXT PRIMARY KEY,
    title       TEXT,
    type        TEXT,           -- 'sticker' | 'emoji'
    source      TEXT,           -- исходная ссылка
    items_json  TEXT NOT NULL,  -- JSON массив { name, file_id, emoji, tgs_b64 }
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id     INTEGER PRIMARY KEY,
    state       TEXT,
    created_at  INTEGER NOT NULL
  );
`);

const insertPack = db.prepare(`
  INSERT OR REPLACE INTO packs (slug, title, type, source, items_json, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getPack = db.prepare(`SELECT * FROM packs WHERE slug = ?`);
const deleteExpired = db.prepare(`DELETE FROM packs WHERE expires_at < ?`);
const listUserPacks = db.prepare(`
  SELECT slug, title, type, created_at, expires_at FROM packs
  WHERE source LIKE ? ORDER BY created_at DESC LIMIT 10
`);

// Чистка просроченных каждые 5 минут
setInterval(() => {
  const res = deleteExpired.run(Date.now());
  if (res.changes > 0) console.log(`🧹 Удалено просроченных страниц: ${res.changes}`);
}, 5 * 60 * 1000);

// ---------- УТИЛИТЫ ----------
function randomSlug(len = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

function parseLink(text) {
  text = text.trim();
  let m = text.match(/t\.me\/addstickers\/([\w\d_]+)/i);
  if (m) return { type: 'sticker', name: m[1] };
  m = text.match(/t\.me\/addemoji\/([\w\d_]+)/i);
  if (m) return { type: 'emoji', name: m[1] };
  return null;
}

async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function tgsToJson(tgsBuffer) {
  // .tgs = gzipped lottie json
  const json = zlib.gunzipSync(tgsBuffer).toString('utf8');
  return JSON.parse(json);
}

// ---------- TELEGRAM BOT ----------
// FIX: polling: false при создании, потом вручную удаляем webhook и стартуем polling.
// Это устраняет 409 Conflict — старый инстанс успевает завершиться до старта нового.
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📥 Загрузить пак', callback_data: 'menu:upload' }],
      [{ text: '📚 Мои паки', callback_data: 'menu:list' }],
      [{ text: 'ℹ️ Как пользоваться', callback_data: 'menu:help' }],
      [{ text: '⚙️ Поддерживаемые форматы', callback_data: 'menu:formats' }],
    ],
  },
  parse_mode: 'HTML',
};

const backBtn = {
  reply_markup: {
    inline_keyboard: [[{ text: '← Назад', callback_data: 'menu:home' }]],
  },
  parse_mode: 'HTML',
};

const HOME_TEXT =
  `<b>✨ TGS Pack Parser</b>\n\n` +
  `Кидай мне ссылку на премиум-эмодзи или стикерпак, ` +
  `я соберу все <code>.tgs</code> и сделаю красивую страничку.\n\n` +
  `<i>Страница живёт 1 час и потом самоудаляется.</i>`;

bot.onText(/\/start/, (msg) => {
  db.prepare(`INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)`)
    .run(msg.from.id, Date.now());
  bot.sendMessage(msg.chat.id, HOME_TEXT, mainMenu);
});

bot.onText(/\/menu/, (msg) => {
  bot.sendMessage(msg.chat.id, HOME_TEXT, mainMenu);
});

bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data;

  try {
    if (data === 'menu:home') {
      await bot.editMessageText(HOME_TEXT, {
        chat_id: chatId, message_id: msgId, ...mainMenu,
      });
    } else if (data === 'menu:upload') {
      await bot.editMessageText(
        `📥 <b>Загрузка пака</b>\n\nПросто пришли ссылку:\n` +
        `• <code>https://t.me/addstickers/НАЗВАНИЕ</code>\n` +
        `• <code>https://t.me/addemoji/НАЗВАНИЕ</code>`,
        { chat_id: chatId, message_id: msgId, ...backBtn },
      );
    } else if (data === 'menu:list') {
      const rows = listUserPacks.all(`%uid:${q.from.id}%`);
      const text = rows.length
        ? `📚 <b>Твои паки</b>\n\n` + rows.map(r =>
            `• <a href="${DOMAIN}/${r.slug}">${r.title}</a> ` +
            `(${Math.max(0, Math.round((r.expires_at - Date.now()) / 60000))} мин)`,
          ).join('\n')
        : `📚 <b>Твои паки</b>\n\nПока ничего нет.`;
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId, disable_web_page_preview: true, ...backBtn,
      });
    } else if (data === 'menu:help') {
      await bot.editMessageText(
        `ℹ️ <b>Как пользоваться</b>\n\n` +
        `1. Жми «📥 Загрузить пак»\n` +
        `2. Кидай ссылку на стикерпак/эмодзи-пак\n` +
        `3. Получаешь ссылку на сайт\n` +
        `4. На сайте смотришь список и качаешь <code>.zip</code> с JSON\n\n` +
        `Страница активна <b>1 час</b>.`,
        { chat_id: chatId, message_id: msgId, ...backBtn },
      );
    } else if (data === 'menu:formats') {
      await bot.editMessageText(
        `⚙️ <b>Форматы</b>\n\n` +
        `• <b>.tgs</b> — анимированные стикеры/эмодзи (Lottie)\n` +
        `• Конвертация в чистый <b>.json</b> и упаковка в <b>.zip</b>\n` +
        `• Статичные <code>.webp</code> и видео <code>.webm</code> игнорируются`,
        { chat_id: chatId, message_id: msgId, ...backBtn },
      );
    }
    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error('callback error', e.message);
    // FIX: игнорируем "message is not modified" — не критическая ошибка
    if (!e.message?.includes('message is not modified')) {
      await bot.answerCallbackQuery(q.id, { text: 'Ошибка', show_alert: false }).catch(() => {});
    } else {
      await bot.answerCallbackQuery(q.id).catch(() => {});
    }
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const parsed = parseLink(msg.text);
  if (!parsed) return; // не ссылка — игнор

  const status = await bot.sendMessage(msg.chat.id, '⏳ Достаю пак...', { parse_mode: 'HTML' });

  try {
    const stickerSet = await bot.getStickerSet(parsed.name);
    const tgsItems = stickerSet.stickers.filter(s => s.is_animated);

    if (!tgsItems.length) {
      return bot.editMessageText(
        '⚠️ В этом паке нет <b>.tgs</b> файлов (только статика или видео).',
        { chat_id: msg.chat.id, message_id: status.message_id, parse_mode: 'HTML' },
      );
    }

    await bot.editMessageText(
      `⏬ Качаю <b>${tgsItems.length}</b> .tgs файлов...`,
      { chat_id: msg.chat.id, message_id: status.message_id, parse_mode: 'HTML' },
    );

    const items = [];
    for (let i = 0; i < tgsItems.length; i++) {
      const st = tgsItems[i];
      try {
        const file = await bot.getFile(st.file_id);
        const buf = await downloadFile(file.file_path);
        items.push({
          file_id: st.file_id,
          emoji: st.emoji || '',
          name: `sticker_${String(i + 1).padStart(3, '0')}`,
          tgs_b64: buf.toString('base64'),
        });
      } catch (err) {
        console.error('item download error', err.message);
      }
      if ((i + 1) % 10 === 0) {
        await bot.editMessageText(
          `⏬ Прогресс: ${i + 1}/${tgsItems.length}`,
          { chat_id: msg.chat.id, message_id: status.message_id, parse_mode: 'HTML' },
        ).catch(() => {});
      }
    }

    const slug = randomSlug(12);
    const now = Date.now();
    insertPack.run(
      slug,
      stickerSet.title,
      parsed.type,
      `${msg.text} | uid:${msg.from.id}`,
      JSON.stringify(items),
      now,
      now + TTL_MS,
    );

    const url = `${DOMAIN}/${slug}`;
    await bot.editMessageText(
      `✅ <b>Готово!</b>\n\n` +
      `📦 <b>${stickerSet.title}</b>\n` +
      `🎞 .tgs файлов: <b>${items.length}</b>\n` +
      `🔗 <a href="${url}">${url}</a>\n\n` +
      `<i>Страница исчезнет через 1 час.</i>`,
      {
        chat_id: msg.chat.id,
        message_id: status.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Открыть страницу', url }],
            [{ text: '🏠 Меню', callback_data: 'menu:home' }],
          ],
        },
      },
    );
  } catch (e) {
    console.error(e);
    bot.editMessageText(
      `❌ Ошибка: <code>${(e.message || 'unknown').slice(0, 200)}</code>`,
      { chat_id: msg.chat.id, message_id: status.message_id, parse_mode: 'HTML' },
    ).catch(() => {});
  }
});

// FIX: Обработка polling ошибок — не падаем при сетевых сбоях
bot.on('polling_error', (err) => {
  // 409 логируем как warning, не как error — это значит был другой инстанс
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
    console.warn('⚠️  [polling] 409 Conflict — завершение старого инстанса...');
  } else {
    console.error('[polling_error]', err.message);
  }
});

// ---------- WEB ----------
const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/', (_req, res) => {
  res.type('html').send(renderHome());
});

app.get('/:slug', (req, res) => {
  // FIX: исключаем /api/* из slug-маршрута
  if (req.params.slug === 'api') return res.status(404).type('html').send(render404());
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) {
    return res.status(404).type('html').send(render404());
  }
  res.type('html').send(renderPack(pack));
});

// API: мета-информация пака
app.get('/api/pack/:slug', (req, res) => {
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) return res.status(404).json({ error: 'not found' });
  const items = JSON.parse(pack.items_json).map(({ tgs_b64, ...rest }, i) => ({
    ...rest, idx: i,
  }));
  res.json({
    slug: pack.slug,
    title: pack.title,
    type: pack.type,
    expires_at: pack.expires_at,
    items,
  });
});

app.get('/api/pack/:slug/tgs/:idx', (req, res) => {
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) return res.status(404).end();
  const items = JSON.parse(pack.items_json);
  const item = items[+req.params.idx];
  if (!item) return res.status(404).end();
  res.set('Content-Type', 'application/x-tgsticker');
  res.send(Buffer.from(item.tgs_b64, 'base64'));
});

// ZIP с json'ами всех .tgs
app.get('/api/pack/:slug/zip', (req, res) => {
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) return res.status(404).end();
  const items = JSON.parse(pack.items_json);

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${pack.slug}_lottie_json.zip"`,
  });
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { console.error(err); res.status(500).end(); });
  archive.pipe(res);

  for (const it of items) {
    try {
      const tgsBuf = Buffer.from(it.tgs_b64, 'base64');
      const json = tgsToJson(tgsBuf);
      archive.append(JSON.stringify(json, null, 2), { name: `${it.name}.json` });
    } catch (e) {
      archive.append(`// failed: ${e.message}`, { name: `${it.name}.error.txt` });
    }
  }
  archive.finalize();
});

// одиночный JSON
app.get('/api/pack/:slug/json/:idx', (req, res) => {
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) return res.status(404).end();
  const items = JSON.parse(pack.items_json);
  const it = items[+req.params.idx];
  if (!it) return res.status(404).end();
  try {
    const json = tgsToJson(Buffer.from(it.tgs_b64, 'base64'));
    res.set('Content-Disposition', `attachment; filename="${it.name}.json"`);
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lottie JSON для плеера (декодит .tgs на лету)
app.get('/api/pack/:slug/lottie/:idx', (req, res) => {
  const pack = getPack.get(req.params.slug);
  if (!pack || pack.expires_at < Date.now()) return res.status(404).end();
  const items = JSON.parse(pack.items_json);
  const it = items[+req.params.idx];
  if (!it) return res.status(404).end();
  try {
    const json = tgsToJson(Buffer.from(it.tgs_b64, 'base64'));
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- HTML ----------
const BASE_HEAD = `
<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:'Unbounded',sans-serif;
    background:#0a0a0a;color:#f5f5f5;
    min-height:100vh;padding:48px 24px;
    background-image:radial-gradient(circle at 20% 0%,#161616 0%,#0a0a0a 60%);
  }
  .wrap{max-width:1200px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:48px;gap:24px;flex-wrap:wrap}
  h1{font-weight:900;font-size:clamp(28px,4vw,44px);letter-spacing:-1px;line-height:1.1}
  h1 span{color:#888;font-weight:300}
  .meta{font-size:12px;color:#888;font-weight:300;text-align:right}
  .meta b{color:#f5f5f5;font-weight:500}
  .actions{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:32px}
  .btn{
    display:inline-flex;align-items:center;gap:8px;
    padding:14px 22px;border-radius:14px;
    background:#f5f5f5;color:#0a0a0a;
    font-family:inherit;font-weight:500;font-size:13px;
    text-decoration:none;cursor:pointer;border:none;
    transition:all .2s ease;letter-spacing:.5px;text-transform:uppercase;
  }
  .btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(255,255,255,.15)}
  .btn.ghost{background:transparent;color:#f5f5f5;border:1px solid #2a2a2a}
  .btn.ghost:hover{border-color:#f5f5f5;background:#111}
  .grid{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
    gap:16px;
  }
  .card{
    background:#111;border:1px solid #1f1f1f;border-radius:18px;
    padding:18px 14px;display:flex;flex-direction:column;align-items:center;gap:10px;
    transition:all .25s ease;position:relative;overflow:hidden;
  }
  .card:hover{border-color:#f5f5f5;transform:translateY(-3px)}
  .card .player{width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center}
  .card .emoji{font-size:11px;color:#888;font-weight:300}
  .card .num{position:absolute;top:8px;left:10px;font-size:10px;color:#444;font-weight:500}
  .card a.dl{
    font-size:10px;color:#888;text-decoration:none;
    border:1px solid #222;padding:5px 10px;border-radius:99px;
    transition:all .2s ease;
  }
  .card a.dl:hover{color:#f5f5f5;border-color:#f5f5f5}
  footer{margin-top:64px;text-align:center;color:#444;font-size:11px;font-weight:300;letter-spacing:1px}
  .err{text-align:center;padding:120px 20px}
  .err h1{font-size:120px;color:#222}
  .err p{color:#888;margin-top:12px}
  .badge{
    display:inline-block;padding:4px 10px;border:1px solid #2a2a2a;
    border-radius:99px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#888
  }
</style>
<script src="https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js"></script>
</head><body><div class="wrap">
`;
const BASE_FOOT = `
<footer>TGS PACK PARSER · СТРАНИЦА УДАЛИТСЯ ЧЕРЕЗ ЧАС</footer>
</div></body></html>`;

function renderHome() {
  return BASE_HEAD + `
    <header><h1>TGS Parser<br><span>premium emoji & sticker → lottie json</span></h1></header>
    <div class="actions">
      <span class="badge">отправь ссылку боту в телеграм</span>
    </div>
    <p style="color:#888;font-weight:300;line-height:1.7;max-width:640px">
      Этот сервис превращает анимированные стикерпаки и премиум-эмодзи Telegram
      в чистый Lottie JSON. Открой бота, кинь ссылку — и получишь персональную
      страницу со списком и кнопкой скачивания .zip архива.
    </p>
  ` + BASE_FOOT;
}

function render404() {
  return BASE_HEAD + `
    <div class="err">
      <h1>404</h1>
      <p>страница не найдена или истёк срок жизни (1 час)</p>
    </div>
  ` + BASE_FOOT;
}

function renderPack(pack) {
  const items = JSON.parse(pack.items_json);
  const minutesLeft = Math.max(0, Math.round((pack.expires_at - Date.now()) / 60000));
  const safeTitle = pack.title.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  return BASE_HEAD + `
    <header>
      <div>
        <h1>${safeTitle}<br><span>${items.length} animated · ${pack.type}</span></h1>
      </div>
      <div class="meta">
        <span class="badge">live ${minutesLeft} min</span><br><br>
        slug · <b>${pack.slug}</b>
      </div>
    </header>
    <div class="actions">
      <a class="btn" href="/api/pack/${pack.slug}/zip" download>⬇ Скачать .zip (Lottie JSON)</a>
      <a class="btn ghost" href="/">← Главная</a>
    </div>
    <div class="grid" id="grid">
      ${items.map((it, i) => `
        <div class="card">
          <span class="num">${String(i + 1).padStart(3, '0')}</span>
          <div class="player">
            <lottie-player
              src="/api/pack/${pack.slug}/lottie/${i}"
              background="transparent" speed="1" loop autoplay
              style="width:100%;height:100%"></lottie-player>
          </div>
          <div class="emoji">${it.emoji || '·'}</div>
          <a class="dl" href="/api/pack/${pack.slug}/json/${i}" download>JSON</a>
        </div>
      `).join('')}
    </div>
  ` + BASE_FOOT;
}

// ---------- ЗАПУСК ----------
// FIX: сначала стартуем Express, потом удаляем webhook и запускаем polling
app.listen(PORT, async () => {
  console.log(`🌐 Web: http://localhost:${PORT}`);
  console.log(`🤖 Bot: домен ${DOMAIN}`);

  try {
    // Удаляем возможный webhook и сбрасываем pending updates перед polling
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log('✅ Webhook удалён, pending updates сброшены');
    bot.startPolling({ restart: false });
    console.log('✅ Polling запущен');
  } catch (e) {
    console.error('❌ Ошибка запуска polling:', e.message);
    process.exit(1);
  }
});

// ---------- GRACEFUL SHUTDOWN ----------
// FIX: корректное завершение — останавливаем polling перед выходом,
// чтобы следующий запуск не получал 409 Conflict
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} получен, завершаю...`);
  try {
    await bot.stopPolling();
    console.log('✅ Polling остановлен');
  } catch (e) {
    console.error('Ошибка при остановке polling:', e.message);
  }
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
