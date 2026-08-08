// server/games/socket.js
// Socket surface for the game floor. Every handler resolves the caller from
// the session and their current room, so nothing here trusts a client-supplied
// user or room id.

const floor = require("./index");

// Drawing bypasses the generic socket limiter the same way piano notes do,
// so it carries its own cap: this many messages a second, each a small batch
// of segments.
const DRAW_MSGS_PER_SEC = 50;
const DRAW_SEGMENTS_PER_MSG = 40;

// Paddle intent for a realtime game. The browser samples its own pointer at
// fifty a second; this is the ceiling that stops a patched page turning the
// input channel into a flood. It has room above the browser's rate on purpose:
// when this sat just under it, a burst clipped the cap and the dropped
// messages were the newest ones, so the paddle simply stopped following the
// hand for the rest of the second.
const INPUT_MSGS_PER_SEC = 90;

function who(socket) {
  const sess = socket.handshake.session || {};
  if (!socket.roomId || !sess.userId) return null;
  return { userId: sess.userId, username: sess.username || "Someone" };
}

// One counter per stream, so a drag and a paddle never eat each other's budget.
function allowed(socket, key, perSec) {
  const now = Date.now();
  const w = "_w" + key;
  const c = "_c" + key;
  if (!socket[w] || now - socket[w] > 1000) {
    socket[w] = now;
    socket[c] = 0;
  }
  socket[c]++;
  return socket[c] <= perSec;
}

function drawAllowed(socket) {
  return allowed(socket, "gd", DRAW_MSGS_PER_SEC);
}

function register(socket, safe) {
  const fail = (msg) => socket.emit("games error", { message: msg });

  const act = (fn) =>
    safe(async (data) => {
      const u = who(socket);
      if (!u) return;
      if (socket.spectating) return; // room spectators are read-only
      const out = await fn(u, data || {});
      if (out && out.err) fail(out.err);
    });

  socket.on(
    "games open",
    safe(async () => {
      const u = who(socket);
      if (!u) return;
      socket.emit("games snapshot", floor.snapshot(socket.roomId, u.userId));
    }),
  );

  socket.on(
    "games queue join",
    act((u, d) => floor.queueJoin(socket.roomId, u, String(d.type || ""))),
  );

  socket.on(
    "games queue leave",
    act((u, d) => floor.queueLeave(socket.roomId, u.userId, String(d.type || ""))),
  );

  // A watcher putting their hand up for a seat when this round ends.
  socket.on(
    "games play next",
    act((u, d) =>
      floor.playNext(socket.roomId, u, String(d.tableId || ""), d.on !== false),
    ),
  );

  socket.on(
    "games join table",
    act((u, d) => floor.joinTable(socket.roomId, u, String(d.tableId || ""))),
  );

  socket.on(
    "games leave",
    act((u, d) => floor.leaveTable(socket.roomId, u.userId, String(d.tableId || ""))),
  );

  socket.on(
    "games move",
    act((u, d) => {
      const out = floor.makeMove(
        socket.roomId,
        u.userId,
        String(d.tableId || ""),
        d.move || {},
      );
      // Word Race and guessing want a private yes/no rather than a board
      // update everyone can read.
      if (out && out.ok && (out.accepted || out.correct !== undefined)) {
        socket.emit("games feedback", {
          tableId: d.tableId,
          accepted: out.accepted || null,
          pts: out.pts || 0,
          correct: out.correct === true,
          close: out.close === true,
          // A real country, just not this one. Never says which.
          known: out.known === true,
        });
      }
      return out;
    }),
  );

  // Strokes come in batches on their own event so the shared limiter does not
  // chop a line in half mid-drag.
  socket.on(
    "games draw",
    safe(async (data) => {
      const u = who(socket);
      if (!u || socket.spectating) return;
      if (!drawAllowed(socket)) return;
      const tableId = String((data && data.tableId) || "");
      const kind = (data && data.kind) || "stroke";

      if (kind === "sync") {
        floor.syncCanvas(socket.roomId, u.userId, tableId);
        return;
      }
      if (kind === "clear" || kind === "undo") {
        floor.makeMove(socket.roomId, u.userId, tableId, { kind });
        return;
      }
      const segs = Array.isArray(data && data.segments) ? data.segments : [];
      if (!segs.length) return;
      floor.drawStrokes(
        socket.roomId,
        u.userId,
        tableId,
        segs.slice(0, DRAW_SEGMENTS_PER_MSG),
      );
    }),
  );

  // Paddle intent, on its own event for the same reason strokes are: the
  // generic limiter would chop a rally in half. Answers nothing, ever - the
  // next frame off the realtime lane is the answer.
  socket.on(
    "games input",
    safe(async (data) => {
      const u = who(socket);
      if (!u || socket.spectating) return;
      if (!allowed(socket, "gi", INPUT_MSGS_PER_SEC)) return;
      floor.realtimeInput(
        socket.roomId,
        u.userId,
        String((data && data.tableId) || ""),
        (data && data.input) || {},
      );
    }),
  );

  // Watchers throwing an emoji at the board. Players can too.
  socket.on(
    "games cheer",
    act((u, d) =>
      floor.cheer(socket.roomId, u.userId, String(d.tableId || ""), String(d.emoji || "")),
    ),
  );

  socket.on(
    "games rematch",
    act((u, d) => floor.rematch(socket.roomId, u.userId, String(d.tableId || ""))),
  );

  socket.on(
    "games spectate",
    act((u, d) =>
      floor.spectate(socket.roomId, u.userId, String(d.tableId || ""), !!d.on),
    ),
  );

  socket.on(
    "games challenge",
    act((u, d) =>
      floor.challenge(
        socket.roomId,
        u,
        String(d.targetUserId || ""),
        String(d.type || ""),
      ),
    ),
  );

  socket.on(
    "games challenge respond",
    act((u, d) =>
      floor.respondChallenge(
        socket.roomId,
        u.userId,
        String(d.id || ""),
        !!d.accept,
      ),
    ),
  );

  // Per-game chat. Spectators can talk to the people playing, which is most of
  // the point of watching.
  socket.on(
    "games chat",
    act((u, d) =>
      floor.chat(socket.roomId, u, String(d.tableId || ""), d.text),
    ),
  );

  socket.on(
    "games typing",
    act((u, d) =>
      floor.typing(socket.roomId, u.userId, String(d.tableId || ""), !!d.on),
    ),
  );

  socket.on(
    "games vote remove",
    act((u, d) =>
      floor.voteRemove(
        socket.roomId,
        u.userId,
        String(d.tableId || ""),
        String(d.targetUserId || ""),
      ),
    ),
  );
}

module.exports = { register };
