/**
 * @fileoverview Technique difficulty levels — the single source of truth.
 *
 * A puzzle's 1-12 display level is owned **here**, not by the solver. The
 * solver still reports a `level` on /validate, /generate and /solve, but this
 * API ignores it and re-derives the value from {@link TECHNIQUE_LEVELS} before
 * responding, so consumers see one consistent level system no matter which
 * solver build answered. Changing a technique's level is a one-line edit in
 * this file plus a board backfill; nothing needs to ship in the solver.
 *
 * The rules:
 *
 * - **A technique's level** is {@link levelForTechnique}.
 * - **A board's level** is the level of the hardest technique its solve needed,
 *   i.e. the max over the techniques bitmask ({@link levelForBitmask}).
 * - **A hint's level** is the level of the technique that hint demonstrates.
 *
 * Levels 1-3 are set by hand: Full House is 1, Naked/Hidden Single are 2,
 * Naked/Hidden Pair are 3. Locked Candidates and Unique Rectangle Type 1 score
 * 13 in the solver, just above the pairs, and open level 4. Levels 4-12 are
 * banded by score so boards per level come out as even as the data allows;
 * re-derive the bands from the boards' techniques bitmasks (hardest technique
 * per board) if the board mix changes a lot.
 *
 * `score` is the solver's `GetDifficultyScore` (SudokuEngine/CSudokuRuleSolver.cpp,
 * documented in sudojo_solver/docs/LEVELS.md): an open-ended ratio scale anchored
 * at Full House = 1. It is mirrored here for one reason — the solver tries
 * techniques in ascending score order, so for "try easiest first" and "level"
 * to agree, `level` must be a non-decreasing banding of `score`. levels.test.ts
 * enforces it and fails if an edit breaks it.
 *
 * Keep this table in sync with the `techniques.level` column, the denormalised
 * copy the apps read to group the technique library by level:
 *   bun run scripts/verify-technique-levels.ts         # report drift
 *   bun run scripts/verify-technique-levels.ts --fix   # rewrite it from this map
 * Then re-run scripts/backfill-board-difficulty.ts, because moving a technique
 * changes the level of every board whose hardest technique it is.
 */

/** Lowest display level. */
export const MIN_LEVEL = 1;

/** Highest display level. */
export const MAX_LEVEL = 12;

/** Highest known technique ID; ALC (61) is currently opt-in at the solver. */
export const MAX_TECHNIQUE_ID = 61;

export interface TechniqueLevel {
  /** Solver difficulty score; the solve order is ascending in this value. */
  score: number;
  /** Display level 1-12. Must be a non-decreasing function of `score`. */
  level: number;
  /** Display title, for diagnostics and admin tooling. */
  name: string;
}

/**
 * Technique id -> difficulty. Ordered by score, which is also the solver's
 * try-order. Ids are the bit positions in a techniques bitmask.
 */
