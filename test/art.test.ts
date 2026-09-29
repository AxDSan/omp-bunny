import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BLOCK_W,
  EGG_FRAMES,
  EYES,
  FRAMES,
  HAT_ART,
  HATS,
  HEART_FRAMES,
  IDLE_SEQUENCE,
  RARITIES,
  RARITY_RGB,
  SPRITE_W,
  STARS,
  STATS,
  bubbleLines,
  cardLines,
  center,
  peakStat,
  rollBones,
  spriteLines,
  wrap,
  type Bones,
  type State,
} from "../src/bunny.ts";
import { FIXTURES } from "../tools/fixtures.ts";
import { stripAnsi } from "../tools/harness.ts";

const bones = (over: Partial<Bones> = {}): Bones => ({
  rarity: "common",
  eye: "o",
  hat: "none",
  shiny: false,
  stats: { DEBUGGING: 10, PATIENCE: 20, CHAOS: 30, WISDOM: 40, SNARK: 50 },
  ...over,
});

describe("sprite geometry", () => {
  test("every frame has 5 rows: an empty hat slot plus a 12-column body", () => {
    for (const frame of FRAMES) {
      expect(frame).toHaveLength(5);
      expect(frame[0]).toBe("");
      for (const row of frame.slice(1)) expect(row.replaceAll("{E}", "x")).toHaveLength(SPRITE_W);
    }
  });

  test("spriteLines returns 5 rows of exactly 12 columns for every frame, eye and hat", () => {
    for (const frame of [-1, 0, 1, 2]) {
      for (const eye of EYES) {
        for (const hat of HATS) {
          const lines = spriteLines(bones({ eye, hat }), frame);
          expect(lines).toHaveLength(5);
          for (const line of lines) expect([...line]).toHaveLength(SPRITE_W);
        }
      }
    }
  });

  test("the eye glyph replaces both {E} placeholders, and only there", () => {
    for (const eye of EYES) {
      const text = spriteLines(bones({ eye }), 0).join("\n");
      expect(text).not.toContain("{E}");
      expect(text.split(eye).length - 1).toBe(2); // no other glyph in the frame collides with an eye
    }
  });

  test("a blink (-1) draws '-' for both eyes and otherwise matches the resting pose", () => {
    const b = bones({ eye: "@" });
    const open = spriteLines(b, 0);
    const blink = spriteLines(b, -1);
    expect(blink[2]).toBe(open[2]!.replaceAll("@", "-"));
    expect(blink.filter((_, i) => i !== 2)).toEqual(open.filter((_, i) => i !== 2));
  });

  test("ear flick and nose wiggle change only the ears / nose and mouth rows", () => {
    const b = bones();
    const rest = spriteLines(b, 0);
    const flick = spriteLines(b, 1);
    const wiggle = spriteLines(b, 2);
    expect(flick.map((l, i) => l === rest[i])).toEqual([true, false, true, true, true]);
    expect(wiggle.map((l, i) => l === rest[i])).toEqual([true, true, true, false, false]);
  });

  test("idle sequence only names existing frames (or -1 for a blink) and includes each pose", () => {
    for (const f of IDLE_SEQUENCE) expect(f === -1 || (f >= 0 && f < FRAMES.length)).toBe(true);
    expect(new Set(IDLE_SEQUENCE)).toEqual(new Set([-1, 0, 1, 2]));
    expect(IDLE_SEQUENCE.length * 500).toBe(7500); // one loop = 7.5 s at 500 ms per tick
  });
});

describe("hat slot", () => {
  test("no hat leaves row 0 blank", () => {
    expect(spriteLines(bones({ hat: "none" }), 0)[0]).toBe(" ".repeat(SPRITE_W));
  });

  test("a hat is centered in row 0 and leaves the body untouched", () => {
    const plain = spriteLines(bones(), 0);
    for (const hat of HATS.filter(h => h !== "none")) {
      const lines = spriteLines(bones({ hat }), 0);
      expect(lines[0]).toBe(center(HAT_ART[hat], SPRITE_W));
      expect(lines[0]!.trim()).toBe(HAT_ART[hat]);
      expect(lines.slice(1)).toEqual(plain.slice(1));
    }
  });

  test("every hat fits the sprite", () => {
    for (const hat of HATS) expect(HAT_ART[hat].length).toBeLessThanOrEqual(SPRITE_W);
  });

  test("egg and heart art fit the 12-column sprite too", () => {
    for (const egg of EGG_FRAMES) {
      expect(egg).toHaveLength(5);
      for (const row of egg) expect(row.length).toBeLessThanOrEqual(SPRITE_W);
    }
    expect(HEART_FRAMES).toHaveLength(5); // 5 ticks x 500 ms = the 2.5 s the README promises
    for (const [top, bottom] of HEART_FRAMES) {
      for (const col of [...top, ...bottom]) {
        expect(col).toBeGreaterThanOrEqual(0);
        expect(col).toBeLessThan(SPRITE_W);
      }
    }
  });
});

describe("center", () => {
  test("pads to width, extra column on the right", () => {
    expect(center("ab", 5)).toBe(" ab  ");
    expect(center("abc", 5)).toBe(" abc ");
    expect(center("abcdef", 3)).toBe("abcdef"); // never truncates
    expect(center("", 4)).toBe("    ");
  });

  test("a 14-character name fits under the 14-column block", () => {
    expect(center("A".repeat(14), BLOCK_W)).toBe("A".repeat(14));
  });
});

