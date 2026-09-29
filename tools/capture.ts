// Runs the real extension inside the fake omp host (tools/harness.ts) and dumps the exact ANSI text it
// produces for every README image to build/scenes.json. tools/render_assets.py turns that into PNG/GIF.
//
// Only the bunny's own output (widget rows and stat cards) comes from src/bunny.ts. The surrounding
// terminal - a fake chat transcript and a prompt box - is a mock drawn here for context.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness } from "./harness.ts";
import { FIXTURES, HAT_FIXTURES, HATCH_ID, type Fixture } from "./fixtures.ts";

interface Screen {
  title: string;
  cols: number;
  lines: string[];
}

const fg = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const dim = fg(110, 118, 129);
const text = fg(201, 209, 217);
const accent = fg(88, 166, 255);
const ok = fg(63, 185, 80);
const frame = fg(72, 80, 92);

const visible = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const padTo = (s: string, cols: number) => s + " ".repeat(Math.max(0, cols - visible(s)));

/** Bottom-anchored fake terminal: transcript, bunny widget, prompt box, status line. */
function chrome(opts: {
  cols: number;
  rows: number;
  history: string[];
  notice?: string;
  widget?: string[] | null;
  prompt?: string;
}): string[] {
  const { cols, rows } = opts;
  const inner = cols - 4;
  const box = [
    frame(` ╭${"─".repeat(cols - 4)}╮`),
    `${frame(" │")} ${accent("❯")} ${text(opts.prompt ?? "")}${opts.prompt === undefined ? "" : dim("█")}${" ".repeat(Math.max(0, inner - 3 - (opts.prompt?.length ?? 0) - (opts.prompt === undefined ? 0 : 1)))}${frame("│")}`,
    frame(` ╰${"─".repeat(cols - 4)}╯`),
    dim("  ~/code/http-client  ·  main"),
  ];
  const all = [...opts.history, ...(opts.notice ? ["", `  ${dim("→ " + opts.notice)}`] : []), "", ...(opts.widget ?? []), ...box];
  const kept = all.slice(-rows);
  return [...Array.from({ length: rows - kept.length }, () => ""), ...kept].map(l => padTo(l, cols));
}

const HISTORY = [
  `  ${accent("❯")} ${text("fix the flaky retry test in http_client.rs")}`,
  "",
  `  ${dim("●")} ${dim("Read")} ${text("src/http_client.rs")}`,
  `  ${dim("●")} ${dim("Edit")} ${text("src/http_client.rs")} ${ok("+3")} ${fg(248, 81, 73)("−1")}`,
  `  ${dim("●")} ${dim("Run")}  ${text("cargo test http_client")}`,
  `    ${dim("↳")} ${ok("14 passed")}${dim("; 0 failed")}`,
  "",
  `  ${text("Backoff jitter is now seeded, so the retry test is deterministic.")}`,
];

async function widgetAt(state: Fixture, columns: number, ticks: number, scene?: string): Promise<string[]> {
  const h = await Harness.boot({ columns, state, randomSeed: 2 });
  try {
    await h.emit("session_start");
    if (scene) await h.run(scene);
    h.advance(ticks * 500);
    return h.lastWidget ?? [];
  } finally {
    h.dispose();
  }
}

/** Places blocks side by side, padding shorter ones with blank rows and every row to `width`. */
function stitch(blocks: string[][], width: number, gap = 2): string[] {
  const height = Math.max(...blocks.map(b => b.length));
  return Array.from({ length: height }, (_, row) =>
    blocks.map(b => padTo(b[row] ?? "", width)).join(" ".repeat(gap)),
  );
}

