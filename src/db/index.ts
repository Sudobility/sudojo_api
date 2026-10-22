/**
 * @fileoverview Database initialization and connection management
 *
 * Uses PostgreSQL via postgres.js driver with Drizzle ORM.
 * Database initialization uses raw SQL CREATE TABLE IF NOT EXISTS statements
 * for idempotent table creation and ALTER TABLE for migrations.
 *
 * Schema versioning strategy:
 * - Tables are created with CREATE TABLE IF NOT EXISTS (idempotent)
 * - Column additions use ALTER TABLE ADD COLUMN IF NOT EXISTS (idempotent)
 * - No rollback mechanism - migrations are forward-only
 * - Table creation order respects foreign key dependencies:
 *   levels -> techniques -> learning, boards -> dailies/challenges,
 *   badge_definitions -> user_badges, technique_examples -> technique_practices
 *
 * @see schema.ts for Drizzle ORM schema definitions (kept in sync with raw SQL)
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getRequiredEnv } from "../lib/env-helper";

// Lazy initialization to allow test env to be applied first
let _client: ReturnType<typeof postgres> | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

/**
 * Get the raw postgres.js client (lazily initialized).
 * Connection string is read from DATABASE_URL environment variable.
 */
function getClient() {
  if (!_client) {
    const connectionString = getRequiredEnv("DATABASE_URL");
    _client = postgres(connectionString);
  }
  return _client;
}

/**
 * Get the Drizzle ORM database instance (lazily initialized).
 * Prefer this over the `db` proxy for new code.
 */
export function getDb() {
  if (!_db) {
    _db = drizzle(getClient(), { schema });
  }
  return _db;
}

/**
 * Proxy-based database accessor for backwards compatibility.
 * Delegates all property access to the lazily-initialized Drizzle instance.
 * Prefer `getDb()` for explicit initialization control in tests.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Idempotent migration: ALTER a column to BIGINT only while it is still
 * INTEGER. The type change rewrites the table under an ACCESS EXCLUSIVE lock,
 * so it is skipped entirely once the column has been widened.
 */
async function widenColumnToBigint(
  client: ReturnType<typeof postgres>,
  table: string,
  column: string
) {
  const [info] = await client<{ data_type: string }[]>`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
  `;
  if (info?.data_type === "integer") {
    await client`ALTER TABLE ${client(table)} ALTER COLUMN ${client(column)} TYPE BIGINT`;
  }
}

/**
 * Idempotent migration: convert a technique-bitmask column from BIGINT to
 * bit(128) so technique ids can exceed 62 (a signed BIGINT caps the usable
 * mask at 2^63-1). Runs only while the column is still BIGINT, so it is a
 * no-op once converted (and on a fresh DB where CREATE already made it bit).
 *
 * The three steps are required in order: the existing `DEFAULT 0` (a bigint)
 * cannot be auto-cast to bit during ALTER TYPE, so it is dropped first and a
 * bit default restored after. The USING clause zero-extends the signed 64-bit
 * value on the left (`zeros(64) || value::bit(64)`), which matches the
 * MSB-first, id-N-at-position-(127-N) convention in src/lib/bitmask.ts. All
 * current values are non-negative and < 2^63, so the top bits are zero and the
 * reinterpretation is exact. Verified empirically against Postgres.
 */
async function convertColumnToBit128(
  client: ReturnType<typeof postgres>,
  table: string,
  column: string,
  options: { setDefault: boolean }
) {
  const [info] = await client<{ data_type: string }[]>`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
  `;
  if (info?.data_type !== "bigint") return;
  await client`ALTER TABLE ${client(table)} ALTER COLUMN ${client(column)} DROP DEFAULT`;
  await client`ALTER TABLE ${client(table)} ALTER COLUMN ${client(column)} TYPE bit(128) USING (repeat('0', 64)::bit(64) || ${client(column)}::bit(64))`;
  if (options.setDefault) {
    await client`ALTER TABLE ${client(table)} ALTER COLUMN ${client(column)} SET DEFAULT (repeat('0', 128))::bit(128)`;
  }
}

/**
 * Initialize core database tables using raw SQL.
 *
 * Creates tables in dependency order:
 * 1. levels (no dependencies)
 * 2. techniques (references levels)
 * 3. learning (references techniques)
 * 4. boards (references levels)
 * 5. dailies (references boards, levels)
 * 6. challenges (references boards, levels)
 * 7. access_logs (no dependencies)
 * 8. technique_examples (references boards)
 * 9. technique_practices (references techniques, technique_examples)
 *
 * All statements are idempotent (IF NOT EXISTS).
 * Column migrations use ALTER TABLE ADD COLUMN IF NOT EXISTS.
 *
 * @throws Error if DATABASE_URL is not set or database is unreachable
 */
