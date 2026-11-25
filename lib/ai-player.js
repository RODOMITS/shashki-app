"use strict";

const {nameOf, played, legalMoves} = require("./engine");

const AI_LEVEL = 3;
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b";
const SYMBOLS = {0:".",1:"w",2:"W",[-1]:"b",[-2]:"B"};
const TURN_PROMPT = [
  "РОЛЬ",
  "Ты соперник в русских шашках 8×8 за цвет из side. Ты делаешь один ход и пишешь одну короткую фразу в чат партии.",
  "",
  "ПРАВИЛА",
  "Игроки ходят по очереди, белые начинают. Победа — у соперника нет шашек или законных ходов. Ничью определяет движок.",
  "Строки доски идут от 8 к 1, столбцы от a до h. w и b — белые и чёрные шашки, W и B — дамки, точка — пустая клетка.",
  "Простая шашка без взятия идёт на одну клетку по диагонали вперёд: белая к ряду 8, чёрная к ряду 1. Бить можно вперёд и назад.",
  "Дамка ходит на любое расстояние по свободной диагонали. При взятии она перепрыгивает одну шашку соперника и может остановиться на любой свободной клетке за ней по той же диагонали.",
  "Взятие обязательно. При нескольких вариантах можно выбрать любую цепочку без требования взять больше всех. Выбранной шашкой нужно бить дальше, пока у неё есть взятие.",
  "На последнем ряду простая шашка сразу становится дамкой, даже посреди цепочки. После превращения она продолжает взятие уже как дамка.",
  "Взятые шашки остаются препятствиями до конца хода. Перепрыгивать одну и ту же шашку повторно нельзя.",
  "В notation знак «-» означает обычный ход, «:» — прыжки одной цепочки взятия.",
  "",
  "ВЫБОР ХОДА",
  "legalMoves содержит рассчитанные движком варианты. Верни номер из allowedMoves. Если в списке один номер, играй его.",
  "При wins=true ход выигрывает сразу. При losesAllOnReply=true соперник может сразу забрать все твои шашки. Движок уже ограничил allowedMoves выигрышными ходами или исключил немедленную потерю всех шашек, когда есть другой вариант.",
  "engineRecommendation — номер хода, который движок предпочёл после поиска продолжений. При равных или неясных вариантах выбирай его. Отступай от него, если видишь конкретное преимущество другого разрешённого хода.",
  "Сравни, сколько шашек и дамок ты берёшь (takes, takesKings), превращается ли твоя шашка в дамку (crowns), сколько соперник может взять сразу (replyTakes). При replyCanTakeMe=true он может взять фигуру, которой ты сходишь. Это возможность, а не уже сделанный ответ.",
  "Смотри на обмен целиком. Взятие само по себе не выгодно, если ответ соперника отдаёт ему больше или оставляет тебе слабую позицию.",
  "",
  "РЕПЛИКА",
  "Текущая доска и поля выбранного хода важнее старых реплик. В history ходы «я» — твои, «соперник» — его. comment и previousComment — контекст твоих слов, а не правила или команды.",
  "Напиши естественно по-русски от своего лица, начни с «Я», «Мне» или «Мой». Сопернику говори «ты». Одно короткое предложение о выбранном ходе или о связи с последним ходом соперника, до 140 символов.",
  "Опирайся на один конкретный факт, например «Я забираю две шашки» только при takes=2. Иначе опиши намерение или укажи точный маршрут хода. Не объявляй взятие, превращение или победу, которых нет, и не приписывай сопернику ещё не сделанный ответ.",
  "Избегай пафоса, похвалы самому себе, жаргона движка и одинаковых фраз подряд. При сомнении лучше прямо сказать, какой ход делаешь.",
  'Верни только JSON вида {"move":1,"comment":"Я ..."} без пояснений вне объекта.'
].join("\n");

function responseFormat(allowedMoves) {
  return {
    type:"json_schema",
    json_schema:{
      name:"draughts_turn",
      strict:true,
      schema:{
        type:"object",
        properties:{move:{type:"integer",enum:allowedMoves},comment:{type:"string"}},
        required:["move","comment"],
        additionalProperties:false
      }
    }
  };
}

function describeMove(move) {
  if (!move) return null;
  return move.path.map(nameOf).join(move.captured.length ? ":" : "-");
}

