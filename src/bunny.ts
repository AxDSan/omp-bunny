// /bunny — a rabbit companion that lives above the prompt.
//
// Modeled on the short-lived /buddy pet from Claude Code v2.1.89-v2.1.96 (removed in 2.1.97):
//   - "bones" (rarity, eyes, hat, shiny, stats) are re-derived from a stable id on every read,
//     so editing the state file cannot hand you a legendary;
//   - the "soul" (name, personality, hatch time) is generated once and persisted;
//   - animated 5-line sprite, speech bubble beside it, `/bunny pet` floats hearts for 2.5s.
// The algorithm (FNV-1a -> mulberry32, rarity weights, stat floors, hat gating) follows the public
// write-ups of that feature. Sprite art, names and lines here are original.
//
// Loaded by omp at startup from ~/.omp/agent/extensions (docs: extension-loading.md).
// State: <agent dir>/bunny.json. The bunny reacts to finished turns and failed tool calls in the
// interactive main session only (`ctx.hasUI`), at most once per 20s. `/bunny mute` silences that.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ─── Bones ──────────────────────────────────────────────────────────────────────────────────────

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 };
export const STAT_FLOOR: Record<Rarity, number> = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 };
export const STARS: Record<Rarity, string> = { common: "★", uncommon: "★★", rare: "★★★", epic: "★★★★", legendary: "★★★★★" };
export type RGB = [number, number, number];
export const RARITY_RGB: Record<Rarity, RGB> = {
  common: [160, 160, 160],
  uncommon: [78, 186, 101],
  rare: [99, 155, 255],
  epic: [177, 124, 255],
  legendary: [255, 193, 7],
};

export const STATS = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"] as const;
export type Stat = (typeof STATS)[number];

export const EYES = ["·", "°", "@", "×", "o", "^"] as const;

export const HATS = ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"] as const;
export type Hat = (typeof HATS)[number];
// The lowest rarity index that can roll each hat. Commons never get one.
export const HAT_MIN_RARITY: Record<Hat, number> = {
  none: 0, crown: 1, tophat: 1, propeller: 1, halo: 2, wizard: 2, beanie: 3, tinyduck: 4,
};
export const HAT_ART: Record<Hat, string> = {
  none: "",
  crown: "\\^^^/",
  tophat: "[___]",
  propeller: "-+-",
  halo: "(   )",
  wizard: "/^\\",
  beanie: "(___)",
  tinyduck: ",>",
};

export interface Bones {
  rarity: Rarity;
  eye: string;
  hat: Hat;
  shiny: boolean;
  stats: Record<Stat, number>;
}

export const SALT = "bunny-2026-401";

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollBones(id: string): Bones {
  const rand = mulberry32(fnv1a(id + SALT));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  let roll = rand() * 100;
  let rarity: Rarity = "common";
  for (const candidate of RARITIES) {
    roll -= RARITY_WEIGHT[candidate];
    if (roll < 0) {
      rarity = candidate;
      break;
    }
  }
  const rank = RARITIES.indexOf(rarity);

  const eye = pick(EYES);
  const hats = HATS.filter(h => h !== "none" && HAT_MIN_RARITY[h] <= rank);
  const hat: Hat = rank === 0 ? "none" : pick(hats);
  const shiny = rand() < 0.01;

  const floor = STAT_FLOOR[rarity];
  const peak = pick(STATS);
  const dump = pick(STATS.filter(s => s !== peak));
  const stats = {} as Record<Stat, number>;
  for (const stat of STATS) {
    if (stat === peak) stats[stat] = Math.min(100, floor + 50 + Math.floor(rand() * 30));
    else if (stat === dump) stats[stat] = Math.max(1, floor - 5 + Math.floor(rand() * 10));
    else stats[stat] = Math.min(100, floor + Math.floor(rand() * 40));
  }
  return { rarity, eye, hat, shiny, stats };
}

export function peakStat(bones: Bones): Stat {
  return STATS.reduce((best, s) => (bones.stats[s] > bones.stats[best] ? s : best), STATS[0]);
}

// ─── Soul ───────────────────────────────────────────────────────────────────────────────────────

export const NAMES = [
  "Clover", "Biscuit", "Thumper", "Nibbles", "Pip", "Maple", "Truffle", "Juniper", "Waffles", "Hazel",
  "Mochi", "Turnip", "Bramble", "Sprout", "Parsley", "Pancake", "Radish", "Dandelion", "Cinnamon", "Fern",
  "Bean", "Peaches", "Cocoa", "Willow", "Nutmeg", "Pudding", "Marigold", "Toast", "Bunsen", "Sorrel",
];