export const TECHNIQUE_LEVELS: Readonly<Record<number, TechniqueLevel>> =
  Object.freeze({
    1: { score: 1, level: 1, name: "Full House" },
    3: { score: 2, level: 2, name: "Naked Single" },
    2: { score: 4, level: 2, name: "Hidden Single" },
    5: { score: 8, level: 3, name: "Naked Pair" },
    4: { score: 12, level: 3, name: "Hidden Pair" },
    6: { score: 13, level: 4, name: "Locked Candidates" },
    30: { score: 13, level: 4, name: "Unique Rectangle Type 1" },
    32: { score: 14, level: 5, name: "BUG+1" },
    11: { score: 15, level: 5, name: "X-Wing" },
    31: { score: 16, level: 5, name: "Unique Rectangle Type 2" },
    8: { score: 18, level: 6, name: "Naked Triple" },
    24: { score: 18, level: 6, name: "Skyscraper" },
    14: { score: 20, level: 7, name: "XY-Wing" },
    25: { score: 20, level: 7, name: "Two-String Kite" },
    28: { score: 22, level: 8, name: "W-Wing" },
    38: { score: 22, level: 8, name: "Crane" },
    40: { score: 22, level: 8, name: "Unique Rectangle Type 4" },
    41: { score: 22, level: 8, name: "Unique Rectangle Type 5" },
    55: { score: 24, level: 8, name: "Firework" },
    7: { score: 28, level: 8, name: "Hidden Triple" },
    19: { score: 28, level: 8, name: "XYZ-Wing" },
    26: { score: 28, level: 8, name: "Empty Rectangle" },
    50: { score: 28, level: 8, name: "Avoidable Rectangle" },
    15: { score: 30, level: 8, name: "Finned X-Wing" },
    39: { score: 30, level: 8, name: "Unique Rectangle Type 3" },
    27: { score: 35, level: 9, name: "Simple Coloring" },
    51: { score: 35, level: 9, name: "Sashimi X-Wing" },
    10: { score: 40, level: 9, name: "Naked Quad" },
    12: { score: 40, level: 9, name: "Swordfish" },
    54: { score: 40, level: 9, name: "Hidden Unique Rectangle" },
    20: { score: 45, level: 9, name: "WXYZ-Wing" },
    29: { score: 50, level: 9, name: "Remote Pairs" },
    57: { score: 55, level: 9, name: "Franken X-Wing" },
    61: { score: 55, level: 9, name: "Almost Locked Candidates" },
    9: { score: 60, level: 9, name: "Hidden Quad" },
    42: { score: 60, level: 9, name: "X-Chain" },
    17: { score: 65, level: 9, name: "Finned Swordfish" },
    44: { score: 70, level: 9, name: "VWXYZ-Wing" },
    52: { score: 70, level: 9, name: "Sashimi Swordfish" },
    43: { score: 75, level: 10, name: "XY-Chain" },
    13: { score: 80, level: 11, name: "Jellyfish" },
    35: { score: 80, level: 11, name: "X-Cycles" },
    21: { score: 90, level: 11, name: "Almost Locked Sets (ALS-XY)" },
    34: { score: 100, level: 11, name: "ALS-XZ" },
    45: { score: 100, level: 11, name: "UVWXYZ-Wing" },
    58: { score: 110, level: 11, name: "Franken Swordfish" },
    18: { score: 120, level: 11, name: "Finned Jellyfish" },
    33: { score: 120, level: 11, name: "Sue de Coq" },
    60: { score: 120, level: 11, name: "Grouped X-Cycles" },
    53: { score: 125, level: 11, name: "Sashimi Jellyfish" },
    16: { score: 140, level: 11, name: "Squirmbag" },
    46: { score: 140, level: 11, name: "TUVWXYZ-Wing" },
    48: { score: 180, level: 12, name: "Alternating Inference Chain (AIC)" },
    47: { score: 190, level: 12, name: "STUVWXYZ-Wing" },
    22: { score: 200, level: 12, name: "Finned Squirmbag" },
    23: { score: 200, level: 12, name: "ALS Chain" },
    37: { score: 200, level: 12, name: "3D Medusa" },
    59: { score: 200, level: 12, name: "Franken Jellyfish" },
    56: { score: 220, level: 12, name: "Death Blossom" },
    36: { score: 350, level: 12, name: "Forcing Chains" },
    49: { score: 500, level: 12, name: "Forcing Net" },
  });

/**
 * The level of a single technique, or `null` if the id is not a real technique.
 *
 * `null` (rather than a default level) is deliberate: technique 0 means "no
 * technique" in solver hints (an auto-pencilmark step), and silently calling
 * that level 1 would award hint points for it.
 */
export function levelForTechnique(techniqueId: number): number | null {
  return TECHNIQUE_LEVELS[techniqueId]?.level ?? null;
}

/** The solver difficulty score of a single technique, or `null` if unknown. */
export function scoreForTechnique(techniqueId: number): number | null {
  return TECHNIQUE_LEVELS[techniqueId]?.score ?? null;
}

/**
 * A board's level: the level of the hardest technique in its bitmask.
 *
 * Takes a `bigint` because a mask with any technique id >= 54 exceeds 2^53 and
 * a JS number silently drops its low bits — see src/lib/bitmask.ts. Bits that
 * are not real technique ids are ignored, so an unknown-but-set high bit from a
 * newer solver cannot inflate the level.
 *
 * Returns {@link MIN_LEVEL} for an empty mask: a board that needed no technique
 * is as easy as a board can be, and no caller wants a null level here.
 */
export function levelForBitmask(mask: bigint): number {
  let level: number = MIN_LEVEL;
  for (let id = 1; id <= MAX_TECHNIQUE_ID; id++) {
    if ((mask >> BigInt(id)) & 1n) {
      const techLevel = TECHNIQUE_LEVELS[id]?.level;
      if (techLevel !== undefined && techLevel > level) {
        level = techLevel;
      }
    }
  }
  return level;
}
