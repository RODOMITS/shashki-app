"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHmac} = require("node:crypto");
const {mkdtemp, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {setTimeout:wait} = require("node:timers/promises");
const {createApp} = require("../index");
const {initialPosition, WHITE, positionKey, drawState} = require("../lib/engine");
const {jump, viewPosition, available} = require("../lib/game");

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

async function start(databasePath) {
  const server = createApp({token,databasePath,now:() => date});
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
