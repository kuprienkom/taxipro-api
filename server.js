import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import mongoose from 'mongoose';

const app = express();
const ORIGINS = ['https://t.me', 'https://web.telegram.org', 'https://kuprienkom.github.io'];
app.use(cors({ origin: ORIGINS }));
app.use(express.json());

// ---------- MongoDB ----------
if (!process.env.MONGODB_URI) {
  console.warn('⚠️ MONGODB_URI is not set — Mongo connection will be skipped');
} else {
  mongoose.connect(process.env.MONGODB_URI, { dbName: 'taxipro' })
    .then(() => console.log('✅ Mongo connected'))
    .catch(err => console.error('❌ Mongo error:', err));
}

// Модели
const User = mongoose.model('User', new mongoose.Schema({
  tgId: { type: Number, unique: true, index: true },
  username: String,
  first_name: String,
  last_name: String,
  language_code: String,
  photo_url: String,
}, { timestamps: true }));

const Presence = mongoose.model('Presence', new mongoose.Schema({
  tgId: { type: Number, unique: true, index: true },
  last_seen: { type: Date, default: Date.now }
}));
// >>> добавленный индекс для быстрого поиска по last_seen
Presence.schema.index({ last_seen: -1 });
// Синхронизируем индексы после установления соединения с Mongo
mongoose.connection.once('open', async () => {
  try {
    await Presence.syncIndexes();
    console.log('🧭 Presence indexes synced');
  } catch (e) {
    console.error('❌ Presence index sync error:', e);
  }
});


// ---------- Валидация initData (официальный алгоритм) ----------
function verifyInitData(initDataRaw) {
  if (!initDataRaw) return { ok: false, error: 'no_init_data' };

  const urlParams = new URLSearchParams(initDataRaw);
  const hash = urlParams.get('hash');
  if (!hash) return { ok: false, error: 'no_hash' };

  // Строка для подписи: все пары, кроме hash, по алфавиту
  urlParams.delete('hash');
  const entries = Array.from(urlParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // secret_key = HMAC_SHA256(bot_token, "WebAppData")
  const botToken = process.env.BOT_TOKEN || '';
  if (!botToken) return { ok: false, error: 'no_bot_token' };

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calc !== hash) return { ok: false, error: 'bad_hash' };

  // Доп. защита по времени
  const authDate = Number(urlParams.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 300) return { ok: false, error: 'stale_auth' };

  // user приходит как JSON-строка
  let user = null;
  try {
    user = JSON.parse(urlParams.get('user'));
  } catch {
    return { ok: false, error: 'bad_user_json' };
  }

  return { ok: true, user, params: Object.fromEntries(entries) };
}
// ---------- Роуты ----------

// Healthcheck (как в шаге 1)
app.get('/health', (req, res) => res.json({ ok: true }));

// Авторизация/апсерт пользователя (при первом заходе мини-апки)
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });

    const u = check.user; // { id, username, first_name, ... }
    console.log('🔐 AUTH hit', u.id, u.username || u.first_name || '');


    // апсерт пользователя
    await User.updateOne(
      { tgId: u.id },
      {
        $set: {
          username: u.username ?? null,
          first_name: u.first_name ?? null,
          last_name: u.last_name ?? null,
          language_code: u.language_code ?? null,
          photo_url: u.photo_url ?? null,
        }
      },
      { upsert: true }
    );

    // заодно отметим активность
    await Presence.updateOne(
      { tgId: u.id },
      { $set: { last_seen: new Date() } },
      { upsert: true }
    );

    res.json({ status: 'ok', userId: u.id });
  } catch (e) {
    console.error('❌ /api/auth/telegram error:', e);
    res.status(500).json({ error: 'auth_failed' });
  }
});

// Пинг активности (будем дёргать каждые 30–60 сек из клиента)
app.post('/api/ping', async (req, res) => {
  try {
    const { initData, screen } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });

    const { id } = check.user;
    await Presence.updateOne(
      { tgId: id },
      { $set: { last_seen: new Date() } },
      { upsert: true }
    );
    // просто для логов
    console.log('👀 ping', { tgId: id, screen: screen || 'unknown' });
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('❌ /api/ping error:', e);
    res.status(500).json({ error: 'ping_failed' });
  }
});

// ---------- Запуск сервера ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API running on :${PORT}`);
});
