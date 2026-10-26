import { z } from "zod";
import { parseBitmask } from "../lib/bitmask";

/**
 * A technique bitmask in a request body: a non-negative integer as a JSON
 * number or a decimal string (up to the 128-bit bitmask max), parsed to a
 * bigint. Values above 2^53 (any technique id >= 54) must be sent as a string:
 * a JSON number that large has already lost its low bits, so it is rejected.
 * `null` means 0, as it did when these fields were `z.coerce.number()`.
 */
function bitmaskSchema(options: { allowUnsafeNumber?: boolean } = {}) {
  return z.union([z.number(), z.string(), z.null()]).transform((value, ctx) => {
    const parsed = value === null ? 0n : parseBitmask(value, options);
    if (parsed === null) {
      const unsafeNumber =
        typeof value === "number" &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value);
      ctx.addIssue({
        code: "custom",
        message: unsafeNumber
          ? "Bitmasks above 2^53 must be sent as a decimal string (a JSON number that large has lost its low bits)"
          : "Must be a non-negative integer bitmask, as a number or a decimal string",
      });
      return z.NEVER;
    }
    return parsed;
  });
}

const bitmask = bitmaskSchema();

/**
 * `/play/start` only: old app builds in the stores send `techniques` as a
 * JSON number, so an unsafe number is still accepted (lossy, as before) rather
 * than failing game start. The stored value is never read.
 */
const legacyBitmask = bitmaskSchema({ allowUnsafeNumber: true });

/** A bitmask with at least one technique bit set. */
const nonEmptyBitmask = bitmask.refine(value => value >= 1n, {
  message: "Must have at least one bit set",
});

// Level schemas
export const levelCreateSchema = z.object({
  level: z.number().int().min(1).max(12),
  title: z.string().min(1).max(255),
  text: z.string().nullish().default(""),
  requires_subscription: z.boolean().optional().default(false),
  entitlement: z.string().max(255).nullish(),
  offer_id: z.string().max(255).nullish(),
  percentage: z.number().min(0).max(1).nullish(),
});

export const levelUpdateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  text: z.string().nullish(),
  requires_subscription: z.boolean().optional(),
  entitlement: z.string().max(255).nullish(),
  offer_id: z.string().max(255).nullish(),
  percentage: z.number().min(0).max(1).nullish(),
});

export const levelParamSchema = z.object({
  level: z.coerce.number().int().min(1).max(12),
});

// Technique schemas
// Max technique ID is 63 (opt-in ALC, Triple Firework, and Bivalue Oddagon)
export const techniqueCreateSchema = z.object({
  technique: z.number().int().min(1).max(63),
  level: z.number().int().min(1).max(12),
  title: z.string().min(1).max(255),
  text: z.string().nullish().default(""),
  percentage: z.number().min(0).max(1).nullish(),
  strategy_id: z.number().int().min(1).nullish(),
});

export const techniqueUpdateSchema = z.object({
  level: z.number().int().min(1).max(12).optional(),
  title: z.string().min(1).max(255).optional(),
  text: z.string().nullish(),
  percentage: z.number().min(0).max(1).nullish(),
  dependencies: z.string().nullish(),
  strategy_id: z.number().int().min(1).nullish(),
});

export const techniqueParamSchema = z.object({
  technique: z.coerce.number().int().min(1).max(63),
});

export const techniquePathParamSchema = z.object({
  path: z.string().min(1).max(255),
});

// Learning schemas
export const learningCreateSchema = z.object({
  technique: z.number().int().min(1).max(63),
  index: z.number().int(),
  language_code: z.string().min(2).max(10).nullish().default("en"),
  text: z.string().nullish().default(""),
  image_url: z.string().url().nullish(),
});

export const learningUpdateSchema = z.object({
  technique: z.number().int().min(1).max(63).optional(),
  index: z.number().int().optional(),
  language_code: z.string().min(2).max(10).nullish(),
  text: z.string().nullish(),
  image_url: z.string().url().nullish(),
});

// Board schemas
export const boardCreateSchema = z.object({
  level: z.number().int().min(1).max(12).nullish(),
  symmetrical: z.boolean().optional().default(false),
  board: z.string().length(81),
  solution: z.string().length(81),
  techniques: bitmask.optional().default(0n),
  difficulty_score: z.coerce.number().int().optional().default(0),
});

export const boardUpdateSchema = z.object({
  level: z.number().int().min(1).max(12).nullish(),
  symmetrical: z.boolean().optional(),
  board: z.string().length(81).optional(),
  solution: z.string().length(81).optional(),
  techniques: bitmask.optional(),
  difficulty_score: z.coerce.number().int().optional(),
});

// Daily schemas
export const dailyCreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  board_uuid: z.string().uuid().nullish(),
  level: z.number().int().min(1).max(12).nullish(),
  techniques: bitmask.optional().default(0n),
  difficulty_score: z.coerce.number().int().optional().default(0),
  board: z.string().length(81),
  solution: z.string().length(81),
});

