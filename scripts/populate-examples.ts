/**
 * populate-examples.ts
 *
 * Populates the `technique_examples` table by running boards through the solver
 * and capturing example board states for each technique.
 *
 * Strategy:
 * - Process techniques from hardest (rarest) to easiest
 * - For each technique, find boards that use it (have the bit set)
 * - Run /solve repeatedly to capture examples at each step
 * - Stop when we have TARGET_PER_TECHNIQUE examples for each technique
 *
 * Usage: bun run scripts/populate-examples.ts [--dry-run] [--target N]
 */

import { db, boards, techniqueExamples } from "../src/db";
import { eq, sql, and, ne } from "drizzle-orm";
import {
  TechniqueId,
  getTechniqueNameById,
  type SolveData,
  type SolverHintStep,
} from "@sudobility/sudojo_types";
import { bitmaskParam, techniqueBit } from "../src/lib/bitmask";

// Configuration
const SOLVER_URL = process.env.SOLVER_URL || "http://localhost:8080";
const DRY_RUN = process.argv.includes("--dry-run");
const TARGET_ARG = process.argv.indexOf("--target");
const TARGET_PER_TECHNIQUE = TARGET_ARG !== -1 ? parseInt(process.argv[TARGET_ARG + 1], 10) : 20;

// Techniques ordered from hardest (rarest) to easiest (most common)
const TECHNIQUE_ORDER: TechniqueId[] = [
  TechniqueId.ALS_CHAIN,
  TechniqueId.FINNED_SQUIRMBAG,
  TechniqueId.ALMOST_LOCKED_SETS,
  TechniqueId.WXYZ_WING,
  TechniqueId.XYZ_WING,
  TechniqueId.FINNED_JELLYFISH,
  TechniqueId.FINNED_SWORDFISH,
  TechniqueId.SQUIRMBAG,
  TechniqueId.FINNED_X_WING,
  TechniqueId.XY_WING,
  TechniqueId.JELLYFISH,
  TechniqueId.SWORDFISH,
  TechniqueId.X_WING,
  TechniqueId.NAKED_QUAD,
  TechniqueId.HIDDEN_QUAD,
  TechniqueId.NAKED_TRIPLE,
  TechniqueId.HIDDEN_TRIPLE,
  TechniqueId.LOCKED_CANDIDATES,
  TechniqueId.NAKED_PAIR,
  TechniqueId.HIDDEN_PAIR,
  TechniqueId.NAKED_SINGLE,
  TechniqueId.HIDDEN_SINGLE,
  TechniqueId.FULL_HOUSE,
];

interface SolverResponse<T> {
  success: boolean;
  error: { code: string; message: string } | null;
  data: T | null;
}

// Track counts in memory
const exampleCounts: Map<TechniqueId, number> = new Map();

async function initializeCounts(): Promise<void> {
  const rows = await db
    .select({
      primary_technique: techniqueExamples.primary_technique,
      count: sql<number>`count(*)::int`,
    })
    .from(techniqueExamples)
    .groupBy(techniqueExamples.primary_technique);

  for (const row of rows) {
    exampleCounts.set(row.primary_technique as TechniqueId, row.count);
  }

  console.log("Current example counts:");
  for (const technique of TECHNIQUE_ORDER) {
    const count = exampleCounts.get(technique) || 0;
    const name = getTechniqueNameById(technique);
    console.log(`  ${name}: ${count}/${TARGET_PER_TECHNIQUE}${count >= TARGET_PER_TECHNIQUE ? " ✓" : ""}`);
  }
  console.log();
}

function getCount(technique: TechniqueId): number {
  return exampleCounts.get(technique) || 0;
}

function incrementCount(technique: TechniqueId): void {
  exampleCounts.set(technique, getCount(technique) + 1);
}

function allTechniquesFull(): boolean {
  return TECHNIQUE_ORDER.every((t) => getCount(t) >= TARGET_PER_TECHNIQUE);
}

