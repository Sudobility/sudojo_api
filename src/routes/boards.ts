/**
 * @fileoverview Board routes for Sudojo API
 *
 * Provides CRUD endpoints for Sudoku puzzle boards.
 * Each board has an 81-char board string, solution, optional level, and techniques bitfield.
 * Public endpoints: GET (list with filters, counts, random, get by UUID)
 * Admin endpoints: POST, PUT, DELETE (require Firebase admin auth)
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import { db, boards, levels, techniques } from "../db";
import {
  boardCreateSchema,
  boardUpdateSchema,
  uuidParamSchema,
} from "../schemas";
import { adminMiddleware } from "../middleware/auth";
import {
  successResponse,
  errorResponse,
  type BoardCountsData,
  type BoardCountsByTechniqueData,
  type UpdateStatsData,
} from "@sudobility/sudojo_types";
import {
  bitmaskParam,
  parseBitmask,
  techniqueBit,
  toBitmaskFields,
  type BoardResponse,
} from "../lib/bitmask";

const boardsRouter = new Hono();

/**
 * GET /api/v1/boards
 *
 * List boards with optional filtering and pagination.
 * When several filters are given, a board must match all of them.
 *
 * @public No authentication required
 * @query level - Filter by difficulty level (integer)
 * @query technique_bit - Filter boards with any of these technique bits set
 *   (bitmask, decimal; 0 is ignored)
 * @query techniques - Filter by exact techniques bitmask (decimal; 0 includes NULL)
 * @query limit - Maximum number of results (positive integer)
 * @query offset - Number of results to skip (non-negative integer)
 * @returns 200 - Array of board objects ordered by created_at desc
 * @returns 400 - technique_bit or techniques is not a non-negative integer
 */
boardsRouter.get("/", async c => {
  const levelParam = c.req.query("level");
  const techniqueBit = c.req.query("technique_bit");
  const techniques = c.req.query("techniques");
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");

  // Collect every filter and AND them. Calling .where() once per filter on the
  // dynamic builder replaces the previous condition, so only the last applied.
  const conditions: SQL[] = [];

  // Filter by level if provided
  if (levelParam) {
    const level = parseInt(levelParam, 10);
    if (!isNaN(level)) {
      conditions.push(eq(boards.level, level));
    }
  }

  // Filter by technique bit if provided (boards that have this technique).
  // Bitmasks are bound as bigint strings; a JS number loses bits above 2^53.
  if (techniqueBit) {
    const bit = parseBitmask(techniqueBit);
    if (bit === null) {
      return c.json(
        errorResponse("Invalid technique_bit: must be a non-negative integer"),
        400
      );
    }
    if (bit > 0n) {
      conditions.push(
        sql`(${boards.techniques} & ${bitmaskParam(bit)}) <> ${bitmaskParam(0n)}`
      );
    }
  }

  // Filter by techniques value (e.g., techniques=0 for boards without techniques)
  if (techniques) {
    const value = parseBitmask(techniques);
    if (value === null) {
      return c.json(
        errorResponse("Invalid techniques: must be a non-negative integer"),
        400
      );
    }
    if (value === 0n) {
      // Include both 0 and NULL. Parenthesized so the OR stays grouped when
      // ANDed with the other filters.
      conditions.push(
        sql`(${boards.techniques} = ${bitmaskParam(0n)} OR ${boards.techniques} IS NULL)`
      );
    } else {
      conditions.push(sql`${boards.techniques} = ${bitmaskParam(value)}`);
    }
  }

  let query = db
    .select()
    .from(boards)
    .where(and(...conditions))
    .$dynamic();

  // Order and limit/offset
  query = query.orderBy(desc(boards.created_at));
  if (offset) {
    const offsetNum = parseInt(offset, 10);
    if (!isNaN(offsetNum) && offsetNum >= 0) {
      query = query.offset(offsetNum);
    }
  }
  if (limit) {
    const limitNum = parseInt(limit, 10);
    if (!isNaN(limitNum) && limitNum > 0) {
      query = query.limit(limitNum);
    }
  }

  const rows = await query;
  const data: BoardResponse[] = rows.map(toBitmaskFields);
  return c.json(successResponse(data));
});

/**
 * GET /api/v1/boards/counts
 *
 * Get total board count and count of boards without techniques.
 *
 * @public No authentication required
 * @returns 200 - { total, withoutTechniques }
 */