export const PERSONALITY: Record<Stat, string> = {
  DEBUGGING: "Sniffs out off-by-one errors before they bloom and thumps twice at every unchecked null.",
  PATIENCE: "Will wait out any build, any flaky test, any forty-minute CI run without twitching an ear.",
  CHAOS: "Hops through your codebase with zero regard for the architecture diagram. Loves a force-push.",
  WISDOM: "Has read the man page. All of it. Quietly points at the paragraph you skipped.",
  SNARK: "Watches you name a variable `data2` and just slowly chews.",
};

export const LINES: Record<Stat, { done: string[]; error: string[] }> = {
  DEBUGGING: {
    done: ["Turn's done. I checked the edge cases. Twice.", "Looks fine. Suspiciously fine.", "No new bugs detected. Yet."],
    error: ["That stack trace has a story to tell.", "Read the first error, not the last one."],
  },
  PATIENCE: {
    done: ["All done. No rush reading it.", "Mm. Good pace.", "Take your time with that diff."],
    error: ["It's okay. Breathe. Retry.", "Errors are just slow feedback."],
  },
  CHAOS: {
    done: ["Ooh, what if we rewrote it in Rust?", "Ship it!!", "*zoomies*"],
    error: ["Fire! Fun fire!", "Everything is on fire. Great."],
  },
  WISDOM: {
    done: ["A clean diff is its own reward.", "Small steps. Good.", "Tests first next time, perhaps?"],
    error: ["The error message is usually right.", "Check your assumptions."],
  },
  SNARK: {
    done: ["Oh look, it finished. Miracles.", "Bold choice.", "I'm sure it works. Sure."],
    error: ["Well. That went great.", "Ah, the classic."],
  },
};
export const PET_LINES = ["*nose wiggle*", "*happy thump*", "*binky!*", "*leans into it*", "*flops over*"];

export interface State {
  id: string;
  name: string;
  personality: string;
  hatchedAt: number;
  hidden: boolean;
  muted: boolean;
}