export async function initDatabase() {
  const client = getClient();
  // Create tables if they don't exist
  await client`
    CREATE TABLE IF NOT EXISTS levels (
      level INTEGER PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      text TEXT,
      requires_subscription BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Strategies table (must be created before techniques FK migration)
  await client`
    CREATE TABLE IF NOT EXISTS strategies (
      strategy SERIAL PRIMARY KEY,
      difficulty INTEGER UNIQUE NOT NULL,
      stub VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS techniques (
      technique INTEGER PRIMARY KEY,
      level INTEGER REFERENCES levels(level) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      path VARCHAR(255),
      dependencies TEXT,
      text TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migration: add columns that may be missing from older schema
  await client`
    ALTER TABLE techniques ADD COLUMN IF NOT EXISTS path VARCHAR(255)
  `;
  await client`
    ALTER TABLE techniques ADD COLUMN IF NOT EXISTS dependencies TEXT
  `;

  await client`
    CREATE INDEX IF NOT EXISTS techniques_path_idx ON techniques(path)
  `;

  // Migration: add entitlement column to levels for tiered access control
  await client`
    ALTER TABLE levels ADD COLUMN IF NOT EXISTS entitlement VARCHAR(255)
  `;
  // Seed entitlement values for existing levels (idempotent: only updates null rows)
  await client`
    UPDATE levels SET entitlement = 'blue_belt,red_belt' WHERE level >= 8 AND level <= 10 AND entitlement IS NULL
  `;
  await client`
    UPDATE levels SET entitlement = 'red_belt' WHERE level >= 11 AND level <= 12 AND entitlement IS NULL
  `;

  // Migration: add offer_id column to levels for linking to RevenueCat offerings
  await client`
    ALTER TABLE levels ADD COLUMN IF NOT EXISTS offer_id VARCHAR(255)
  `;
  // Seed offer_id values for existing levels (idempotent: only updates null rows)
  await client`
    UPDATE levels SET offer_id = '1_blue_belt' WHERE level >= 8 AND level <= 10 AND offer_id IS NULL
  `;
  await client`
    UPDATE levels SET offer_id = '8_red_belt' WHERE level >= 11 AND level <= 12 AND offer_id IS NULL
  `;

  // Migration: add percentage column to levels for pre-computed board stats (ratio 0-1)
  await client`
    ALTER TABLE levels ADD COLUMN IF NOT EXISTS percentage REAL
  `;
  // Migration: convert percentage from INTEGER to REAL if needed
  await client`
    ALTER TABLE levels ALTER COLUMN percentage TYPE REAL
  `;

  // Migration: add percentage column to techniques for pre-computed board stats (ratio 0-1)
  await client`
    ALTER TABLE techniques ADD COLUMN IF NOT EXISTS percentage REAL
  `;
  // Migration: convert percentage from INTEGER to REAL if needed
  await client`
    ALTER TABLE techniques ALTER COLUMN percentage TYPE REAL
  `;

  // Migration: add strategy_id FK column to techniques
  await client`
    ALTER TABLE techniques ADD COLUMN IF NOT EXISTS strategy_id INTEGER REFERENCES strategies(strategy) ON DELETE SET NULL
  `;

  // Seed strategies (idempotent)
  await client`
    INSERT INTO strategies (difficulty, stub) VALUES
      (1, 'naked-subsets'),
      (2, 'hidden-subsets'),
      (3, 'locked-candidates'),
      (4, 'basic-fish'),
      (5, 'finned-sashimi-fish'),
      (6, 'franken-fish'),
      (7, 'single-digit-patterns'),
      (8, 'wings'),
      (9, 'unique-rectangles'),
      (10, 'coloring'),
      (11, 'remote-pairs'),
      (12, 'almost-locked-sets'),
      (13, 'bug-plus-one'),
      (14, 'firework'),
      (15, 'single-digit-chains'),
      (16, 'multi-digit-chains'),
      (17, 'forcing')
    ON CONFLICT (stub) DO NOTHING
  `;

  // Seed technique → strategy mappings (idempotent: only updates null rows)
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'naked-subsets') WHERE technique IN (3, 5, 8, 10) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'hidden-subsets') WHERE technique IN (1, 2, 4, 7, 9) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'locked-candidates') WHERE technique IN (6) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'basic-fish') WHERE technique IN (11, 12, 13, 16) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'finned-sashimi-fish') WHERE technique IN (15, 17, 18, 22, 51, 52, 53) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'franken-fish') WHERE technique IN (57, 58, 59) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'single-digit-patterns') WHERE technique IN (24, 25, 26, 38) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'wings') WHERE technique IN (14, 19, 20, 28, 44, 45, 46, 47) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'unique-rectangles') WHERE technique IN (30, 31, 39, 40, 41, 50, 54) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'coloring') WHERE technique IN (27, 37) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'remote-pairs') WHERE technique IN (29) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'almost-locked-sets') WHERE technique IN (21, 23, 33, 34, 56) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'bug-plus-one') WHERE technique IN (32) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'firework') WHERE technique IN (55) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'single-digit-chains') WHERE technique IN (35, 42, 60) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'multi-digit-chains') WHERE technique IN (43, 48) AND strategy_id IS NULL`;
  await client`UPDATE techniques SET strategy_id = (SELECT strategy FROM strategies WHERE stub = 'forcing') WHERE technique IN (36, 49) AND strategy_id IS NULL`;

  await client`
    CREATE TABLE IF NOT EXISTS learning (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      technique INTEGER REFERENCES techniques(technique) ON DELETE CASCADE,
      index INTEGER NOT NULL,
      language_code VARCHAR(10) NOT NULL DEFAULT 'en',
      text TEXT,
      image_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS boards (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      level INTEGER REFERENCES levels(level) ON DELETE SET NULL,
      symmetrical BOOLEAN DEFAULT false,
      board VARCHAR(81) NOT NULL,
      solution VARCHAR(81) NOT NULL,
      techniques bit(128) DEFAULT (repeat('0', 128))::bit(128),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS dailies (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date DATE UNIQUE NOT NULL,
      board_uuid UUID REFERENCES boards(uuid) ON DELETE SET NULL,
      level INTEGER REFERENCES levels(level) ON DELETE SET NULL,
      techniques bit(128) DEFAULT (repeat('0', 128))::bit(128),
      board VARCHAR(81) NOT NULL,
      solution VARCHAR(81) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS challenges (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_uuid UUID REFERENCES boards(uuid) ON DELETE SET NULL,
      level INTEGER REFERENCES levels(level) ON DELETE SET NULL,
      difficulty INTEGER DEFAULT 1,
      board VARCHAR(81) NOT NULL,
      solution VARCHAR(81) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migration: add difficulty_score (sum of per-step technique scores from the
  // solver /validate response) to puzzle tables. Additive; defaults to 0.
  //
  // Must run AFTER boards/dailies/challenges are created above. It previously
  // ran ~60 lines earlier, which worked only because every existing database
  // already had those tables -- on a fresh one, initDatabase died here with
  // `relation "boards" does not exist`, so a new test database could never be
  // bootstrapped.
  await client`ALTER TABLE boards ADD COLUMN IF NOT EXISTS difficulty_score INTEGER DEFAULT 0`;
  await client`ALTER TABLE dailies ADD COLUMN IF NOT EXISTS difficulty_score INTEGER DEFAULT 0`;
  await client`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS difficulty_score INTEGER DEFAULT 0`;

  await client`
    CREATE TABLE IF NOT EXISTS access_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      access_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS technique_examples (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board VARCHAR(81) NOT NULL,
      pencilmarks TEXT,
      solution VARCHAR(81) NOT NULL,
      techniques_bitfield bit(128) NOT NULL,
      primary_technique INTEGER NOT NULL,
      hint_data TEXT,
      source_board_uuid UUID REFERENCES boards(uuid) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migration: widen technique bitfields from INTEGER to BIGINT.
  //
  // Bits are 1 << techniqueId for ids 1-60, and the Drizzle schema declares
  // these columns bigint, but this setup used to create them as INTEGER, so a
  // database bootstrapped from it could not store technique bits >= 31. Must
  // run after boards, dailies and technique_examples are created above.
  await widenColumnToBigint(client, "boards", "techniques");
  await widenColumnToBigint(client, "dailies", "techniques");
  await widenColumnToBigint(
    client,
    "technique_examples",
    "techniques_bitfield"
  );

  // Migration: widen technique bitmasks from BIGINT to bit(128) so technique
  // ids can exceed 62. Chains after the int->bigint widen above; no-op once a
  // column is already bit(128). technique_examples.techniques_bitfield is NOT
  // NULL with no default, so it keeps no default.
  await convertColumnToBit128(client, "boards", "techniques", {
    setDefault: true,
  });
  await convertColumnToBit128(client, "dailies", "techniques", {
    setDefault: true,
  });
  await convertColumnToBit128(
    client,
    "technique_examples",
    "techniques_bitfield",
    {
      setDefault: false,
    }
  );

  await client`
    CREATE TABLE IF NOT EXISTS technique_practices (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      technique INTEGER REFERENCES techniques(technique) ON DELETE CASCADE,
      board VARCHAR(81) NOT NULL,
      pencilmarks TEXT,
      solution VARCHAR(81) NOT NULL,
      hint_data TEXT,
      source_example_uuid UUID REFERENCES technique_examples(uuid) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE TABLE IF NOT EXISTS communities (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      language_code VARCHAR(10) NOT NULL,
      name VARCHAR(500) NOT NULL,
      name_english VARCHAR(500),
      description TEXT NOT NULL,
      url TEXT NOT NULL,
      platform VARCHAR(50) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await client`
    CREATE INDEX IF NOT EXISTS communities_language_code_idx ON communities(language_code)
  `;

  // Migration: add icon_url column to communities
  await client`
    ALTER TABLE communities ADD COLUMN IF NOT EXISTS icon_url TEXT
  `;

  console.log("Database tables initialized");
}

/**
 * Close the database connection and reset cached instances.
 * Should be called during graceful shutdown or after test runs.
 */
export async function closeDatabase() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

/**
 * Initialize gamification-related database tables.
 *
 * Creates tables in dependency order:
 * 1. user_stats (user points, level, games completed)
 * 2. badge_definitions (badge types and requirements)
 * 3. user_badges (earned badges, references badge_definitions)
 * 4. game_sessions (active game state, one per user)
 * 5. point_transactions (audit trail for all point changes)
 *
 * Also creates performance indexes on user_badges, point_transactions.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * @throws Error if database connection fails
 */
export async function initGamificationTables() {
  const client = getClient();

  // User stats table
  await client`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id VARCHAR(128) PRIMARY KEY,
      total_points BIGINT NOT NULL DEFAULT 0,
      user_level INTEGER NOT NULL DEFAULT 0,
      games_completed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Migration: add status column to user_stats for account deletion
  await client`
    ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
  `;

  // Badge definitions table
  await client`
    CREATE TABLE IF NOT EXISTS badge_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      badge_type VARCHAR(50) NOT NULL,
      badge_key VARCHAR(100) UNIQUE NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      icon_url VARCHAR(500),
      requirement_value INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // User badges table
  await client`
    CREATE TABLE IF NOT EXISTS user_badges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) NOT NULL,
      badge_key VARCHAR(100) NOT NULL REFERENCES badge_definitions(badge_key),
      earned_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, badge_key)
    )
  `;

  // Game sessions table (one active session per user)
  await client`
    CREATE TABLE IF NOT EXISTS game_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) UNIQUE NOT NULL,
      board VARCHAR(81) NOT NULL,
      solution VARCHAR(81) NOT NULL,
      level INTEGER NOT NULL,
      techniques bit(128) DEFAULT (repeat('0', 128))::bit(128),
      hint_used BOOLEAN NOT NULL DEFAULT FALSE,
      hints_count INTEGER NOT NULL DEFAULT 0,
      hint_points_earned INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      puzzle_type VARCHAR(20) NOT NULL,
      puzzle_id VARCHAR(100)
    )
  `;

  // Migration: add difficulty_score snapshot to active game sessions
  await client`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS difficulty_score INTEGER NOT NULL DEFAULT 0`;

  // Migration: widen game_sessions.techniques from BIGINT to bit(128) (see
  // convertColumnToBit128). No-op once converted / on a fresh bit(128) create.
  await convertColumnToBit128(client, "game_sessions", "techniques", {
    setDefault: true,
  });

  // Point transactions table (audit trail)
  await client`
    CREATE TABLE IF NOT EXISTS point_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(128) NOT NULL,
      points INTEGER NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Create indexes for better query performance
  await client`
    CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id)
  `;

  await client`
    CREATE INDEX IF NOT EXISTS idx_point_transactions_user_id ON point_transactions(user_id)
  `;

  await client`
    CREATE INDEX IF NOT EXISTS idx_point_transactions_created_at ON point_transactions(created_at)
  `;

  console.log("Gamification tables initialized");
}

// Re-export schema for convenience
export * from "./schema";
