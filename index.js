"use strict";

const {createServer} = require("node:http");
const {readFileSync, mkdirSync} = require("node:fs");
const {join} = require("node:path");
const {Worker} = require("node:worker_threads");
const {randomInt} = require("node:crypto");
const {openStore} = require("./lib/store");
const {verifier} = require("./lib/auth");
const {available, viewPosition, complete, jump} = require("./lib/game");
const {legalMoves} = require("./lib/engine");
const {AI_LEVEL, createAiPlayer} = require("./lib/ai-player");
const {appUrl, runTelegram} = require("./lib/telegram");

const AI_HISTORY_LIMIT = 8;

function rememberAiTurn(game, comment = null) {
  if (game.level !== AI_LEVEL) return;
  if (comment) game.comment = comment;
  game.aiHistory = [...(game.aiHistory ?? []),{...game.last,side:-game.turn,comment}].slice(-AI_HISTORY_LIMIT);
}

const staticContent = new Map([
  ["/", ["index.html","text/html; charset=utf-8"]],
  ["/style.css", ["style.css","text/css; charset=utf-8"]],
  ["/app.js", ["app.js","text/javascript; charset=utf-8"]],
  ["/mark.svg", ["mark.svg","image/svg+xml"]]
]);
const security = {
  "Content-Security-Policy":"default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"no-referrer"
};

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status,{
    ...security, "Content-Type":type, "Cache-Control":"no-store"
  });
  response.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readBody(request) {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 2048) throw Object.assign(new Error("Запрос слишком большой."),{status:413});
  }
  try {
    const json = JSON.parse(data || "{}");
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json;
  } catch {
    throw Object.assign(new Error("Неверный формат запроса."),{status:400});
  }
}