export function hatch(): State {
  const id = randomUUID();
  const rand = mulberry32(fnv1a(id + "soul"));
  const name = NAMES[Math.floor(rand() * NAMES.length)] as string;
  return {
    id,
    name,
    personality: PERSONALITY[peakStat(rollBones(id))],
    hatchedAt: Date.now(),
    hidden: false,
    muted: false,
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────────────────────────

const STATE_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "bunny.json");

// undefined = not read yet, null = no bunny hatched.
let cache: State | null | undefined;

function loadState(): State | null {
  if (cache !== undefined) return cache;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    if (typeof raw.id !== "string" || typeof raw.name !== "string") throw new Error("missing id/name");
    cache = {
      id: raw.id,
      name: raw.name,
      personality: typeof raw.personality === "string" ? raw.personality : PERSONALITY[peakStat(rollBones(raw.id))],
      hatchedAt: typeof raw.hatchedAt === "number" ? raw.hatchedAt : Date.now(),
      hidden: raw.hidden === true,
      muted: raw.muted === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${STATE_FILE} is unreadable (${(error as Error).message}); fix or delete it`);
    }
    cache = null;
  }
  return cache;
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE_FILE); // a crash mid-write must not leave a half-written identity
  cache = state;
}

// ─── Art ────────────────────────────────────────────────────────────────────────────────────────

export const SPRITE_W = 12;
export const BLOCK_W = 14; // sprite plus a column either side, so a 14-char name fits underneath
const BLINK = "-";

// 5 lines x 12 columns once {E} is replaced by a one-column eye. Line 0 is the hat slot.
export const FRAMES: string[][] = [
  ["", "   (\\  /)   ", "  ( {E}  {E} )  ", " =(  ww  )= ", "   (_)(_)   "],
  ["", "   (|  /)   ", "  ( {E}  {E} )  ", " =(  ww  )= ", "   (_)(_)   "], // ear flick
  ["", "   (\\  /)   ", "  ( {E}  {E} )  ", " =(  vv  )= ", "   (_) (_)  "], // nose wiggle
];
// Frame index per 500ms tick; -1 = blink.
export const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

export const EGG_FRAMES: string[][] = [
  ["", "    .--.    ", "   /    \\   ", "   \\    /   ", "    `--'    "],
  ["", "   .--.     ", "  /    \\    ", "  \\    /    ", "   `--'     "],
  ["", "     .--.   ", "    /    \\  ", "    \\    /  ", "     `--'   "],
  ["", "    .--.    ", "   / /\\ \\   ", "   \\/  \\/   ", "    `--'    "],
  ["", "   \\ ,, /   ", "   / /\\ \\   ", "   \\/  \\/   ", "    `--'    "],
  ["  \\      /  ", "   \\    /   ", "   /\\/\\/\\   ", "   \\    /   ", "    `--'    "],
];

const HEART = "♥";
const HEART_RGB: RGB = [255, 105, 135];
// [col, col, ...] of hearts in the two rows above the sprite, per 500ms tick (5 ticks = 2.5s).
export const HEART_FRAMES: Array<[number[], number[]]> = [
  [[], [7]],
  [[], [4, 9]],
  [[6], [3, 10]],
  [[4, 9], [7]],
  [[3, 10], []],
];

export const center = (text: string, width: number): string => {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + text + " ".repeat(pad - left);
};

const sparse = (width: number, cols: number[], glyph: string): string => {
  const cells = Array.from({ length: width }, () => " ");
  for (const col of cols) if (col >= 0 && col < width) cells[col] = glyph;
  return cells.join("");
};

const paint = (text: string, [r, g, b]: RGB): string =>
  process.env.NO_COLOR ? text : `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

function rainbow(step: number): RGB {
  const h = (step * 40) % 360;
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

export function spriteLines(bones: Bones, frame: number): string[] {
  const blink = frame === -1;
  const art = FRAMES[blink ? 0 : frame] as string[];
  const eye = blink ? BLINK : bones.eye;
  const lines = art.map(line => line.replaceAll("{E}", eye).padEnd(SPRITE_W));
  if (bones.hat !== "none") lines[0] = center(HAT_ART[bones.hat], SPRITE_W);
  return lines;
}

// ─── Layout ─────────────────────────────────────────────────────────────────────────────────────

const columns = (): number => process.stdout.columns || 100;

export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] as string;
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  return kept;
}

export function bubbleLines(text: string, maxTextWidth: number): string[] {
  const lines = wrap(text, maxTextWidth, 3);
  const width = Math.max(...lines.map(l => l.length));
  const edge = "-".repeat(width + 2);
  return [` .${edge}.`, ...lines.map(l => ` | ${l.padEnd(width)} |`), ` \`${edge}'`];
}

/** Right-aligns `block` (BLOCK_W wide) with an optional speech bubble to its left. */
function place(block: string[], bubble: string[] | null): string[] {
  const cols = columns();
  const bubbleW = bubble ? Math.max(...bubble.map(l => l.length)) : 0;
  const total = bubble ? bubbleW + 2 + BLOCK_W : BLOCK_W;
  const left = " ".repeat(Math.max(0, cols - 2 - total));
  const top = bubble ? Math.max(0, Math.floor((block.length - bubble.length) / 2)) : 0;
  const tail = bubble ? top + Math.floor(bubble.length / 2) : -1;
  return block.map((row, i) => {
    if (!bubble) return left + row;
    const b = i >= top && i < top + bubble.length ? (bubble[i - top] as string) : "";
    return left + b.padEnd(bubbleW) + (i === tail ? "--" : "  ") + row;
  });
}

function bubbleFor(text: string | null): string[] | null {
  if (!text) return null;
  const room = columns() - 2 - BLOCK_W - 2 - 4; // border + padding
  if (room < 12) return null; // too narrow: the sprite alone
  return bubbleLines(text, Math.min(28, room));
}

function spriteBlock(bones: Bones, name: string, frame: number, step: number, above: string[] = []): string[] {
  const color = bones.shiny ? rainbow(step) : RARITY_RGB[bones.rarity];
  const rows = spriteLines(bones, frame).map(l => paint(center(l, BLOCK_W), color));
  return [...above, ...rows, paint(center(name, BLOCK_W), color)];
}

function eggBlock(step: number): string[] {
  const frame = EGG_FRAMES[Math.min(step, EGG_FRAMES.length - 1)] as string[];
  const rows = frame.map(l => center(l.padEnd(SPRITE_W), BLOCK_W));
  return [...rows, center("hatching...", BLOCK_W)];
}