boardsRouter.get("/counts", async c => {
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(boards);

  const [zeroTechniquesResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(boards)
    .where(
      sql`${boards.techniques} = ${bitmaskParam(0n)} OR ${boards.techniques} IS NULL`
    );

  const countsData: BoardCountsData = {
    total: totalResult?.count ?? 0,
    withoutTechniques: zeroTechniquesResult?.count ?? 0,
  };
  return c.json(successResponse(countsData));
});

/**
 * GET /api/v1/boards/counts/by-technique
 *
 * Get board counts for each technique bit (1-37).
 * Uses BigInt for bit calculation to support technique IDs >= 32.
 *
 * @public No authentication required
 * @returns 200 - Record<number, number> mapping technique ID to count
 */
boardsRouter.get("/counts/by-technique", async c => {
  const counts: BoardCountsByTechniqueData = {};

  // Query count for each technique bit (1-60)
  // TechniqueId enum goes from 1 (FULL_HOUSE) to 60 (GROUPED_X_CYCLES)
  // Build each single-technique mask as a bit(128) via bitmaskParam, so ids
  // beyond 62 work and the id-N-at-position-(127-N) convention stays in one
  // place. `bit & bit` is a bit, so test for a hit with `<> 0::bit(128)`.
  for (let technique = 1; technique <= 60; technique++) {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .where(
        sql`(${boards.techniques} & ${bitmaskParam(techniqueBit(technique))}) <> ${bitmaskParam(0n)}`
      );
    counts[technique] = result?.count ?? 0;
  }

  return c.json(successResponse(counts));
});

/**
 * GET /api/v1/boards/random
 *
 * Get a random board with optional filtering.
 *
 * @public No authentication required
 * @query level - Filter by difficulty level (integer)
 * @query symmetrical - Filter for symmetrical boards ("true")
 * @returns 200 - Single board object
 * @returns 404 - No boards found matching criteria
 */
boardsRouter.get("/random", async c => {
  const levelParam = c.req.query("level");
  const symmetricalParam = c.req.query("symmetrical");

  const conditions = [];

  if (levelParam) {
    const level = parseInt(levelParam, 10);
    if (!isNaN(level)) {
      conditions.push(eq(boards.level, level));
    }
  }

  if (symmetricalParam === "true") {
    conditions.push(eq(boards.symmetrical, true));
  }

  const rows = await db
    .select()
    .from(boards)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`RANDOM()`)
    .limit(1);

  if (rows.length === 0) {
    return c.json(errorResponse("No boards found"), 404);
  }

  const data: BoardResponse = toBitmaskFields(rows[0]!);
  return c.json(successResponse(data));
});

/**
 * GET /api/v1/boards/:uuid
 *
 * Get a single board by UUID.
 *
 * @public No authentication required
 * @param uuid - Valid UUID string
 * @returns 200 - Board object
 * @returns 404 - Board not found
 */
boardsRouter.get("/:uuid", zValidator("param", uuidParamSchema), async c => {
  const { uuid } = c.req.valid("param");
  const rows = await db.select().from(boards).where(eq(boards.uuid, uuid));

  if (rows.length === 0) {
    return c.json(errorResponse("Board not found"), 404);
  }

  const data: BoardResponse = toBitmaskFields(rows[0]!);
  return c.json(successResponse(data));
});

/**
 * POST /api/v1/boards/update-stats
 *
 * Calculate and update percentage fields on levels and techniques tables.
 * Values are stored as ratios (0-1), e.g. 0.1234 = 12.34%.
 * - Level ratio: boards with this level / total boards
 * - Technique ratio: boards with this technique bit set / total boards
 *
 * @auth Admin (Firebase token + SITEADMIN_EMAILS check)
 * @returns 200 - { levels: Record<number, number>, techniques: Record<number, number> }
 */
