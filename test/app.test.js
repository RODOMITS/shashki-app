"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const {mkdtemp, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {setTimeout:wait} = require("node:timers/promises");
const {createApp} = require("../index");
const {initialPosition, WHITE, positionKey, drawState, legalMoves, played} = require("../lib/engine");
const {jump, viewPosition, available} = require("../lib/game");
const {AI_LEVEL, createAiPlayer} = require("../lib/ai-player");

const token = "synthetic-token-for-local-testing";
const date = 1_800_000_000_000;

function sign(id, authDate = date) {
  const params = new URLSearchParams({
    user:JSON.stringify({id,first_name:"Игрок " + id}),auth_date:String(Math.floor(authDate / 1000)),signature:"included-in-hmac"
  });
  params.sort();
  const secret = createHmac("sha256","WebAppData").update(token).digest();
  const hash = createHmac("sha256",secret).update([...params].map(([key,value])=>key+"="+value).join("\n")).digest("hex");
  params.set("hash",hash);
  return params.toString();
}

async function start(databasePath, aiPlayer) {
  const server = createApp({token,databasePath,now:() => date,aiPlayer});
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    async request(id,method,path,body,init = sign(id)) {
      const response = await fetch(base + "/api/" + path,{
        method, headers:{"X-Telegram-Init-Data":init,"Content-Type":"application/json"},
        body:body === undefined ? undefined : JSON.stringify(body)
      });
      return {status:response.status,data:await response.json()};
    },
    close() { return new Promise((resolve,reject) => server.close(error=>error ? reject(error) : resolve())); }
  };
}

test("Telegram auth, simultaneous matchmaking, move validation, persistent statistics and bot turns",async t => {
  const folder = await mkdtemp(join(tmpdir(),"shashki-app-"));
  const database = join(folder,"test.sqlite");
  let app = await start(database);
  t.after(async() => {
    await app.close();
    await rm(folder,{recursive:true,force:true});
  });
  const {request} = app;
  assert.equal((await fetch(app.base+"/health")).status,200);
  const home = await fetch(app.base+"/");
  assert.match(await home.text(),/<title>Шашки\.App<\/title>/);
  assert.equal((await fetch(app.base+"/style.css")).status,200);
  assert.equal((await request(1,"GET","state",undefined,"")).status,401);
  assert.equal((await request(1,"GET","state")).data.aiAvailable,false);
  assert.equal((await request(1,"POST","bot",{side:1,level:AI_LEVEL})).status,503);
  assert.equal((await request(1,"GET","state",undefined,sign(1,date-86_401_000))).status,401);
  const tampered = new URLSearchParams(sign(1));
  tampered.set("user",JSON.stringify({id:2,first_name:"Подмена"}));
  assert.equal((await request(1,"GET","state",undefined,tampered.toString())).status,401);
  assert.equal((await request(3,"POST","queue",{})).data.queued,true);
  assert.equal((await request(3,"DELETE","queue")).data.queued,false);

  const joins = await Promise.all([request(1,"POST","queue",{}),request(2,"POST","queue",{})]);
  assert.equal(joins.filter(result=>result.data.queued).length,1);
  const first = (await request(1,"GET","state")).data.game;
  const second = (await request(2,"GET","state")).data.game;
  assert.equal(first.id,second.id);
  assert.equal(first.mode,"online");
  assert.notEqual(first.side,second.side);
  assert.deepEqual(first.board,initialPosition());
  const [white,black] = first.side === 1 ? [1,2] : [2,1];
  const initial = first.side === 1 ? first : second;
  const [move] = initial.available;
  const payload = {id:initial.id,version:0,from:move.from,to:move.to};
  assert.equal((await request(3,"POST","move",payload)).status,404);
  assert.equal((await request(black,"POST","move",payload)).status,409);
  assert.equal((await request(white,"POST","move",{...payload,to:0})).status,422);
  const worked = await request(white,"POST","move",payload);
  assert.equal(worked.status,200);
  assert.equal(worked.data.game.board[move.from],0);
  assert.equal(worked.data.game.board[move.to],1);
  assert.equal((await request(white,"POST","move",payload)).status,409);
  assert.equal((await request(black,"GET","state")).data.game.turn,-1);

  await app.close();
  app = await start(database);
  assert.equal((await app.request(black,"GET","state")).data.game.version,1);
  const resigned = await app.request(black,"POST","resign",{id:initial.id});
  assert.equal(resigned.data.stats.losses,1);
  assert.equal((await app.request(black,"POST","resign",{id:initial.id})).status,409);
  assert.deepEqual((await app.request(white,"GET","state")).data.stats,{played:1,wins:1,draws:0,losses:0});

  const bot = await app.request(white,"POST","bot",{side:-1,level:2});
  assert.equal(bot.status,200);
  assert.equal(bot.data.game.mode,"bot");
  assert.equal(bot.data.game.side,-1);
  let game = bot.data.game;
  for (let i = 0; game.turn === 1 && i < 25; i++) {
    await wait(50);
    game = (await app.request(white,"GET","state")).data.game;
  }
  assert.equal(game.turn,-1);
  assert.equal(game.version,1);
  assert.ok(game.available.length);
});

