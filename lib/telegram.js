"use strict";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

function appUrl(env) {
  const value = env.APP_URL || env.DOMAIN || env.WEBHOOK_URL;
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return env.APP_URL ? url.href : url.origin + "/";
  } catch {
    return null;
  }
}

async function runTelegram(token, url) {
  const app = {text:"Играть в шашки",web_app:{url}};
  async function call(method,data) {
    const response = await fetch("https://api.telegram.org/bot" + token + "/" + method,{
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify(data), signal:AbortSignal.timeout(40_000)
    });
    const json = await response.json();
    if (!json.ok) {
      const error = new Error("Telegram " + method + " — код " + json.error_code);
      error.code = json.error_code;
      throw error;
    }
    return json.result;
  }

  try {
    await call("setChatMenuButton",{menu_button:{type:"web_app",...app}});
  } catch (error) {
    console.warn("Кнопку меню можно настроить через BotFather.", error.code ?? "сетевая ошибка");
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await call("getUpdates",{offset,timeout:28,allowed_updates:["message"]});
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (msg?.chat.type !== "private" || !/^\/(start|play)(?:@\w+)?(?:\s|$)/i.test(msg.text ?? "")) continue;
        try {
          await call("sendMessage",{chat_id:msg.chat.id,text:"♟ Шашки.App\nИграй онлайн или тренируйся с ботом.",
            reply_markup:{inline_keyboard:[[app]]}});
        } catch (error) {
          console.warn("Ответ бота не отправлен.", error.code ?? "сетевая ошибка");
        }
      }
    } catch (error) {
      const message = error.code === 409 ? "Останови другой экземпляр бота или отключи ранее настроенный Telegram webhook." :
        "Повтор подключения к Telegram.";
      console.warn(message,error.code ?? "сетевая ошибка");
      await wait(10_000);
    }
  }
}

module.exports = {appUrl, runTelegram};
