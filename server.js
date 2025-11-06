// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import mongoose from 'mongoose';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => {
  // Короткий access-лог
  console.log('[REQ]', req.method, req.path, {
    query: req.query,
    source: req.body?.source,
  });
  next();
});

const ORIGINS = ['https://t.me', 'https://web.telegram.org', 'https://kuprienkom.github.io'];

app.use(cors({
  origin: ORIGINS,
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'],
  methods: ['GET','POST','PUT','DELETE','OPTIONS']
}));

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

/** Shift: одна смена на дату для конкретной машины. */
const Shift = mongoose.model('Shift', new mongoose.Schema({
  tgId:    { type: Number, required: true, index: true },
  carId:   { type: String, required: true, index: true },
  carName: { type: String, default: null },
  carClass:{ type: String, default: null },
  date:    { type: String, required: true }, // YYYY-MM-DD
  payload: { type: Object, default: {} },
  updatedAt:{ type: Date, default: Date.now },
}, { versionKey: false }));
Shift.schema.index({ tgId: 1, carId: 1, date: 1 }, { unique: true });
Shift.schema.index({ tgId: 1, updatedAt: -1 });


// ---------- Index sync ----------
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
  try { user = JSON.parse(urlParams.get('user')); }
  catch { return { ok: false, error: 'bad_user_json' }; }

  return { ok: true, user, params: Object.fromEntries(entries) };
}

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function calcCommission(payload = {}) {
  const s = payload.settings || {};
  const park = s.park || { mode: 'none', dayFee: 0, orderFee: 0, percent: 0 };
  const mode = park.mode || 'none';
  const hasActivity = n(payload.income) > 0 || n(payload.orders) > 0 || n(payload.otherIncome) > 0 || n(payload.tips) > 0;
  if (payload.commissionManual != null) return Math.max(0, Math.round(n(payload.commissionManual)));
  if (mode === 'none') return 0;
  if (mode === 'day') return hasActivity ? n(park.dayFee) : 0;
  if (mode === 'order') return n(payload.orders) * n(park.orderFee);
  if (mode === 'percent') return n(payload.income) * (n(park.percent) / 100);
  return 0;
}
function calcTax(payload = {}) {
  const s = payload.settings || {};
  const mode = s.taxMode || 'none';
  if (payload.taxManual != null) return Math.max(0, Math.round(n(payload.taxManual)));
  if (mode === 'self4') return n(payload.income) * 0.04;
  if (mode === 'ip6')   return n(payload.income) * 0.06;
  return 0;
}
function calcProfit(payload = {}) {
  const gross = n(payload.income) + n(payload.tips) + n(payload.otherIncome);
  const commission = calcCommission(payload);
  const tax = calcTax(payload);
  const costs = n(payload.rent) + n(payload.fuel) + n(payload.otherExpense) + n(payload.fines) + commission + tax;
  const profit = gross - costs;
  return { gross, commission, tax, costs, profit };
}
function requireAuth(req) {
  const initDataHeader = req.header('X-Telegram-Init-Data');
  const initData = initDataHeader || req.body?.initData || req.query?.initData || '';
  const check = verifyInitData(initData);
  return { check, initData };
}

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ ok: true }));

// Auth + presence
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });
    const u = check.user;

    await User.updateOne(
      { tgId: u.id },
      { $set: {
        username: u.username ?? null,
        first_name: u.first_name ?? null,
        last_name: u.last_name ?? null,
        language_code: u.language_code ?? null,
        photo_url: u.photo_url ?? null,
      }},
      { upsert: true }
    );
    await Presence.updateOne({ tgId: u.id }, { $set: { last_seen: new Date() } }, { upsert: true });
