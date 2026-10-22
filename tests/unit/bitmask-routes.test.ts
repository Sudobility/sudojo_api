/**
 * Technique bitmasks through the real route handlers, without a database.
 *
 * - No BigInt may reach a response: Hono's c.json uses JSON.stringify, which
 *   throws on BigInt. Every endpoint that returns a bitmask column is hit here.
 * - Every bitmask field keeps its numeric form (old app builds read it) and
 *   gains an exact `<field>_bitmask` decimal string.
 * - A value with bit 60 and bit 1 set survives parse -> store -> response.
 *
 * The database is tests/unit/fake-postgres.ts behind a real Drizzle instance;
 * the solver is a stubbed fetch behind the real solver-proxy.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgres as pg } from "./fake-postgres";

vi.hoisted(() => {
  // solver-proxy reads SOLVER_URL at import time. fetch is stubbed below.
  process.env.SOLVER_URL = "http://solver.invalid";
});

vi.mock("../../src/db", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/db")>();
  const { fakePostgres } = await import("./fake-postgres");
  return { ...actual, db: fakePostgres.db };
});

// The real middlewares import services/firebase, which needs credentials at
// import time. Admin and user checks are covered elsewhere; here they pass.
vi.mock("../../src/middleware/auth", () => ({
  adminMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../../src/middleware/firebaseAuth", () => ({
  firebaseAuthMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set("userId", "user-1");
    await next();
  },
}));
vi.mock("../../src/middleware/optionalAuth", () => ({
  optionalAuthMiddleware: async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const { default: boardsRouter } = await import("../../src/routes/boards");
const { default: dailiesRouter } = await import("../../src/routes/dailies");
const { default: examplesRouter } = await import("../../src/routes/examples");
const { default: solverRouter } = await import("../../src/routes/solver");
const { default: playRouter } = await import("../../src/routes/play");

const app = new Hono();
app.route("/boards", boardsRouter);
app.route("/dailies", dailiesRouter);
app.route("/examples", examplesRouter);
app.route("/solver", solverRouter);
app.route("/play", playRouter);
// Surface a BigInt serialization failure as the thrown TypeError instead of
// Hono's generic 500 page.
app.onError(err => {
  throw err;
});

/** Bit 60 (Grouped X-Cycles) + bit 1 (Full House). */
const HIGH = (1n << 60n) | (1n << 1n);
const HIGH_STRING = "1152921504606846978";
const HIGH_NUMBER = Number(HIGH); // what old clients have always received
/** The bit(128) wire form postgres.js returns / Drizzle binds for the mask. */
const HIGH_BITS = HIGH.toString(2).padStart(128, "0");
const ZERO_BITS = "0".repeat(128);

const BOARD_UUID = "11111111-1111-4111-8111-111111111111";
const DAILY_UUID = "22222222-2222-4222-8222-222222222222";
const EXAMPLE_UUID = "33333333-3333-4333-8333-333333333333";
const PUZZLE = "0".repeat(81);
const SOLUTION = "1".repeat(81);

function seedAll() {
  pg.seed("boards", [
    {
      uuid: BOARD_UUID,
      level: 4,
      symmetrical: false,
      board: PUZZLE,
      solution: SOLUTION,
      techniques: HIGH_BITS,
      difficulty_score: 7,
      created_at: null,
      updated_at: null,
    },
  ]);
  pg.seed("dailies", [
    {
      uuid: DAILY_UUID,
      date: "2026-09-10",
      board_uuid: BOARD_UUID,
      level: 4,
      techniques: HIGH_BITS,
      difficulty_score: 7,
      board: PUZZLE,
      solution: SOLUTION,
      created_at: null,
      updated_at: null,
    },
  ]);
  pg.seed("technique_examples", [
    {
      uuid: EXAMPLE_UUID,
      board: PUZZLE,
      pencilmarks: null,
      solution: SOLUTION,
      techniques_bitfield: HIGH_BITS,
      primary_technique: 60,
      hint_data: null,
      source_board_uuid: BOARD_UUID,
      created_at: null,
    },
  ]);
  pg.seed("levels", [{ level: 4, title: "Four" }]);
}

