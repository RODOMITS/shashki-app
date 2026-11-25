"use strict";

const $ = id => document.getElementById(id);
const tg = window.Telegram?.WebApp;
const initData = tg?.initData || "";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const board = $("board");
const cells = [];
let state;
let inGame = false;
let busy = false;
let timer;
let requestVersion = 0;
let selected = null;
let keyboardSquare = 40;
let playingAnimation;
let gameError = "";
let menuError = "";

function telegram(method, ...args) {
  try { tg?.[method]?.(...args); } catch {}
}

const appBackground = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
telegram("setHeaderColor",appBackground);
telegram("setBackgroundColor",appBackground);
telegram("setBottomBarColor",appBackground);
telegram("ready");
telegram("expand");
tg?.BackButton?.onClick(() => showGame(false));

function avatar(target, profile) {
  const name = profile?.name || "Игрок";
  const initial = Array.from(name.trim())[0]?.toUpperCase() || "Ш";
  const photo = profile?.photo || "";
  if (target.dataset.photo === photo && target.dataset.initial === initial) return;
  target.dataset.photo = photo;
  target.dataset.initial = initial;
  target.textContent = initial;
  if (photo) {
    const img = new Image();
    img.alt = "";
    img.src = photo;
    img.addEventListener("error",() => {
      if (target.firstElementChild === img) target.textContent = initial;
    },{once:true});
    target.replaceChildren(img);
  }
}

function chip(piece) {
  const element = document.createElement("span");
  element.className = "chip " + (piece > 0 ? "white" : "black");
  if (Math.abs(piece) === 2) {
    element.classList.add("king");
    element.innerHTML = '<svg aria-hidden="true"><use href="#crown-icon"/></svg>';
  }
  element.setAttribute("aria-hidden","true");
  return element;
}

const isDark = square => ((square >> 3) + (square & 7)) % 2;
const onScreen = square => state.game.side === -1 ? 63 - square : square;
const squareName = square => "abcdefgh"[square & 7] + (8 - (square >> 3));

for (let index = 0; index < 64; index++) {
  const dark = isDark(index);
  const cell = document.createElement(dark ? "button" : "div");
  if (dark) cell.type = "button";
  else cell.setAttribute("aria-hidden","true");
  cell.className = dark ? "cell dark" : "cell";
  cells.push(cell);
  board.append(cell);
}

function renderControls() {
  const active = state?.game && !state.game.result;
  $("menu").hidden = inGame;
  $("game").hidden = !inGame;
  $("back").hidden = !inGame;
  $("resume").hidden = !active;
  $("queue").hidden = Boolean(state?.queued);
  $("queue").disabled = !state || busy || Boolean(active);
  $("bot").disabled = !state || busy || Boolean(active) || Boolean(state?.queued);
  const aiAvailable = Boolean(state?.aiAvailable);
  const aiOption = $("ai-level");
  aiOption.disabled = !aiAvailable;
  aiOption.textContent = aiAvailable ? "ИИ" : "ИИ (недоступен)";
  $("bot-levels-label").textContent = aiAvailable ? "Три уровня и режим ИИ" : "Три уровня сложности";
  $("resume").disabled = busy;
  $("cancel-search").disabled = busy;
  $("search").hidden = !state?.queued;
  $("retry").hidden = !initData || Boolean(state) || busy;
  $("resume-label").textContent = !active ? "" :
    state.game.mode === "online" ? "Онлайн-партия" : state.game.ai ? "Игра с ИИ" : "Игра с ботом";
  $("menu-note").textContent = menuError;
  if (!inGame || !state?.game) return;
  const game = state.game;
  $("resign").hidden = Boolean(game.result);
  $("resign").disabled = busy;
  $("finish").hidden = !game.result;
  $("game-note").textContent = gameError || game.result?.reason || "";
}

function renderBoard() {
  const game = state.game;
  const current = game.chain ?? selected;
  const moves = busy || playingAnimation ? [] : game.available;
  const starts = new Map(moves.map(move => [move.from,move.capture]));
  const targets = new Map(moves.filter(move => move.from === current).map(move => [move.to,move.capture]));
  for (let index = 0; index < cells.length; index++) {
    const square = onScreen(index);
    const cell = cells[index];
    const dark = isDark(square);
    const piece = game.board[square];
    const last = game.last?.path;
    const isLast = last && (square === last[0] || square === last.at(-1));
    const isTarget = targets.has(square);
    cell.className = "cell" + (dark ? " dark" : "") + (current === square ? " selected" : isLast ? " last" : "")
      + (starts.has(square) ? " playable" + (starts.get(square) ? " must" : "") : "")
      + (isTarget ? " target" + (targets.get(square) ? " jump" : "") : "");
    cell.dataset.square = square;
    cell.replaceChildren();
    if (dark) {
      const name = piece ? (piece > 0 ? "Белая " : "Чёрная ") + (Math.abs(piece) === 2 ? "дамка" : "шашка") : "";
      cell.setAttribute("aria-label",[squareName(square),name,isTarget ? "доступный ход" : ""].filter(Boolean).join(", "));
      cell.setAttribute("aria-pressed",String(current === square));
      cell.tabIndex = keyboardSquare === square ? 0 : -1;
    }
    if (piece) {
      const checker = chip(piece);
      if (game.taken.includes(square)) checker.classList.add("taken");
      cell.append(checker);
    }
  }
}