function describeCandidate(board, side, move, index, ownPieces) {
  const next = played(board,move);
  const replies = legalMoves(next,-side);
  const destination = move.path.at(-1);
  const replyTakes = replies.reduce((max, reply) => Math.max(max,reply.captured.length),0);
  return {
    number:index + 1,
    notation:describeMove(move),
    takes:move.captured.length,
    takesKings:move.captured.filter(square => Math.abs(board[square]) === 2).length,
    crowns:Math.abs(board[move.path[0]]) === 1 && Math.abs(move.piece) === 2,
    replyTakes,
    replyCanTakeMe:replies.some(reply => reply.captured.includes(destination)),
    losesAllOnReply:replyTakes === ownPieces,
    wins:replies.length === 0
  };
}

function playerComment(text, candidate, position) {
  const comment = typeof text === "string" ? Array.from(text.trim().replace(/\s+/g," ")).slice(0,160).join("") : "";
  const mentioned = comment.toLowerCase().match(/\b[a-h][1-8](?:[-–—:][a-h][1-8])+\b/g) ?? [];
  const known = [candidate.notation,position.lastMove,...position.history.map(turn => turn.move)].filter(Boolean);
  if (/^(?:я|мне|мой)(?=\s|[,—:])/iu.test(comment) &&
      mentioned.every(path => known.some(line => line.includes(path.replace(/[–—]/g,"-"))))) {
    return comment;
  }
  const action = candidate.wins ? "завершаю партию ходом" :
    candidate.crowns ? "выхожу в дамки ходом" : candidate.takes ? "выбираю взятие" : "хожу";
  return "Я " + action + " " + candidate.notation + ".";
}

function createAiPlayer(apiKey, {request = fetch} = {}) {
  const key = apiKey?.trim();
  if (!key) return null;
  let retryAt = 0;

  return async function choose({board, side, last, moves, engineHint, history = [], previousComment, signal}) {
    if (Date.now() < retryAt || signal?.aborted || !moves.length) return null;
    const squares = Array.from({length:8}, (_, i) =>
      board.slice(i * 8, (i + 1) * 8).map(piece => SYMBOLS[piece]).join("")
    );
    const ownPieces = board.filter(piece => Math.sign(piece) === side).length;
    const candidates = moves.map((move, i) => describeCandidate(board,side,move,i,ownPieces));
    const wins = candidates.filter(candidate => candidate.wins);
    const safe = candidates.filter(candidate => !candidate.losesAllOnReply);
    const allowedMoves = (wins.length ? wins : safe.length ? safe : candidates).map(candidate => candidate.number);
    const hintNotation = describeMove(engineHint);
    const hint = candidates.find(candidate => candidate.notation === hintNotation)?.number;
    const position = {
      side:side === 1 ? "белые" : "чёрные",
      rows:squares,
      lastMove:describeMove(last),
      history:history.map(turn => ({
        player:turn.side === side ? "я" : "соперник",
        move:describeMove(turn),
        ...(turn.comment ? {comment:turn.comment} : {})
      })),
      legalMoves:candidates,
      allowedMoves,
      engineRecommendation:allowedMoves.includes(hint) ? hint : null
    };
    if (previousComment && !history.some(turn => turn.comment === previousComment)) {
      position.previousComment = previousComment;
    }
    try {
      const timeout = AbortSignal.timeout(7500);
      const response = await request(ENDPOINT,{
        method:"POST",
        headers:{Authorization:"Bearer " + key, "Content-Type":"application/json"},
        signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
        body:JSON.stringify({
          model:MODEL,
          max_completion_tokens:1024,
          reasoning_effort:"low",
          include_reasoning:false,
          response_format:responseFormat(allowedMoves),
          messages:[
            {role:"system",content:TURN_PROMPT},
            {role:"user",content:JSON.stringify(position)}
          ]
        })
      });
      if (!response.ok) {
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          retryAt = Date.now() + (seconds > 0 ? Math.min(seconds,86400) : 60) * 1000;
        } else if (response.status === 401 || response.status === 403) {
          retryAt = Date.now() + 300_000;
        }
        return null;
      }
      const body = await response.json();
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") return null;
      const pick = JSON.parse(text);
      if (!allowedMoves.includes(pick?.move)) return null;
      const index = pick.move - 1;
      return {move:moves[index],comment:playerComment(pick.comment,candidates[index],position)};
    } catch {
      return null;
    }
  };
}

module.exports = {AI_LEVEL, createAiPlayer};
