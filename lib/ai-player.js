"use strict";

const {nameOf} = require("./engine");

const AI_LEVEL = 3;
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b";
const SYMBOLS = {0:".",1:"w",2:"W",[-1]:"b",[-2]:"B"};
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

function createAiPlayer(apiKey, {request = fetch} = {}) {
  const key = apiKey?.trim();
  if (!key) return null;
  let retryAt = 0;

  return async function choose({board, side, last, moves, signal}) {
    if (Date.now() < retryAt || signal?.aborted || !moves.length) return null;
    const squares = Array.from({length:8}, (_, i) =>
      board.slice(i * 8, (i + 1) * 8).map(piece => SYMBOLS[piece]).join("")
    );
    const position = {
      side:side === 1 ? "белые" : "чёрные",
      rows:squares,
      lastMove:describeMove(last),
      legalMoves:moves.map((move, i) => (i + 1) + ". " + describeMove(move))
    };
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
            {role:"system",content:'Ты играешь в русские шашки. Строки доски идут от 8 к 1, столбцы от a до h. w и b — белые и чёрные шашки, W и B — дамки, точка — пустая клетка. Выбери один полный ход из списка legalMoves по его номеру. Оцени угрозы, взятия и путь к дамке. В comment коротко и дружелюбно прокомментируй позицию или последний ход соперника и объясни свой выбор. Пиши по-русски, до 140 символов, без ссылок и Markdown. Ответ только JSON: {"move":1,"comment":"текст"}.'},
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
      if (typeof pick.comment !== "string" || !pick.comment.trim()) return null;
      const comment = Array.from(pick.comment.trim().replace(/\s+/g," ")).slice(0,160).join("");
      return {move:moves[pick.move - 1],comment};
    } catch {
      return null;
    }
  };
}

module.exports = {AI_LEVEL, createAiPlayer};
