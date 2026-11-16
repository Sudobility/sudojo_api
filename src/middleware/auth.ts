/**
 * @fileoverview Admin authentication middleware
 */

import type { Context, Next } from "hono";
import { verifyIdToken, isSiteAdmin } from "../services/firebase";
import { errorResponse } from "@sudobility/types";

/**
 * Middleware that requires Firebase authentication and admin email.
 * Checks if user's email is in SITEADMIN_EMAILS environment variable.
 */
export async function adminMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    return c.json(errorResponse("Authorization header required"), 401);
  }

  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return c.json(
      errorResponse("Invalid authorization format. Use: Bearer <token>"),
      401
    );
  }

  try {
    const decodedToken = await verifyIdToken(token);

    if (!isSiteAdmin(decodedToken.email)) {
      return c.json(errorResponse("Admin access required"), 403);
    }

    // Store user info in context for later use
    c.set("firebaseUser", decodedToken);
    c.set("userId", decodedToken.uid);
    c.set("userEmail", decodedToken.email ?? null);
    c.set("siteAdmin", true);

    await next();
  } catch {
    return c.json(errorResponse("Invalid or expired Firebase token"), 401);
  }
}
