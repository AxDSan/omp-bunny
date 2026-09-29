// Drives the real extension (src/bunny.ts) through a fake omp host: command handler, event hooks,
// the 500 ms animation timer, the state file. Time and randomness are faked; nothing else is.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Harness, stripAnsi, type HarnessOptions } from "../tools/harness.ts";
import { FIXTURES, HATCH_ID } from "../tools/fixtures.ts";

let live: Harness[] = [];
async function boot(options: HarnessOptions = {}): Promise<Harness> {
  const h = await Harness.boot({ randomSeed: 7, ...options });
  live.push(h);
  return h;
}
afterEach(() => {
  for (const h of live.reverse()) h.dispose(); // reverse: each harness restores the globals it replaced
  live = [];
});

const text = (lines: string[] | null | undefined) => (lines ?? []).map(stripAnsi);
/** Words currently inside the speech bubble, re-joined into one string. */
const spoken = (h: Harness): string =>
  text(h.lastWidget)
    .map(l => l.match(/\| (.*?) +\|/)?.[1])
    .filter((s): s is string => s !== undefined)
    .join(" ");
const hasBubble = (h: Harness) => text(h.lastWidget).some(l => l.includes(".-"));
const visibleWidth = (l: string) => [...stripAnsi(l)].length;

/** A bunny that already exists and is showing. */
async function withBunny(options: HarnessOptions = {}): Promise<Harness> {
  const h = await boot({ state: FIXTURES.hero, ...options });
  await h.emit("session_start");
  return h;
}

describe("registration", () => {
  test("registers /bunny and hooks the events the README documents", async () => {
    const h = await boot();
    expect(typeof h.command.handler).toBe("function");
    expect([...h.handlers.keys()].sort()).toEqual(["agent_end", "session_shutdown", "session_start", "session_switch", "tool_result"]);
  });

  test("argument completion offers subcommands by prefix, none for unknown prefixes", async () => {
    const h = await boot();
    const complete = h.command.getArgumentCompletions!;
    expect(complete("p")).toEqual([{ value: "pet", label: "pet" }]);
    expect((complete("") as Array<{ value: string }>).map(c => c.value)).toEqual(["pet", "card", "rename", "mute", "unmute", "off", "on", "help"]);
    expect(complete("PE")).toEqual([{ value: "pet", label: "pet" }]);
    expect(complete("zzz")).toBeNull();
  });

  test("without a bunny, session start draws nothing and starts no timer", async () => {
    const h = await boot();
    await h.emit("session_start");
    expect(h.widgets).toHaveLength(0);
    expect(h.activeTimers).toBe(0);
  });
});