function needsMoreExamples(technique: TechniqueId): boolean {
  return getCount(technique) < TARGET_PER_TECHNIQUE;
}

// Empty pencilmarks string (80 commas = 81 empty entries)
const EMPTY_PENCILMARKS = ",".repeat(80);

async function callSolver(
  original: string,
  user: string,
  pencilmarks?: string
): Promise<SolveData | null> {
  const params = new URLSearchParams({
    original,
    user,
    autopencilmarks: "false",
    pencilmarks: pencilmarks || EMPTY_PENCILMARKS,
  });

  const url = `${SOLVER_URL}/api/solve?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as SolverResponse<SolveData>;
    if (!result.success || !result.data) {
      return null;
    }

    return result.data;
  } catch (error) {
    console.error("Solver fetch error:", error);
    return null;
  }
}

function applyHint(
  user: string,
  solveData: SolveData
): { newUser: string; pencilmarks: string | null } {
  const cells = solveData.hints.steps[0]?.cells || [];
  const userArr = user.split("");

  for (const cell of cells) {
    const idx = cell.row * 9 + cell.column;
    const selectDigit = cell.actions.select;
    if (selectDigit && selectDigit !== "" && selectDigit !== "0") {
      userArr[idx] = selectDigit;
    }
  }

  const pencilmarks = solveData.board.pencilmark?.numbers || null;
  return { newUser: userArr.join(""), pencilmarks };
}

// Combine original puzzle with user input to get current board state
function combineBoard(original: string, user: string): string {
  let result = "";
  for (let i = 0; i < 81; i++) {
    // Use original if it has a clue, otherwise use user input
    result += original[i] !== "0" ? original[i] : user[i];
  }
  return result;
}

// Check if puzzle is solved (no zeros in combined state)
function isSolved(original: string, user: string): boolean {
  for (let i = 0; i < 81; i++) {
    if (original[i] === "0" && user[i] === "0") {
      return false;
    }
  }
  return true;
}

async function saveExample(
  board: string,
  pencilmarks: string | null,
  solution: string,
  techniquesBitfield: bigint,
  primaryTechnique: TechniqueId,
  hintStep: SolverHintStep,
  sourceBoardUuid: string
): Promise<boolean> {
  if (DRY_RUN) {
    return true;
  }

  try {
    await db.insert(techniqueExamples).values({
      board,
      pencilmarks,
      solution,
      techniques_bitfield: techniquesBitfield,
      primary_technique: primaryTechnique,
      hint_data: JSON.stringify(hintStep),
      source_board_uuid: sourceBoardUuid,
    });
    return true;
  } catch (error) {
    console.error("Failed to save example:", error);
    return false;
  }
}

async function processBoard(
  boardRecord: { uuid: string; board: string; solution: string; techniques: bigint | null },
  targetTechniques: Set<TechniqueId>
): Promise<number> {
  const original = boardRecord.board;
  // User input starts as all zeros (empty)
  let user = "0".repeat(81);
  let pencilmarks: string | null = null;
  // bigint: addTechnique()/techniqueToBit() return JS numbers, which drop
  // bits once a technique id >= 54 is set.
  let techniquesBitfield = 0n;
  let examplesAdded = 0;
  let iterations = 0;
  const MAX_ITERATIONS = 200;

  while (!isSolved(original, user) && iterations < MAX_ITERATIONS) {
    iterations++;

    const solveData = await callSolver(original, user, pencilmarks || undefined);
    if (!solveData) {
      break;
    }

    const step = solveData.hints.steps[0];
    if (!step) {
      break;
    }

    // Get current pencilmarks from solver response
    const currentPencilmarks = solveData.board.pencilmark?.numbers || null;

    const techniqueId = solveData.hints.technique > 0
      ? (solveData.hints.technique as TechniqueId)
      : undefined;
    if (!techniqueId) {
      console.warn(`Unknown technique: ${step.title}`);
    } else {
      techniquesBitfield |= techniqueBit(techniqueId);

      // Check if we need more examples for this technique
      if (targetTechniques.has(techniqueId) && needsMoreExamples(techniqueId)) {
        // Save the combined board state (original + user), not just user
        const currentBoard = combineBoard(original, user);
        const saved = await saveExample(
          currentBoard,
          currentPencilmarks,
          boardRecord.solution,
          techniquesBitfield,
          techniqueId,
          step,
          boardRecord.uuid
        );
        if (saved) {
          incrementCount(techniqueId);
          examplesAdded++;
          const name = getTechniqueNameById(techniqueId);
          console.log(`    + ${name} (now ${getCount(techniqueId)}/${TARGET_PER_TECHNIQUE})`);
        }
      }
    }

    // Apply hint and continue
    const result = applyHint(user, solveData);
    if (result.newUser === user && !result.pencilmarks) {
      break; // No progress
    }
    user = result.newUser;
    pencilmarks = result.pencilmarks;
  }

  return examplesAdded;
}

async function main() {
  console.log("Populate Technique Examples");
  console.log("===========================");
  console.log(`SOLVER_URL: ${SOLVER_URL}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`TARGET_PER_TECHNIQUE: ${TARGET_PER_TECHNIQUE}`);
  console.log();

  await initializeCounts();

  if (allTechniquesFull()) {
    console.log("All techniques already have enough examples!");
    process.exit(0);
  }

  // Find which techniques still need examples
  const techniquesNeeded = TECHNIQUE_ORDER.filter((t) => needsMoreExamples(t));
  console.log(`Techniques needing examples: ${techniquesNeeded.length}`);
  console.log();

  let totalExamplesAdded = 0;
  let boardsProcessed = 0;

  // Process techniques from hardest to easiest
  for (const targetTechnique of techniquesNeeded) {
    if (!needsMoreExamples(targetTechnique)) {
      continue; // Already filled from previous board processing
    }

    const name = getTechniqueNameById(targetTechnique);
    console.log(`\nProcessing technique: ${name}`);
    console.log(`  Current count: ${getCount(targetTechnique)}/${TARGET_PER_TECHNIQUE}`);

    // Find boards that use this technique
    const bit = bitmaskParam(techniqueBit(targetTechnique));
    const boardsWithTechnique = await db
      .select({
        uuid: boards.uuid,
        board: boards.board,
        solution: boards.solution,
        techniques: boards.techniques,
      })
      .from(boards)
      .where(
        and(
          ne(boards.techniques, 0n),
          sql`(${boards.techniques} & ${bit}) <> ${bitmaskParam(0n)}`
        )
      )
      .limit(100); // Process up to 100 boards per technique

    console.log(`  Found ${boardsWithTechnique.length} boards with this technique`);

    // Track all techniques we still need
    const allNeededTechniques = new Set(techniquesNeeded.filter((t) => needsMoreExamples(t)));

    for (const boardRecord of boardsWithTechnique) {
      if (!needsMoreExamples(targetTechnique)) {
        break; // Got enough for this technique
      }

      boardsProcessed++;
      console.log(`  Board ${boardRecord.uuid.slice(0, 8)}...`);

      const added = await processBoard(boardRecord, allNeededTechniques);
      totalExamplesAdded += added;

      // Small delay to not overwhelm the solver
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  console.log("\n===========================");
  console.log(`Boards processed: ${boardsProcessed}`);
  console.log(`Examples added: ${totalExamplesAdded}`);
  console.log();

  console.log("Final counts:");
  for (const technique of TECHNIQUE_ORDER) {
    const count = getCount(technique);
    const name = getTechniqueNameById(technique);
    console.log(`  ${name}: ${count}/${TARGET_PER_TECHNIQUE}${count >= TARGET_PER_TECHNIQUE ? " ✓" : ""}`);
  }

  console.log("\nDone!");
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
