/**
 * @fileoverview Shared Node canvas adapter for @sudobility/sudojo_ocr.
 *
 * The adapter loads a native module (@napi-rs/canvas), so it is built once and
 * reused by every OCR path that needs board detection/cropping (the paddle
 * recognizer and the ML pre-crop).
 */

import type { CanvasAdapter } from "@sudobility/sudojo_ocr";
import { createNodeAdapter } from "@sudobility/sudojo_ocr/node";

let adapter: CanvasAdapter | null = null;

/** Lazily create the native canvas adapter and keep it for the process. */
export async function getNodeAdapter(): Promise<CanvasAdapter> {
  if (!adapter) {
    adapter = await createNodeAdapter();
  }
  return adapter;
}
