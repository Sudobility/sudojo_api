import { describe, it, expect } from "vitest";
import {
  TECHNIQUE_LEVELS,
  MIN_LEVEL,
  MAX_LEVEL,
  MAX_TECHNIQUE_ID,
  levelForTechnique,
  scoreForTechnique,
  levelForBitmask,
} from "./levels";

/**
 * Technique dependencies, from the `techniques.dependencies` column (a technique
 * builds on these). A technique can never be easier than what it builds on, so
 * its level must be >= every dependency's level.
 */
const DEPENDENCIES: Readonly<Record<number, number[]>> = {
  4: [2],
  5: [3],
  6: [2],
  7: [4],
  8: [5],
  9: [7],
  10: [8],
  11: [6],
  12: [11],
  13: [12],
  14: [5],
  15: [11],
  16: [13],
  17: [12, 15],
  18: [13, 17],
  19: [14],
  20: [19],
  21: [5],
  22: [16, 18],
  23: [34],
  24: [11],
  25: [11, 24],
  26: [6],
  27: [11],
  29: [27],
  30: [5],
  31: [30],
  32: [5],
  33: [21, 6],
  34: [21],
  35: [27],
  36: [35],
  37: [27],
};

describe("TECHNIQUE_LEVELS table", () => {
  it("covers every technique id 1..60 exactly once", () => {
    const ids = Object.keys(TECHNIQUE_LEVELS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(ids).toEqual(
      Array.from({ length: MAX_TECHNIQUE_ID }, (_, i) => i + 1)
    );
  });

  it("assigns every technique a level in 1..12", () => {
    for (const [id, entry] of Object.entries(TECHNIQUE_LEVELS)) {
      expect(entry.level, `technique ${id}`).toBeGreaterThanOrEqual(MIN_LEVEL);
      expect(entry.level, `technique ${id}`).toBeLessThanOrEqual(MAX_LEVEL);
      expect(Number.isInteger(entry.level), `technique ${id}`).toBe(true);
    }
  });

  it("uses all 12 levels, so no level is an empty band", () => {
    const used = new Set(
      Object.values(TECHNIQUE_LEVELS).map(entry => entry.level)
    );
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level++) {
      expect(used.has(level), `level ${level} has no techniques`).toBe(true);
    }
  });

  it("is a non-decreasing banding of the solver difficulty score", () => {
    // The solver tries techniques in ascending score order. If a
    // higher-scoring technique sat at a lower level, "try easiest first" and
    // "level" would disagree and a board could be labelled easier than the
    // hardest step its solve actually needed.
    const byScore = Object.entries(TECHNIQUE_LEVELS)
      .map(([id, entry]) => ({ id: Number(id), ...entry }))
      .sort((a, b) => a.score - b.score || a.id - b.id);

    for (let i = 1; i < byScore.length; i++) {
      const prev = byScore[i - 1];
      const curr = byScore[i];
      expect(
        curr.level,
        `${curr.name} (score ${curr.score}) must not sit below ${prev.name} (score ${prev.score})`
      ).toBeGreaterThanOrEqual(prev.level);
    }
  });

  it("scores Locked Candidates and UR Type 1 above both pairs, at level 4", () => {
    const score = (id: number) => scoreForTechnique(id)!;
    expect(score(6)).toBeGreaterThan(score(5)); // Naked Pair
    expect(score(6)).toBeGreaterThan(score(4)); // Hidden Pair
    expect(score(30)).toBeGreaterThan(score(4));
    expect(levelForTechnique(6)).toBe(4);
    expect(levelForTechnique(30)).toBe(4);
    // Full House 1, the other singles 2, the pairs 3.
    expect([1, 3, 2, 5, 4].map(levelForTechnique)).toEqual([1, 2, 2, 3, 3]);
  });

  it("gives equal-score techniques the same level", () => {
    const byScore = new Map<number, { level: number; name: string }[]>();
    for (const entry of Object.values(TECHNIQUE_LEVELS)) {
      const bucket = byScore.get(entry.score) ?? [];
      bucket.push(entry);
      byScore.set(entry.score, bucket);
    }
    for (const [score, bucket] of byScore) {
      const levels = new Set(bucket.map(e => e.level));
      expect(
        levels.size,
        `score ${score} maps to levels ${[...levels].join("/")} (${bucket.map(e => e.name).join(", ")})`
      ).toBe(1);
    }
  });

  it("never places a technique below something it builds on", () => {
    for (const [idStr, deps] of Object.entries(DEPENDENCIES)) {
      const id = Number(idStr);
      const level = levelForTechnique(id);
      expect(level, `technique ${id} missing`).not.toBeNull();
      for (const dep of deps) {
        const depLevel = levelForTechnique(dep);
        expect(depLevel, `dependency ${dep} missing`).not.toBeNull();
        expect(
          level!,
          `${TECHNIQUE_LEVELS[id].name} (L${level}) builds on ${TECHNIQUE_LEVELS[dep].name} (L${depLevel})`
        ).toBeGreaterThanOrEqual(depLevel!);
      }
    }
  });
});

