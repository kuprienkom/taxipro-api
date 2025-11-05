// server.js
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
  mongoose
    .connect(process.env.MONGODB_URI, { dbName: 'taxipro' })
    .then(() => console.log('✅ Mongo connected'))
    .catch(err => console.error('❌ Mongo error:', err));
}

// ---------- Models ----------
const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      tgId: { type: Number, unique: true, index: true },
      username: String,
      first_name: String,
      last_name: String,
      language_code: String,
      photo_url: String,
    },
    { timestamps: true }
  )
);

const Presence = mongoose.model(
  'Presence',
  new mongoose.Schema({
    tgId: { type: Number, unique: true, index: true },
    last_seen: { type: Date, default: Date.now },
  })
);
Presence.schema.index({ last_seen: -1 });

/**
 * Shift: одна смена на одну дату для конкретной машины.
 * carName/carClass — дублируем в документ для быстрых сводок (optional).
 */
const Shift = mongoose.model(
  'Shift',
  new mongoose.Schema(
    {
      tgId: { type: Number, required: true, index: true },
      carId: { type: String, required: true, index: true },
      carName: { type: String, default: null }, // опционально приходит с клиента
      carClass: { type: String, default: null }, // опционально приходит с клиента
      date: { type: String, required: true }, // YYYY-MM-DD
      payload: { type: Object, default: {} }, // {income, tips, rent, fuel, ... settings:{}}
      updatedAt: { type: Date, default: Date.now },
    },
    { versionKey: false }
  )
);
Shift.schema.index({ tgId: 1, carId: 1, date: 1 }, { unique: true });

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
  try {
    user = JSON.parse(urlParams.get('user'));
  } catch {
    return { ok: false, error: 'bad_user_json' };
  }
  return { ok: true, user, params: Object.fromEntries(entries) };
}

// Безопасные числа
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Локальная логика комиссий/налога — зеркалим фронт
function calcCommission(payload = {}) {
  const s = payload.settings || {};
  const park = s.park || { mode: 'none', dayFee: 0, orderFee: 0, percent: 0 };
  const mode = park.mode || 'none';

  const hasActivity =
    n(payload.income) > 0 || n(payload.orders) > 0 || n(payload.otherIncome) > 0 || n(payload.tips) > 0;

  // ручной ввод имеет приоритет
  if (payload.commissionManual != null) {
    return Math.max(0, Math.round(n(payload.commissionManual)));
  }

  if (mode === 'none') return 0;
  if (mode === 'day') return hasActivity ? n(park.dayFee) : 0;
  if (mode === 'order') return n(payload.orders) * n(park.orderFee);
  if (mode === 'percent') return n(payload.income) * (n(park.percent) / 100);
  return 0;
}

function calcTax(payload = {}) {
  const s = payload.settings || {};
  const mode = s.taxMode || 'none';

  if (payload.taxManual != null) {
    return Math.max(0, Math.round(n(payload.taxManual)));
  }
  if (mode === 'self4') return n(payload.income) * 0.04;
  if (mode === 'ip6') return n(payload.income) * 0.06;
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

// ---------- Routes ----------

// Healthcheck
app.get('/health', (req, res) => res.json({ ok: true }));

// Авторизация/апсерт пользователя
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData } = req.body;
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(403).json({ error: check.error });

    const u = check.user;
    console.log('🔐 AUTH hit', u.id, u.username || u.first_name || '');

    await User.updateOne(
      { tgId: u.id },
      {
        $set: {
          username: u.username ?? null,
          first_name: u.first_name ?? null,
          last_name: u.last_name ?? null,
          language_code: u.language_code ?? null,
          photo_url: u.photo_url ?? null,
        },
      },
      { upsert: true }
    );

    await Presence.updateOne({ tgId: u.id }, { $set: { last_seen: new Date() } }, { upsert: true });

    res.json({ status: 'ok', userId: u.id });
  } catch (e) {
    console.error('❌ /api/auth/telegram error:', e);
    res.status(500).json({ error: 'auth_failed' });
  }
});

