import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

// --- Подключение к базе MongoDB (не обязательно для шага 1, но оставим) ---
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Mongo connected'))
    .catch(err => console.error('❌ Mongo error:', err));
} else {
  console.warn('⚠️ MONGODB_URI is not set — skipping Mongo connect for now');
}

// --- Healthcheck ---
app.get('/health', (req, res) => res.json({ ok: true }));

// --- Запуск сервера ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API running on :${PORT}`);
});
