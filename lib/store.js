"use strict";

const {randomUUID, randomInt} = require("node:crypto");
const {DatabaseSync} = require("node:sqlite");
const {createGame} = require("./game");

const QUEUE_TTL = 45_000;

function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      photo TEXT
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      white INTEGER NOT NULL,
      black INTEGER NOT NULL,
      document TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      winner INTEGER,
      created INTEGER NOT NULL,
      finished INTEGER
    );
    CREATE INDEX IF NOT EXISTS games_white ON games (white, finished, created);
    CREATE INDEX IF NOT EXISTS games_black ON games (black, finished, created);
    CREATE TABLE IF NOT EXISTS queue (
      player INTEGER PRIMARY KEY,
      joined INTEGER NOT NULL,
      seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS queue_joined ON queue (joined);
  `);
  const queries = {
    profile:db.prepare("SELECT name, photo FROM players WHERE id = ?"),
    upsert:db.prepare(`INSERT INTO players VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE
      SET name = excluded.name, photo = excluded.photo
      WHERE name IS NOT excluded.name OR photo IS NOT excluded.photo`),
    game:db.prepare("SELECT * FROM games WHERE id = ?"),
    active:db.prepare("SELECT * FROM games WHERE finished IS NULL AND (white = ? OR black = ?) ORDER BY created DESC LIMIT 1"),
    latest:db.prepare("SELECT * FROM games WHERE white = ? OR black = ? ORDER BY created DESC, rowid DESC LIMIT 1"),
    insert:db.prepare("INSERT INTO games (id,mode,white,black,document,created) VALUES (?, ?, ?, ?, ?, ?)"),
    update:db.prepare("UPDATE games SET document=?, rev=rev+1, winner=?, finished=? WHERE id=? AND rev=? AND finished IS NULL"),
    unqueue:db.prepare("DELETE FROM queue WHERE player = ?"),
    expire:db.prepare("DELETE FROM queue WHERE seen < ?"),
    refresh:db.prepare("UPDATE queue SET seen = ? WHERE player = ? AND seen >= ?"),
    peer:db.prepare("SELECT player FROM queue WHERE player <> ? ORDER BY joined, player LIMIT 1"),
    enqueue:db.prepare("INSERT OR IGNORE INTO queue VALUES (?, ?, ?)"),
    stats:db.prepare(`SELECT count(*) AS played,
      count(*) FILTER (WHERE winner = ?) AS wins,
      count(*) FILTER (WHERE winner = 0) AS draws,
      count(*) FILTER (WHERE winner <> ? AND winner <> 0) AS losses
      FROM games WHERE finished IS NOT NULL AND (white = ? OR black = ?)`)
  };
  const unpack = row => row && {...row, game:JSON.parse(row.document)};
  const active = id => unpack(queries.active.get(id,id));
  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function insert(mode, white, black, level, now) {
    const id = randomUUID();
    queries.insert.run(id,mode,white,black,JSON.stringify(createGame(level)),now);
    return unpack(queries.game.get(id));
  }
  return {
    active,
    profile(id) { return queries.profile.get(id); },
    remember(user) { queries.upsert.run(user.id,user.name,user.photo); },
    get(id) { return unpack(queries.game.get(id)); },
    latest(id) { return unpack(queries.latest.get(id,id)); },
    stats(id) { return queries.stats.get(id,id,id,id); },
    heartbeat(id, now) {
      return Boolean(queries.refresh.run(now,id,now-QUEUE_TTL).changes);
    },
    leaveQueue(id) { queries.unqueue.run(id); },
    join(id, now) {
      return transaction(() => {
        const current = active(id);
        if (current) return current;
        queries.expire.run(now-QUEUE_TTL);
        const peer = queries.peer.get(id);
        if (!peer) {
          queries.enqueue.run(id,now,now);
          return null;
        }
        queries.unqueue.run(id);
        queries.unqueue.run(peer.player);
        const [white,black] = randomInt(2) ? [id,peer.player] : [peer.player,id];
        return insert("online",white,black,null,now);
      });
    },
    startBot(id, side, level, now) {
      return transaction(() => {
        const current = active(id);
        if (current) return current;
        queries.unqueue.run(id);
        return insert("bot",side === 1 ? id : 0,side === -1 ? id : 0,level,now);
      });
    },
    save(row, now) {
      const result = row.game.result;
      const winner = result ? result.side === 0 ? 0 :
        (result.side === 1 ? row.white : row.black) || -1 : null;
      const done = queries.update.run(JSON.stringify(row.game),winner,result ? now : null,row.id,row.rev);
      return done.changes === 1;
    },
    close() { db.close(); }
  };
}

module.exports = {openStore};