async function main() {
  const out: Record<string, unknown> = {};

  // ── hero: the bunny reacting to a finished turn, above the prompt ────────────────────────────
  {
    const cols = 88;
    const h = await Harness.boot({ columns: cols, state: FIXTURES.hero, randomSeed: 2 });
    await h.emit("session_start");
    await h.emit("agent_end");
    const screen: Screen = {
      title: "omp",
      cols,
      lines: chrome({ cols, rows: 19, history: HISTORY, widget: h.lastWidget, prompt: "" }),
    };
    h.dispose();
    out.hero = screen;
  }

  // ── stat cards: `/bunny card` for every rarity ───────────────────────────────────────────────
  const cards: Array<{ key: string; screen: Screen }> = [];
  for (const key of ["common", "uncommon", "rare", "epic", "legendary", "shiny"] as const) {
    const cols = 72;
    const h = await Harness.boot({ columns: cols, state: FIXTURES[key] });
    await h.emit("session_start");
    await h.run("card");
    h.advance(3 * 500); // shiny bunnies cycle colour every tick; this freezes a nice hue
    const card = h.lastWidget ?? [];
    cards.push({ key, screen: { title: "/bunny card", cols, lines: [`  ${accent("❯")} ${text("/bunny card")}`, "", ...card].map(l => padTo(l, cols)) } });
    h.dispose();
  }
  out.cards = cards;

  // ── hats: one bunny per hat ──────────────────────────────────────────────────────────────────
  {
    const names = Object.keys(HAT_FIXTURES) as Array<keyof typeof HAT_FIXTURES>;
    const blocks: string[][] = [];
    for (const hat of names) blocks.push(await widgetAt(HAT_FIXTURES[hat], 16, 0));
    const w = 14;
    const lines = stitch(blocks, w);
    const labels = names.map(n => dim(n.padStart(Math.floor((w + n.length) / 2)).padEnd(w))).join("  ");
    out.hats = { title: "hats", cols: names.length * w + (names.length - 1) * 2 + 4, lines: ["", ...lines, labels, ""].map(l => `  ${l}`) } satisfies Screen;
  }

  // ── poses: hatching, idle animation, petting, shiny colour cycle ─────────────────────────────
  {
    const hatched = await Harness.boot({ columns: 16, hatchId: HATCH_ID, randomSeed: 2 });
    const eggs: string[][] = [];
    await hatched.run("");
    for (let i = 0; i < 6; i++) {
      eggs.push(hatched.lastWidget ?? []);
      hatched.advance(500);
    }
    hatched.dispose();

    const idle: string[][] = [];
    for (const tick of [0, 4, 8, 11]) idle.push(await widgetAt(FIXTURES.rare, 16, tick));

    const petting: string[][] = [];
    {
      const h = await Harness.boot({ columns: 16, state: FIXTURES.rare, randomSeed: 2 });
      await h.emit("session_start");
      await h.run("pet");
      for (let i = 0; i < 5; i++) {
        petting.push(h.lastWidget ?? []);
        h.advance(500);
      }
      h.dispose();
    }

    const shiny: string[][] = [];
    for (const tick of [0, 2, 4, 6, 8, 10]) shiny.push(await widgetAt(FIXTURES.shiny, 16, tick));

    const w = 14;
    const section = (label: string, blocks: string[][]) => [dim(label), ...stitch(blocks, w), ""];
    const cols = 6 * w + 5 * 2 + 4;
    out.poses = {
      title: "poses",
      cols,
      lines: [
        "",
        ...section("hatch  (/bunny, first run: one frame per 500 ms tick)", eggs),
        ...section("idle  (rest, ear flick, blink, nose wiggle)", idle),
        ...section("pet  (/bunny pet: hearts float for 2.5 s)", petting),
        ...section("shiny  (rainbow colour advances every tick; every second tick shown)", shiny),
      ].map(l => `  ${l}`),
    } satisfies Screen;
  }

  // ── demo GIF: /bunny hatch -> idle -> pet -> reaction to a finished turn ─────────────────────
  {
    const cols = 88;
    const rows = 19;
    const gif: Array<{ ms: number; screen: Screen }> = [];
    const h = await Harness.boot({ columns: cols, hatchId: HATCH_ID, randomSeed: 2 });
    await h.emit("session_start");
    let history = HISTORY;
    let prompt: string | undefined = "";
    const snap = (ms: number) => {
      const notice = h.notices.at(-1)?.message;
      gif.push({ ms, screen: { title: "omp", cols, lines: chrome({ cols, rows, history, notice: showNotice ? notice : undefined, widget: h.lastWidget, prompt }) } });
    };
    let showNotice = true;
    const tickAndSnap = (n: number) => {
      for (let i = 0; i < n; i++) {
        h.advance(500);
        snap(500);
      }
    };

    // typing "/bunny"
    for (const p of ["/", "/b", "/bun", "/bunny"]) {
      prompt = p;
      snap(p === "/bunny" ? 700 : 140);
    }
    prompt = "";
    await h.run("");
    if (h.readState().id !== HATCH_ID) throw new Error("forced hatch id did not take effect (import harness before src/bunny.ts)");
    snap(500);
    tickAndSnap(20); // egg wobbles and cracks (6 ticks), then Juniper says hi and idles through blink/ear flick/nose wiggle

    // typing "/bunny pet"
    showNotice = false;
    for (const p of ["/bunny p", "/bunny pe", "/bunny pet"]) {
      prompt = p;
      snap(p === "/bunny pet" ? 600 : 140);
    }
    prompt = "";
    await h.run("pet");
    snap(500);
    tickAndSnap(6);

    // time-lapse: wait out the 20 s reaction cooldown, then a turn finishes
    h.advance(20_000);
    history = [...HISTORY.slice(0, 6), "", `  ${text("Backoff jitter is now seeded, so the retry test is deterministic.")}`];
    await h.emit("agent_end");
    snap(500);
    tickAndSnap(8);
    h.dispose();
    out.demo = gif;
  }

  const build = join(import.meta.dir, "..", "build");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "scenes.json"), JSON.stringify(out));
  console.log("wrote build/scenes.json");
}

await main();
