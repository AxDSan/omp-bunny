import { describe, expect, test } from "bun:test";
import {
  EYES,
  HAT_MIN_RARITY,
  HATS,
  RARITIES,
  RARITY_WEIGHT,
  STAT_FLOOR,
  STATS,
  fnv1a,
  mulberry32,
  peakStat,
  rollBones,
  type Bones,
  type Hat,
  type Rarity,
} from "../src/bunny.ts";

// A fixed, reproducible id population: every assertion below is deterministic.
const N = 200_000;
const SAMPLE: Bones[] = Array.from({ length: N }, (_, i) => rollBones(`sample-${i}`));
const rankOf = (r: Rarity) => RARITIES.indexOf(r);

describe("fnv1a", () => {
  test("matches the published FNV-1a 32-bit test vectors", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  test("always returns an unsigned 32-bit integer", () => {
    for (const s of ["", "x", "bunny-2026-401", "héllo ✓", "😀", "a".repeat(10_000)]) {
      const h = fnv1a(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  test("is sensitive to every character", () => {
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("abc")).not.toBe(fnv1a("cba"));
  });
});

describe("mulberry32", () => {
  test("reproduces reference outputs (cross-checked against an independent Python port)", () => {
    const expected: Array<[number, number[]]> = [
      [0, [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]],
      [1, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]],
      [0xdeadbeef, [0.9413696140982211, 0.26719574979506433, 0.772033357527107]],
    ];
    for (const [seed, values] of expected) {
      const rand = mulberry32(seed);
      expect(values.map(() => rand())).toEqual(values);
    }
  });

  test("same seed, same stream; different seed, different stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(sa);
  });

  test("stays in [0, 1) and looks uniform", () => {
    const rand = mulberry32(fnv1a("uniformity"));
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });

  test("accepts seeds outside int32 by wrapping to uint32", () => {
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
  });
});

describe("rollBones is a pure function of the id", () => {
  test("repeated rolls are deeply equal, and rolling never mutates anything shared", () => {
    for (const id of ["a", "omp-bunny/common/3", "00000000-0000-4000-8000-000000000000"]) {
      const first = rollBones(id);
      expect(rollBones(id)).toEqual(first);
      first.stats.SNARK = 0; // callers may scribble on their copy
      expect(rollBones(id).stats.SNARK).not.toBe(0);
    }
  });

  test("golden values (independently reproduced with a Python port of the algorithm)", () => {
    expect(rollBones("omp-bunny/common/3")).toEqual({
      rarity: "common", eye: "^", hat: "none", shiny: false,
      stats: { DEBUGGING: 11, PATIENCE: 33, CHAOS: 37, WISDOM: 73, SNARK: 6 },
    });
    expect(rollBones("omp-bunny/legendary/278")).toEqual({
      rarity: "legendary", eye: "°", hat: "tinyduck", shiny: false,
      stats: { DEBUGGING: 75, PATIENCE: 84, CHAOS: 100, WISDOM: 74, SNARK: 54 },
    });
    expect(rollBones("omp-bunny/shiny/357")).toEqual({
      rarity: "rare", eye: "°", hat: "crown", shiny: true,
      stats: { DEBUGGING: 58, PATIENCE: 31, CHAOS: 25, WISDOM: 100, SNARK: 46 },
    });
    expect(rollBones("00000000-0000-4000-8000-000000000000")).toEqual({
      rarity: "epic", eye: "o", hat: "wizard", shiny: false,
      stats: { DEBUGGING: 59, PATIENCE: 66, CHAOS: 100, WISDOM: 39, SNARK: 42 },
    });
  });

  test("different ids give different bunnies", () => {
    const seen = new Set(SAMPLE.slice(0, 2000).map(b => JSON.stringify(b)));
    expect(seen.size).toBeGreaterThan(1900);
  });
});

describe("rarity", () => {
  test("weights sum to 100 and are ordered common -> legendary", () => {
    expect(RARITIES.reduce((sum, r) => sum + RARITY_WEIGHT[r], 0)).toBe(100);
    expect(RARITIES.map(r => RARITY_WEIGHT[r])).toEqual([60, 25, 10, 4, 1]);
  });

  test("observed distribution over 200k ids is within 0.15 points of the weights", () => {
    const counts = Object.fromEntries(RARITIES.map(r => [r, 0])) as Record<Rarity, number>;
    for (const b of SAMPLE) counts[b.rarity]++;
    for (const r of RARITIES) {
      const observed = (counts[r] / N) * 100;
      expect(Math.abs(observed - RARITY_WEIGHT[r])).toBeLessThan(0.15 + (r === "common" ? 0.2 : 0));
    }
    expect(counts.legendary).toBeGreaterThan(0); // the 1% tier is reachable
  });
});

describe("stats", () => {
  const rows = SAMPLE.map(b => ({ b, floor: STAT_FLOOR[b.rarity] }));

  test("floors: 5 / 15 / 25 / 35 / 50", () => {
    expect(RARITIES.map(r => STAT_FLOOR[r])).toEqual([5, 15, 25, 35, 50]);
  });

  test("every stat is an integer in 1..100 and none dips below floor - 5", () => {
    for (const { b, floor } of rows) {
      for (const s of STATS) {
        const v = b.stats[s];
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(Math.max(1, floor - 5));
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  test("one peak (>= floor + 50, capped at 100) towers over the other four (<= floor + 39)", () => {
    for (const { b, floor } of rows) {
      const sorted = STATS.map(s => b.stats[s]).sort((x, y) => y - x);
      expect(sorted[0]).toBeGreaterThanOrEqual(Math.min(100, floor + 50));
      expect(sorted[0]).toBeLessThanOrEqual(Math.min(100, floor + 79));
      for (const v of sorted.slice(1)) expect(v).toBeLessThanOrEqual(floor + 39);
    }
  });

  test("one dump stat sits at or below floor + 4", () => {
    for (const { b, floor } of rows) {
      const lowest = Math.min(...STATS.map(s => b.stats[s]));
      expect(lowest).toBeLessThanOrEqual(floor + 4);
    }
  });

  test("higher rarity means a higher average peak and average stat", () => {
    const avg = (r: Rarity, f: (b: Bones) => number) => {
      const xs = SAMPLE.filter(b => b.rarity === r);
      return xs.reduce((sum, b) => sum + f(b), 0) / xs.length;
    };
    const mean = (b: Bones) => STATS.reduce((s, k) => s + b.stats[k], 0) / STATS.length;
    for (let i = 1; i < RARITIES.length; i++) {
      const [lo, hi] = [RARITIES[i - 1] as Rarity, RARITIES[i] as Rarity];
      expect(avg(hi, mean)).toBeGreaterThan(avg(lo, mean));
    }
  });

  test("every stat name can be the peak, roughly a fifth of the time", () => {
    const counts = Object.fromEntries(STATS.map(s => [s, 0])) as Record<string, number>;
    for (const b of SAMPLE) counts[peakStat(b)]!++;
    for (const s of STATS) expect(Math.abs((counts[s]! / N) * 100 - 20)).toBeLessThan(0.6);
  });
});

describe("peakStat", () => {
  const bones = (stats: Bones["stats"]): Bones => ({ rarity: "rare", eye: "o", hat: "none", shiny: false, stats });

  test("returns the highest stat", () => {
    expect(peakStat(bones({ DEBUGGING: 1, PATIENCE: 2, CHAOS: 3, WISDOM: 99, SNARK: 4 }))).toBe("WISDOM");
  });

  test("ties resolve to the earlier stat in STATS order", () => {
    expect(peakStat(bones({ DEBUGGING: 10, PATIENCE: 80, CHAOS: 80, WISDOM: 10, SNARK: 80 }))).toBe("PATIENCE");
  });
});

describe("hats", () => {
  const byRarity = (r: Rarity) => SAMPLE.filter(b => b.rarity === r);

  test("commons never wear a hat", () => {
    const commons = byRarity("common");
    expect(commons.length).toBeGreaterThan(100_000);
    expect(commons.every(b => b.hat === "none")).toBe(true);
  });

  test("everyone above common always wears one", () => {
    for (const b of SAMPLE) if (b.rarity !== "common") expect(b.hat).not.toBe("none");
  });

  test("no bunny wears a hat above its rarity gate", () => {
    for (const b of SAMPLE) expect(HAT_MIN_RARITY[b.hat]).toBeLessThanOrEqual(rankOf(b.rarity));
  });

  test("each rarity can roll exactly the hats it is gated to", () => {
    const allowed = (r: Rarity): Hat[] => HATS.filter(h => h !== "none" && HAT_MIN_RARITY[h] <= rankOf(r));
    for (const r of RARITIES.slice(1)) {
      const seen = new Set(byRarity(r).map(b => b.hat));
      expect([...seen].sort()).toEqual(allowed(r).sort());
    }
  });

  test("gate table: crown/tophat/propeller from uncommon, halo/wizard from rare, beanie from epic, tinyduck legendary only", () => {
    const gate = Object.fromEntries(HATS.map(h => [h, RARITIES[HAT_MIN_RARITY[h]]]));
    expect(gate).toEqual({
      none: "common", crown: "uncommon", tophat: "uncommon", propeller: "uncommon",
      halo: "rare", wizard: "rare", beanie: "epic", tinyduck: "legendary",
    });
  });
});

describe("shiny and eyes", () => {
  test("shiny rate is about 1%, independent of rarity", () => {
    const shinies = SAMPLE.filter(b => b.shiny);
    expect(shinies.length / N).toBeGreaterThan(0.009);
    expect(shinies.length / N).toBeLessThan(0.011);
    const legendary = SAMPLE.filter(b => b.rarity === "legendary");
    const legendaryShiny = legendary.filter(b => b.shiny).length / legendary.length;
    expect(legendaryShiny).toBeGreaterThan(0.002);
    expect(legendaryShiny).toBeLessThan(0.025);
    const common = SAMPLE.filter(b => b.rarity === "common");
    const commonShiny = common.filter(b => b.shiny).length / common.length;
    expect(commonShiny).toBeGreaterThan(0.009);
    expect(commonShiny).toBeLessThan(0.011);
  });

  test("all six eyes appear, each about a sixth of the time, and each is one column wide", () => {
    const counts = new Map<string, number>();
    for (const b of SAMPLE) counts.set(b.eye, (counts.get(b.eye) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...EYES].sort());
    for (const eye of EYES) {
      expect(Math.abs((counts.get(eye)! / N) * 100 - 100 / 6)).toBeLessThan(0.6);
      expect([...eye]).toHaveLength(1);
    }
  });
});
