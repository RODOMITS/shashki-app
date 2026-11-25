"use strict";
const WHITE = 1;
const BLACK = -1;
const DIRECTIONS = [[-1,-1],[-1,1],[1,-1],[1,1]];
const row = square => square >> 3;
const col = square => square & 7;
const sideOf = Math.sign;
const nameOf = square => "abcdefgh"[col(square)] + (8 - row(square));
const inside = (r,c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const asKing = (piece, square) => row(square) === (piece > 0 ? 0 : 7) ? 2 * sideOf(piece) : piece;

function initialPosition() {
  return Array.from({length:64}, (_, square) => {
    if ((row(square) + col(square)) % 2 === 0) return 0;
    if (row(square) < 3) return BLACK;
    if (row(square) > 4) return WHITE;
    return 0;
  });
}

function captureSteps(board, from, captured) {
  const piece = board[from];
  const moves = [];
  for (const [dr, dc] of DIRECTIONS) {
    let r = row(from) + dr;
    let c = col(from) + dc;
    if (Math.abs(piece) === 1) {
      if (!inside(r + dr,c + dc)) continue;
      const victim = r * 8 + c;
      const to = (r + dr) * 8 + c + dc;
      if (sideOf(board[victim]) === -piece && !captured.includes(victim) && !board[to]) {
        moves.push({to,victim});
      }
      continue;
    }
    let victim = -1;
    while (inside(r,c)) {
      const square = r * 8 + c;
      const target = board[square];
      if (target) {
        if (victim !== -1 || sideOf(target) === sideOf(piece) || captured.includes(square)) break;
        victim = square;
      } else if (victim !== -1) {
        moves.push({to:square, victim});
      }
      r += dr;
      c += dc;
    }
  }
  return moves;
}

function captureLines(board, from, path, captured, moves) {
  const steps = captureSteps(board, from, captured);
  if (!steps.length && captured.length) {
    moves.push({path, captured, piece:board[from]});
    return;
  }
  for (const {to, victim} of steps) {
    const piece = board[from];
    board[from] = 0;
    board[to] = asKing(piece, to);
    captureLines(board, to, [...path, to], [...captured, victim], moves);
    board[to] = 0;
    board[from] = piece;
  }
}

function legalMoves(board, side) {
  const pieces = [];
  const moves = [];
  for (let square = 0; square < 64; square++) {
    if (sideOf(board[square]) !== side) continue;
    pieces.push(square);
    captureLines(board, square, [square], [], moves);
  }
  if (moves.length) return moves;
  for (const from of pieces) {
    const piece = board[from];
    const king = Math.abs(piece) === 2;
    for (const [dr,dc] of DIRECTIONS) {
      if (!king && dr !== -side) continue;
      let r = row(from) + dr;
      let c = col(from) + dc;
      while (inside(r,c) && !board[r * 8 + c]) {
        const to = r * 8 + c;
        moves.push({path:[from,to], captured:[], piece:asKing(piece,to)});
        if (!king) break;
        r += dr;
        c += dc;
      }
    }
  }
  return moves;
}

function played(board, move) {
  const next = board.slice();
  next[move.path[0]] = 0;
  for (const victim of move.captured) next[victim] = 0;
  next[move.path.at(-1)] = move.piece;
  return next;
}

function positionKey(board, side) {
  let key = side === WHITE ? "w" : "b";
  for (let i = 0; i < 64; i++) {
    if ((row(i) + col(i)) % 2) key += board[i] + 2;
  }
  return key;
}

function drawState() {
  return {repetitions:new Map(), quietKings:0, balance:0, advantageSide:0, advantageMoves:0};
}

function drawAfter(state, board, nextSide, move, original) {
  const changed = move.captured.length || original !== move.piece;
  if (changed) state.repetitions.clear();
  state.quietKings = !changed && Math.abs(original) === 2 ? state.quietKings + 1 : 0;
  state.balance = changed ? 0 : state.balance + 1;
  const key = positionKey(board, nextSide);
  const count = (state.repetitions.get(key) || 0) + 1;
  state.repetitions.set(key, count);

  let white = 0, black = 0, whiteKings = 0, blackKings = 0, longDiagonal = 0;
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (piece > 0) white++;
    if (piece < 0) black++;
    if (piece === 2) whiteKings++;
    if (piece === -2) blackKings++;
    if (Math.abs(piece) === 2 && row(square) + col(square) === 7) {
      longDiagonal |= piece === 2 ? 1 : 2;
    }
  }
  const whiteAdvantage = whiteKings >= 3 && black === 1 && blackKings === 1 && (white > 3 || (longDiagonal & 1));
  const blackAdvantage = blackKings >= 3 && white === 1 && whiteKings === 1 && (black > 3 || (longDiagonal & 2));
  const advantageSide = whiteAdvantage ? WHITE : blackAdvantage ? BLACK : 0;
  if (changed || advantageSide !== state.advantageSide) state.advantageMoves = 0;
  else if (advantageSide === -nextSide) state.advantageMoves++;
  state.advantageSide = advantageSide;

  if (count >= 3) return "Позиция повторилась трижды.";
  if (advantageSide && state.advantageMoves >= 15) return "Последнюю дамку не взяли за 15 ходов.";
  const total = white + black;
  if (whiteKings && blackKings && total <= 7) {
    const limit = total <= 3 ? 5 : total <= 5 ? 30 : 60;
    if (state.balance >= limit * 2) return "Соотношение фигур не менялось " + limit + " ходов.";
    if (total >= 4) {
      const kingLimit = total <= 5 ? 15 : 25;
      if (state.quietKings >= kingLimit * 2) return "Обе стороны сделали по " + kingLimit + " ходов только дамками без взятий.";
    }
  }
  return "";
}

