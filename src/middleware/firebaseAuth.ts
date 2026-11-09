/**
 * @fileoverview Firebase authentication middleware
 */

import type { Context, Next } from "hono";
import type { DecodedIdToken } from "firebase-admin/auth";
import {
  verifyIdToken,
  isAnonymousUser,
  isSiteAdmin,
} from "../services/firebase";
import { errorResponse } from "@sudobility/sudojo_types";

declare module "hono" {
  interface ContextVariableMap {
    firebaseUser: DecodedIdToken;
    userId: string;
    userEmail: string | null;
    siteAdmin: boolean;
  }
}

/** Options for {@link createFirebaseAuthMiddleware}. */
interface FirebaseAuthOptions {
  /**
   * Allow anonymous Firebase users through. Default `false` — most routes are
   * real-account-only and reject anonymous tokens with 403.
   *
   * Set `true` for resources an anonymous (guest) user legitimately owns. The
   * canonical case is subscription info: on native-IAP platforms (App
   * Store / Play Store / Mac App Store) a guest can purchase against their
   * anonymous app-user id, so they have real subscription data to read. The
   * per-route uid check still restricts a caller to their own data, and a
   * guest on a web-billing platform simply has no subscription (empty result).
   */
  allowAnonymous?: boolean;
}

/**
 * Build a Firebase authentication middleware.
 *
 * Verifies the Firebase ID token and sets context variables:
 * - firebaseUser: The decoded Firebase token
 * - userId: The Firebase UID
 * - userEmail: The user's email (or null)
 * - siteAdmin: Whether the user is a site admin
 *
 * Anonymous users are rejected with 403 unless `allowAnonymous` is set.
 */
export function createFirebaseAuthMiddleware(
  options: FirebaseAuthOptions = {}
) {
  const { allowAnonymous = false } = options;
  return async function firebaseAuth(c: Context, next: Next) {
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

      if (!allowAnonymous && isAnonymousUser(decodedToken)) {
        return c.json(
          errorResponse("Anonymous users cannot access this resource"),
          403
        );
      }

      // Set context variables
      c.set("firebaseUser", decodedToken);
      c.set("userId", decodedToken.uid);
      c.set("userEmail", decodedToken.email ?? null);
      c.set("siteAdmin", isSiteAdmin(decodedToken.email));

      await next();
    } catch {
      return c.json(errorResponse("Invalid or expired Firebase token"), 401);
    }
  };
}

/**
 * Firebase authentication middleware (real accounts only).
 *
 * Rejects anonymous users with 403. The default guard for real-account-only
 * routes.
 */
export const firebaseAuthMiddleware = createFirebaseAuthMiddleware();

/**
 * Firebase authentication middleware that also admits anonymous (guest) users.
 *
 * Use only for resources a guest legitimately owns — notably subscription
 * info, which an anonymous user holds on native-IAP platforms. Verifies the
 * token and sets the same context variables; the route must still enforce that
 * the caller only reads their own data.
 */
export const firebaseAuthAllowAnonymousMiddleware =
  createFirebaseAuthMiddleware({ allowAnonymous: true });