describe("hatching", () => {
  test("first /bunny writes identity and soul, never the bones", async () => {
    const h = await boot({ hatchId: HATCH_ID });
    await h.run("");
    expect(h.readState()).toEqual({
      id: HATCH_ID,
      name: "Juniper",
      personality: "Hops through your codebase with zero regard for the architecture diagram. Loves a force-push.",
      hatchedAt: h.now,
      hidden: false,
      muted: false,
    });
    expect(h.notices).toEqual([{ message: "An egg appears... Juniper is an epic rabbit.", level: "info" }]);
  });

  test("real hatches get a fresh random UUID each time", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const h = await boot();
      await h.run("");
      const id = h.readState().id as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(3);
  });

  test("the announcement uses 'a' or 'an' by the rarity word", async () => {
    const cases: Array<[keyof typeof FIXTURES, string]> = [
      ["common", "a common"],
      ["uncommon", "an uncommon"],
      ["rare", "a rare"],
      ["epic", "an epic"],
      ["legendary", "a legendary"],
    ];
    for (const [key, phrase] of cases) {
      const h = await boot({ hatchId: FIXTURES[key].id });
      await h.run("");
      expect(h.notices[0]!.message).toContain(`is ${phrase} rabbit.`);
    }
  });

  test("the egg hatches over six 500 ms frames, then the bunny introduces itself", async () => {
    const h = await boot({ hatchId: HATCH_ID });
    await h.run("");
    expect(h.placements[0]).toBe("aboveEditor");
    const frames: string[] = [];
    for (let i = 0; i < 6; i++) {
      frames.push(text(h.lastWidget).join("\n"));
      h.advance(500);
    }
    expect(new Set(frames).size).toBe(6);
    for (const f of frames.slice(0, 6)) expect(f).toContain("hatching...");
    // tick 6: the egg is gone and Juniper says hello
    expect(text(h.lastWidget).join("\n")).not.toContain("hatching...");
    expect(spoken(h)).toBe("Hi! I'm Juniper.");
    expect(text(h.lastWidget).at(-1)!.trim()).toBe("Juniper");
  });

  test("bubbles vanish after 12 s", async () => {
    const h = await boot({ hatchId: HATCH_ID });
    await h.run("");
    h.advance(3000); // egg done, "Hi!" said at t = 3 s
    expect(hasBubble(h)).toBe(true);
    h.advance(11_500);
    expect(hasBubble(h)).toBe(true);
    h.advance(500);
    expect(hasBubble(h)).toBe(false);
  });

  test("without a UI it only notifies: no widget, no timer", async () => {
    const h = await boot({ hatchId: HATCH_ID, hasUI: false });
    await h.run("");
    expect(h.notices).toEqual([{ message: "Meet Juniper, an epic rabbit.", level: "info" }]);
    expect(h.widgets).toHaveLength(0);
    expect(h.activeTimers).toBe(0);
    expect(h.readState().name).toBe("Juniper");
  });

  test("subcommands before hatching point at /bunny instead of creating a bunny", async () => {
    const h = await boot();
    for (const sub of ["pet", "card", "rename Bob", "mute", "off", "on", "bogus"]) await h.run(sub);
    expect(h.notices.every(n => n.level === "warning" && n.message === "No bunny yet. Run /bunny to hatch one.")).toBe(true);
    expect(h.notices).toHaveLength(7);
    expect(() => h.readState()).toThrow(); // still no file
  });

  test("/bunny help works even before hatching", async () => {
    const h = await boot();
    await h.run("help");
    expect(h.notices[0]!.message).toBe("/bunny  ·  pet  ·  card  ·  rename <name>  ·  mute  ·  unmute  ·  off  ·  on");
  });
});