boardsRouter.post("/update-stats", adminMiddleware, async c => {
  // Get total board count (only boards with techniques set)
  const [totalResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(boards)
    .where(sql`${boards.techniques} <> ${bitmaskParam(0n)}`);
  const total = totalResult?.count ?? 0;

  if (total === 0) {
    const emptyStats: UpdateStatsData = { levels: {}, techniques: {} };
    return c.json(successResponse(emptyStats));
  }

  // Calculate level ratios
  const levelRows = await db
    .select({
      level: boards.level,
      count: sql<number>`count(*)::int`,
    })
    .from(boards)
    .where(
      sql`${boards.level} IS NOT NULL AND ${boards.techniques} <> ${bitmaskParam(0n)}`
    )
    .groupBy(boards.level);

  const levelRatios: Record<number, number> = {};
  for (const row of levelRows) {
    if (row.level !== null) {
      const ratio = row.count / total;
      levelRatios[row.level] = ratio;

      await db
        .update(levels)
        .set({ percentage: ratio, updated_at: new Date() })
        .where(eq(levels.level, row.level));
    }
  }

  // Calculate technique ratios (techniques 1-60)
  // Use PostgreSQL native bit shift to avoid JavaScript Number precision loss
  // for technique IDs >= 53 (where 2^t exceeds Number.MAX_SAFE_INTEGER)
  const techniqueRatios: Record<number, number> = {};
  for (let t = 1; t <= 60; t++) {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(boards)
      .where(
        sql`(${boards.techniques} & ${bitmaskParam(techniqueBit(t))}) <> ${bitmaskParam(0n)}`
      );
    const count = result?.count ?? 0;
    if (count > 0) {
      const ratio = count / total;
      techniqueRatios[t] = ratio;

      await db
        .update(techniques)
        .set({ percentage: ratio, updated_at: new Date() })
        .where(eq(techniques.technique, t));
    }
  }

  const statsData: UpdateStatsData = {
    levels: levelRatios,
    techniques: techniqueRatios,
  };
  return c.json(successResponse(statsData));
});

/**
 * POST /api/v1/boards
 *
 * Create a new board. Requires admin authentication.
 *
 * @auth Admin (Firebase token + SITEADMIN_EMAILS check)
 * @body boardCreateSchema - { board, solution, level?, symmetrical?, techniques? }
 * @returns 201 - Created board object
 * @returns 401 - Missing or invalid auth token
 * @returns 403 - Not an admin user
 */
boardsRouter.post(
  "/",
  adminMiddleware,
  zValidator("json", boardCreateSchema),
  async c => {
    const body = c.req.valid("json");

    const rows = await db
      .insert(boards)
      .values({
        level: body.level ?? null,
        symmetrical: body.symmetrical,
        board: body.board,
        solution: body.solution,
        techniques: body.techniques,
        difficulty_score: body.difficulty_score,
      })
      .returning();

    const data: BoardResponse = toBitmaskFields(rows[0]!);
    return c.json(successResponse(data), 201);
  }
);

/**
 * PUT /api/v1/boards/:uuid
 *
 * Update an existing board. Requires admin authentication.
 * Only provided fields are updated; omitted fields retain their current values.
 *
 * @auth Admin (Firebase token + SITEADMIN_EMAILS check)
 * @param uuid - Valid UUID string
 * @body boardUpdateSchema - { board?, solution?, level?, symmetrical?, techniques? }
 * @returns 200 - Updated board object
 * @returns 401 - Missing or invalid auth token
 * @returns 403 - Not an admin user
 * @returns 404 - Board not found
 */
boardsRouter.put(
  "/:uuid",
  adminMiddleware,
  zValidator("param", uuidParamSchema),
  zValidator("json", boardUpdateSchema),
  async c => {
    const { uuid } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await db
      .select()
      .from(boards)
      .where(eq(boards.uuid, uuid));
    if (existing.length === 0) {
      return c.json(errorResponse("Board not found"), 404);
    }

    const current = existing[0]!;
    const rows = await db
      .update(boards)
      .set({
        level: body.level !== undefined ? body.level : current.level,
        symmetrical: body.symmetrical ?? current.symmetrical,
        board: body.board ?? current.board,
        solution: body.solution ?? current.solution,
        techniques: body.techniques ?? current.techniques,
        difficulty_score: body.difficulty_score ?? current.difficulty_score,
        updated_at: new Date(),
      })
      .where(eq(boards.uuid, uuid))
      .returning();

    const data: BoardResponse = toBitmaskFields(rows[0]!);
    return c.json(successResponse(data));
  }
);

/**
 * DELETE /api/v1/boards/:uuid
 *
 * Delete a board. Requires admin authentication.
 * Referencing dailies/challenges will have their board_uuid set to NULL.
 *
 * @auth Admin (Firebase token + SITEADMIN_EMAILS check)
 * @param uuid - Valid UUID string
 * @returns 200 - Deleted board object
 * @returns 401 - Missing or invalid auth token
 * @returns 403 - Not an admin user
 * @returns 404 - Board not found
 */
boardsRouter.delete(
  "/:uuid",
  adminMiddleware,
  zValidator("param", uuidParamSchema),
  async c => {
    const { uuid } = c.req.valid("param");

    const rows = await db
      .delete(boards)
      .where(eq(boards.uuid, uuid))
      .returning();

    if (rows.length === 0) {
      return c.json(errorResponse("Board not found"), 404);
    }

    const data: BoardResponse = toBitmaskFields(rows[0]!);
    return c.json(successResponse(data));
  }
);

export default boardsRouter;