export const dailyUpdateSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  board_uuid: z.string().uuid().nullish(),
  level: z.number().int().min(1).max(12).nullish(),
  techniques: bitmask.optional(),
  difficulty_score: z.coerce.number().int().optional(),
  board: z.string().length(81).optional(),
  solution: z.string().length(81).optional(),
});

// Challenge schemas
export const challengeCreateSchema = z.object({
  board_uuid: z.string().uuid().nullish(),
  level: z.number().int().min(1).max(12).nullish(),
  difficulty: z.number().int().min(1).max(10).optional().default(1),
  difficulty_score: z.coerce.number().int().optional().default(0),
  board: z.string().length(81),
  solution: z.string().length(81),
});

export const challengeUpdateSchema = z.object({
  board_uuid: z.string().uuid().nullish(),
  level: z.number().int().min(1).max(12).nullish(),
  difficulty: z.number().int().min(1).max(10).optional(),
  difficulty_score: z.coerce.number().int().optional(),
  board: z.string().length(81).optional(),
  solution: z.string().length(81).optional(),
});

// Strategy schemas
export const strategyCreateSchema = z.object({
  difficulty: z.number().int().min(1),
  stub: z.string().min(1).max(255),
});

export const strategyUpdateSchema = z.object({
  difficulty: z.number().int().min(1).optional(),
  stub: z.string().min(1).max(255).optional(),
});

export const strategyParamSchema = z.object({
  strategy: z.coerce.number().int().min(1),
});

export const strategyStubParamSchema = z.object({
  stub: z.string().min(1).max(255),
});

// Community schemas
export const communityCreateSchema = z.object({
  language_code: z.string().min(2).max(10),
  name: z.string().min(1).max(500),
  name_english: z.string().max(500).nullish(),
  description: z.string().min(1),
  url: z.string().min(1),
  platform: z.string().min(1).max(50),
  sort_order: z.number().int().optional().default(0),
  icon_url: z.string().nullish(),
});

export const communityUpdateSchema = z.object({
  language_code: z.string().min(2).max(10).optional(),
  name: z.string().min(1).max(500).optional(),
  name_english: z.string().max(500).nullish(),
  description: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  platform: z.string().min(1).max(50).optional(),
  sort_order: z.number().int().optional(),
  icon_url: z.string().nullish(),
});

// UUID param schema
export const uuidParamSchema = z.object({
  uuid: z.string().uuid(),
});

export const dateParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// User param schema (Firebase user IDs are typically 28 characters)
export const userIdParamSchema = z.object({
  userId: z.string().min(1).max(128),
});

// Technique example schemas
// Note: primary_technique max value must match the highest TechniqueId in sudojo_types
export const techniqueExampleCreateSchema = z.object({
  board: z.string().length(81),
  pencilmarks: z.string().nullish(),
  solution: z.string().length(81),
  techniques_bitfield: nonEmptyBitmask,
  primary_technique: z.number().int().min(1).max(63),
  hint_data: z.string().nullish(),
  source_board_uuid: z.string().uuid().nullish(),
});

export const techniqueExampleUpdateSchema = z.object({
  board: z.string().length(81).optional(),
  pencilmarks: z.string().nullish(),
  solution: z.string().length(81).optional(),
  techniques_bitfield: nonEmptyBitmask.optional(),
  primary_technique: z.number().int().min(1).max(63).optional(),
  hint_data: z.string().nullish(),
  source_board_uuid: z.string().uuid().nullish(),
});

// Technique practice schemas
export const techniquePracticeCreateSchema = z.object({
  technique: z.number().int().min(1).max(63),
  board: z.string().length(81),
  pencilmarks: z.string().nullish(),
  solution: z.string().length(81),
  hint_data: z.string().nullish(),
  source_example_uuid: z.string().uuid().nullish(),
});

// =============================================================================
// Gamification schemas
// =============================================================================

// Play session schemas
export const gameStartSchema = z.object({
  board: z.string().length(81),
  solution: z.string().length(81),
  level: z.number().int().min(1).max(12),
  techniques: legacyBitmask.optional().default(0n),
  difficultyScore: z.coerce.number().int().optional().default(0),
  puzzleType: z.enum(["daily", "level"]),
  puzzleId: z.string().max(100).optional(),
});

export const gameFinishSchema = z.object({
  elapsedTime: z.number().int().min(0), // seconds from frontend timer
});

// Badge definition schemas (admin)
export const badgeDefinitionCreateSchema = z.object({
  badgeType: z.string().min(1).max(50),
  badgeKey: z.string().min(1).max(100),
  title: z.string().min(1).max(255),
  description: z.string().nullish(),
  iconUrl: z.string().url().max(500).nullish(),
  requirementValue: z.number().int().nullish(),
});

export const badgeDefinitionUpdateSchema = z.object({
  badgeType: z.string().min(1).max(50).optional(),
  title: z.string().min(1).max(255).optional(),
  description: z.string().nullish(),
  iconUrl: z.string().url().max(500).nullish(),
  requirementValue: z.number().int().nullish(),
});

export const badgeKeyParamSchema = z.object({
  badgeKey: z.string().min(1).max(100),
});
