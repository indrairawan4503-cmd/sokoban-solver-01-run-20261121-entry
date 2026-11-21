// sokoban-solver-01-run-20261121-entry — variant A: push-BFS per room.
//
// How it works: a level is a hallway with 1-4 small rooms off it, each room
// holding 3-4 boxes and as many goals, and a box that leaves its room can
// never come back — so the level's push-optimal count is the sum of its
// rooms' optima. For every room we run a breadth-first search over PUSHES
// (state = sorted box squares + the player's reachable region, named by its
// lowest square), so the first solved state found is push-optimal. Two
// deadlocks are pruned: a dead square (pull-back reachability from the goals
// — a square a box can never be pushed from onto a goal, ignoring other
// boxes) and a frozen 2x2 block (four wall/box squares holding a box off its
// goal). Each room is searched on a small board of just its own squares plus
// the hallway row, with the other rooms' squares walled off; if that ever
// fails, the room is retried on the whole board, and a level that is no set
// of rooms falls back to a whole-level push search. The push list of each
// room is then replayed on the full board, stitching the shortest walks
// between pushes, so the final answer is the player's moves in LURD.
//
// Everything is budgeted by WORK, never by the clock: a fixed cap of states
// per search and one shared cap for the whole run. No clock reads, no
// randomness, no environment reads beyond the input/output directories, and
// fixed direction order everywhere, so two runs answer byte for byte alike.
// A search that gives up never crashes the run: the level simply gets an
// empty solution.txt (still a valid, answered instance).

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States kept by one search before it gives up. */
const ROOM_STATES = 250_000;
/** States expanded by the whole run before later searches give up. */
const RUN_STATES = 2_000_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

/** States expanded so far in this run (the shared work budget). */
let runStates = 0;

interface Board {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Push {
  from: number;
  dir: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

/** A level in XSB (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parse(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, size, wall, goal, goals, boxes, player };
}

/** Squares a lone box can be pushed from onto some goal, pulled back from the goals. */
function liveSquares(bd: Board): Uint8Array {
  const { w, wall, goals, size } = bd;
  const live = new Uint8Array(size);
  const q: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    q.push(g);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d; // the square the box is pushed from
      if (y < 0 || y >= size || wall[y] || live[y]) continue;
      const stand = y - d; // where the player stands to make that push
      if (stand < 0 || stand >= size || wall[stand]) continue;
      live[y] = 1;
      q.push(y);
    }
  }
  return live;
}

/**
 * Flood-fill from `from` over floor squares with `occ` in the way, stamping
 * `seen` and returning the region's lowest square. Every square the fill
 * touches is strictly inside the board's outer wall frame, so its four
 * neighbours are always valid indices.
 */