function renderGame(previous) {
  const game = state.game;
  const waiting = game.ai ? "ИИ думает…" : game.mode === "bot" ? "Бот думает…" : "Ход соперника";
  const status = game.result ? game.result.side === 0 ? "Ничья" :
    game.result.side === game.side ? "Вы победили!" : "Поражение" :
    game.turn !== game.side ? waiting :
    game.chain !== null ? "Продолжайте взятие" :
    game.available.some(move => move.capture) ? "Взятие обязательно" : "Ваш ход";
  if ($("game-status").textContent !== status) $("game-status").textContent = status;
  $("game-status").classList.toggle("waiting",!game.result && game.turn !== game.side);
  $("own-side").textContent = game.side > 0 ? "Белые" : "Чёрные";
  $("opponent-side").textContent = game.side > 0 ? "Чёрные" : "Белые";
  $("opponent-name").textContent = game.opponent?.name || "Соперник";
  avatar($("own-avatar"),state.profile);
  avatar($("opponent-avatar"),game.opponent);
  const bubble = $("ai-comment");
  const opening = game.turn === game.side ? "Жду твой первый ход." : "Оцениваю позицию…";
  const comment = game.ai ? game.comment || (game.result ? "" : opening) : "";
  $("game").classList.toggle("with-ai",game.ai);
  bubble.hidden = !comment;
  if (bubble.textContent !== comment) bubble.textContent = comment;
  $("own-count").textContent = game.board.filter(p => Math.sign(p) === game.side).length;
  $("opponent-count").textContent = game.board.filter(p => Math.sign(p) === -game.side).length;
  renderBoard();
  if (previous?.id === game.id && previous.version < game.version) animateMove(previous,game);
}

function animateMove(previous, game) {
  const path = game.last?.path;
  if (reducedMotion.matches || !path) return;
  const destination = path.at(-1);
  const piece = game.board[destination];
  if (!piece) return;
  const previousPath = previous.last?.path;
  const start = previousPath && previousPath.length < path.length && previousPath.every((square,i) => path[i] === square)
    ? previousPath.length - 1 : 0;
  const from = path[start];
  const oldPiece = previous.board[from];
  if (!oldPiece || Math.sign(oldPiece) !== Math.sign(piece)) return;
  if (previous.board[destination] === piece && previousPath?.at(-1) === destination) return;
  const resting = cells[onScreen(destination)].querySelector(".chip");
  if (!resting?.animate) return;
  const area = board.getBoundingClientRect();
  const {width,height} = resting.getBoundingClientRect();
  if (!width || !height) return;
  const point = square => {
    const cell = cells[onScreen(square)].getBoundingClientRect();
    return [cell.left - area.left + (cell.width - width)/2,cell.top - area.top + (cell.height - height)/2];
  };
  const ghost = chip(oldPiece);
  ghost.classList.add("ghost");
  ghost.style.width = width + "px";
  ghost.style.left = "0";
  ghost.style.top = "0";
  resting.classList.add("invisible");
  board.append(ghost);
  playingAnimation?.cancel();
  const frames = path.slice(start).map(square => {
    const [x,y] = point(square);
    return {transform:"translate("+x+"px,"+y+"px)"};
  });
  const movement = ghost.animate(frames,{duration:Math.min(390,130 + frames.length*25),easing:"ease-in-out"});
  playingAnimation = movement;
  const ended = () => {
    ghost.remove();
    resting.classList.remove("invisible");
    if (playingAnimation !== movement) return;
    playingAnimation = null;
    if (inGame) renderBoard();
  };
  movement.finished.then(ended,ended);
}

function renderProfile() {
  if (!state) return;
  $("profile-name").textContent = state.profile.name;
  avatar($("profile-avatar"),state.profile);
  for (const name of ["played","wins","draws","losses"]) $("stats-"+name).textContent = state.stats[name];
}

function showGame(show) {
  if (show && !state?.game) return;
  if (!show) playingAnimation?.cancel();
  inGame = show;
  selected = null;
  gameError = "";
  renderControls();
  if (show) renderGame();
  if (show) tg?.BackButton?.show();
  else tg?.BackButton?.hide();
  syncTelegram();
}

function syncTelegram() {
  if (inGame && state?.game && !state.game.result) {
    telegram("enableClosingConfirmation");
    telegram("disableVerticalSwipes");
  } else {
    telegram("disableClosingConfirmation");
    telegram("enableVerticalSwipes");
  }
}

