"use strict";

const {nameOf, played, legalMoves} = require("./engine");

const AI_LEVEL = 3;
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b";
const SYMBOLS = {0:".",1:"w",2:"W",[-1]:"b",[-2]:"B"};
const TURN_PROMPT = [
  "Ты играешь в русские шашки за цвет из side. Цель — выиграть партию. Выбери полный ход по номеру из legalMoves.",
  "Строки доски идут от 8 к 1, столбцы от a до h. w и b — белые и чёрные шашки, W и B — дамки, точка — пустая клетка.",
  "Сначала ищи немедленную победу (wins). Затем сравни взятия (takes), превращение в дамку (crowns) и сильнейший ответ соперника (replyTakes — максимум шашек, которые он может взять сразу).",
  "Если replyCanTakeMe истинно, соперник может сразу взять шашку, которой ты сходишь. Не отдавай её без понятной выгоды. При равных вариантах выбирай безопасный ход к дамке или к центру.",
  "В history «я» — твои ходы, «соперник» — его ходы. Твои прошлые реплики лежат в comment, а previousComment может содержать реплику из более ранней версии игры. Учитывай историю, если она относится к позиции.",
  "Пиши как участник игры от первого лица. Начинай comment с «Я», «Мне» или «Мой». К сопернику обращайся на «ты».",
  "Дай одну короткую реплику по-русски о конкретном выбранном ходе. Например: «Я меняю шашки, чтобы открыть путь к дамке». Не выдумывай взятия, дамки, угрозы или прошлые ходы. Не обещай победу, если wins ложно.",
  'До 140 символов. Только JSON: {"move":1,"comment":"Я ..."}'
].join(" ");
const RESPONSE_FORMAT = {
  type:"json_schema",
  json_schema:{
    name:"draughts_turn",
    strict:true,
    schema:{
      type:"object",
      properties:{move:{type:"integer"},comment:{type:"string"}},
      required:["move","comment"],
      additionalProperties:false
    }
  }
};

function describeMove(move) {
  if (!move) return null;
  return move.path.map(nameOf).join(move.captured.length ? ":" : "-");
}

function describeCandidate(board, side, move, index) {
  const next = played(board,move);
  const replies = legalMoves(next,-side);
  const destination = move.path.at(-1);
  return {
    number:index + 1,
    notation:describeMove(move),
    takes:move.captured.length,
    crowns:Math.abs(board[move.path[0]]) === 1 && Math.abs(move.piece) === 2,
    replyTakes:replies.reduce((max, reply) => Math.max(max,reply.captured.length),0),
    replyCanTakeMe:replies.some(reply => reply.captured.includes(destination)),
    wins:replies.length === 0
  };
}

function playerComment(text, move) {
  const comment = typeof text === "string" ? Array.from(text.trim().replace(/\s+/g," ")).slice(0,160).join("") : "";
  if (/^(?:я|мне|мой)(?=\s|[,—:])/iu.test(comment)) return comment;
  const action = move.captured.length ? "выбираю взятие" : "хожу";
  return "Я " + action + " " + describeMove(move) + ".";
}

function createAiPlayer(apiKey, {request = fetch} = {}) {
  const key = apiKey?.trim();
  if (!key) return null;
  let retryAt = 0;

  return async function choose({board, side, last, moves, history = [], previousComment, signal}) {
    if (Date.now() < retryAt || signal?.aborted || !moves.length) return null;
    const squares = Array.from({length:8}, (_, i) =>
      board.slice(i * 8, (i + 1) * 8).map(piece => SYMBOLS[piece]).join("")
    );
    const position = {
      side:side === 1 ? "белые" : "чёрные",
      rows:squares,
      lastMove:describeMove(last),
      history:history.map(turn => ({
        player:turn.side === side ? "я" : "соперник",
        move:describeMove(turn),
        ...(turn.comment ? {comment:turn.comment} : {})
      })),
      legalMoves:moves.map((move, i) => describeCandidate(board,side,move,i))
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
          response_format:RESPONSE_FORMAT,
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
      if (!Number.isInteger(pick?.move) || pick.move < 1 || pick.move > moves.length) return null;
      const move = moves[pick.move - 1];
      return {move,comment:playerComment(pick.comment,move)};
    } catch {
      return null;
    }
  };
}

module.exports = {AI_LEVEL, createAiPlayer};