describe("idle animation", () => {
  test("draws a right-aligned 6-row block above the editor at the terminal width", async () => {
    for (const columns of [60, 100, 160]) {
      const h = await withBunny({ columns });
      const lines = text(h.lastWidget);
      expect(lines).toHaveLength(6); // hat slot + 4 body rows + name
      expect(h.placements.at(-1)).toBe("aboveEditor");
      for (const l of lines) expect([...l]).toHaveLength(columns - 2);
      expect(lines[0]!.trim()).toBe("[___]"); // Toast wears a tophat
      expect(lines[5]!.trim()).toBe("Toast");
    }
  });

  test("repaints only when the picture changes: ear flick on tick 4, blink on tick 8, nose wiggle on tick 11", async () => {
    const h = await withBunny();
    const initial = h.widgets.length;
    h.advance(1500);
    expect(h.widgets).toHaveLength(initial); // ticks 1-3 look identical to tick 0
    h.advance(500);
    expect(h.widgets).toHaveLength(initial + 1);
    expect(text(h.lastWidget)[1]).toContain("(|  /)");
    h.advance(500); // tick 5: back to rest
    expect(text(h.lastWidget)[1]).toContain("(\\  /)");
    h.advance(1500); // tick 8: blink
    expect(text(h.lastWidget)[2]).toContain("( -  - )");
    h.advance(1500); // tick 11: nose wiggle
    expect(text(h.lastWidget)[3]).toContain("=(  vv  )=");
    h.advance(2000 + 500); // tick 16 (= 1 mod 15): the loop restarts and stays quiet until the next flick
    const n = h.widgets.length;
    h.advance(1000);
    expect(h.widgets).toHaveLength(n);
  });

  test("keeps exactly one timer, even across session switches", async () => {
    const h = await withBunny();
    expect(h.activeTimers).toBe(1);
    await h.emit("session_switch");
    await h.emit("session_start");
    expect(h.activeTimers).toBe(1);
  });

  test("session shutdown stops the timer and later ticks draw nothing", async () => {
    const h = await withBunny();
    await h.emit("session_shutdown");
    expect(h.activeTimers).toBe(0);
    const n = h.widgets.length;
    h.advance(10_000);
    expect(h.widgets).toHaveLength(n);
  });

  test("NO_COLOR gives plain text, otherwise 24-bit colour", async () => {
    const plain = await withBunny({ noColor: true });
    expect(plain.lastWidget!.join("")).not.toContain("\x1b");
    const colour = await withBunny();
    expect(colour.lastWidget!.join("")).toContain("\x1b[38;2;177;124;255m"); // epic purple
  });

  test("non-UI sessions never start the animation", async () => {
    const h = await withBunny({ hasUI: false });
    expect(h.widgets).toHaveLength(0);
    expect(h.activeTimers).toBe(0);
  });

  test("hidden bunnies stay hidden at session start", async () => {
    const h = await boot({ state: { ...FIXTURES.hero, hidden: true } });
    await h.emit("session_start");
    expect(h.widgets).toHaveLength(0);
    expect(h.activeTimers).toBe(0);
  });
});

describe("narrow terminals", () => {
  test("the speech bubble needs 34 columns; below that only the sprite is drawn", async () => {
    for (const [columns, bubble] of [[33, false], [34, true], [80, true]] as const) {
      const h = await withBunny({ columns });
      await h.emit("agent_end");
      expect(hasBubble(h)).toBe(bubble);
      if (!bubble) expect(text(h.lastWidget).every(l => visibleWidth(l) === columns - 2)).toBe(true);
    }
  });

  test("bubble text is capped at 28 columns and 3 lines however wide the terminal", async () => {
    const h = await withBunny({ columns: 240 });
    await h.emit("agent_end");
    const rows = text(h.lastWidget).map(l => l.match(/\| (.*?) +\|/)?.[1]).filter(Boolean) as string[];
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(28);
  });
});