describe("wrap and bubbles", () => {
  test("wraps on word boundaries within the width", () => {
    expect(wrap("the quick brown fox jumps", 10, 5)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  test("overlong words stay whole on their own line", () => {
    expect(wrap("a supercalifragilistic b", 8, 5)).toEqual(["a", "supercalifragilistic", "b"]);
  });

  test("truncates to maxLines with an ellipsis that keeps the line within width", () => {
    const out = wrap("one two three four five six seven eight nine ten", 9, 2);
    expect(out).toHaveLength(2);
    expect(out[1]!.endsWith("…")).toBe(true);
    expect(out[1]!.length).toBeLessThanOrEqual(9);
  });

  test("whitespace-only text wraps to nothing", () => {
    expect(wrap("   \n\t ", 10, 3)).toEqual([]);
  });

  test("bubbleLines draws a closed box of uniform width around the text", () => {
    const lines = bubbleLines("Ship it!!", 28);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
    expect(lines[0]).toMatch(/^ \.-+\.$/);
    expect(lines[1]).toBe(" | Ship it!! |");
    expect(lines[2]).toMatch(/^ `-+'$/);
  });

  test("long lines wrap into at most three bubble rows", () => {
    const lines = bubbleLines("Hops through your codebase with zero regard for the architecture diagram. Loves a force-push.", 28);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
  });
});

describe("stat card", () => {
  const state = (name: string, personality: string): State => ({ id: "x", name, personality, hatchedAt: 0, hidden: false, muted: false });
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true, writable: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });

  test("shows name, stars, rarity, hat, eyes and one bar per stat", () => {
    const b = rollBones(FIXTURES.legendary.id);
    const card = cardLines(state("Bunsen", "Hops around."), b, 0, 0).join("\n");
    expect(card).toContain("Bunsen the rabbit");
    expect(card).toContain(`${STARS.legendary} LEGENDARY`);
    expect(card).toContain(`hat: ${b.hat}`);
    expect(card).toContain(`eyes: ${b.eye}`);
    for (const s of STATS) {
      const row = card.split("\n").find(l => l.includes(s))!;
      const filled = Math.round(b.stats[s] / 10);
      expect(row).toContain(`${"█".repeat(filled)}${"░".repeat(10 - filled)}`);
      expect(row.trim().endsWith(`${b.stats[s]}`) || row.includes(`${b.stats[s]}  peak`)).toBe(true);
    }
  });

  test("marks the peak stat, and only the peak stat", () => {
    for (const key of ["common", "uncommon", "rare", "epic", "legendary", "shiny"] as const) {
      const b = rollBones(FIXTURES[key].id);
      const rows = cardLines(state("X", "y"), b, 0, 0).filter(l => l.endsWith("peak"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(peakStat(b));
    }
  });

  test("SHINY appears in the header only for shiny bunnies", () => {
    const shiny = cardLines(state("X", "y"), rollBones(FIXTURES.shiny.id), 0, 0).join("\n");
    const plain = cardLines(state("X", "y"), rollBones(FIXTURES.rare.id), 0, 0).join("\n");
    expect(shiny).toContain("RARE  SHINY");
    expect(plain).not.toContain("SHINY");
  });

  test("the sprite (with its hat) sits in the left column, personality underneath", () => {
    const b = rollBones(FIXTURES.legendary.id);
    const lines = cardLines(state("Bunsen", "Hops through your codebase."), b, 0, 0);
    expect(lines[0]).toContain(",>"); // tinyduck in the hat slot, next to the name row
    expect(lines[1]).toContain("(\\  /)");
    expect(lines.at(-1)).toBe("  Hops through your codebase.");
  });

  test("long personalities wrap to at most two lines", () => {
    const long = "word ".repeat(80);
    const lines = cardLines(state("X", long), rollBones(FIXTURES.common.id), 0, 0);
    expect(lines).toHaveLength(9); // name row + rarity row + 5 stats + personality capped at 2 lines
  });
});

describe("colour", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NO_COLOR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  });
  const st: State = { id: "x", name: "N", personality: "p", hatchedAt: 0, hidden: false, muted: false };

  test("NO_COLOR removes every escape sequence", () => {
    process.env.NO_COLOR = "1";
    for (const line of cardLines(st, rollBones(FIXTURES.shiny.id), 0, 3)) expect(line).not.toContain("\x1b");
  });

  test("otherwise sprite and name use the rarity colour as 24-bit escapes", () => {
    delete process.env.NO_COLOR;
    for (const r of RARITIES) {
      const b = rollBones(FIXTURES[r].id);
      const [red, green, blue] = RARITY_RGB[r];
      const card = cardLines(st, b, 0, 0).join("\n");
      expect(card).toContain(`\x1b[38;2;${red};${green};${blue}m`);
    }
  });

  test("shiny bunnies leave the rarity palette and cycle colour with the tick", () => {
    delete process.env.NO_COLOR;
    const b = rollBones(FIXTURES.shiny.id);
    const rareColour = `\x1b[38;2;${RARITY_RGB.rare.join(";")}m`;
    const colourAt = (step: number) => cardLines(st, b, 0, step)[0]!.match(/\x1b\[38;2;(\d+;\d+;\d+)m/)![1]!;
    const seen = new Set(Array.from({ length: 9 }, (_, i) => colourAt(i)));
    expect(seen.size).toBe(9); // 40 degrees per tick: nine distinct hues before the wheel repeats
    expect(colourAt(0)).toBe(colourAt(9));
    // the star row keeps the plain rarity colour even on a shiny
    expect(cardLines(st, b, 0, 0)[1]).toContain(rareColour);
  });

  test("stripAnsi leaves exactly the NO_COLOR text", () => {
    delete process.env.NO_COLOR;
    const coloured = cardLines(st, rollBones(FIXTURES.epic.id), 0, 0).map(stripAnsi);
    process.env.NO_COLOR = "1";
    expect(cardLines(st, rollBones(FIXTURES.epic.id), 0, 0)).toEqual(coloured);
  });
});