test("an intermediate capture can be resumed with the same piece and crowns immediately",() => {
  const board = Array(64).fill(0);
  board[17] = 1;
  board[10] = -1;
  board[21] = -2;
  let game = {board,turn:WHITE,result:null,chain:null,last:null,
    draw:{...drawState(),repetitions:[[positionKey(board,WHITE),1]]}};
  assert.equal(jump(game,17,3),true);
  const intermediate = viewPosition(game);
  assert.equal(intermediate.board[3],2);
  assert.deepEqual(intermediate.taken,[10]);
  game = JSON.parse(JSON.stringify(game));
  assert.equal(jump(game,17,30),false);
  assert.deepEqual(available(game).map(move=>move.to).sort((a,b)=>a-b),[30,39]);
  assert.equal(jump(game,3,30),true);
  assert.equal(game.result.side,1);
  assert.equal(game.board.filter(Boolean).length,1);
});

test("AI chooses an allowed move, saves its comment and falls back for an invalid choice",async t => {
  const position = initialPosition();
  const choices = legalMoves(position,WHITE);
  const comment = "Занимаю центр, чтобы оставить больше вариантов для следующего хода.";
  let calls = 0;
  const ai = createAiPlayer("test-key",{
    async request(url, options) {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(url,"https://openrouter.ai/api/v1/chat/completions");
      assert.equal(body.model,"openrouter/free");
      const sent = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(sent),["side","rows","lastMove","legalMoves"]);
      assert.equal(sent.rows.length,8);
      assert.equal(sent.legalMoves.length,choices.length);
      assert.equal(sent.side,"белые");
      assert.equal(sent.lastMove,null);
      return Response.json({choices:[{message:{content:JSON.stringify({
        move:calls === 1 ? 2 : 999,comment
      })}}]});
    }
  });
  const app = await start(":memory:",ai);
  t.after(() => app.close());

  async function waitForWhiteMove(id) {
    const reply = await app.request(id,"POST","bot",{side:-1,level:AI_LEVEL});
    assert.equal(reply.status,200);
    assert.equal(reply.data.aiAvailable,true);
    assert.equal(reply.data.game.ai,true);
    assert.equal(reply.data.game.opponent.name,"ИИ");
    for (let i = 0; i < 50; i++) {
      const {data} = await app.request(id,"GET","state");
      if (data.game.version > 0) return data.game;
      await wait(20);
    }
    assert.fail("Bot did not answer");
  }

  const game = await waitForWhiteMove(4);
  assert.deepEqual(game.board,played(position,choices[1]));
  assert.equal(game.comment,comment);
  assert.equal(game.turn,-1);
  assert.equal((await app.request(4,"GET","state")).data.game.comment,comment);

  const fallback = await waitForWhiteMove(5);
  assert.ok(choices.some(move => JSON.stringify(move.path) === JSON.stringify(fallback.last.path)));
  assert.match(fallback.comment,/недоступен/);
  assert.equal(calls,2);
});

test("resigning aborts an unfinished AI request without writing a late move",async t => {
  let receivedSignal;
  let finishRequest;
  const ai = ({moves,signal}) => {
    receivedSignal = signal;
    return new Promise(resolve => {
      finishRequest = () => resolve({move:moves[0],comment:"Запоздавший ход."});
    });
  };
  const app = await start(":memory:",ai);
  t.after(() => app.close());
  const initial = await app.request(6,"POST","bot",{side:-1,level:AI_LEVEL});
  assert.equal(receivedSignal.aborted,false);
  const {data} = await app.request(6,"POST","resign",{id:initial.data.game.id});
  assert.equal(receivedSignal.aborted,true);
  assert.equal(data.game.version,1);
  finishRequest();
  const final = (await app.request(6,"GET","state")).data.game;
  assert.equal(final.version,1);
  assert.equal(final.comment,null);
  assert.deepEqual(final.board,initialPosition());
});
