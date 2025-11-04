import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

// --- Подключение к базе MongoDB ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Mongo connected'))
  .catch(err => console.error('❌ Mongo error:', err));

// --- Модель пользователей ---
const User = mongoose.model('User', new mongoose.Schema({
  tgId: { type: Number, unique: true },
  first_name: String,
  username: String,
  joinedAt: { type: Date, default: Date.now }
}));

// --- Модель смен ---
const Shift = mongoose.model('Shift', new mongoose.Schema({
  userId: Number,
  date: String,
  income: Number,
  tipsExtra: Number,
  rent: Number,
  fuel: Number,
  other: Number,
  fines: Number,
  hours: Number,
  distance: Number,
  profit: Number,
  createdAt: { type: Date, default: Date.now }
}));

// --- Проверка подписи Telegram WebApp ---
function verifyInitData(initDataRaw) {
  const urlParams = new URLSearchParams(initDataRaw);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckArr = [];
  for (const [k, v] of Array.from(urlParams.entries()).sort()) {
    dataCheckArr.push(`${k}=${v}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return hmac === hash;
}

// --- Авторизация Telegram WebApp ---
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData, user } = req.body;
    if (!initData || !user?.id)
      return res.status(400).json({ error: 'Bad payload' });

    const ok = verifyInitData(initData);
    if (!ok)
      return res.status(403).json({ error: 'Invalid signature' });

    const tgId = user.id;
    let doc = await User.findOne({ tgId });
    if (!doc) {
      doc = await User.create({
        tgId,
        first_name: user.first_name,
        username: user.username
      });
      console.log('🆕 New user:', tgId, user.username || user.first_name);
    }
    res.json({ status: 'ok', userId: tgId });
  } catch (e) {
    console.error('❌ Auth error:', e);
    res.status(500).json({ error: 'Auth failed' });
  }
});

// --- Пинг активности пользователя ---
app.post('/api/ping', async (req, res) => {
  const { userId, screen } = req.body;
  console.log('👀 open:', userId, screen);
  res.json({ status: 'ok' });
});

// --- Сохранение смены ---
app.post('/api/shifts', async (req, res) => {
  try {
    const shift = await Shift.create(req.body);
    res.json({ status: 'ok', shift });
  } catch (e) {
    console.error('❌ Shift save error:', e);
    res.status(500).json({ error: 'Failed to save shift' });
  }
});

// --- Получение смен пользователя ---
app.get('/api/shifts', async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    if (!userId)
      return res.status(400).json({ error: 'userId required' });

    const q = { userId: Number(userId) };
    if (from || to) q.date = {};
    if (from) q.date.$gte = from;
    if (to) q.date.$lte = to;

    const shifts = await Shift.find(q).sort({ date: 1 });
    res.json({ shifts });
  } catch (e) {
    console.error('❌ Shift fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// --- Запуск сервера ---
app.listen(process.env.PORT || 3000, () => {
  console.log(`✅ API running on :${process.env.PORT || 3000}`);
});
