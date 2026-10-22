/**
 * @fileoverview Technique bitmasks: parsing, SQL binding, JSON output.
 *
 * A technique bitmask sets bit N for technique id N (1-127). Once any id >= 54
 * is set the value exceeds 2^53, so a JS number silently drops the low bits
 * (the easy techniques). Inside the API a bitmask is therefore always a
 * `bigint`: the Drizzle bitmask columns are `bit(128)` (the `techniqueBitmask`
 * custom type in src/db/schema.ts, carried as a bigint), request fields and
 * query params are parsed with {@link parseBitmask}, and SQL params go through
 * {@link bitmaskParam}.
 *
 * `JSON.stringify` (and so Hono's `c.json`) throws on a `bigint`, and old app
 * builds read `techniques` as a number. Every response therefore goes through
 * {@link toBitmaskFields}: it keeps the numeric field (the low 64 bits, as
 * lossy as it has always been) and adds an exact decimal-string companion
 * `<field>_bitmask`. Clients should read the companion and parse it with
 * `BigInt(...)`.
 */

import { sql, type SQL } from "drizzle-orm";
import { levelForBitmask } from "./levels";
import type {
  Board,
  Daily,
  TechniqueExample,
  ValidateBoardData,
} from "@sudobility/sudojo_types";

/**
 * Largest value a technique bitmask may hold: an unsigned 128-bit value, the
 * width of the `bit(128)` columns. (Was a signed BIGINT's 2^63-1.)
 */
export const BITMASK_MAX = 2n ** 128n - 1n;

/** Digits in {@link BITMASK_MAX}; longer strings are rejected before `BigInt()`. */
const BITMASK_MAX_DIGITS = BITMASK_MAX.toString().length;

/** Response fields that carry a technique bitmask. */
export const BITMASK_FIELDS = ["techniques", "techniques_bitfield"] as const;
export type BitmaskField = (typeof BITMASK_FIELDS)[number];

/**
 * Parse a technique bitmask from a request.
 *
 * Accepts a non-negative safe-integer `number`, a base-10 digit string of at
 * most 39 digits, or a `bigint`, up to {@link BITMASK_MAX}. Returns `null` for
 * anything else (negative, fractional, exponent/hex/padded/over-long strings,
 * "", null, ...), so each caller reports the error in its own style.
 *
 * A `number` above 2^53 is rejected: `JSON.parse` has already rounded it, so
 * its low bits are wrong. Pass `allowUnsafeNumber` only where legacy clients
 * must keep working and the value is never trusted (e.g. `/play/start`).
 */
export function parseBitmask(
  value: unknown,
  options: { allowUnsafeNumber?: boolean } = {}
): bigint | null {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    if (!Number.isSafeInteger(value) && !options.allowUnsafeNumber) return null;
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    // Length check first: BigInt() on a huge digit string blocks the event
    // loop (~1s for 300k digits) or throws (600k+ in Bun).
    if (value.length > BITMASK_MAX_DIGITS || !/^[0-9]+$/.test(value)) {
      return null;
    }
    parsed = BigInt(value);
  } else {
    return null;
  }
  return parsed >= 0n && parsed <= BITMASK_MAX ? parsed : null;
}

/** The bitmask bit for a technique id: `1n << id`, exact for every id. */
export function techniqueBit(techniqueId: number): bigint {
  return 1n << BigInt(techniqueId);
}

/**
 * Bind a bitmask into raw SQL as a `bit(128)` literal, e.g.
 * sql`(${boards.techniques} & ${bitmaskParam(bit)}) <> ${bitmaskParam(0n)}`.
 *
 * The value is sent as its 128-char MSB-first binary string and cast to
 * bit(128); Postgres coerces the bound string param (verified empirically).
 * This is the single place the id-N-at-position-(127-N) convention is encoded,
 * so every bitwise predicate must go through it. Because `bit & bit` yields a
 * bit, test for a hit with `<> ${bitmaskParam(0n)}`, not `!= 0` (an integer).
 *
 * Never interpolate a JS number here: postgres.js sends it as `'' + x`, and
 * `String(2 ** 60)` is "1152921504606847000" -- not bit 60.
 */
export function bitmaskParam(value: bigint): SQL {
  const bits = BigInt.asUintN(128, value).toString(2).padStart(128, "0");
  return sql`${bits}::bit(128)`;
}

/**
 * The solver's /validate and /generate `data.board` bitmask.
 *
 * The solver sends the ulong twice: `techniques` (a JSON number, already
 * rounded by `JSON.parse`) and `techniques_bitmask` (the same value as a
 * decimal string). Prefer the string; for a solver that predates it, fall back
 * to `BigInt(techniques)`. That is the double's exact value: it may lack low
 * bits but never invents any. (`String(techniques)` would: `String(2 ** 57)` is
 * "144115188075855870" = 2^57 - 2, i.e. bits 1-56 set and bit 57 cleared.)
 *
 * @throws Error if neither field holds a valid bitmask
 */