async function call(path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: non-JSON ${res.status} response: ${text}`);
  }
  return { status: res.status, body };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Every `techniques` / `techniques_bitfield` in `value`, with its parent. */
function bitmaskFields(value: unknown, out: [string, any][] = []) {
  if (Array.isArray(value)) {
    value.forEach(v => bitmaskFields(v, out));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "techniques" || key === "techniques_bitfield") {
        out.push([key, value]);
      } else {
        bitmaskFields(v, out);
      }
    }
  }
  return out;
}

function expectBitmaskPairs(body: unknown, expected: string) {
  const fields = bitmaskFields(body);
  expect(fields.length).toBeGreaterThan(0);
  for (const [key, parent] of fields) {
    expect(parent[`${key}_bitmask`]).toBe(expected);
    expect(parent[key]).toBe(Number(BigInt(expected)));
  }
}

function solverJson(board: Record<string, unknown>) {
  // Raw JSON text, so `techniques` is rounded by JSON.parse exactly as it is
  // in production.
  const { techniques, ...rest } = board;
  const fields = JSON.stringify(rest).slice(1, -1);
  return `{"success":true,"error":null,"data":{"board":{"techniques":${techniques},${fields}}}}`;
}

function stubSolver(text: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  pg.reset();
  seedAll();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("no BigInt reaches a response; every bitmask gets a _bitmask string", () => {
  it.each([
    "/boards",
    "/boards?level=4&technique_bit=4",
    "/boards/random",
    `/boards/${BOARD_UUID}`,
    "/dailies",
    "/dailies/today",
    "/dailies/date/2026-09-10",
    `/dailies/${DAILY_UUID}`,
    "/examples",
    "/examples?technique=60",
    "/examples?has_technique=60",
    "/examples/random",
    `/examples/${EXAMPLE_UUID}`,
  ])("GET %s", async path => {
    const { status, body } = await call(path);
    expect(status).toBe(200);
    expectBitmaskPairs(body.data, HIGH_STRING);
  });

  it("GET /dailies/today fallback (no daily stored)", async () => {
    pg.seed("dailies", []);
    const { status, body } = await call("/dailies/today");
    expect(status).toBe(200);
    expect(body.data.uuid).toMatch(/^fallback-/);
    expectBitmaskPairs(body.data, HIGH_STRING);
  });

  it.each([
    ["POST", "/boards", { board: PUZZLE, solution: SOLUTION }],
    ["PUT", `/boards/${BOARD_UUID}`, { level: 5 }],
    ["DELETE", `/boards/${BOARD_UUID}`, undefined],
    [
      "POST",
      "/dailies",
      { date: "2026-09-11", board: PUZZLE, solution: SOLUTION },
    ],
    ["PUT", `/dailies/${DAILY_UUID}`, { level: 5 }],
    ["DELETE", `/dailies/${DAILY_UUID}`, undefined],
    [
      "POST",
      "/examples",
      {
        board: PUZZLE,
        solution: SOLUTION,
        techniques_bitfield: 2,
        primary_technique: 1,
      },
    ],
    ["PUT", `/examples/${EXAMPLE_UUID}`, { primary_technique: 2 }],
    ["DELETE", `/examples/${EXAMPLE_UUID}`, undefined],
  ] as const)("%s %s", async (method, path, body) => {
    const res = await call(
      path,
      body === undefined ? { method } : json(method, body)
    );
    expect(res.status).toBeLessThan(300);
    const fields = bitmaskFields(res.body.data);
    expect(fields.length).toBeGreaterThan(0);
    for (const [key, parent] of fields) {
      expect(typeof parent[`${key}_bitmask`]).toBe("string");
      expect(parent[key]).toBe(Number(BigInt(parent[`${key}_bitmask`])));
    }
  });
});

describe("round trip of bit 60 + bit 1", () => {
  it("POST /boards: string in -> bigint bound -> exact string out", async () => {
    pg.seed("boards", []);
    const { status, body } = await call(
      "/boards",
      json("POST", {
        board: PUZZLE,
        solution: SOLUTION,
        techniques: HIGH_STRING,
      })
    );
    expect(status).toBe(201);

    const insert = pg.executed.find(e => /^insert into "boards"/.test(e.query));
    // Bound through the bit(128) custom type: the bigint becomes its 128-char
    // binary wire form, which is what the column stores.
    expect(insert?.params).toContainEqual(HIGH_BITS);
    expect(pg.tables.get("boards")?.[0]?.techniques).toBe(HIGH_BITS);

    expect(body.data.techniques_bitmask).toBe(HIGH_STRING);
    expect(body.data.techniques).toBe(HIGH_NUMBER);

    // ...and read back.
    const read = await call(`/boards/${body.data.uuid}`);
    expect(read.body.data.techniques_bitmask).toBe(HIGH_STRING);
  });

  it("PUT /boards/:uuid", async () => {
    pg.seed("boards", [{ ...pg.tables.get("boards")![0], techniques: "0" }]);
    const { body } = await call(
      `/boards/${BOARD_UUID}`,
      json("PUT", { techniques: HIGH_STRING })
    );
    expect(body.data.techniques_bitmask).toBe(HIGH_STRING);
  });

  it("POST /dailies", async () => {
    const { status, body } = await call(
      "/dailies",
      json("POST", {
        date: "2026-09-11",
        board: PUZZLE,
        solution: SOLUTION,
        techniques: HIGH_STRING,
      })
    );
    expect(status).toBe(201);
    expect(body.data.techniques_bitmask).toBe(HIGH_STRING);
  });

  it("POST /examples", async () => {
    const { status, body } = await call(
      "/examples",
      json("POST", {
        board: PUZZLE,
        solution: SOLUTION,
        techniques_bitfield: HIGH_STRING,
        primary_technique: 60,
      })
    );
    expect(status).toBe(201);
    expect(body.data.techniques_bitfield_bitmask).toBe(HIGH_STRING);
    expect(body.data.techniques_bitfield).toBe(HIGH_NUMBER);
  });

  it("POST /play/start stores the exact mask as bit(128)", async () => {
    const { status } = await call(
      "/play/start",
      json("POST", {
        board: PUZZLE,
        solution: SOLUTION,
        level: 4,
        techniques: HIGH_STRING,
        puzzleType: "level",
      })
    );
    expect(status).toBe(201);
    const insert = pg.executed.find(e =>
      /^insert into "game_sessions"/.test(e.query)
    );
    expect(insert?.params).toContainEqual(HIGH_BITS);
    expect(pg.tables.get("game_sessions")?.[0]?.techniques).toBe(HIGH_BITS);
  });
});

describe("bitmask input validation", () => {
  it.each([
    ["negative", "-1"],
    ["fractional", 1.5],
    ["non-numeric", "abc"],
  ])("POST /boards rejects a %s techniques value", async (_label, value) => {
    const { status, body } = await call(
      "/boards",
      json("POST", { board: PUZZLE, solution: SOLUTION, techniques: value })
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("POST /examples rejects techniques_bitfield 0", async () => {
    const { status } = await call(
      "/examples",
      json("POST", {
        board: PUZZLE,
        solution: SOLUTION,
        techniques_bitfield: "0",
        primary_technique: 1,
      })
    );
    expect(status).toBe(400);
  });

  it("POST /play/start rejects a negative techniques value", async () => {
    const { status } = await call(
      "/play/start",
      json("POST", {
        board: PUZZLE,
        solution: SOLUTION,
        level: 4,
        techniques: -2,
        puzzleType: "level",
      })
    );
    expect(status).toBe(400);
  });
});

describe("solver validate/generate pass-through", () => {
  const board = {
    techniques: HIGH_STRING, // emitted as a bare JSON number
    techniques_bitmask: HIGH_STRING,
    level: 12,
    difficulty_score: 40,
    original: PUZZLE,
    solution: SOLUTION,
  };

  it.each(["validate", "generate"])(
    "/solver/%s prefers the solver's techniques_bitmask",
    async endpoint => {
      stubSolver(solverJson(board));
      const query = endpoint === "validate" ? `?original=${PUZZLE}` : "";
      const { status, body } = await call(`/solver/${endpoint}${query}`);
      expect(status).toBe(200);
      expect(body.data.board.techniques_bitmask).toBe(HIGH_STRING);
      expect(body.data.board.techniques).toBe(HIGH_NUMBER);
      // The level is DERIVED from the bitmask by src/lib/levels.ts, not passed
      // through from the solver: this mask is bit 60 (Grouped X-Cycles, L11)
      // plus bit 1 (Full House, L1), so the level is 11 even though the stub
      // solver reported 12.
      expect(body.data.board.level).toBe(11);
    }
  );

  it("falls back to the numeric techniques from an older solver", async () => {
    const { techniques_bitmask: _omit, ...old } = board;
    stubSolver(solverJson({ ...old, techniques: 42 }));
    const { status, body } = await call(`/solver/validate?original=${PUZZLE}`);
    expect(status).toBe(200);
    expect(body.data.board.techniques_bitmask).toBe("42");
    expect(body.data.board.techniques).toBe(42);
  });

  it("passes the solver's integer error code through", async () => {
    stubSolver(
      '{"success":false,"error":{"code":2,"message":"Cannot solve this Sudoku puzzle"},"data":null}'
    );
    const { status, body } = await call(`/solver/validate?original=${PUZZLE}`);
    expect(status).toBe(400);
    expect(body.error).toBe("2: Cannot solve this Sudoku puzzle");
  });
});
