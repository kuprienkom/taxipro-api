// bot.js (ESM, webhook)
import { Telegraf } from 'telegraf';

const BOT_TOKEN       = process.env.BOT_TOKEN;
const MINI_APP_URL    = 'https://kuprienkom.github.io/taxipro/'; // правильная ссылка
const CHANNEL_URL     = 'https://t.me/taxipro_channel';
const FEEDBACK_URL    = 'https://t.me/taxipro_official';

if (!BOT_TOKEN) {
  console.warn('⚠️ BOT_TOKEN is missing — bot not started');
  // ничего не запускаем (API поднимется без бота)
}

/** Экспортируемый инстанс (может понадобиться в будущем) */
export const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

/** Роуты/хендлеры бота — подключаем только если есть токен */
if (bot) {
  // /start
  bot.start(async (ctx) => {
    const caption =
`Привет! Это TaxiPro — мини-апка для расчёта ЧИСТОЙ прибыли таксиста.

🚕 Учитывай аренду, топливо, комиссию и налоги
📊 Отчёты: день / неделя / месяц
⚡ Быстро, без Excel и формул

Жми кнопку ниже, чтобы открыть мини-апку.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 Открыть мини-апку', web_app: { url: MINI_APP_URL } }],
        [
          { text: '❓ FAQ', callback_data: 'faq' },
          { text: '💡 Идея/баг', url: FEEDBACK_URL }
        ],
        [
          { text: '📰 Новости', url: CHANNEL_URL }
        ]
      ]
    };

    await ctx.reply(caption, { reply_markup: keyboard });
  });

  // FAQ
  bot.action('faq', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
`FAQ — кратко:
• Как добавить авто? Настройки → заполни данные авто → «Добавить».
• Как внести смену? Главная → карточки «Доход/Расходы».
• Комиссия парка? Настройки: фикс/за заказ/процент.
• Налог? Самозанятый 4% или ИП 6%.
• Отчёты? Вкладка «Отчёты»: 7/30 дней, сравнение по классам.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть мини-апку', web_app: { url: MINI_APP_URL } }]] } }
    );
  });
}

/**
 * Настройка вебхука и подключение middleware в Express.
 * Вызывать из server.js ПЕРЕД app.listen(...).
 */
// ЗАМЕНИТЬ содержимое setupBotWebhook целиком:
export async function setupBotWebhook(app) {
  if (!bot) return;

  const BASE_URL = process.env.BASE_URL;          // https://taxipro-api.onrender.com
  const SECRET   = process.env.TG_WEBHOOK_SECRET; // как в Render → Environment
  const PATH     = '/tg/webhook';
  const WEBHOOK_URL = `${BASE_URL}${PATH}`;

  if (!BASE_URL) { console.warn('⚠️ BASE_URL is not set — skip webhook'); return; }
  if (!SECRET)   { console.warn('⚠️ TG_WEBHOOK_SECRET is not set — skip webhook'); return; }

  // 1) ЯВНО обрабатываем только POST и логируем
  app.post(PATH, (req, res, next) => {
    const got = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
    const ok  = got === SECRET;
    console.log('➡️  /tg/webhook hit', { method: req.method, ok, len: (req.headers['content-length'] || '0') });

    if (!ok) return res.sendStatus(401);

    // прокидываем апдейт в Telegraf
    return bot.webhookCallback(PATH)(req, res, next);
    // альтернативно: return bot.handleUpdate(req.body, res);
  });

  // 2) Регистрируем вебхук у Telegram (с секретом)
  await bot.telegram.setWebhook(WEBHOOK_URL, { secret_token: SECRET });
  console.log('🤖 Webhook set:', WEBHOOK_URL);
}