describe("levelForTechnique", () => {
  it("returns the table's level", () => {
    expect(levelForTechnique(1)).toBe(1); // Full House
    expect(levelForTechnique(3)).toBe(2); // Naked Single
    expect(levelForTechnique(6)).toBe(4); // Locked Candidates
    expect(levelForTechnique(36)).toBe(12); // Forcing Chains
    expect(levelForTechnique(49)).toBe(12); // Forcing Net
  });

  it("returns null for technique 0 and out-of-range ids", () => {
    // Technique 0 is "no technique" (an auto-pencilmark hint step): it must not
    // silently become level 1, which would award hint points for it.
    expect(levelForTechnique(0)).toBeNull();
    expect(levelForTechnique(66)).toBeNull();
    expect(levelForTechnique(-1)).toBeNull();
  });

  it("exposes the matching score", () => {
    expect(scoreForTechnique(1)).toBe(1);
    expect(scoreForTechnique(49)).toBe(500);
    expect(scoreForTechnique(0)).toBeNull();
  });
});

describe("levelForBitmask", () => {
  const bit = (id: number) => 1n << BigInt(id);

  it("returns the level of the hardest technique in the mask", () => {
    expect(levelForBitmask(bit(1) | bit(3))).toBe(2); // singles only
    expect(levelForBitmask(bit(1) | bit(3) | bit(6))).toBe(4); // + locked candidates
    expect(levelForBitmask(bit(3) | bit(24))).toBe(6); // + skyscraper
  });

  it("is exact for high technique ids, where a JS number would lose bits", () => {
    // Bit 60 alone exceeds 2^53. Combined with bit 1, a double drops the low
    // bit entirely (1152921504606846978 reads back as ...976), so this must be
    // computed in bigint throughout.
    const mask = bit(1) | bit(60); // Full House + Grouped X-Cycles
    expect(mask).toBe(1152921504606846978n);
    expect(levelForBitmask(mask)).toBe(11);

    expect(levelForBitmask(bit(3) | bit(36))).toBe(12); // Forcing Chains wins
    expect(levelForBitmask(bit(3) | bit(56))).toBe(12); // Death Blossom wins
  });

  it("takes the max, not the last or highest bit set", () => {
    // Bit 60 (Grouped X-Cycles, L11) is a higher id than bit 36 (Forcing
    // Chains, L12) but an easier level: the level must follow the table, not
    // the id.
    expect(levelForBitmask(bit(36) | bit(60))).toBe(12);
  });

  it("returns the minimum level for an empty mask", () => {
    expect(levelForBitmask(0n)).toBe(MIN_LEVEL);
  });

  it("ignores bits that are not real technique ids", () => {
    // A newer solver setting an unknown bit must not inflate the level.
    expect(levelForBitmask(bit(3) | bit(66) | bit(67))).toBe(2);
    expect(levelForBitmask(bit(3) | bit(61))).toBe(9);
    expect(levelForBitmask(bit(3) | bit(62))).toBe(9);
    expect(levelForBitmask(bit(3) | bit(63))).toBe(11);
    expect(levelForBitmask(bit(3) | bit(64))).toBe(11);
    expect(levelForBitmask(bit(65))).toBe(12);
  });
});
