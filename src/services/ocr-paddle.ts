/**
 * @fileoverview OCR via the paddle_ocr service.
 *
 * @sudobility/sudojo_ocr detects and crops the board in-process, then posts the
 * cropped board to paddle_ocr, which has no board detector of its own. This is
 * the only path for camera captures and the fallback for library images.
 *
 * The service is optional: when PADDLE_OCR_URL is unset the paddle path is
 * disabled, and the route reports 503 rather than degrading silently.
 */

import { extractSudokuFromImage } from "@sudobility/sudojo_ocr";
import type { OCRExtractData } from "@sudobility/sudojo_types";
import { getEnv } from "../lib/env-helper";
import { getNodeAdapter } from "./ocr-canvas";

const PADDLE_OCR_URL = getEnv("PADDLE_OCR_URL", "")!;
const PADDLE_OCR_TIMEOUT_MS = parseInt(
  getEnv("PADDLE_OCR_TIMEOUT_MS", "30000")!,
  10
);

/** Whether the paddle backend is configured for this deployment. */
export function isPaddleEnabled(): boolean {
  return PADDLE_OCR_URL.length > 0;
}

/**
 * Read a board from an image via board detection + paddle_ocr.
 *
 * @param image - Base64 image data, with or without a `data:` URL prefix
 */
export async function extractViaPaddle(image: string): Promise<OCRExtractData> {
  const base64 = image.includes(",") ? image.split(",")[1] || image : image;
  const imageBuffer = Buffer.from(base64, "base64");
  const adapter = await getNodeAdapter();
  const startedAt = Date.now();

  const result = await extractSudokuFromImage(
    adapter,
    imageBuffer,
    { url: PADDLE_OCR_URL, timeoutMs: PADDLE_OCR_TIMEOUT_MS },
    { skipBoardDetection: false, recognizePencilmarks: true }
  );

  console.log(
    `[OCR] paddle ${Date.now() - startedAt}ms digits=${result.digitCount} ` +
      `conf=${Math.round(result.confidence)}`
  );

  return {
    board: result.board,
    confidence: result.confidence,
    digitCount: result.digitCount,
    engine: "paddle",
  };
}