describe("reactions", () => {
  test("a finished turn gets a line from the peak stat's 'done' pool", async () => {
    const { LINES } = (await boot()).mod;
    const h = await withBunny(); // Toast peaks in SNARK
    await h.emit("agent_end");
    expect(LINES.SNARK.done).toContain(spoken(h));
  });

  test("a failed tool call gets a line from the 'error' pool; a successful one gets nothing", async () => {
    const { LINES } = (await boot()).mod;
    const ok = await withBunny();
    await ok.emit("tool_result", { isError: false });
    expect(hasBubble(ok)).toBe(false);
    const bad = await withBunny();
    await bad.emit("tool_result", { isError: true });
    expect(LINES.SNARK.error).toContain(spoken(bad));
  });

  test("at most one reaction per 20 s", async () => {
    const h = await withBunny();
    await h.emit("agent_end");
    const first = spoken(h);
    expect(first).not.toBe("");
    h.advance(12_500); // bubble expires
    expect(hasBubble(h)).toBe(false);
    await h.emit("agent_end");
    await h.emit("tool_result", { isError: true });
    h.advance(6_500); // 19.0 s since the first line
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(false);
    h.advance(500); // 19.5 s
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(false);
    h.advance(500); // 20.0 s
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(true);
  });

  test("silent while muted, hidden, headless, or hatching", async () => {
    const muted = await boot({ state: { ...FIXTURES.hero, muted: true } });
    await muted.emit("session_start");
    await muted.emit("agent_end");
    expect(hasBubble(muted)).toBe(false);
    await muted.run("unmute"); // a muted bunny must not have queued the line for later
    expect(hasBubble(muted)).toBe(false);

    const hidden = await boot({ state: { ...FIXTURES.hero, hidden: true } });
    await hidden.emit("session_start");
    await hidden.emit("agent_end");
    expect(hidden.widgets).toHaveLength(0);

    const headless = await withBunny({ hasUI: false });
    await headless.emit("agent_end");
    expect(headless.widgets).toHaveLength(0);

    const hatching = await boot({ hatchId: HATCH_ID });
    await hatching.run("");
    await hatching.emit("agent_end");
    await hatching.emit("tool_result", { isError: true });
    expect(text(hatching.lastWidget).join("\n")).toContain("hatching...");
    hatching.advance(3000);
    expect(spoken(hatching)).toBe("Hi! I'm Juniper."); // the hello, not a reaction
  });

  test("each stat has its own pool, so reactions reflect the peak stat", async () => {
    const { LINES, PERSONALITY, STATS } = (await boot()).mod;
    for (const stat of STATS) {
      expect(LINES[stat].done.length).toBeGreaterThanOrEqual(2);
      expect(LINES[stat].error.length).toBeGreaterThanOrEqual(2);
      expect(PERSONALITY[stat].length).toBeGreaterThan(20);
    }
    const all = STATS.flatMap(s => [...LINES[s].done, ...LINES[s].error]);
    expect(new Set(all).size).toBe(all.length); // no line is shared between pools
  });
});

describe("/bunny pet", () => {
  test("floats hearts for five ticks (2.5 s) while the bunny answers with a pet line", async () => {
    const h = await withBunny();
    await h.run("pet");
    const { PET_LINES } = h.mod;
    expect(PET_LINES).toContain(spoken(h));
    const heartsPerTick: number[] = [];
    for (let i = 0; i < 5; i++) {
      heartsPerTick.push(text(h.lastWidget).join("").split("♥").length - 1);
      h.advance(500);
    }
    expect(heartsPerTick.every(n => n >= 1)).toBe(true);
    expect(heartsPerTick.slice(0, 2)).toEqual([1, 2]);
    expect(text(h.lastWidget).join("").includes("♥")).toBe(false);
    expect(text(h.lastWidget)).toHaveLength(6); // hearts' two rows are gone again
  });

  test("hearts sit above the sprite: the widget grows by two rows", async () => {
    const h = await withBunny();
    await h.run("pet");
    expect(h.lastWidget).toHaveLength(8);
    expect(text(h.lastWidget).slice(0, 2).join("")).toContain("♥");
  });

  test("brings a hidden bunny back and persists that", async () => {
    const h = await boot({ state: { ...FIXTURES.hero, hidden: true } });
    await h.emit("session_start");
    await h.run("pet");
    expect(h.readState().hidden).toBe(false);
    expect(h.activeTimers).toBe(1);
  });

  test("does nothing without a UI", async () => {
    const h = await withBunny({ hasUI: false });
    await h.run("pet");
    expect(h.widgets).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });
});

describe("/bunny card", () => {
  test("shows the stat card for 12 s, then returns to the sprite", async () => {
    const h = await withBunny();
    await h.run("card");
    expect(text(h.lastWidget).join("\n")).toContain("Toast the rabbit");
    h.advance(11_500);
    expect(text(h.lastWidget).join("\n")).toContain("Toast the rabbit");
    h.advance(1000);
    const after = text(h.lastWidget).join("\n");
    expect(after).not.toContain("the rabbit");
    expect(after).toContain("Toast");
  });

  test("bare /bunny and /bunny show do the same once hatched", async () => {
    for (const sub of ["", "show", "card"]) {
      const h = await withBunny();
      await h.run(sub);
      expect(text(h.lastWidget).join("\n")).toContain("EPIC");
    }
  });

  test("without a UI it prints a one-line summary", async () => {
    const h = await withBunny({ hasUI: false });
    await h.run("card");
    expect(h.notices).toEqual([{ message: "Toast: epic rabbit, hat tophat, peak SNARK.", level: "info" }]);
  });
});

