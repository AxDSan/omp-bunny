import { describe, expect, test } from "bun:test";
import { HAT_MIN_RARITY, NAMES, fnv1a, mulberry32, peakStat, rollBones } from "../src/bunny.ts";
import { FIXTURES, HATCH_ID, HAT_FIXTURES } from "../tools/fixtures.ts";

// The README images are rendered from these ids. If the derivation in src/bunny.ts ever changes, these
// fail loudly and the assets must be regenerated (`bun run assets`) instead of silently lying.
describe("README fixtures still roll what the images claim", () => {
  test("one bunny per rarity", () => {
    const rolled = (k: keyof typeof FIXTURES) => rollBones(FIXTURES[k].id);
    expect(rolled("common")).toMatchObject({ rarity: "common", eye: "^", hat: "none", shiny: false });
    expect(rolled("uncommon")).toMatchObject({ rarity: "uncommon", hat: "propeller", shiny: false });
    expect(rolled("rare")).toMatchObject({ rarity: "rare", hat: "wizard", shiny: false });
    expect(rolled("epic")).toMatchObject({ rarity: "epic", hat: "halo", shiny: false });
    expect(rolled("legendary")).toMatchObject({ rarity: "legendary", hat: "tinyduck", shiny: false });
    expect(rolled("shiny")).toMatchObject({ rarity: "rare", hat: "crown", shiny: true });
    expect(rolled("hero")).toMatchObject({ rarity: "epic", hat: "tophat", shiny: false });
    expect(peakStat(rolled("hero"))).toBe("SNARK");
  });

  test("the hat parade shows all seven hats, each legally worn", () => {
    const hats = Object.entries(HAT_FIXTURES).map(([hat, f]) => {
      const b = rollBones(f.id);
      expect(b.hat).toBe(hat as typeof b.hat);
      expect(HAT_MIN_RARITY[b.hat]).toBeLessThanOrEqual(["common", "uncommon", "rare", "epic", "legendary"].indexOf(b.rarity));
      return hat;
    });
    expect(hats.sort()).toEqual(["beanie", "crown", "halo", "propeller", "tinyduck", "tophat", "wizard"]);
  });

  test("the first-hatch demo id hatches an epic propeller-wearing CHAOS bunny named Juniper", () => {
    const b = rollBones(HATCH_ID);
    expect(b).toMatchObject({ rarity: "epic", hat: "propeller", shiny: false });
    expect(peakStat(b)).toBe("CHAOS");
    expect(NAMES[Math.floor(mulberry32(fnv1a(`${HATCH_ID}soul`))() * NAMES.length)]).toBe("Juniper");
  });
});
