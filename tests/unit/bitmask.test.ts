/**
 * src/lib/bitmask.ts: the single place technique bitmasks are parsed, bound
 * into SQL, and turned into JSON-safe response fields.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  BITMASK_MAX,
  bitmaskParam,
  parseBitmask,
  solverBitmask,
  techniqueBit,
  toBitmaskFields,
} from "../../src/lib/bitmask";

/** Bit 60 (Grouped X-Cycles) + bit 1 (Full House). Needs 61 bits. */
const HIGH = (1n << 60n) | (1n << 1n);
const HIGH_STRING = "1152921504606846978";

describe("parseBitmask", () => {
  it("accepts non-negative safe integers as numbers", () => {
    expect(parseBitmask(0)).toBe(0n);
    expect(parseBitmask(42)).toBe(42n);
  });

  it("rejects integer numbers above 2^53: JSON.parse has already rounded them", () => {
    // The mask {1,2,3,5,6,11,24,55} sent as a JSON number arrives without bit 1.
    const lossy = JSON.parse("36028797035743342") as number;
    expect(BigInt(lossy)).not.toBe(36028797035743342n);
    expect(parseBitmask(lossy)).toBeNull();
    expect(parseBitmask(2 ** 60)).toBeNull();
    expect(parseBitmask(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER)
    );
  });

  it("accepts unsafe numbers only when allowUnsafeNumber is set (legacy clients)", () => {
    expect(parseBitmask(2 ** 60, { allowUnsafeNumber: true })).toBe(1n << 60n);
  });

  it("rejects over-long digit strings without parsing them", () => {
    // A real bitmask has at most 39 digits (BITMASK_MAX = 2^128-1). BigInt() on
    // a 300k-digit string blocks the event loop for ~1s; 600k+ throws.
    expect(parseBitmask("0".repeat(39) + "1")).toBeNull();
    const started = performance.now();
    expect(parseBitmask("9".repeat(600_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("accepts decimal strings exactly, beyond 2^53", () => {
    expect(HIGH.toString()).toBe(HIGH_STRING);
    expect(parseBitmask(HIGH_STRING)).toBe(HIGH);
    expect(parseBitmask("0")).toBe(0n);
  });

  it("accepts bigints", () => {
    expect(parseBitmask(HIGH)).toBe(HIGH);
  });

  it("accepts the largest value a bit(128) column holds", () => {
    expect(BITMASK_MAX).toBe(2n ** 128n - 1n);
    expect(parseBitmask(BITMASK_MAX.toString())).toBe(BITMASK_MAX);
    // A former signed-BIGINT-overflow value (2^63) is now well within range.
    expect(parseBitmask((2n ** 63n).toString())).toBe(2n ** 63n);
    expect(parseBitmask(((1n << 127n) | 2n).toString())).toBe((1n << 127n) | 2n);
  });

  it.each([
    ["negative number", -1],
    ["fractional number", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["negative string", "-1"],
    ["fractional string", "1.5"],
    ["exponent string", "1e3"],
    ["hex string", "0x10"],
    ["empty string", ""],
    ["padded string", " 12"],
    ["word", "abc"],
    ["negative bigint", -1n],
    ["above bitmask max (2^128)", (2n ** 128n).toString()],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
    ["object", {}],
  ])("rejects %s", (_label, value) => {
    expect(parseBitmask(value)).toBeNull();
  });
});

describe("techniqueBit", () => {
  it("is exact for every technique id, including 54-60", () => {
    expect(techniqueBit(1)).toBe(2n);
    expect(techniqueBit(60)).toBe(1n << 60n);
    expect(techniqueBit(60).toString()).toBe("1152921504606846976");
  });
});

describe("bitmaskParam", () => {
  it("binds the value as a 128-char binary string cast to bit(128)", () => {
    const query = new PgDialect().sqlToQuery(
      sql`(x & ${bitmaskParam(HIGH)}) <> ${bitmaskParam(0n)}`
    );
    expect(query.sql).toBe("(x & $1::bit(128)) <> $2::bit(128)");
    const highBits = HIGH.toString(2).padStart(128, "0");
    expect(query.params).toEqual([highBits, "0".repeat(128)]);
    expect(typeof query.params[0]).toBe("string");
    expect((query.params[0] as string).length).toBe(128);
  });

  it("binds bit 127 without losing bit 1", () => {
    const mask = (1n << 127n) | 2n;
    const query = new PgDialect().sqlToQuery(sql`${bitmaskParam(mask)}`);
    expect(query.params).toEqual(["1" + "0".repeat(125) + "10"]);
  });
});

describe("toBitmaskFields", () => {
  it("keeps the numeric field and adds an exact <field>_bitmask string", () => {
    const out = toBitmaskFields({ uuid: "u", techniques: HIGH, level: 12 });
    expect(out).toEqual({
      uuid: "u",
      level: 12,
      techniques: Number(HIGH),
      techniques_bitmask: HIGH_STRING,
    });
    // The numeric field stays exactly as lossy as it always was.
    expect(out.techniques).toBe(1152921504606846976);
  });

  it("handles techniques_bitfield", () => {
    const out = toBitmaskFields({ techniques_bitfield: HIGH });
    expect(out).toEqual({
      techniques_bitfield: Number(HIGH),
      techniques_bitfield_bitmask: HIGH_STRING,
    });
  });

  it("passes null through to both fields", () => {
    expect(toBitmaskFields({ techniques: null })).toEqual({
      techniques: null,
      techniques_bitmask: null,
    });
  });

  it("leaves objects without bitmask fields unchanged", () => {
    expect(toBitmaskFields({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });

  it("never returns a bigint", () => {
    const out = toBitmaskFields({ techniques: HIGH, techniques_bitfield: 3n });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("returns an exact 128-bit companion while keeping the legacy number bounded", () => {
    const mask = (1n << 127n) | 2n;
    expect(toBitmaskFields({ techniques: mask })).toEqual({
      techniques: 2,
      techniques_bitmask: mask.toString(),
    });
  });
});

describe("solverBitmask", () => {
  it("prefers techniques_bitmask over the lossy number", () => {
    // What JSON.parse makes of the solver's `"techniques":1152921504606846978`.
    const lossy = JSON.parse(`{"t":${HIGH_STRING}}`).t as number;
    expect(BigInt(lossy)).not.toBe(HIGH);
    expect(
      solverBitmask({ techniques: lossy, techniques_bitmask: HIGH_STRING })
    ).toBe(HIGH);
  });

  it("falls back to the number when techniques_bitmask is absent", () => {
    expect(solverBitmask({ techniques: 42 })).toBe(42n);
    expect(solverBitmask({ techniques: 42, techniques_bitmask: null })).toBe(
      42n
    );
  });

  it("never invents bits in the fallback (uses the double's exact value)", () => {
    // An old solver's bit-57-only mask. String(2 ** 57) is "144115188075855870"
    // = 2^57 - 2, i.e. bits 1-56 set and bit 57 cleared.
    expect(solverBitmask({ techniques: 2 ** 57 })).toBe(1n << 57n);
    // A rounded mask may still lack low bits, but never gains any.
    const lossy = JSON.parse(`{"t":${HIGH_STRING}}`).t as number;
    expect(solverBitmask({ techniques: lossy })).toBe(BigInt(lossy));
  });

  it("falls back when techniques_bitmask is malformed", () => {
    expect(solverBitmask({ techniques: 42, techniques_bitmask: "x" })).toBe(
      42n
    );
  });

  it("throws when neither field holds a bitmask", () => {
    expect(() => solverBitmask({})).toThrow(/techniques/);
    expect(() => solverBitmask({ techniques: -1 })).toThrow(/techniques/);
  });
});
