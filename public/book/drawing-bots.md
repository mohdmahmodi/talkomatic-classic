# Drawing Bots (Talkoboard)

How to make a bot draw on the shared board in a room.

This picks up where [Getting Started With Bots](getting-started-with-bots.md)
leaves off: get a bot token, connect, and join a room first. Everything here is
Socket.IO events on that same connection.

---

## Table of Contents

- [Two kinds of bot](#two-kinds-of-bot)
- [In the page: userscripts and the console](#in-the-page-userscripts-and-the-console)
- [The shortest bot that draws](#the-shortest-bot-that-draws)
- [How the board works](#how-the-board-works)
- [Freehand: start, move, end](#freehand-start-move-end)
- [Whole shapes in one event](#whole-shapes-in-one-event)
- [Filled shapes and holes](#filled-shapes-and-holes)
- [Reading the board](#reading-the-board)
- [Undo and redo](#undo-and-redo)
- [Claimed areas](#claimed-areas)
- [Limits, and what gets you refused](#limits-and-what-gets-you-refused)
- [Event reference](#event-reference)
- [A worked example: writing text](#a-worked-example-writing-text)

---

## Two kinds of bot

**Outside the page** - a Node or Python script with a bot token, connecting over
Socket.IO. It joins a room like anybody else. Everything from
[the next section](#the-shortest-bot-that-draws) down is about this.

**Inside the page** - a userscript, a bookmarklet, or something typed into the
console, running in a room you already have open. No token, no second
connection: it borrows the board you are already looking at. Read on.

---

## In the page: userscripts and the console

Open a room, open the Talkoboard, and the page exposes `window.TalkoboardBots`.

```js
const tb = window.TalkoboardBots;

tb.draw({
  points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 160 }, { x: 0, y: 0 }],
  color: "#e74c3c",
  size: 5,
  sharp: true,
});
```

That single call puts the stroke on **your** screen and sends it to everyone
else. Both halves matter: the server does not echo your own strokes back to
you, so a script that only emits leaves you staring at a blank board wondering
whether it worked.

| | |
| --- | --- |
| `tb.draw(stroke)` | One finished stroke, locally and to the room. Returns its id |
| `tb.send(strokes, onProgress)` | A batch, **paced under the rate limit**. Returns a promise of the ids |
| `tb.erase(id)` | Takes one of yours back off, here and everywhere |
| `tb.view()` | `zoom`, `panX/panY`, size, and `toWorld` / `toScreen` / `centre()` |
| `tb.claims()` | Areas people have fenced off |
| `tb.on(event, fn)` | Board events straight through |
| `tb.limits` | The numbers below, so you do not have to hard-code them |
| `tb.board`, `tb.socket`, `tb.isOpen` | The real objects, if you need them |

`tb.send()` is the one to reach for. Pacing is what everybody gets wrong by
hand - the burst is small, and going over it costs fifteen seconds of nothing
getting through:

```js
// Draw where the person is actually looking.
const c = tb.view().centre();

await tb.send(
  myStrokes.map((s) => ({ ...s, points: s.points.map((p) => ({
    x: c.x + p.x, y: c.y + p.y,
  })) })),
  (done, total) => console.log(done + "/" + total),
);
```

### Writing a userscript

Two things will stop you before your code ever runs:

- **Use a `@grant`, not `@grant none`.** The page's Content Security Policy is
  `script-src 'self' 'nonce-…'`, so a script injected into the page without the
  nonce is refused and silently never runs. Any grant puts the script in the
  manager's own sandbox instead, where the policy does not apply. Reach the page
  through `unsafeWindow`.
- **`eval` and `new Function` are blocked** by the same policy - there is no
  `unsafe-eval`. Anything that builds code from strings will throw.

```js
// ==UserScript==
// @match        https://classic.talkomatic.co/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

const tb = unsafeWindow.TalkoboardBots; // undefined until the board is opened
```

`TalkoboardBots` appears when the board is first opened in a room, so poll for
it rather than assuming it is there at load.

Nothing here is a privilege. It is the same connection with the same rules: the
rate limit, claimed areas, bans and moderation apply exactly as they do to a
person with a mouse, and everything you draw carries your name.

---

## The shortest bot that draws

```js
const { io } = require("socket.io-client");

const socket = io("https://classic.talkomatic.co", {
  transports: ["websocket"],
  auth: { token: process.env.BOT_TOKEN },
});

socket.on("connect", () => {
  socket.emit("join lobby", { username: "DrawBot", location: "Somewhere" });
  setTimeout(() => socket.emit("join room", { roomId: process.env.ROOM_ID }), 500);
});

socket.on("room joined", () => {
  socket.emit("board open");

  // A red triangle, sent as one finished stroke.
  socket.emit("board stroke add", {
    stroke: {
      id: "drawbot:1",
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 200, y: 260 },
        { x: 100, y: 100 },
      ],
      color: "#e74c3c",
      size: 6,
      eraser: false,
      sharp: true,
    },
  });
});
```

That is the whole idea. `board stroke add` takes a finished stroke, so a bot
never has to simulate a hand moving.

---

## How the board works

The board is an **infinite plane of vector strokes**. There is no bitmap. A
stroke is a list of points, a colour and a width, and everybody's client draws
the same list the same way.

- **Coordinates are world coordinates**, not pixels on anybody's screen. `(0, 0)`
  is where the board opens by default; people pan and zoom around it. Positive
  x is right, positive y is down.
- **There are no bounds.** `{ x: 90000, y: -4000 }` is a real place. Nobody will
  ever see it, which is its own kind of problem - keep near the origin unless you
  have a reason not to.
- **A stroke is the unit of everything.** Erasing by person, undo, the PNG
  export and moderation all work on whole strokes.
- **Shapes are not special.** A rectangle is a stroke whose points happen to
  trace a rectangle. The server has no idea what a rectangle is, which means
  anything you can express as a point list is drawable.

Every stroke you send is attributed to you. A moderator can see who drew what,
erase everything one account drew, and take a badly behaved account off the
board. Write bots accordingly.

---

## Freehand: start, move, end

Use this when the drawing arrives over time and you want people to watch it
appear - a plotter, a clock hand, someone's mouse being mirrored.

```js
socket.emit("board stroke start", {
  id: "drawbot:2",          // yours, unique, <= 64 chars
  point: { x: 0, y: 0 },
  color: "#2196f3",
  size: 4,
  eraser: false,
  gradient: null,           // or ["#ff0000", "#ffff00"] for a gradient brush
});

socket.emit("board stroke move", { points: [{ x: 20, y: 6 }, { x: 40, y: 14 }] });
socket.emit("board stroke move", { points: [{ x: 60, y: 26 }] });

socket.emit("board stroke end");
```

- Batch points into one `board stroke move` rather than one event each. Up to
  **200 points per event**.
- One stroke at a time per connection. Starting another finishes the last.
- `board stroke end` matters: an unfinished stroke stays "in progress" until you
  disconnect.

---

## Whole shapes in one event

Use this for anything you already know the shape of. One event, no timing, and
it cannot be left half-finished:

```js
socket.emit("board stroke add", {
  stroke: {
    id: "drawbot:3",
    points: [ /* ... */ ],
    color: "#000000",
    size: 3,
    eraser: false,
    gradient: null,
    fill: false,     // solid inside?
    rings: null,     // extra rings, for a fill with holes in it
    sharp: true,     // corners stay corners - see below
  },
});
```

**`sharp` is the one that catches people out.** Without it the points are
smoothed through their midpoints, which is right for a wobbly hand-drawn line
and wrong for anything geometric: it rounds off every corner of your rectangle.

- Straight edges and corners (rectangles, triangles, letters, graphs) -
  `sharp: true`.
- Curves you have already tessellated finely (circles, spirals, sine waves) -
  leave it off and let the smoothing help you.

Helpers for the common shapes:

```js
const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y },
];

const ellipse = (cx, cy, rx, ry, steps = 48) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * Math.PI * 2;
    return { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry };
  });
```

---

## Filled shapes and holes

`fill: true` fills the path with `color`. `size` still draws the outline, so use
`size: 1` if you want the fill and nothing else.

`rings` is how a fill gets holes. Every ring goes into one path, filled
**even-odd**: the outer ring fills, a ring inside it punches a hole, a ring
inside that fills again.

```js
socket.emit("board stroke add", {
  stroke: {
    id: "drawbot:4",
    points: rect(0, 0, 200, 200),           // the outline, for hit-testing
    rings: [rect(0, 0, 200, 200), rect(60, 60, 80, 80)], // a square with a hole
    color: "#8bc34a",
    size: 1,
    fill: true,
    sharp: true,
  },
});
```

Keep `points` set to your outer ring even when you use `rings` - it is what the
board hit-tests against.

---

## Reading the board

```js
socket.emit("board open");

socket.on("board state", ({ strokes, active, claims }) => {
  // strokes: everything finished, oldest first, each with an `owner`
  // active:  strokes being drawn right now, keyed by user id
  // claims:  areas people have fenced off (see below)
});

// And then, as things happen:
socket.on("board stroke start", ({ userId, id, point, color, size }) => {});
socket.on("board stroke move",  ({ userId, points }) => {});
socket.on("board stroke end",   ({ userId }) => {});
socket.on("board stroke add",   ({ userId, stroke }) => {});
socket.on("board stroke remove",({ id }) => {});
socket.on("board clear",        () => {});
socket.on("board user wiped",   ({ userId, n }) => {});
```

You do not have to call `board open` to draw, but you do have to call it to be
sent any of this.

---

## Undo and redo

```js
socket.emit("board stroke remove", { id: "drawbot:3" }); // yours only
socket.emit("board stroke add", { stroke: theSameStrokeAgain });
```

Removal is ownership-checked on the server: you can only remove strokes you
drew. This is also how a bot cleans up after itself - keep your ids and remove
them when you are done, rather than leaving a room full of your output.

---

## Claimed areas

Anyone can fence off a box that only they may draw in. Your bot must expect to
be refused:

```js
socket.on("board claims", ({ claims }) => { /* [{ owner, name, x, y, w, h, away }] */ });

socket.on("board blocked", ({ id, name }) => {
  // Something you drew ran into `name`'s area and was refused.
  // If `id` is set, that whole stroke was thrown away - drop it your side too.
});
```

Rules worth knowing before you write around them:

- A **line that crosses** an area is cut at the fence, not just the points
  inside it. Your stroke ends there; start a new one on the far side.
- A **shape or fill** that touches an area is refused **whole**, including one
  drawn *around* the area or a fill that would swallow it.
- Your bot can claim one too: `board claim { x, y, w, h }` (120 to 1800 a side,
  no overlapping somebody else's), and `board unclaim {}` to give it back. It is
  held for five minutes after you leave, then released.

---

## Limits, and what gets you refused

| Limit | Value | What happens |
| --- | --- | --- |
| Finished strokes (`board stroke add`) | 8 per 6 seconds | Then a 15s cooldown. `board too fast` with `id` and `wait` |
| Points per `board stroke move` | 200 | Extra points dropped |
| Points per stroke | 5000 | Truncated |
| Strokes on a board | 2000 | Oldest go, heaviest contributor first |
| Stroke id | 64 chars | Refused |
| Brush size | 1 to 50 | Clamped |
| Colour | `#rrggbb` | Anything else becomes black |

Two more things that will stop you:

- **`board barred`** - a moderator has taken your account off the board for ten
  minutes. Stop drawing; you will be refused until it passes.
- **`board clear`** - a moderator wiped the board. Do not immediately redraw
  everything; that reads as griefing and gets the bot removed.

The rate limit is deliberately tight because a shape costs one event and a
human drawing one costs a second of their time. **If your bot needs to place a
lot of strokes, send fewer, bigger ones** - one polyline with 400 points, not
400 lines.

---

## Event reference

**You send:**

| Event | Payload |
| --- | --- |
| `board open` | - |
| `board close` | - |
| `board stroke start` | `{ id, point, color, size, eraser, gradient }` |
| `board stroke move` | `{ points: [{x, y}] }` |
| `board stroke end` | - |
| `board stroke add` | `{ stroke: { id, points, color, size, eraser, gradient, fill, rings, sharp } }` |
| `board stroke remove` | `{ id }` |
| `board cursor` | `{ x, y }` |
| `board chat` | `{ message }` |
| `board claim` | `{ x, y, w, h }` |
| `board unclaim` | `{}` |

**You receive:** `board state`, `board stroke start`, `board stroke move`,
`board stroke end`, `board stroke add`, `board stroke remove`, `board clear`,
`board user wiped`, `board claims`, `board claim result`, `board blocked`,
`board too fast`, `board barred`, `board allowed`, `board chat`,
`board cursor`, `board user status`.

---

## A worked example: writing text

Stroke fonts are the easy win, because a letter is just a point list. This draws
with straight segments, so `sharp: true`:

```js
const LETTERS = {
  H: [[[0, 0], [0, 100]], [[0, 50], [60, 50]], [[60, 0], [60, 100]]],
  I: [[[30, 0], [30, 100]]],
  "!": [[[30, 0], [30, 70]], [[30, 90], [30, 100]]],
};

function write(text, x, y, scale = 1, color = "#000000") {
  let cursor = x;
  let n = 0;
  for (const ch of text.toUpperCase()) {
    const strokes = LETTERS[ch];
    if (strokes) {
      for (const seg of strokes) {
        socket.emit("board stroke add", {
          stroke: {
            id: `drawbot:text:${Date.now()}:${n++}`,
            points: seg.map(([px, py]) => ({
              x: cursor + px * scale,
              y: y + py * scale,
            })),
            color,
            size: 4,
            sharp: true,
          },
        });
      }
    }
    cursor += 80 * scale;
  }
}
```

Mind the rate limit: that emits one event per segment, so `write("HI!")` is five
events - fine. A whole sentence is not. Batch a word into a single stroke where
the pen would not have to lift, or space the calls out.

---

## Be a good guest

The board is shared, and everything you draw has your name on it as far as
moderators are concerned.

- Draw **where you were asked to**, near where the people are, not scattered
  across the plane.
- **Clean up** with `board stroke remove` when your output is no longer wanted.
- **Never** redraw over somebody's work to cover it, and never treat a refusal
  from a claimed area as something to route around.
- Respect `board barred`, `board too fast` and `board clear` instead of
  retrying in a loop.

A bot that ignores these gets its strokes wiped and its account taken off the
board, which is a lot of work for nothing.
