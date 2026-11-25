"use strict";

const rules = require("./engine");

function createGame(level) {
  const board = rules.initialPosition();
  return {board, turn:rules.WHITE, level, chain:null, last:null, result:null, draw:{
    ...rules.drawState(), repetitions:[[rules.positionKey(board, rules.WHITE), 1]]
  }};
}

function options(game) {
  const moves = rules.legalMoves(game.board,game.turn);
  return game.chain ? moves.filter(move => game.chain.every((square,i) => move.path[i] === square)) : moves;
}

function available(game, moves = options(game)) {
  const index = game.chain ? game.chain.length - 1 : 0;
  const edges = new Map();
  for (const move of moves) {
    const from = move.path[index], to = move.path[index + 1];
    if (to !== undefined) edges.set(from * 64 + to, {from,to,capture:move.captured.length > 0});
  }
  return [...edges.values()];
}

function viewPosition(game) {
  if (!game.chain) return {board:game.board, taken:[]};
  const board = game.board.slice();
  const path = game.chain;
  let piece = board[path[0]];
  board[path[0]] = 0;
  for (const square of path.slice(1)) piece = rules.asKing(piece,square);
  board[path.at(-1)] = piece;
  return {board,taken:options(game)[0].captured.slice(0,path.length - 1)};
}

function complete(game, move) {
  const piece = game.board[move.path[0]];
  game.board = rules.played(game.board,move);
  game.turn = -game.turn;
  game.chain = null;
  game.last = {path:move.path, captured:move.captured};
  if (!rules.legalMoves(game.board,game.turn).length) {
    const reason = game.board.some(p => Math.sign(p) === game.turn) ? "Нет доступных ходов." : "Все шашки соперника взяты.";
    game.result = {side:-game.turn, reason};
    return;
  }
  const draw = {...game.draw,repetitions:new Map(game.draw.repetitions)};
  const reason = rules.drawAfter(draw,game.board,game.turn,move,piece);
  game.draw = {...draw,repetitions:[...draw.repetitions]};
  if (reason) game.result = {side:0,reason};
}

function jump(game, from, to) {
  const index = game.chain ? game.chain.length - 1 : 0;
  const move = options(game).find(m => m.path[index] === from && m.path[index + 1] === to);
  if (!move) return false;
  if (move.path.length === index + 2) {
    complete(game,move);
  } else {
    const path = move.path.slice(0,index + 2);
    game.chain = path;
    game.last = {path,captured:move.captured.slice(0,index + 1)};
  }
  return true;
}

module.exports = {createGame, available, viewPosition, complete, jump};