function evaluate(board, side) {
  let value = 0;
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (!piece) continue;
    const r = row(square), c = col(square);
    const center = 7 - Math.abs(r - 3.5) - Math.abs(c - 3.5);
    const forward = piece > 0 ? 7 - r : r;
    const worth = Math.abs(piece) === 2 ? 288 + center * 4 :
      100 + forward * 5 + center * 3 + (forward === 0 ? 8 : 0);
    value += sideOf(piece) * worth;
  }
  return value * side;
}

function ordered(moves, board) {
  const weight = move => move.captured.reduce((sum, victim) => sum + Math.abs(board[victim]) * 100, 0)
    + (Math.abs(board[move.path[0]]) !== Math.abs(move.piece) ? 90 : 0);
  return moves.sort((a,b) => weight(b) - weight(a));
}

function chooseMove(board, side, level, repetitions = []) {
  const moves = ordered(legalMoves(board, side), board);
  if (moves.length < 2) return moves[0] || null;
  if (level === 0) return moves[Math.floor(Math.random() * moves.length)];

  const prior = new Map(repetitions);
  const timeout = {};
  const maxDepth = level === 1 ? 3 : 6;
  const maxNodes = level === 1 ? 4000 : 26000;
  const deadline = Date.now() + (level === 1 ? 100 : 380);
  let nodes = 0;
  function search(position, turn, depth, alpha, beta, ply, captureDepth) {
    nodes++;
    if (nodes > maxNodes || (nodes % 128 === 0 && Date.now() > deadline)) throw timeout;
    const choices = legalMoves(position, turn);
    if (!choices.length) return -10000 + ply;
    if (depth <= 0 && (!choices[0].captured.length || captureDepth <= 0)) return evaluate(position, turn);
    let best = -Infinity;
    for (const move of ordered(choices, position)) {
      const score = -search(played(position,move), -turn, depth - 1, -beta, -alpha, ply + 1,
        depth <= 0 ? captureDepth - 1 : captureDepth);
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return best;
  }

  let best = moves[0];
  for (let depth = 1; depth <= maxDepth; depth++) {
    let choice = best;
    let score = -Infinity;
    try {
      const candidates = [best, ...moves.filter(move => move !== best)];
      for (const move of candidates) {
        const next = played(board, move);
        const priorCount = prior.get(positionKey(next,-side)) || 0;
        const repetitionCost = priorCount === 1 ? 10 : 0;
        let value = -search(next, -side, depth - 1, -Infinity, -score - repetitionCost, 1, 3);
        if (value < 9000 && priorCount >= 2) value = 0;
        else value -= repetitionCost;
        if (value > score) {
          choice = move;
          score = value;
        }
      }
    } catch (error) {
      if (error !== timeout) throw error;
      break;
    }
    best = choice;
    if (score > 9000) break;
  }
  return best;
}

module.exports = {WHITE, BLACK, row, col, nameOf, asKing, initialPosition, legalMoves, played, positionKey, drawState, drawAfter, chooseMove};
