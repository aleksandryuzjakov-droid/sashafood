const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = 3000;

// ВСТАВЬ СЮДА ТОКЕН ОТ BOTFATHER
const BOT_TOKEN = "8567093999:AAFR5cB0iZhQ4OC4byouc2RKcEHLTZh8cGI";

// Твой chat_id уже вставлен
const ADMIN_CHAT_ID = "8529003623";

app.use(express.json());
app.use(express.static(__dirname));

const orders = {};
let nextOrderId = 1000;

const statusNames = {
  waiting: "⏳ Ожидание",
  accepted: "✅ Принят",
  cooking: "🍳 Готовится",
  delivery: "🚗 Едет",
  done: "🏁 Доставлен",
  declined: "❎ Отклонён"
};

function tgUrl(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function sendTelegramOrder(order) {
  if (!BOT_TOKEN || BOT_TOKEN === "ВСТАВЬ_ТОКЕН_БОТА") {
    console.log("BOT_TOKEN не вставлен. Заказ сохранён только на сайте.");
    return;
  }

  const itemsText = order.items.map(i => `${i.emoji || "•"} ${i.name} — ${i.price} ₽`).join("\n");

  const text =
`🍔 Новый заказ №${order.id}

👤 Имя: ${order.name}
🏠 Адрес: ${order.address}

${itemsText}

💰 Итого: ${order.total} ₽

Текущий статус: ${statusNames[order.status]}`;

  await axios.post(tgUrl("sendMessage"), {
    chat_id: ADMIN_CHAT_ID,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Принять", callback_data: `status:${order.id}:accepted` },
          { text: "🍳 Готовится", callback_data: `status:${order.id}:cooking` }
        ],
        [
          { text: "🚗 Едет", callback_data: `status:${order.id}:delivery` },
          { text: "🏁 Доставлен", callback_data: `status:${order.id}:done` }
        ],
        [
          { text: "❎ Отклонить", callback_data: `status:${order.id}:declined` }
        ]
      ]
    }
  });
}

app.post("/api/order", async (req, res) => {
  try {
    const { name, address, items, total } = req.body;

    if (!name || name.length < 2) {
      return res.status(400).json({ ok: false, error: "Введите имя" });
    }

    if (!address || !address.includes("ЖК Акватория")) {
      return res.status(400).json({ ok: false, error: "Адрес выбран неправильно" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Корзина пустая" });
    }

    const id = nextOrderId++;

    const order = {
      id,
      name,
      address,
      items,
      total,
      status: "waiting",
      createdAt: new Date().toISOString()
    };

    orders[id] = order;

    await sendTelegramOrder(order);

    res.json({ ok: true, orderId: id });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: "Ошибка сервера или Telegram" });
  }
});

app.get("/api/order/:id", (req, res) => {
  const order = orders[req.params.id];

  if (!order) {
    return res.status(404).json({ ok: false, error: "Заказ не найден" });
  }

  res.json({ ok: true, order });
});

async function answerCallback(callbackQueryId, text) {
  try {
    await axios.post(tgUrl("answerCallbackQuery"), {
      callback_query_id: callbackQueryId,
      text
    });
  } catch (e) {}
}

async function editTelegramMessage(callback, order) {
  const itemsText = order.items.map(i => `${i.emoji || "•"} ${i.name} — ${i.price} ₽`).join("\n");

  const text =
`🍔 Заказ №${order.id}

👤 Имя: ${order.name}
🏠 Адрес: ${order.address}

${itemsText}

💰 Итого: ${order.total} ₽

Текущий статус: ${statusNames[order.status]}`;

  await axios.post(tgUrl("editMessageText"), {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Принять", callback_data: `status:${order.id}:accepted` },
          { text: "🍳 Готовится", callback_data: `status:${order.id}:cooking` }
        ],
        [
          { text: "🚗 Едет", callback_data: `status:${order.id}:delivery` },
          { text: "🏁 Доставлен", callback_data: `status:${order.id}:done` }
        ],
        [
          { text: "❎ Отклонить", callback_data: `status:${order.id}:declined` }
        ]
      ]
    }
  });
}

// Polling: кнопки Telegram работают даже на localhost, без webhook/ngrok
// ВАЖНО: тут НЕ setInterval, чтобы не было Conflict от нескольких getUpdates одновременно
let lastUpdateId = 0;
let pollingStarted = false;

async function handleTelegramUpdate(update) {
  if (!update.callback_query) return;

  const callback = update.callback_query;
  const data = callback.data || "";

  if (!data.startsWith("status:")) return;

  const [, id, status] = data.split(":");
  const order = orders[id];

  if (!order) {
    await answerCallback(callback.id, "Заказ не найден");
    return;
  }

  order.status = status;
  await answerCallback(callback.id, "Статус изменён: " + statusNames[status]);
  await editTelegramMessage(callback, order);
}

async function startTelegramPolling() {
  if (pollingStarted) return;
  pollingStarted = true;

  if (!BOT_TOKEN || BOT_TOKEN === "ВСТАВЬ_ТОКЕН_БОТА") {
    console.log("BOT_TOKEN не вставлен — кнопки Telegram отключены.");
    return;
  }

  console.log("Telegram кнопки включены ✅");

  while (true) {
    try {
      const res = await axios.get(tgUrl("getUpdates"), {
        params: {
          offset: lastUpdateId + 1,
          timeout: 15,
          allowed_updates: JSON.stringify(["callback_query"])
        },
        timeout: 20000
      });

      for (const update of res.data.result) {
        lastUpdateId = update.update_id;
        await handleTelegramUpdate(update);
      }
    } catch (err) {
      const msg = err.response?.data?.description || err.message;
      console.log("Telegram polling:", msg);

      // маленькая пауза, чтобы не спамить ошибками
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

app.listen(PORT, () => {
  console.log(`Саша Food запущен: http://localhost:${PORT}`);
  console.log("Если вставил BOT_TOKEN — заказы будут приходить в Telegram.");
  startTelegramPolling();
});