// ВСТАВИТЬ ПЕРЕД res.json(...)
const start_param = check.params?.start_param ?? null;
console.log('✅ auth', {
  tgId: u.id,
  user: u.username || null,
  start_param,
  source: req.body?.source ?? null
});

    res.json({ status: 'ok', userId: u.id });
  } catch (e) {
    console.error('❌ /api/auth/telegram error:', e);
    res.status(500).json({ error: 'auth_failed' });
  }
});

app.post('/api/ping', async (req, res) => {
  try {
    const { initData, screen, source } = req.body || {};
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });

    const { id, username } = check.user || {};
    const start_param = check.params?.start_param ?? null;

    await Presence.updateOne(
      { tgId: id },
      { $set: { last_seen: new Date() } },
      { upsert: true }
    );

    console.log('⚡ ping', {
      tgId: id,
      user: username || null,
      screen: screen || 'unknown',
      source: source ?? null,
      start_param
    });

    res.json({ status: 'ok' });
  } catch (e) {
    console.error('❌ /api/ping error:', e);
    res.status(500).json({ error: 'ping_failed' });
  }
});


// ---------- Shifts ----------
app.post('/api/shifts', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { carId, date, payload, carName, carClass } = req.body || {};
    if (!carId) return res.status(400).json({ ok: false, error: 'CAR_ID_REQUIRED' });
    if (!date)  return res.status(400).json({ ok: false, error: 'DATE_REQUIRED' });

    const row = await Shift.findOneAndUpdate(
      { tgId, carId, date },
      { $set: {
        payload: payload ?? {},
        updatedAt: new Date(),
        ...(carName ? { carName } : {}),
        ...(carClass ? { carClass } : {}),
      }},
      { new: true, upsert: true }
    ).lean();

    res.json({ ok: true, row });
  } catch (e) {
    console.error('❌ /api/shifts upsert error', e);
    res.status(500).json({ ok: false, error: 'UPSERT_FAILED' });
  }
});

// BULK upsert — для офлайн-очереди
app.post('/api/shifts/bulk', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });
    const tgId = Number(check.user.id);

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'EMPTY_ITEMS' });

    const results = [];
    for (const [idx, it] of items.entries()) {
      try {
        const { carId, date, payload, carName, carClass } = it || {};
        if (!carId || !date) {
          results.push({ idx, ok: false, error: 'CAR_ID_AND_DATE_REQUIRED' });
          continue;
        }
        const row = await Shift.findOneAndUpdate(
          { tgId, carId, date },
          {
            $set: {
              payload: payload ?? {},
              updatedAt: new Date(),
              ...(carName ? { carName } : {}),
              ...(carClass ? { carClass } : {}),
            },
          },
          { new: true, upsert: true }
        ).lean();
        
results.push({
  idx,
  ok: true,
  _id: row?._id,
  carId: row?.carId,
  date: row?.date,
  updatedAt: row?.updatedAt
});

      } catch {
        results.push({ idx, ok: false, error: 'UPSERT_FAILED' });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    console.error('❌ /api/shifts/bulk error', e);
    res.status(500).json({ ok: false, error: 'BULK_FAILED' });
  }
});


// Listing
app.get('/api/shifts', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { from, to, carId, updatedSince } = req.query || {};

    const q = { tgId };
    if (carId) q.carId = String(carId);
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = from;
      if (to)   q.date.$lte = to;
    }
    if (updatedSince) {
      const since = new Date(updatedSince);
      if (!isNaN(since.getTime())) {
        q.updatedAt = { ...(q.updatedAt || {}), $gt: since };
      }
    }

    const rows = await Shift.find(q).sort({ date: 1 }).lean();
    // rows уже содержат updatedAt
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('❌ /api/shifts get error', e);
    res.status(500).json({ ok: false, error: 'GET_FAILED' });
  }
});


// CRUD by id (с проверкой владельца)
app.get('/api/shifts/:id', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });
    const tgId = Number(check.user.id);

    const doc = await Shift.findOne({ _id: req.params.id, tgId }).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, row: doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'GET_BY_ID_FAILED' });
  }
});

