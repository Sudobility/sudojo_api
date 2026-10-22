/**
 * @fileoverview OCR ML proxy service
 *
 * Calls the sudojo_ocr_ml inference service (whole-board CNN) and normalises
 * its response into OCRExtractData.
 *
 * The service is optional: when OCR_ML_URL is unset, or the call fails, the
 * caller falls back to the Tesseract pipeline in @sudobility/sudojo_ocr. That
 * keeps image scanning working during a model rollout or an outage of the
 * inference box.
 *
 * Before the call we crop to the board square with @sudobility/sudojo_ocr's
 * board detector. Library images are often whole-app screenshots where a digit
 * button pad sits right below the grid; the pad is a grid-like decoy that the
 * model's own detector mistakes for the board. Handing the model a tight square
 * crop removes the decoy, and a crop that already fills the frame is exactly
 * what the model's whole-image detection path expects.
 */

import { getEnv } from "../lib/env-helper";
import { detectAndCropBoard } from "@sudobility/sudojo_ocr";
import type { OCRExtractData } from "@sudobility/sudojo_types";
import { getNodeAdapter } from "./ocr-canvas";

const OCR_ML_URL = getEnv("OCR_ML_URL", "")!;
const OCR_ML_TIMEOUT_MS = parseInt(getEnv("OCR_ML_TIMEOUT_MS", "20000")!, 10);

/** Extra diagnostics the ML service returns alongside OCRExtractData. */
export interface OCRMLDebug {
  detection: "cornernet" | "classical" | "whole-image";
  solvable: "unique" | "multiple" | "unsolvable";
  constraintRepaired: boolean;
  /** Cells the model was unsure about — worth asking the user to confirm. */
  lowConfidenceCells: number[];
  /** "gpu" or "cpu"; useful for spotting a silent CPU fallback in production. */
  device: string;
  elapsedMs: number;
}

export interface OCRMLResult extends OCRExtractData {
  debug?: OCRMLDebug;
}

/** Whether the ML backend is configured for this deployment. */
export function isOCRMLEnabled(): boolean {
  return OCR_ML_URL.length > 0;
}

/**
 * Crop the image to the detected board square, returned as a data URL.
 *
 * Falls back to the original image if detection throws, so a cropping failure
 * never blocks a scan — the ML service still runs its own board detection on
 * whatever it receives.
 *
 * @param image Base64 image data (with or without a data URL prefix)
 */
async function cropToBoard(image: string): Promise<string> {
  try {
    const base64 = image.includes(",") ? image.split(",")[1] || image : image;
    const imageBuffer = Buffer.from(base64, "base64");
    const adapter = await getNodeAdapter();
    return await detectAndCropBoard(adapter, imageBuffer);
  } catch (err) {
    console.warn(
      "[OCR] ML board pre-crop failed, sending original image:",
      err
    );
    return image;
  }
}

/**
 * Extract a puzzle via the ML service.
 *
 * @param image Base64 image data (with or without a data URL prefix)
 * @param minClues Minimum clue count the service should accept
 * @throws when the service is unreachable, times out, or rejects the image
 */
export async function extractViaML(
  image: string,
  minClues = 17
): Promise<OCRMLResult> {
  if (!isOCRMLEnabled()) {
    throw new Error("OCR_ML_URL is not configured");
  }

  const url = `${OCR_ML_URL}/v1/ocr`;
  const startedAt = Date.now();

  // Isolate the board square before recognition so a whole-app screenshot's
  // digit-button pad can't be mistaken for the grid.
  const cropped = await cropToBoard(image);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OCR_ML_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: cropped, min_clues: minClues }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      // 422 means the model read the image but found too few clues -- a real
      // answer about the image, not a service failure, so surface it as-is
      // rather than burning time on a Tesseract retry that will also fail.
      const detail = await response.text().catch(() => "");
      const err = new Error(
        `OCR ML service error ${response.status}: ${detail.slice(0, 200)}`
      );
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }

    return (await response.json()) as OCRMLResult;
  } catch (err) {
    clearTimeout(timeoutId);
    const elapsedMs = Date.now() - startedAt;
    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[extractViaML] Timed out after ${elapsedMs}ms (configured ${OCR_ML_TIMEOUT_MS}ms)`
      );
      throw new Error(
        `OCR ML service timeout after ${Math.round(elapsedMs / 1000)}s`
      );
    }
    console.error(`[extractViaML] Failed after ${elapsedMs}ms:`, err);
    throw err;
  }
}