export function solverBitmask(board: {
  techniques?: number | null;
  techniques_bitmask?: string | null;
}): bigint {
  if (board.techniques_bitmask != null) {
    const exact = parseBitmask(board.techniques_bitmask);
    if (exact !== null) return exact;
    console.warn(
      `[bitmask] solver sent invalid techniques_bitmask ${JSON.stringify(board.techniques_bitmask)}; using techniques`
    );
  }
  const fallback = parseBitmask(board.techniques, { allowUnsafeNumber: true });
  if (fallback === null) {
    throw new Error(
      `Solver returned no valid techniques bitmask (techniques=${String(board.techniques)})`
    );
  }
  return fallback;
}

/**
 * The solver's /validate or /generate `data` as the API returns it: the board
 * bitmask read with {@link solverBitmask}, then split into `techniques`
 * (number) and `techniques_bitmask` (exact string).
 *
 * The board's `level` is **re-derived here** from the bitmask via
 * {@link levelForBitmask} and overwrites whatever the solver sent. The 1-12
 * scale is owned by src/lib/levels.ts, so a solver rebalance (or an older
 * deployment answering) can no longer change the level a client sees. This is
 * the only place /validate and /generate build their board, so it is the only
 * place that needs the override.
 *
 * @throws Error if the solver sent no valid bitmask
 */
export function toValidateResponseData<
  D extends {
    board: ValidateBoardData & { techniques_bitmask?: string | null };
  },
>(data: D): Omit<D, "board"> & ValidateResponseData {
  const techniques = solverBitmask(data.board);
  // toBitmaskFields overwrites the solver's techniques_bitmask with the value
  // actually used, so the response is consistent whichever field won.
  return {
    ...data,
    board: toBitmaskFields({
      ...data.board,
      techniques,
      level: levelForBitmask(techniques),
    }),
  };
}

type NumberFor<V> = V extends bigint ? number : V;
type StringFor<V> = V extends bigint ? string : V;

/**
 * `T` as it goes out in a response: each bitmask field becomes a number and
 * gains a `<field>_bitmask` string (null stays null in both).
 */
export type WithBitmaskFields<T> = {
  [K in keyof T]: K extends BitmaskField ? NumberFor<T[K]> : T[K];
} & {
  [K in keyof T & BitmaskField as `${K}_bitmask`]: StringFor<T[K]>;
};

/**
 * Convert a row (or any object) for a JSON response. For every bitmask field
 * present: `field` -> `Number` of the LOW 64 BITS (kept for old clients; lossy
 * above 2^53 as it has always been, and now capped to 64 bits so a >64-bit
 * mask never serializes as a ~1e38 number literal), plus `field_bitmask` ->
 * the exact decimal string of the full value. Other fields are copied
 * unchanged. Accepts the field as a bigint, number, or decimal string.
 *
 * @throws Error if a bitmask field holds something that is not a bitmask
 */
export function toBitmaskFields<T extends object>(
  row: T
): WithBitmaskFields<T> {
  const input = row as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input };
  for (const field of BITMASK_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === null || value === undefined) {
      out[field] = value;
      out[`${field}_bitmask`] = value;
      continue;
    }
    // Output only: accept any integer (as before) so a value can't 500 a response.
    const bitmask = parseBitmask(value, { allowUnsafeNumber: true });
    if (bitmask === null) {
      throw new Error(`Invalid ${field} bitmask: ${String(value)}`);
    }
    // Low 64 bits only: the legacy numeric field never carries more than a
    // signed-64-ish value, so a >64-bit mask can't become an unreadable 1e38
    // number literal for old clients. The exact value is in `_bitmask`.
    out[field] = Number(BigInt.asUintN(64, bitmask));
    out[`${field}_bitmask`] = bitmask.toString();
  }
  return out as WithBitmaskFields<T>;
}

// =============================================================================
// Response types
// =============================================================================
// TODO(sudojo_types): @sudobility/sudojo_types ^1.2.67 does not have the
// `_bitmask` companions yet. Another change is adding `techniques_bitmask?:
// string` there. Once a version with them is published and this repo depends
// on it, replace these intersections with the package types.

/** GET/POST/PUT/DELETE /boards* item. */
export type BoardResponse = Board & { techniques_bitmask: string | null };

/** /dailies* item, including the unpersisted fallback daily. */
export type DailyResponse = Daily & { techniques_bitmask: string | null };

/** /examples* item. */
export type TechniqueExampleResponse = TechniqueExample & {
  techniques_bitfield_bitmask: string;
};

/** `data.board` of /solver/validate and /solver/generate. */
export type ValidateBoardResponse = ValidateBoardData & {
  techniques_bitmask: string;
};

/** `data` of /solver/validate and /solver/generate. */
export interface ValidateResponseData {
  board: ValidateBoardResponse;
}
