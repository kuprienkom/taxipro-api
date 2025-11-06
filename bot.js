// bot.js (ESM)
import { Telegraf } from 'telegraf';

const BOT_TOKEN    = process.env.BOT_TOKEN;
const MINI_APP_URL = 'https://kuprienkom.github.io/taxipro/';
const CHANNEL_URL  = 'https://t.me/taxipro_channel';
const FEEDBACK_URL = 'https://t.me/taxipro_official';

if (!BOT_TOKEN) {
  console.warn('⚠️ BOT_TOKEN is missing — bot not started');
  // мягко выходим, чтобы API всё равно поднялся
  return;
}

const bot = new Telegraf(BOT_TOKEN);

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
• Как добавить авто? Открой мини-апку → Настройки → Заполни данные авто и нажми «Добавить»
• Как внести смену? Открой мини-апку → Главная → карточки «Доход/Расходы».
• Как учитывается комиссия? В «Настройках» выбери режим: фикс/за заказ/процент.
• Налог? «Самозанятый 4%» или «ИП 6%».
• Где отчёты? Вкладка «Отчёты»: 7/30 дней, сравнение по классам.`,
    { reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть мини-апку', web_app: { url: MINI_APP_URL } }]] } }
  );
});

// запуск
bot.launch()
  .then(() => console.log('🤖 Bot launched (polling)'))
  .catch((e) => console.error('Bot launch error', e));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