describe("/bunny rename", () => {
  const nameAfter = async (arg: string) => {
    const h = await withBunny();
    await h.run(`rename ${arg}`);
    return { h, name: h.readState().name };
  };

  test("accepts 1-14 characters of letters, digits, space and ' _ . -", async () => {
    for (const ok of ["Waffles", "A", "7", "Sir Hops-a-Lot", "O'Brien", "x_y.z", "Mr. Fluff"]) {
      expect(ok.length).toBeLessThanOrEqual(14);
      const { h, name } = await nameAfter(ok);
      expect(name).toBe(ok);
      expect(h.notices.at(-1)).toEqual({ message: `${ok} it is.`, level: "info" });
    }
  });

  test("rejects empty, over-long, badly-starting and exotic names and keeps the old name", async () => {
    for (const bad of ["", "A23456789012345", "-dash", ".dot", "'quote", "bad/char", "émile", "tab\there!", "😀"]) {
      const { h, name } = await nameAfter(bad);
      expect(name).toBe("Toast");
      expect(h.notices.at(-1)!.level).toBe("warning");
      expect(h.notices.at(-1)!.message).toStartWith("Usage: /bunny rename <name>");
    }
  });

  test("collapses runs of whitespace and redraws immediately", async () => {
    const { h, name } = await nameAfter("   Big    Ears  ");
    expect(name).toBe("Big Ears");
    expect(text(h.lastWidget).at(-1)!.trim()).toBe("Big Ears");
  });

  test("a renamed bunny is still the same bunny: bones follow the id, not the name", async () => {
    const h = await withBunny();
    const before = text(h.lastWidget).slice(0, 5);
    await h.run("rename Quick");
    expect(text(h.lastWidget).slice(0, 5)).toEqual(before);
  });
});

describe("/bunny mute, unmute, off, on", () => {
  test("mute silences the bubble now and later, unmute restores it; both persist", async () => {
    const h = await withBunny();
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(true);
    await h.run("mute");
    expect(hasBubble(h)).toBe(false);
    expect(h.readState().muted).toBe(true);
    expect(h.notices.at(-1)!.message).toBe("Toast stops talking.");
    h.advance(25_000);
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(false);
    await h.run("unmute");
    expect(h.readState().muted).toBe(false);
    expect(h.notices.at(-1)!.message).toBe("Toast is chatty again.");
    await h.emit("agent_end");
    expect(hasBubble(h)).toBe(true);
  });

  test("off removes the widget, stops the timer and persists; on brings the bunny back with a greeting", async () => {
    const h = await withBunny();
    await h.run("off");
    expect(h.lastWidget).toBeNull();
    expect(h.activeTimers).toBe(0);
    expect(h.readState().hidden).toBe(true);
    expect(h.notices.at(-1)!.message).toBe("Toast hops out of sight. /bunny on to bring them back.");
    await h.run("on");
    expect(h.readState().hidden).toBe(false);
    expect(h.activeTimers).toBe(1);
    expect(spoken(h)).toBe("Back!");
  });

  test("hidden survives a restart, and /bunny card unhides", async () => {
    const h = await withBunny();
    await h.run("off");
    expect(h.readState().hidden).toBe(true);
    const restarted = await boot({ state: { ...FIXTURES.hero, hidden: true } });
    await restarted.emit("session_start");
    expect(restarted.widgets).toHaveLength(0);
    await restarted.run("card");
    expect(restarted.readState().hidden).toBe(false);
  });

  test("unknown subcommands print the help line", async () => {
    const h = await withBunny();
    await h.run("dance");
    expect(h.notices.at(-1)!.level).toBe("info");
    expect(h.notices.at(-1)!.message).toStartWith("/bunny  ·  pet");
  });
});

