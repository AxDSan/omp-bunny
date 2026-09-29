// Fixed bunny ids used by the gallery, the README images and the test-suite. The ids are plain strings
// found by scanning `omp-bunny/<tag>/<n>` for the first roll that matches the description; the fixture
// test (test/fixtures.test.ts) re-checks every description against the real `rollBones`, so if the
// derivation ever changes the images can no longer silently drift from the code.
export interface Fixture {
  id: string;
  name: string;
}

export const FIXTURES = {
  common: { id: "omp-bunny/common/3", name: "Pip" }, //             common, eyes ^, no hat
  uncommon: { id: "omp-bunny/uncommon/4", name: "Biscuit" }, //    uncommon, propeller
  rare: { id: "omp-bunny/rare/14", name: "Juniper" }, //           rare, wizard
  epic: { id: "omp-bunny/epic/37", name: "Hazel" }, //             epic, halo
  legendary: { id: "omp-bunny/legendary/278", name: "Bunsen" }, // legendary, tinyduck
  shiny: { id: "omp-bunny/shiny/357", name: "Mochi" }, //          rare + shiny, crown
  hero: { id: "omp-bunny/hero/352", name: "Toast" }, //            epic, tophat, peak SNARK
} as const satisfies Record<string, Fixture>;

/** One bunny per hat, at the lowest rarity that can wear it where the scan found one. */
export const HAT_FIXTURES = {
  crown: { id: "omp-bunny/crown/3", name: "Clover" },
  tophat: { id: "omp-bunny/tophat/12", name: "Maple" },
  propeller: { id: "omp-bunny/uncommon/4", name: "Biscuit" },
  halo: { id: "omp-bunny/epic/37", name: "Hazel" },
  wizard: { id: "omp-bunny/rare/14", name: "Juniper" },
  beanie: { id: "omp-bunny/beanie/79", name: "Fern" },
  tinyduck: { id: "omp-bunny/legendary/278", name: "Bunsen" },
} as const satisfies Record<string, Fixture>;

/** `randomUUID()` result forced for the first-hatch demo (epic, propeller, peak CHAOS, named by the code). */
export const HATCH_ID = "omp-bunny/hatch/21";