function flood(bd: Board, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = bd;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    let q = p - w;
    if (!wall[q] && !occ[q] && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p + w;
    if (!wall[q] && !occ[q] && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p - 1;
    if (!wall[q] && !occ[q] && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p + 1;
    if (!wall[q] && !occ[q] && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozen(bd: Board, occ: Uint8Array, t: number): boolean {
  const { w, wall, goal } = bd;
  for (let c = 0; c < 4; c++) {
    const a = c === 0 ? t : c === 1 ? t - 1 : c === 2 ? t - w : t - w - 1;
    const b = a + 1;
    const cc = a + w;
    const d = cc + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[cc] || occ[cc]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[cc] && !goal[cc]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The push-optimal push list for a board, or null when the search gives up.
 * Breadth-first over pushes: states are visited in order of pushes made, so
 * the first solved state generated is optimal. Two stamp arrays are kept —
 * one for the region of the state being expanded, one for the regions of the
 * states its pushes would make — so a candidate's flood never overwrites the
 * expansion's region marks.
 */
function pushBfs(bd: Board, maxStates: number): Push[] | null {
  const { w, wall, goal, size } = bd;
  const live = liveSquares(bd);
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stampSeen = 0;
  let stampMark = 0;
  const solved = (bs: number[]): boolean => {
    for (const x of bs) if (!goal[x]) return false;
    return true;
  };
  if (bd.boxes.some((x) => !live[x])) return null;
  // A numeric key is exact while size ** (boxes + 1) stays under 2 ** 53;
  // otherwise the key is a string (whole-level boards with many boxes).
  const numeric = size ** (bd.boxes.length + 1) < 2 ** 53;
  const keyOf = (bs: number[], low: number): number | string => {
    if (numeric) {
      let k = low;
      for (const x of bs) k = k * size + x;
      return k;
    }
    return low + '|' + bs.join(',');
  };
  const sBoxes: number[][] = [bd.boxes.slice()];
  const sPlayer: number[] = [bd.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const x of bd.boxes) occ[x] = 1;
  index.set(keyOf(bd.boxes, flood(bd, occ, bd.player, mark, ++stampMark, stack)), 0);
  for (const x of bd.boxes) occ[x] = 0;
  let found = solved(bd.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    if (++runStates > RUN_STATES) return null;
    const boxes = sBoxes[head];
    for (const x of boxes) occ[x] = 1;
    flood(bd, occ, sPlayer[head], seen, ++stampSeen, stack);
    const here = stampSeen;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        if (wall[t] || occ[t] || !live[t]) continue;
        if (seen[b - d] !== here) continue; // the player cannot reach the push square
        occ[b] = 0;
        occ[t] = 1;
        let next: number[] | null = null;
        let k2: number | string = -1;
        if (!frozen(bd, occ, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          k2 = keyOf(next, flood(bd, occ, b, mark, ++stampMark, stack));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (next === null || index.has(k2)) continue;
        if (sBoxes.length >= maxStates) return null;
        index.set(k2, sBoxes.length);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(head);
        sFrom.push(b);
        sDir.push(k);
        if (solved(next)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;
  const pushes: Push[] = [];
  for (let s = found; s > 0; s = sParent[s]) pushes.push({ from: sFrom[s], dir: sDir[s] });
  pushes.reverse();
  return pushes;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway —
 * a box there reaches no goal) out of the floor; each remaining part holding
 * a box is a room. Null when a box starts in the hallway, a goal is cut off,
 * or some part holds more or fewer boxes than goals.
 */
function roomsOf(lv: Board): Room[] | null {
  const { w, wall, goals, boxes, player, size } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      const ns = [p - w, p + w, p - 1, p + 1];
      for (const q of ns) {
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r].boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The lowest square of the player's full-board region that lies in `allowed`, or -1. */
function lowestRegionIn(lv: Board, occ: Uint8Array, from: number, allowed: Uint8Array): number {
  const { w, wall, size } = lv;
  const seen = new Uint8Array(size);
  const stack: number[] = [from];
  seen[from] = 1;
  let best = allowed[from] ? from : -1;
  for (let i = 0; i < stack.length; i++) {
    const p = stack[i];
    if (allowed[p] && (best < 0 || p < best)) best = p;
    const ns = [p - w, p + w, p - 1, p + 1];
    for (const q of ns) {
      if (!wall[q] && !occ[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return best;
}

/**
 * The small board a room is searched on: its own squares plus the hallway
 * row (the player walks the hallway to reach the door), everything else a
 * wall. The player's start is the lowest square of the player's real region
 * inside that board — the region there is the real region cut to the board,
 * so every push the search finds is one the player can really make.
 */
function roomBoard(lv: Board, room: Room, player: number, boxes: number[]): Board | null {
  const { w, size } = lv;
  const inS = new Uint8Array(size);
  for (const s of room.squares) inS[s] = 1;
  const row = Math.floor(lv.player / w); // the hallway row of the original level
  for (let i = row * w; i < (row + 1) * w; i++) if (!lv.wall[i]) inS[i] = 1;
  const occ = new Uint8Array(size);
  for (const b of boxes) occ[b] = 1;
  const start = lowestRegionIn(lv, occ, player, inS);
  if (start < 0) return null;
  const wall = new Uint8Array(size);
  for (let i = 0; i < size; i++) wall[i] = lv.wall[i] || !inS[i] ? 1 : 0;
  const goal = new Uint8Array(size);
  for (const g of room.goals) goal[g] = 1;
  return { w: lv.w, h: lv.h, size, wall, goal, goals: room.goals.slice(), boxes: room.boxes.slice(), player: start };
}

/** The same room on the whole board, the other rooms' boxes standing as walls (retry when the small board fails). */
function roomBoardWhole(lv: Board, room: Room, player: number, boxes: number[]): Board {
  const { size } = lv;
  const wall = lv.wall.slice();
  for (const b of boxes) if (!room.boxes.includes(b)) wall[b] = 1;
  const goal = new Uint8Array(size);
  for (const g of room.goals) goal[g] = 1;
  return { w: lv.w, h: lv.h, size, wall, goal, goals: room.goals.slice(), boxes: room.boxes.slice(), player };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters, or null when unreachable. */
function walkTo(lv: Board, occ: Uint8Array, from: number, to: number): string | null {
  const { w, wall, size } = lv;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Uint8Array(size);
  const q: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const p = q[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const s = p + DY[k] * w + DX[k];
      if (wall[s] || occ[s] || prev[s] !== -1) continue;
      prev[s] = p;
      how[s] = k;
      q.push(s);
    }
  }
  if (prev[to] === -1) return null;
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = STEP[how[p]] + out;
  return out;
}

/**
 * Replay a room's push list on the full board from the real player position:
 * walk to each push square, then push. Returns the move string with the
 * player's and boxes' new positions, or null when a walk fails.
 */
function replay(lv: Board, player: number, boxes: number[], pushes: Push[]): { moves: string; player: number; boxes: number[] } | null {
  const { size, w } = lv;
  const occ = new Uint8Array(size);
  const bs = boxes.slice();
  let p = player;
  let moves = '';
  for (const { from, dir } of pushes) {
    const d = DY[dir] * w + DX[dir];
    for (const b of bs) occ[b] = 1;
    const walk = walkTo(lv, occ, p, from - d);
    for (const b of bs) occ[b] = 0;
    if (walk === null) return null;
    moves += walk + PUSH[dir];
    const i = bs.indexOf(from);
    bs[i] = from + d;
    bs.sort((a, c) => a - c);
    p = from;
  }
  return { moves, player: p, boxes: bs };
}

/** The player's moves solving a level, or '' when the level gives up (still a valid answer). */
function solveLevel(text: string): string {
  const lv = parse(text);
  if (lv.player < 0 || lv.boxes.length === 0) return '';
  if (lv.boxes.every((b) => lv.goal[b])) return '';
  const rooms = roomsOf(lv);
  if (rooms === null) {
    const pushes = pushBfs(lv, ROOM_STATES);
    if (pushes === null) return '';
    const r = replay(lv, lv.player, lv.boxes, pushes);
    return r === null ? '' : r.moves;
  }
  let player = lv.player;
  let boxes = lv.boxes.slice();
  let moves = '';
  for (const room of rooms) {
    const small = roomBoard(lv, room, player, boxes);
    let pushes = small === null ? null : pushBfs(small, ROOM_STATES);
    if (pushes === null) pushes = pushBfs(roomBoardWhole(lv, room, player, boxes), ROOM_STATES);
    if (pushes === null) return '';
    const r = replay(lv, player, boxes, pushes);
    if (r === null) return '';
    moves += r.moves;
    player = r.player;
    boxes = r.boxes;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const dir = join(I, id);
    if (!statSync(dir).isDirectory()) continue;
    moves = solveLevel(readFileSync(join(dir, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