describe("state file", () => {
  test("editing bunny.json cannot change the bones: rarity, hat, shiny and stats are re-derived from the id", async () => {
    const h = await boot({ state: FIXTURES.common });
    writeFileSync(
      h.stateFile,
      JSON.stringify({
        id: FIXTURES.common.id,
        name: "Cheater",
        rarity: "legendary",
        hat: "crown",
        shiny: true,
        eye: "@",
        stats: { DEBUGGING: 100, PATIENCE: 100, CHAOS: 100, WISDOM: 100, SNARK: 100 },
        bones: { rarity: "legendary" },
      }),
    );
    await h.emit("session_start");
    await h.run("card");
    const card = text(h.lastWidget).join("\n");
    expect(card).toContain("Cheater the rabbit");
    expect(card).toContain("★ COMMON");
    expect(card).not.toContain("LEGENDARY");
    expect(card).not.toContain("SHINY");
    expect(card).toContain("hat: none");
    expect(card).toContain("WISDOM    ███████░░░  73  peak");
    // and the next save writes back only identity + soul, dropping the forged fields
    await h.run("mute");
    expect(Object.keys(h.readState()).sort()).toEqual(["hatchedAt", "hidden", "id", "muted", "name", "personality"]);
  });

  test("changing the id is the only way to change the bunny", async () => {
    const a = await boot({ state: { id: FIXTURES.common.id, name: "Same" } });
    const b = await boot({ state: { id: FIXTURES.legendary.id, name: "Same" } });
    for (const h of [a, b]) {
      await h.emit("session_start");
      await h.run("card");
    }
    expect(text(a.lastWidget).join("\n")).toContain("COMMON");
    expect(text(b.lastWidget).join("\n")).toContain("LEGENDARY");
  });

  test("a state file with only id and name is filled in with defaults", async () => {
    const h = await boot({ state: FIXTURES.rare });
    writeFileSync(h.stateFile, JSON.stringify({ id: FIXTURES.rare.id, name: "Bare" }));
    await h.emit("session_start");
    expect(h.activeTimers).toBe(1); // not hidden
    await h.run("mute");
    const saved = h.readState();
    expect(saved.name).toBe("Bare");
    expect(saved.personality).toBe(h.mod.PERSONALITY[h.mod.peakStat(h.mod.rollBones(FIXTURES.rare.id))]);
    expect(typeof saved.hatchedAt).toBe("number");
    expect(saved.muted).toBe(true);
  });

  test("a corrupt file is reported, not overwritten and not a crash", async () => {
    for (const body of ["{ not json", JSON.stringify({ id: 5, name: "x" }), JSON.stringify({ name: "no id" }), "[]"]) {
      const h = await boot({ state: FIXTURES.rare });
      writeFileSync(h.stateFile, body);
      await h.run("card");
      expect(h.notices.at(-1)!.level).toBe("error");
      expect(h.notices.at(-1)!.message).toContain("is unreadable");
      expect(h.notices.at(-1)!.message).toContain("fix or delete it");
      expect(readFileSync(h.stateFile, "utf8")).toBe(body);
    }
  });

  test("saves are atomic renames: no temp files are left behind", async () => {
    const h = await withBunny();
    for (const sub of ["mute", "unmute", "rename A", "off", "on"]) await h.run(sub);
    expect(readdirSync(h.dir)).toEqual(["bunny.json"]);
    expect(readFileSync(h.stateFile, "utf8").endsWith("}\n")).toBe(true);
  });

  test("the state file lives at $PI_CODING_AGENT_DIR/bunny.json", async () => {
    const h = await boot({ hatchId: HATCH_ID });
    await h.run("");
    expect(h.stateFile).toBe(`${h.dir}/bunny.json`);
    expect(h.readState().id).toBe(HATCH_ID);
  });
});