// Пинг активности
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

// ---------- Shifts ----------

// Upsert смены (tgId+carId+date уникальны)
app.post('/api/shifts', async (req, res) => {
  try {
    const initDataHeader = req.header('X-Telegram-Init-Data');
    const initData = initDataHeader || req.body?.initData || '';
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const { carId, date, payload, carName, carClass } = req.body || {};
    if (!carId) return res.status(400).json({ ok: false, error: 'CAR_ID_REQUIRED' });
    if (!date) return res.status(400).json({ ok: false, error: 'DATE_REQUIRED' });

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

    return res.json({ ok: true, row });
  } catch (e) {
    console.error('❌ /api/shifts upsert error', e);
    return res.status(500).json({ ok: false, error: 'UPSERT_FAILED' });
  }
});

// Выборка смен (фильтр по дате и опционально carId)
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
      if (from) q.date.$gte = from;
      if (to) q.date.$lte = to;
    }

    const rows = await Shift.find(q).sort({ date: 1 }).lean();
    res.json({ ok: true, rows });
  } catch (e) {
    console.error('❌ /api/shifts get error', e);
    res.status(500).json({ ok: false, error: 'GET_FAILED' });
  }
});

// CRUD по id (для админки/ручной правки)
app.get('/api/shifts/:id', async (req, res) => {
  try {
    const doc = await Shift.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, row: doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'GET_BY_ID_FAILED' });
  }
});

app.put('/api/shifts/:id', async (req, res) => {
  try {
    const { payload, carName, carClass } = req.body || {};
    const doc = await Shift.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...(payload ? { payload } : {}),
          ...(carName ? { carName } : {}),
          ...(carClass ? { carClass } : {}),
          updatedAt: new Date(),
        },
      },
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
    const r = await Shift.findByIdAndDelete(req.params.id).lean();
    if (!r) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DELETE_FAILED' });
  }
});

// ---------- Aggregations / Summaries ----------

// Список машин пользователя с короткой сводкой
app.get('/api/cars', async (req, res) => {
  try {
    const initDataHeader = req.header('X-Telegram-Init-Data');
    const initData = initDataHeader || req.query?.initData || '';
    const check = verifyInitData(initData);
    if (!check.ok) return res.status(401).json({ ok: false, error: check.error });

    const tgId = Number(check.user.id);
    const rows = await Shift.find({ tgId }).lean();

    const byCar = new Map();
    for (const r of rows) {
      const key = r.carId;
      const cur = byCar.get(key) || {
        carId: r.carId,
        carName: r.carName || null,
        carClass: r.carClass || null,
        lastDate: null,
        days: 0,
        income: 0,
        profit: 0,
        gross: 0,
      };

      const p = r.payload || {};
      const { gross, profit } = calcProfit(p);

      cur.days += 1;
      cur.income += n(p.income);
      cur.profit += profit;
      cur.gross += gross;
      if (!cur.lastDate || r.date > cur.lastDate) cur.lastDate = r.date;

      byCar.set(key, cur);
    }

    res.json({ ok: true, cars: Array.from(byCar.values()) });
  } catch (e) {
    console.error('❌ /api/cars error', e);
    res.status(500).json({ ok: false, error: 'CARS_FAILED' });
  }
});

// Общая сводка по пользователю (по всем авто)
app.get('/api/users/:tgId/summary', async (req, res) => {
  try {
    const initDataHeader = req.header('X-Telegram-Init-Data');
    const initData = initDataHeader || req.query?.initData || '';
    const check = verifyInitData(initData);
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

      if (!cars[r.carId]) {
        cars[r.carId] = {
          carId: r.carId,
          carName: r.carName || null,
          carClass: r.carClass || null,
          days: 0,
          income: 0,
          profit: 0,
          gross: 0,
        };
      }
      cars[r.carId].days += 1;
      cars[r.carId].income += n(p.income);
      cars[r.carId].profit += profit;
      cars[r.carId].gross += gross;
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