function heartRows(step: number): string[] {
  const [top, bottom] = HEART_FRAMES[Math.min(step, HEART_FRAMES.length - 1)] as [number[], number[]];
  return [top, bottom].map(cols => paint(center(sparse(SPRITE_W, cols, HEART), BLOCK_W), HEART_RGB));
}

export function cardLines(state: State, bones: Bones, frame: number, step: number): string[] {
  const color = bones.shiny ? rainbow(step) : RARITY_RGB[bones.rarity];
  const sprite = spriteLines(bones, frame).map(l => paint(center(l, BLOCK_W), color));
  const blank = " ".repeat(BLOCK_W);
  const peak = peakStat(bones);
  const header = [
    `${paint(state.name, color)} the rabbit`,
    `${paint(STARS[bones.rarity], RARITY_RGB[bones.rarity])} ${bones.rarity.toUpperCase()}${bones.shiny ? "  SHINY" : ""}  hat: ${bones.hat}  eyes: ${bones.eye}`,
    ...STATS.map(s => {
      const filled = Math.round(bones.stats[s] / 10);
      return `${s.padEnd(9)} ${"█".repeat(filled)}${"░".repeat(10 - filled)} ${String(bones.stats[s]).padStart(3)}${s === peak ? "  peak" : ""}`;
    }),
  ];
  const rows = header.map((text, i) => `  ${sprite[i] ?? blank}  ${text}`);
  const about = wrap(state.personality, Math.max(30, Math.min(72, columns() - 6)), 2);
  return [...rows, ...about.map(l => `  ${l}`)];
}

// ─── Runtime ────────────────────────────────────────────────────────────────────────────────────

const WIDGET_KEY = "bunny";
const TICK_MS = 500;
const BUBBLE_MS = 12_000;
const CARD_MS = 12_000;
const REACT_COOLDOWN_MS = 20_000;

type Scene =
  | { kind: "idle" }
  | { kind: "hatch"; step: number }
  | { kind: "pet"; step: number }
  | { kind: "card"; until: number };

let host: ExtensionContext | undefined;
let timer: unknown;
let scene: Scene = { kind: "idle" };
let speech: { text: string; until: number } | null = null;
let tickNo = 0;
let lastRendered = "";
let lastSpoke = 0;

const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;

function render(): void {
  const state = loadState();
  if (!host || !state || state.hidden) return;
  const bones = rollBones(state.id);
  let lines: string[];
  switch (scene.kind) {
    case "hatch":
      lines = place(eggBlock(scene.step), null);
      break;
    case "card":
      lines = cardLines(state, bones, IDLE_SEQUENCE[tickNo % IDLE_SEQUENCE.length] as number, tickNo);
      break;
    case "pet":
      lines = place(
        spriteBlock(bones, state.name, 0, tickNo, heartRows(scene.step)),
        bubbleFor(state.muted ? null : (speech?.text ?? null)),
      );
      break;
    default:
      lines = place(
        spriteBlock(bones, state.name, IDLE_SEQUENCE[tickNo % IDLE_SEQUENCE.length] as number, tickNo),
        bubbleFor(state.muted ? null : (speech?.text ?? null)),
      );
  }
  const key = lines.join("\n");
  if (key === lastRendered) return; // idle frames repeat: repaint only on change
  lastRendered = key;
  host.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
}

function say(text: string): void {
  speech = { text, until: Date.now() + BUBBLE_MS };
  lastSpoke = Date.now();
  render();
}

function tick(): void {
  tickNo++;
  const now = Date.now();
  if (speech && now >= speech.until) speech = null;
  if (scene.kind === "hatch") {
    if (scene.step + 1 >= EGG_FRAMES.length) {
      scene = { kind: "idle" };
      const state = loadState();
      if (state) say(`Hi! I'm ${state.name}.`);
    } else scene = { kind: "hatch", step: scene.step + 1 };
  } else if (scene.kind === "pet") {
    scene = scene.step + 1 >= HEART_FRAMES.length ? { kind: "idle" } : { kind: "pet", step: scene.step + 1 };
  } else if (scene.kind === "card" && now >= scene.until) {
    scene = { kind: "idle" };
  }
  render();
}

function stop(): void {
  if (host && timer !== undefined) host.clearTimer(timer as never);
  timer = undefined;
}

function start(ctx: ExtensionContext): void {
  stop();
  host = ctx;
  lastRendered = "";
  timer = ctx.setInterval(tick, TICK_MS);
  render();
}

function hide(ctx: ExtensionContext): void {
  stop();
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  lastRendered = "";
}

