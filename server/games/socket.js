// server/games/socket.js
// Socket surface for the game floor.

const floor = require("./index");

const DRAW_MSGS_PER_SEC = 50;
const DRAW_SEGMENTS_PER_MSG = 40;

function who(socket) {
  const sess = socket.handshake.session || {};
  if (!socket.roomId || !sess.userId) return null;
  return { userId: sess.userId, username: sess.username || "Someone" };
}

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
      if (socket.spectating) return;
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
      if (out && out.ok && (out.accepted || out.correct !== undefined)) {
        socket.emit("games feedback", {
          tableId: d.tableId,
          accepted: out.accepted || null,
          pts: out.pts || 0,
          correct: out.correct === true,
          close: out.close === true,
          known: out.known === true,
        });
      }
      return out;
    }),
  );

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
