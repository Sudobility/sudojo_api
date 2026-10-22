import {
  pgTable,
  uuid,
  integer,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  unique,
  index,
  real,
  customType,
} from "drizzle-orm/pg-core";

/**
 * A technique bitmask column: Postgres `bit(128)`, carried in app code as a JS
 * `bigint`. Bit N (0-127) = technique id N. Replaces the former signed-64-bit
 * `bigint` column, whose 2^63-1 ceiling capped the usable ids at ~62; `bit(128)`
 * lifts that to 127.
 *
 * Stored MSB-first, so technique id N is bit-string position `127 - N` — the
 * same convention as `bitmaskParam()` in src/lib/bitmask.ts, which every SQL
 * predicate goes through. `toDriver` emits the 128-char binary string Postgres
 * coerces into the bit column; `fromDriver` parses it back to a bigint.
 */
export const techniqueBitmask = customType<{
  data: bigint;
  driverData: string;
}>({
  dataType() {
    return "bit(128)";
  },
  toDriver(value: bigint): string {
    return BigInt.asUintN(128, value).toString(2).padStart(128, "0");
  },
  fromDriver(value: string): bigint {
    return value === "" ? 0n : BigInt("0b" + value);
  },
});

export const levels = pgTable("levels", {
  level: integer("level").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  text: text("text"),
  requires_subscription: boolean("requires_subscription").default(false),
  entitlement: varchar("entitlement", { length: 255 }),
  offer_id: varchar("offer_id", { length: 255 }),
  percentage: real("percentage"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const strategies = pgTable("strategies", {
  strategy: integer("strategy").primaryKey().generatedAlwaysAsIdentity(),
  difficulty: integer("difficulty").unique().notNull(),
  stub: varchar("stub", { length: 255 }).unique().notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const techniques = pgTable(
  "techniques",
  {
    technique: integer("technique").primaryKey(),
    level: integer("level").references(() => levels.level, {
      onDelete: "cascade",
    }),
    strategy_id: integer("strategy_id").references(() => strategies.strategy, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 255 }).notNull(),
    path: varchar("path", { length: 255 }),
    dependencies: text("dependencies"),
    text: text("text"),
    percentage: real("percentage"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  table => ({
    pathIdx: index("techniques_path_idx").on(table.path),
  })
);

export const learning = pgTable("learning", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  technique: integer("technique").references(() => techniques.technique, {
    onDelete: "cascade",
  }),
  index: integer("index").notNull(),
  language_code: varchar("language_code", { length: 10 })
    .notNull()
    .default("en"),
  text: text("text"),
  image_url: text("image_url"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const boards = pgTable("boards", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  level: integer("level").references(() => levels.level, {
    onDelete: "set null",
  }),
  symmetrical: boolean("symmetrical").default(false),
  board: varchar("board", { length: 81 }).notNull(),
  solution: varchar("solution", { length: 81 }).notNull(),
  // Technique bitmask, bit N = technique id N, as a Postgres bit(128) carried
  // in app code as a bigint (see techniqueBitmask above). Values exceed 2^53;
  // responses go through toBitmaskFields() (src/lib/bitmask.ts) since
  // JSON.stringify throws on bigint.
  techniques: techniqueBitmask("techniques").default(0n),
  // Sum of every solving step's technique score (ratio scale, Full House = 1);
  // finer-grained companion to `level`. From the solver /validate response.
  difficulty_score: integer("difficulty_score").default(0),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const dailies = pgTable("dailies", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  date: date("date").unique().notNull(),
  board_uuid: uuid("board_uuid").references(() => boards.uuid, {
    onDelete: "set null",
  }),
  level: integer("level").references(() => levels.level, {
    onDelete: "set null",
  }),
  techniques: techniqueBitmask("techniques").default(0n),
  difficulty_score: integer("difficulty_score").default(0),
  board: varchar("board", { length: 81 }).notNull(),
  solution: varchar("solution", { length: 81 }).notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const challenges = pgTable("challenges", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  board_uuid: uuid("board_uuid").references(() => boards.uuid, {
    onDelete: "set null",
  }),
  level: integer("level").references(() => levels.level, {
    onDelete: "set null",
  }),
  difficulty: integer("difficulty").default(1),
  difficulty_score: integer("difficulty_score").default(0),
  board: varchar("board", { length: 81 }).notNull(),
  solution: varchar("solution", { length: 81 }).notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const accessLogs = pgTable("access_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: varchar("user_id", { length: 128 }).notNull(),
  endpoint: varchar("endpoint", { length: 50 }).notNull(),
  access_date: date("access_date").notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

// =============================================================================
// Technique Examples Table (for tutorials)
// =============================================================================

export const techniqueExamples = pgTable("technique_examples", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  /** Board state (current position, not original puzzle) */
  board: varchar("board", { length: 81 }).notNull(),
  /** Pencilmarks at this state (comma-delimited) */
  pencilmarks: text("pencilmarks"),
  /** Solution for reference */
  solution: varchar("solution", { length: 81 }).notNull(),
  /** Bitfield of ALL techniques applicable at this board state */
  techniques_bitfield: techniqueBitmask("techniques_bitfield").notNull(),
  /** Primary technique (the one solver would use first) */
  primary_technique: integer("primary_technique").notNull(),
  /** Hint data (JSON with areas, cells, description) */
  hint_data: text("hint_data"),
  /** Source board UUID (optional, for reference) */
  source_board_uuid: uuid("source_board_uuid").references(() => boards.uuid, {
    onDelete: "set null",
  }),
  created_at: timestamp("created_at").defaultNow(),
});

// =============================================================================
// Technique Practices Table (for practice mode)
// =============================================================================

export const techniquePractices = pgTable("technique_practices", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  /** Reference to the technique this practice is for */
  technique: integer("technique").references(() => techniques.technique, {
    onDelete: "cascade",
  }),
  /** Board state (merged user input into original - looks like fresh puzzle) */
  board: varchar("board", { length: 81 }).notNull(),
  /** Pencilmarks at this state (comma-delimited) */
  pencilmarks: text("pencilmarks"),
  /** Solution for reference */
  solution: varchar("solution", { length: 81 }).notNull(),
  /** Hint data (JSON with areas, cells, description) */
  hint_data: text("hint_data"),
  /** Source example UUID (optional, for reference) */
  source_example_uuid: uuid("source_example_uuid").references(
    () => techniqueExamples.uuid,
    {
      onDelete: "set null",
    }
  ),
  created_at: timestamp("created_at").defaultNow(),
});

// =============================================================================
// Gamification Tables
// =============================================================================

/** User gamification stats - total points, level, games completed */
export const userStats = pgTable("user_stats", {
  userId: varchar("user_id", { length: 128 }).primaryKey(),
  totalPoints: bigint("total_points", { mode: "number" }).notNull().default(0),
  userLevel: integer("user_level").notNull().default(0),
  gamesCompleted: integer("games_completed").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** Badge definitions - flexible badge system with types and requirements */
export const badgeDefinitions = pgTable("badge_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  badgeType: varchar("badge_type", { length: 50 }).notNull(), // 'level_mastery', 'games_played', etc.
  badgeKey: varchar("badge_key", { length: 100 }).unique().notNull(), // 'level_1', 'games_100', etc.
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  iconUrl: varchar("icon_url", { length: 500 }),
  requirementValue: integer("requirement_value"), // e.g., level 5, or 100 games
  createdAt: timestamp("created_at").defaultNow(),
});

/** User earned badges */
export const userBadges = pgTable(
  "user_badges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 128 }).notNull(),
    badgeKey: varchar("badge_key", { length: 100 })
      .notNull()
      .references(() => badgeDefinitions.badgeKey),
    earnedAt: timestamp("earned_at").defaultNow(),
  },
  table => ({
    uniqueUserBadge: unique().on(table.userId, table.badgeKey),
  })
);

/** Active game session - one per user, tracks current game state */
export const gameSessions = pgTable("game_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 128 }).unique().notNull(), // UNIQUE enforces one active session per user
  board: varchar("board", { length: 81 }).notNull(),
  solution: varchar("solution", { length: 81 }).notNull(),
  level: integer("level").notNull(),
  difficultyScore: integer("difficulty_score").notNull().default(0),
  techniques: techniqueBitmask("techniques").default(0n),
  hintUsed: boolean("hint_used").notNull().default(false),
  hintsCount: integer("hints_count").notNull().default(0),
  hintPointsEarned: integer("hint_points_earned").notNull().default(0),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  puzzleType: varchar("puzzle_type", { length: 20 }).notNull(), // 'daily', 'level'
  puzzleId: varchar("puzzle_id", { length: 100 }), // date for daily, uuid for level
});

// =============================================================================
// Communities Table
// =============================================================================

/** Curated Sudoku community/forum, language-specific (different records per language) */
export const communities = pgTable(
  "communities",
  {
    uuid: uuid("uuid").primaryKey().defaultRandom(),
    language_code: varchar("language_code", { length: 10 }).notNull(),
    name: varchar("name", { length: 500 }).notNull(),
    name_english: varchar("name_english", { length: 500 }),
    description: text("description").notNull(),
    url: text("url").notNull(),
    platform: varchar("platform", { length: 50 }).notNull(),
    sort_order: integer("sort_order").default(0),
    icon_url: text("icon_url"),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
  table => ({
    languageIdx: index("communities_language_code_idx").on(table.language_code),
  })
);

/** Point transaction history - audit trail for all point changes */
export const pointTransactions = pgTable("point_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 128 }).notNull(),
  points: integer("points").notNull(),
  transactionType: varchar("transaction_type", { length: 50 }).notNull(), // 'puzzle_complete', 'hint_used'
  metadata: jsonb("metadata"), // {level, puzzle_type, multipliers, etc.}
  createdAt: timestamp("created_at").defaultNow(),
});
