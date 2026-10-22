/**
 * Raw setup SQL in src/db/index.ts vs the Drizzle schema, checked without a
 * database.
 *
 * `postgres` is replaced by a stub tagged-template client that records every
 * statement initDatabase() / initGamificationTables() send and answers them
 * from an in-memory map of column types.
 */
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  statements: [] as string[],
  /** "table.column" -> information_schema data_type */
  columnTypes: new Map<string, string>(),
}));

vi.mock("postgres", () => {
  function client(
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ) {
    if (typeof strings === "string") {
      // sql("name") -- postgres.js identifier helper
      return { identifier: strings };
    }
    const text = strings.reduce((acc, part, i) => {
      if (i === 0) return part;
      const value = values[i - 1];
      const rendered =
        value && typeof value === "object" && "identifier" in value
          ? `"${String(value.identifier)}"`
          : `'${String(value)}'`;
      return acc + rendered + part;
    }, "");
    const statement = text.replace(/\s+/g, " ").trim();
    fake.statements.push(statement);

    const lookup =
      /information_schema\.columns .*table_name = '(\w+)' AND column_name = '(\w+)'/.exec(
        statement
      );
    if (lookup) {
      const dataType = fake.columnTypes.get(`${lookup[1]}.${lookup[2]}`);
      return Promise.resolve(dataType ? [{ data_type: dataType }] : []);
    }
    return Promise.resolve([]);
  }
  client.end = () => Promise.resolve();
  return { default: () => client };
});

const db = await import("../../src/db");
const schema = await import("../../src/db/schema");

const bitfieldColumns = [
  ["boards", "techniques"],
  ["dailies", "techniques"],
  ["technique_examples", "techniques_bitfield"],
] as const;

async function runSetup() {
  await db.initDatabase();
  await db.initGamificationTables();
  return fake.statements;
}

/** The SQL type a column is created with, from CREATE TABLE or ADD COLUMN. */
function declaredType(statements: string[], table: string, column: string) {
  for (const stmt of statements) {
    const create = new RegExp(
      `^CREATE TABLE IF NOT EXISTS ${table} \\((.*)\\)$`
    ).exec(stmt);
    const inCreate = create
      ? new RegExp(`(?:^|, )${column} (\\w+)`).exec(create[1]!)
      : null;
    if (inCreate) return inCreate[1]!.toUpperCase();

    const added = new RegExp(
      `^ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} (\\w+)`
    ).exec(stmt);
    if (added) return added[1]!.toUpperCase();
  }
  return undefined;
}

describe("database setup SQL", () => {
  beforeEach(() => {
    // Required by getClient(). The postgres module is stubbed, so nothing
    // connects; the value only has to be non-empty.
    vi.stubEnv("DATABASE_URL", "postgres://stub@localhost:5432/unused");
    vi.spyOn(console, "log").mockImplementation(() => {});
    fake.statements.length = 0;
    fake.columnTypes.clear();
  });

  afterEach(async () => {
    await db.closeDatabase();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates every Drizzle bigint column as BIGINT", async () => {
    const statements = await runSetup();
    const tables = (Object.values(schema) as unknown[]).filter(
      (value): value is PgTable => is(value, PgTable)
    );
    expect(tables.length).toBeGreaterThan(0);

    const mismatches: string[] = [];
    for (const table of tables) {
      const { name, columns } = getTableConfig(table);
      for (const column of columns) {
        if (column.getSQLType() !== "bigint") continue;
        const type = declaredType(statements, name, column.name);
        if (type !== "BIGINT") {
          mismatches.push(`${name}.${column.name}: ${type ?? "not created"}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("maps technique bitmask columns to the bit(128) custom type, other bigints to number", () => {
    const columnType = (table: PgTable, name: string) =>
      getTableConfig(table).columns.find(c => c.name === name)?.columnType;
    const sqlType = (table: PgTable, name: string) =>
      getTableConfig(table).columns.find(c => c.name === name)?.getSQLType();
    // The techniqueBitmask custom type: bit(128), carried as a JS bigint.
    for (const [table, name] of [
      [schema.boards, "techniques"],
      [schema.dailies, "techniques"],
      [schema.techniqueExamples, "techniques_bitfield"],
      [schema.gameSessions, "techniques"],
    ] as const) {
      expect(columnType(table, name)).toBe("PgCustomColumn");
      expect(sqlType(table, name)).toBe("bit(128)");
    }
    // Not a bitmask; stays mode: "number".
    expect(columnType(schema.userStats, "total_points")).toBe("PgBigInt53");
  });

  it("creates technique bitmask columns as bit(128) in raw SQL", async () => {
    const statements = await runSetup();
    for (const [table, column] of bitfieldColumns) {
      const created = statements.find(s =>
        s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)
      );
      expect(created).toContain(`${column} bit(128)`);
    }
    const gs = statements.find(s =>
      s.startsWith("CREATE TABLE IF NOT EXISTS game_sessions (")
    );
    expect(gs).toContain("techniques bit(128)");
  });

  it("widens INTEGER technique bitfields left by the old setup", async () => {
    for (const [table, column] of bitfieldColumns) {
      fake.columnTypes.set(`${table}.${column}`, "integer");
    }
    const statements = await runSetup();
    for (const [table, column] of bitfieldColumns) {
      expect(statements).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE BIGINT`
      );
    }
  });

  it("does not re-widen technique bitfields that are already BIGINT", async () => {
    for (const [table, column] of bitfieldColumns) {
      fake.columnTypes.set(`${table}.${column}`, "bigint");
    }
    const statements = await runSetup();
    // The int->bigint widen is skipped; the bigint->bit(128) convert runs.
    expect(statements.filter(s => /TYPE BIGINT/.test(s))).toEqual([]);
    // The guard still has to look before deciding.
    for (const [table, column] of bitfieldColumns) {
      expect(
        statements.some(
          s =>
            s.includes("information_schema.columns") &&
            s.includes(`table_name = '${table}'`) &&
            s.includes(`column_name = '${column}'`)
        )
      ).toBe(true);
    }
  });

  it("converts BIGINT technique bitfields to bit(128)", async () => {
    for (const [table, column] of bitfieldColumns) {
      fake.columnTypes.set(`${table}.${column}`, "bigint");
    }
    const statements = await runSetup();
    for (const [table, column] of bitfieldColumns) {
      expect(statements).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE bit(128) USING (repeat('0', 64)::bit(64) || "${column}"::bit(64))`
      );
      // The old bigint DEFAULT can't auto-cast, so it is dropped first.
      expect(statements).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT`
      );
    }
    // boards/dailies regain a bit default; the NOT NULL bitfield stays default-less.
    expect(statements).toContain(
      `ALTER TABLE "boards" ALTER COLUMN "techniques" SET DEFAULT (repeat('0', 128))::bit(128)`
    );
    expect(statements).not.toContain(
      `ALTER TABLE "technique_examples" ALTER COLUMN "techniques_bitfield" SET DEFAULT (repeat('0', 128))::bit(128)`
    );
  });

  it("widens the bitfields after their tables exist", async () => {
    for (const [table, column] of bitfieldColumns) {
      fake.columnTypes.set(`${table}.${column}`, "integer");
    }
    const statements = await runSetup();
    for (const [table, column] of bitfieldColumns) {
      const created = statements.findIndex(s =>
        s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)
      );
      const altered = statements.indexOf(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE BIGINT`
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(altered).toBeGreaterThan(created);
    }
  });
});
