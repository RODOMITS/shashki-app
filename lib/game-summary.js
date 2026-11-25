"use strict";

const {WHITE, row, col} = require("./engine");

const plural = new Intl.PluralRules("ru");

function createPlayStats(history = []) {
  const empty = () => ({moves:0, captured:0, center:0, edge:0, chains:0, crowned:0});
  const stats = {white:empty(), black:empty(), partial:history.length > 0};
  for (const turn of history) recordPlay(stats,turn);
  return stats;
}

function sideStats(stats, side) {
  return side === WHITE ? stats.white : stats.black;
}

function recordPlay(stats, turn) {
  const player = sideStats(stats,turn.side);
  const end = turn.path.at(-1);
  const r = row(end), c = col(end);
  player.moves++;
  player.captured += turn.captured.length;
  if (r >= 2 && r <= 5 && c >= 2 && c <= 5) player.center++;
  if (c === 0 || c === 7) player.edge++;
  if (turn.captured.length > 1) player.chains++;
  if (turn.crowned) player.crowned++;
}

function describePlay(player) {
  const style = player.moves >= 3 && player.center * 2 > player.moves ? "часто ходил в центр" :
    player.moves >= 3 && player.edge * 2 > player.moves ? "чаще ходил по краю" : "";
  let detail;
  if (player.crowned) {
    detail = player.crowned === 1 ? "вывел шашку в дамки" : "выводил шашки в дамки";
  } else if (player.chains) {
    detail = player.chains === 1 ? "провёл серию взятий" : "провёл несколько серий взятий";
  } else if (player.captured) {
    const forms = {one:"шашку",few:"шашки",many:"шашек",other:"шашек"};
    detail = "взял " + player.captured + " " + forms[plural.select(player.captured)];
  }
  return [style,detail].filter(Boolean).join(" и ") || "играл без взятий";
}

function summarizeGame(game, playerSide) {
  const stats = game.aiPlayStats ?? createPlayStats(game.aiHistory);
  const player = sideStats(stats,playerSide);
  const ai = sideStats(stats,-playerSide);
  if (!player.moves || !ai.moves) {
    const played = player.moves ? "Ты " + describePlay(player) + ". " :
      ai.moves ? "Я " + describePlay(ai) + ". " : "";
    return played + "Мы сыграли слишком мало ходов, чтобы сравнить стили. Спасибо за партию!";
  }
  if (player.moves + ai.moves <= 4 && !player.captured && !ai.captured) {
    return "Мы успели сыграть только начало без взятий. Спасибо за партию!";
  }
  const you = stats.partial ? "По записанным ходам ты" : "Ты";
  return you + " " + describePlay(player) + ", а я " + describePlay(ai) + ". Спасибо за партию!";
}

module.exports = {createPlayStats, recordPlay, summarizeGame};