app.put('/api/shifts/:id', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });
    const tgId = Number(check.user.id);

    const { payload, carName, carClass } = req.body || {};
    const doc = await Shift.findOneAndUpdate(
      { _id: req.params.id, tgId },
      { $set: {
        ...(payload ? { payload } : {}),
        ...(carName ? { carName } : {}),
        ...(carClass ? { carClass } : {}),
        updatedAt: new Date(),
      }},
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, row: doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'UPDATE_FAILED' });
  }
});

app.delete('/api/shifts/:id', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });
    const tgId = Number(check.user.id);

    const r = await Shift.findOneAndDelete({ _id: req.params.id, tgId }).lean();
    if (!r) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DELETE_FAILED' });
  }
});

// ---------- Aggregations ----------
app.get('/api/cars', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const rows = await Shift.find({ tgId }).lean();

    const byCar = new Map();
    for (const r of rows) {
      const cur = byCar.get(r.carId) || {
        carId: r.carId, carName: r.carName || null, carClass: r.carClass || null,
        lastDate: null, days: 0, income: 0, profit: 0, gross: 0,
      };
      const p = r.payload || {};
      const { gross, profit } = calcProfit(p);
      cur.days += 1;
      cur.income += n(p.income);
      cur.profit += profit;
      cur.gross += gross;
      if (!cur.lastDate || r.date > cur.lastDate) cur.lastDate = r.date;
      byCar.set(r.carId, cur);
    }

    res.json({ ok: true, cars: Array.from(byCar.values()) });
  } catch (e) {
    console.error('❌ /api/cars error', e);
    res.status(500).json({ ok: false, error: 'CARS_FAILED' });
  }
});

// summary по конкретному авто
app.get('/api/cars/:carId/summary', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { carId } = req.params;
    const { from, to } = req.query || {};

    const q = { tgId, carId: String(carId) };
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = from;
      if (to)   q.date.$lte = to;
    }

    const rows = await Shift.find(q).lean();
    const total = { days: 0, income: 0, profit: 0, gross: 0 };
    for (const r of rows) {
      const p = r.payload || {};
      const { gross, profit } = calcProfit(p);
      total.days += 1;
      total.income += n(p.income);
      total.profit += profit;
      total.gross += gross;
    }

    const meta = rows[0] ? { carId, carName: rows[0].carName || null, carClass: rows[0].carClass || null } : { carId };
    res.json({ ok: true, meta, total });
  } catch (e) {
    console.error('❌ /api/cars/:carId/summary error', e);
    res.status(500).json({ ok: false, error: 'CAR_SUMMARY_FAILED' });
  }
});

// общая сводка по пользователю
app.get('/api/users/:tgId/summary', async (req, res) => {
  try {
    const { check } = requireAuth(req);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgIdParam = req.params.tgId === 'me' ? check.user.id : req.params.tgId;
    const tgId = Number(tgIdParam);

    const rows = await Shift.find({ tgId }).lean();
    const total = { days: 0, income: 0, profit: 0, gross: 0 };
    const cars = {};

    for (const r of rows) {
      const p = r.payload || {};
      const { gross, profit } = calcProfit(p);
      total.days += 1;
      total.income += n(p.income);
      total.profit += profit;
      total.gross += gross;

      if (!cars[r.carId]) cars[r.carId] = {
        carId: r.carId, carName: r.carName || null, carClass: r.carClass || null,
        days: 0, income: 0, profit: 0, gross: 0
      };
      cars[r.carId].days   += 1;
      cars[r.carId].income += n(p.income);
      cars[r.carId].profit += profit;
      cars[r.carId].gross  += gross;
    }

    res.json({ ok: true, total, cars: Object.values(cars) });
  } catch (e) {
    console.error('❌ /api/users/:tgId/summary error', e);
    res.status(500).json({ ok: false, error: 'SUMMARY_FAILED' });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API running on :${PORT}`);
});
