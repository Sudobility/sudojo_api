/**
 * @fileoverview Sudojo API entry point
 *
 * Sets up the Hono application with middleware, health checks, API routes,
 * global error handling, and graceful shutdown. Initializes the database
 * before accepting requests.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { initDatabase, initGamificationTables, closeDatabase } from "./db";
import routes from "./routes";
import {
  successResponse,
  errorResponse,
  type HealthCheckData,
} from "@sudobility/types";
import { getEnv } from "./lib/env-helper";
import { encryptSolutionsMiddleware } from "./middleware/encryptSolutions";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check endpoints
const healthResponse: HealthCheckData = {
  version: "1.0.0",
  status: "healthy",
};

app.get("/", c => c.json(successResponse(healthResponse)));
app.get("/health", c => c.json(successResponse(healthResponse)));

// Encrypt solution fields in GET responses
app.use("/api/v1/*", encryptSolutionsMiddleware);

// API routes
app.route("/api/v1", routes);

/**
 * Global error handler for unhandled exceptions.
 * Catches any errors not handled by route-level try/catch blocks
 * and returns a consistent 500 response.
 */
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(errorResponse("Internal server error"), 500);
});

/**
 * 404 handler for routes that don't match any registered handlers.
 */
app.notFound(c => {
  return c.json(errorResponse("Not found"), 404);
});

// Initialize database and start server
const port = parseInt(getEnv("PORT", "3000")!);

initDatabase()
  .then(() => initGamificationTables())
  .then(() => {
    console.log(`Server running on http://localhost:${port}`);
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });

/**
 * Graceful shutdown handler.
 * Closes the database connection when the process receives SIGTERM or SIGINT.
 */
function handleShutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  closeDatabase()
    .then(() => {
      console.log("Database connection closed.");
      process.exit(0);
    })
    .catch(err => {
      console.error("Error during shutdown:", err);
      process.exit(1);
    });
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

export default {
  port,
  fetch: app.fetch,
  // Increase idle timeout for long-running requests like /validate (default is 10s)
  idleTimeout: 120, // 2 minutes
};

// Export app for testing
export { app };
