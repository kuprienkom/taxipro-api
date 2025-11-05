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

// ---------- Models ----------
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
Presence.schema.index({ last_seen: -1 });

// === TaxiPro · Shift model (с учётом машины + снапшот названия) ===
const Shift = mongoose.model('Shift', new mongoose.Schema({
  tgId:    { type: Number, required: true, index: true },
  carId:   { type: String, required: true, index: true },
  date:    { type: String, required: true },            // YYYY-MM-DD (нормализуем)
  carName: { type: String, default: null },             // снапшот
  carClass:{ type: String, default: null },             // снапшот
  payload: { type: Object, default: {} },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false }));
Shift.schema.index({ tgId: 1, carId: 1, date: 1 }, { unique: true });
// === /Shift model ===

// Синхронизация индексов
mongoose.connection.once('open', async () => {
  try {
    await Presence.syncIndexes();
    await Shift.syncIndexes();
    console.log('🧭 Presence indexes synced');
    console.log('🧭 Shift indexes synced');
  } catch (e) {
    console.error('❌ Index sync error:', e);
  }
});

// ---------- Helpers ----------
function normISO(d) {
  try { return new Date(d).toISOString().slice(0,10); }
  catch { return String(d).slice(0,10); }
}

// ---------- Валидация initData ----------
function verifyInitData(initDataRaw) {
  if (!initDataRaw) return { ok: false, error: 'no_init_data' };
  const urlParams = new URLSearchParams(initDataRaw);
  const hash = urlParams.get('hash');
  if (!hash) return { ok: false, error: 'no_hash' };
  urlParams.delete('hash');
  const entries = Array.from(urlParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const botToken = process.env.BOT_TOKEN || '';
  if (!botToken) return { ok: false, error: 'no_bot_token' };
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calc !== hash) return { ok: false, error: 'bad_hash' };
  const authDate = Number(urlParams.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 300) return { ok: false, error: 'stale_auth' };
  let user = null;
  try { user = JSON.parse(urlParams.get('user')); } catch { return { ok: false, error: 'bad_user_json' }; }
  return { ok: true, user, params: Object.fromEntries(entries) };
}

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });
    const u = check.user;
    console.log('🔐 AUTH hit', u.id, u.username || u.first_name || '');
    await User.updateOne(
      { tgId: u.id },
      { $set: { username: u.username ?? null, first_name: u.first_name ?? null, last_name: u.last_name ?? null, language_code: u.language_code ?? null, photo_url: u.photo_url ?? null } },
      { upsert: true }
    );
    await Presence.updateOne({ tgId: u.id }, { $set: { last_seen: new Date() } }, { upsert: true });
    res.json({ status: 'ok', userId: u.id });
  } catch (e) {
    console.error('❌ /api/auth/telegram error:', e);
    res.status(500).json({ error: 'auth_failed' });
  }
});

app.post('/api/ping', async (req, res) => {
  try {
    const { initData, screen } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });
    const { id } = check.user;
    await Presence.updateOne({ tgId: id }, { $set: { last_seen: new Date() } }, { upsert: true });
    console.log('👀 ping', { tgId: id, screen: screen || 'unknown' });
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('❌ /api/ping error:', e);
    res.status(500).json({ error: 'ping_failed' });
  }
});

// --- POST /api/shifts (апсерт по tgId+carId+date) ---
app.post('/api/shifts', async (req, res) => {
  try {
    const initDataHeader = req.header('X-Telegram-Init-Data');
    const initData = initDataHeader || req.body?.initData || '';
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { carId, date, payload, carName, carClass } = req.body || {};
    if (!carId) return res.status(400).json({ ok:false, error:'CAR_ID_REQUIRED' });
    if (!date)  return res.status(400).json({ ok:false, error:'DATE_REQUIRED' });

    const dateISO = normISO(date);

    const row = await Shift.findOneAndUpdate(
      { tgId, carId, date: dateISO },
      { $set: { payload: payload ?? {}, carName: carName ?? null, carClass: carClass ?? null, updatedAt: new Date() } },
      { new: true, upsert: true }
    ).lean();

    return res.json({ ok: true, row });
  } catch (e) {
    console.error('❌ /api/shifts upsert error', e);
    return res.status(500).json({ ok:false, error:'UPSERT_FAILED' });
  }
});

// --- GET /api/shifts (фильтр по дате, опционально carId) ---
app.get('/api/shifts', async (req, res) => {
  try {
    const initDataHeader = req.header('X-Telegram-Init-Data');
    const initData = initDataHeader || req.query?.initData || '';
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { from, to, carId } = req.query || {};

    const q = { tgId };
    if (carId) q.carId = String(carId);
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = normISO(from);
      if (to)   q.date.$lte = normISO(to);
    }

    const rows = await Shift.find(q).sort({ carName: 1, date: -1 }).lean();
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('❌ /api/shifts get error', e);
    res.status(500).json({ ok: false, error: 'GET_FAILED' });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API running on :${PORT}`);
});