function applyState(next, open = false) {
  const previous = state;
  const sameGame = next.game?.id === previous?.game?.id;
  state = next;
  if (!sameGame || previous?.game?.version !== next.game?.version) {
    selected = null;
    if (!sameGame) keyboardSquare = next.game?.side === -1 ? 17 : 40;
  }
  renderProfile();
  const matched = previous?.queued && next.game?.mode === "online" && !next.game.result && !sameGame;
  if (next.game && (open || matched)) {
    showGame(true);
  } else {
    renderControls();
    if (inGame && next.game && (!sameGame || previous.game.version !== next.game.version)) renderGame(previous?.game);
  }
  syncTelegram();
}

async function api(method,path,body) {
  const headers = {"X-Telegram-Init-Data":initData};
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch("/api/"+path,{
    method,headers,body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(6500)
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.error || "Не удалось обновить партию.");
  }
  return response.json();
}

function planPoll() {
  clearTimeout(timer);
  if (!state || busy || document.hidden) return;
  const active = state.game && !state.game.result;
  if (active || state.queued) timer = setTimeout(refresh,inGame ? 750 : 1250);
}

async function refresh() {
  if (busy || !initData) return;
  const version = ++requestVersion;
  try {
    const next = await api("GET","state");
    if (version !== requestVersion) return;
    const first = !state;
    menuError = "";
    gameError = "";
    applyState(next,first && next.game && !next.game.result);
  } catch (error) {
    if (version !== requestVersion) return;
    if (inGame) gameError = error.message;
    else menuError = error.message;
    renderControls();
  } finally {
    if (version === requestVersion) planPoll();
  }
}

async function act(method,path,body,{open = false, close = null} = {}) {
  if (busy || !state) return;
  busy = true;
  requestVersion++;
  clearTimeout(timer);
  renderControls();
  try {
    const next = await api(method,path,body);
    busy = false;
    menuError = "";
    gameError = "";
    close?.close();
    applyState(next,open && Boolean(next.game && !next.game.result));
    if (inGame && !playingAnimation) renderBoard();
    if (path === "move") tg?.HapticFeedback?.selectionChanged();
  } catch (error) {
    busy = false;
    close?.close();
    if (inGame) gameError = error.message;
    else menuError = error.message;
    renderControls();
    if (inGame) renderBoard();
  } finally {
    planPoll();
  }
}

board.addEventListener("click",event => {
  const cell = event.target.closest("button.cell");
  if (!cell || busy || playingAnimation || !state?.game) return;
  const square = Number(cell.dataset.square);
  keyboardSquare = square;
  const game = state.game;
  const from = game.chain ?? selected;
  if (game.available.some(move => move.from === from && move.to === square)) {
    act("POST","move",{id:game.id,version:game.version,from,to:square});
    return;
  }
  selected = square !== selected && game.available.some(move => move.from === square) ? square : null;
  renderBoard();
});
board.addEventListener("keydown",event => {
  const direction = {ArrowUp:-16,ArrowDown:16,ArrowLeft:-2,ArrowRight:2}[event.key];
  const cell = event.target.closest("button.cell");
  if (!direction || !cell) return;
  event.preventDefault();
  const index = onScreen(Number(cell.dataset.square));
  const next = index + direction;
  if (!cells[next] || (Math.abs(direction) === 2 && (index >> 3) !== (next >> 3))) return;
  cell.tabIndex = -1;
  cells[next].tabIndex = 0;
  keyboardSquare = Number(cells[next].dataset.square);
  cells[next].focus();
});
$("queue").addEventListener("click",() => act("POST","queue",{}, {open:true}));
$("cancel-search").addEventListener("click",() => act("DELETE","queue"));
$("resume").addEventListener("click",() => showGame(true));
$("back").addEventListener("click",() => showGame(false));
$("finish").addEventListener("click",() => showGame(false));
$("retry").addEventListener("click",refresh);
$("bot").addEventListener("click",() => $("bot-dialog").showModal());
$("close-bot").addEventListener("click",() => $("bot-dialog").close());
$("bot-form").addEventListener("submit",event => {
  event.preventDefault();
  act("POST","bot",{level:Number($("level").value),side:Number($("side").value)},
    {open:true, close:$("bot-dialog")});
});
$("resign").addEventListener("click",() => $("resign-dialog").showModal());
$("close-resign").addEventListener("click",() => $("resign-dialog").close());
$("confirm-resign").addEventListener("click",() => act("POST","resign",{id:state.game.id},{close:$("resign-dialog")}));
document.addEventListener("visibilitychange",() => {
  if (document.hidden) clearTimeout(timer);
  else refresh();
});
window.addEventListener("online",refresh);
window.addEventListener("beforeunload",event => {
  if (inGame && state?.game && !state.game.result) {
    event.preventDefault();
    event.returnValue = true;
  }
});

if (initData) refresh();
else {
  menuError = "Откройте игру через кнопку в чате Telegram-бота.";
  renderControls();
}