function createApp({token, databasePath, now = Date.now, aiPlayer = null}) {
  if (!token) throw new Error("Нужен BOT_TOKEN.");
  const assets = new Map([...staticContent].map(([url,[file,type]]) => [
    url, [readFileSync(join(__dirname,"public",file)),type]
  ]));
  const store = openStore(databasePath);
  const authenticate = verifier(token);
  const jobs = new Map();
  let worker;

  function finishBotMove(id, job, move, comment = null) {
    if (jobs.get(id) !== job) return;
    jobs.delete(id);
    const row = store.get(id);
    if (!row || row.rev !== job.rev || row.game.result) return;
    const choice = move || legalMoves(row.game.board,row.game.turn)[0];
    if (!choice) return;
    complete(row.game,choice);
    rememberAiTurn(row.game,comment);
    store.save(row,now());
  }

  function currentWorker() {
    if (worker) return worker;
    const instance = new Worker(join(__dirname,"lib","bot-worker.js"));
    worker = instance;
    instance.on("message", ({id,move}) => {
      const job = jobs.get(id);
      if (job?.worker === instance) finishBotMove(id,job,move,job.comment);
    });
    instance.on("error", () => console.warn("Вычисление хода бота прервалось."));
    instance.on("exit", () => {
      for (const [id,job] of jobs) {
        if (job.worker === instance) jobs.delete(id);
      }
      if (worker === instance) worker = undefined;
    });
    instance.unref();
    return instance;
  }

  function queueLocalBot(row, job, level) {
    if (jobs.get(row.id) !== job) return;
    const {board, turn, draw} = row.game;
    job.worker = currentWorker();
    job.worker.postMessage({id:row.id,args:[board,turn,level,draw.repetitions]});
  }

  function nudgeBot(row) {
    if (!row || row.mode !== "bot" || row.game.result || jobs.has(row.id)) return;
    const botSide = row.white === 0 ? 1 : -1;
    if (row.game.turn !== botSide) return;
    const {board, level, last} = row.game;
    const job = {rev:row.rev};
    jobs.set(row.id,job);
    if (level !== AI_LEVEL) {
      queueLocalBot(row,job,level);
      return;
    }
    function fallback() {
      job.comment = "Я не получил ответ от модели. Делаю ход запасным движком.";
      queueLocalBot(row,job,2);
    }
    if (!aiPlayer) {
      fallback();
      return;
    }
    const moves = legalMoves(board,botSide);
    job.controller = new AbortController();
    aiPlayer({
      board, side:botSide, last, moves, history:row.game.aiHistory,
      previousComment:row.game.comment, signal:job.controller.signal
    })
      .then(decision => {
        if (moves.includes(decision?.move)) finishBotMove(row.id,job,decision.move,decision.comment);
        else fallback();
      },fallback);
  }

  function view(row, id) {
    if (!row) return null;
    const side = row.white === id ? 1 : -1;
    const foe = side === 1 ? row.black : row.white;
    const game = row.game;
    const ai = row.mode === "bot" && game.level === AI_LEVEL;
    const opponent = foe ? store.profile(foe) : {name:ai ? "ИИ" : "Бот",photo:null};
    return {
      id:row.id, mode:row.mode, version:row.rev, side, turn:game.turn, opponent,
      ...viewPosition(game), chain:game.chain?.at(-1) ?? null, last:game.last,
      available:!game.result && game.turn === side ? available(game) : [],
      result:game.result, ai, comment:ai ? game.comment ?? null : null
    };
  }

  function state(user, row) {
    row ??= store.active(user.id) ?? store.latest(user.id);
    nudgeBot(row);
    return {profile:{name:user.name,photo:user.photo}, stats:store.stats(user.id), aiAvailable:Boolean(aiPlayer),
      queued:store.heartbeat(user.id,now()), game:view(row,user.id)};
  }

  const fail = (code, message) => Object.assign(new Error(message),{status:code});
  const handlers = {
    "GET /api/state":user => state(user),
    "POST /api/queue":user => state(user,store.join(user.id,now())),
    "DELETE /api/queue":user => {
      store.leaveQueue(user.id);
      return state(user);
    },
    "POST /api/bot":(user, body) => {
      if (![0,1,2,AI_LEVEL].includes(body.level) || ![-1,0,1].includes(body.side)) throw fail(400,"Выбери цвет и сложность.");
      if (body.level === AI_LEVEL && !aiPlayer) throw fail(503,"Режим ИИ пока недоступен.");
      const side = body.side || (randomInt(2) ? 1 : -1);
      return state(user,store.startBot(user.id,side,body.level,now()));
    },
    "POST /api/move":(user, body) => {
      const row = selectedGame(user,body);
      if (row.rev !== body.version) throw fail(409,"Позиция обновилась. Проверь доску и повтори ход.");
      const side = row.white === user.id ? 1 : -1;
      if (row.game.turn !== side) throw fail(409,"Сейчас ход соперника.");
      if (!Number.isInteger(body.from) || !Number.isInteger(body.to) || !jump(row.game,body.from,body.to)) {
        throw fail(422,"Такой ход недоступен.");
      }
      if (!row.game.chain) rememberAiTurn(row.game);
      if (!store.save(row,now())) throw fail(409,"Позиция обновилась. Проверь доску и повтори ход.");
      return state(user,store.get(row.id));
    },
    "POST /api/resign":(user, body) => {
      const row = selectedGame(user,body);
      const side = row.white === user.id ? 1 : -1;
      row.game.result = {side:-side,reason:"Партия завершилась сдачей."};
      row.game.chain = null;
      if (!store.save(row,now())) throw fail(409,"Партия уже завершилась.");
      const job = jobs.get(row.id);
      jobs.delete(row.id);
      job?.controller?.abort();
      return state(user,store.get(row.id));
    }
  };

  function selectedGame(user, body) {
    const row = typeof body.id === "string" && body.id.length === 36 ? store.get(body.id) : null;
    if (!row || (row.white !== user.id && row.black !== user.id)) throw fail(404,"Партия не найдена.");
    if (row.game.result) throw fail(409,"Партия уже завершилась.");
    return row;
  }

  const server = createServer(async (request,response) => {
    try {
      const url = new URL(request.url,"http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return send(response,200,{ok:true});
      const asset = request.method === "GET" && assets.get(url.pathname);
      if (asset) return send(response,200,asset[0],asset[1]);
      const handler = handlers[request.method + " " + url.pathname];
      if (!handler) return send(response,404,{error:"Страница не найдена."});
      const user = authenticate(request.headers["x-telegram-init-data"],now());
      if (!user) return send(response,401,{error:"Открой Шашки.App заново из Telegram."});
      const body = request.method === "POST" ? await readBody(request) : {};
      store.remember(user);
      return send(response,200,handler(user,body));
    } catch (error) {
      if (!error.status) console.error("Ошибка сервера:",error.message);
      if (!response.headersSent) send(response,error.status || 500,{error:error.status ? error.message : "Не удалось выполнить запрос."});
    }
  });
  server.on("close", () => {
    for (const job of jobs.values()) job.controller?.abort();
    jobs.clear();
    worker?.removeAllListeners("message");
    worker?.terminate();
    store.close();
  });
  return server;
}

if (require.main === module) {
  const env = process.env;
  const token = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || env.API_TOKEN;
  const port = Number(env.PORT || 3000);
  const data = env.DATA_DIR || join(__dirname,"data");
  mkdirSync(data,{recursive:true});
  const aiPlayer = createAiPlayer(env.GROQ_API_KEY);
  const server = createApp({token,databasePath:join(data,"shashki.sqlite"),aiPlayer});
  server.listen(port,"0.0.0.0",()=>{
    console.log("Шашки.App запущены, порт " + port);
    const url = appUrl(env);
    if (url) runTelegram(token,url);
    else console.warn("Укажи публичный HTTPS-домен в APP_URL, чтобы включить Telegram-бота.");
  });
}

module.exports = {createApp};