function restore(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const state = loadState();
  scene = { kind: "idle" };
  speech = null;
  if (state && !state.hidden) start(ctx);
}

function react(ctx: ExtensionContext, kind: "done" | "error"): void {
  if (!ctx.hasUI || !host) return;
  const state = loadState();
  if (!state || state.hidden || state.muted || scene.kind === "hatch") return;
  if (Date.now() - lastSpoke < REACT_COOLDOWN_MS) return;
  say(pickOne(LINES[peakStat(rollBones(state.id))][kind]));
}

// ─── Command ────────────────────────────────────────────────────────────────────────────────────

const HELP = "/bunny  ·  pet  ·  card  ·  rename <name>  ·  mute  ·  unmute  ·  off  ·  on";
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '_.-]{0,13}$/;

async function bunny(args: string, ctx: ExtensionContext): Promise<void> {
  const [sub = "", ...rest] = args.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  let state: State | null;
  try {
    state = loadState();
  } catch (error) {
    ctx.ui.notify((error as Error).message, "error");
    return;
  }

  if (sub === "help") {
    ctx.ui.notify(HELP, "info");
    return;
  }

  if (!state) {
    if (sub !== "") {
      ctx.ui.notify("No bunny yet. Run /bunny to hatch one.", "warning");
      return;
    }
    state = hatch();
    saveState(state);
    const rarity = rollBones(state.id).rarity;
    const kind = `${/^[aeiou]/.test(rarity) ? "an" : "a"} ${rarity} rabbit`;
    if (!ctx.hasUI) {
      ctx.ui.notify(`Meet ${state.name}, ${kind}.`, "info");
      return;
    }
    scene = { kind: "hatch", step: 0 };
    speech = null;
    start(ctx);
    ctx.ui.notify(`An egg appears... ${state.name} is ${kind}.`, "info");
    return;
  }

  const bones = rollBones(state.id);
  switch (sub) {
    case "":
    case "show":
    case "card":
      if (!ctx.hasUI) {
        ctx.ui.notify(`${state.name}: ${bones.rarity} rabbit, hat ${bones.hat}, peak ${peakStat(bones)}.`, "info");
        return;
      }
      if (state.hidden) saveState({ ...state, hidden: false });
      scene = { kind: "card", until: Date.now() + CARD_MS };
      start(ctx);
      return;
    case "pet":
      if (!ctx.hasUI) return;
      if (state.hidden) saveState({ ...state, hidden: false });
      scene = { kind: "pet", step: 0 };
      speech = { text: pickOne(PET_LINES), until: Date.now() + BUBBLE_MS };
      start(ctx);
      return;
    case "rename":
      if (!NAME_RE.test(arg)) {
        ctx.ui.notify("Usage: /bunny rename <name>  (1-14 chars: letters, digits, space ' _ . -)", "warning");
        return;
      }
      saveState({ ...state, name: arg });
      lastRendered = "";
      render();
      ctx.ui.notify(`${arg} it is.`, "info");
      return;
    case "mute":
    case "unmute":
      saveState({ ...state, muted: sub === "mute" });
      lastRendered = "";
      render();
      ctx.ui.notify(sub === "mute" ? `${state.name} stops talking.` : `${state.name} is chatty again.`, "info");
      return;
    case "off":
      saveState({ ...state, hidden: true });
      hide(ctx);
      ctx.ui.notify(`${state.name} hops out of sight. /bunny on to bring them back.`, "info");
      return;
    case "on":
      saveState({ ...state, hidden: false });
      if (ctx.hasUI) {
        scene = { kind: "idle" };
        start(ctx);
        say("Back!");
      }
      return;
    default:
      ctx.ui.notify(HELP, "info");
  }
}

export default function bunnyExtension(pi: ExtensionAPI): void {
  pi.registerCommand("bunny", {
    description: "Hatch and pet your rabbit companion (pet, card, rename, mute, off)",
    getArgumentCompletions: prefix => {
      const subs = ["pet", "card", "rename", "mute", "unmute", "off", "on", "help"];
      const hits = subs.filter(s => s.startsWith(prefix.toLowerCase()));
      return hits.length ? hits.map(value => ({ value, label: value })) : null;
    },
    handler: bunny,
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_switch", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => {
    stop();
    host = undefined;
  });

  pi.on("agent_end", async (_event, ctx) => react(ctx, "done"));
  // Returns nothing, so the tool result is never altered.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) react(ctx, "error");
  });
}
