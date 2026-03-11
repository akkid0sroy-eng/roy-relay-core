import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { authMiddleware } from "./middleware/auth.ts";
import { rateLimitMiddleware } from "./middleware/rate-limit.ts";
import authRoutes from "./routes/auth.ts";
import userRoutes from "./routes/users.ts";
import integrationRoutes from "./routes/integrations.ts";
import messageRoutes from "./routes/messages.ts";
import actionRoutes from "./routes/actions.ts";
import webhookRoutes from "./routes/webhook.ts";
import whatsappWebhookRoutes from "./routes/webhook-whatsapp.ts";
import { createHealthRoutes } from "./routes/health.ts";

export const app = new Hono();

app.use("*", logger());
// Attach security response headers to every reply:
//   X-Content-Type-Options: nosniff         — prevent MIME-type sniffing
//   X-Frame-Options: DENY                   — prevent clickjacking
//   Strict-Transport-Security               — enforce HTTPS (1 year + subdomains)
//   X-XSS-Protection: 0                    — disabled (CSP is the modern replacement)
//   Referrer-Policy: no-referrer            — don't leak URL in Referer header
//   Content-Security-Policy                 — restrict resource loading
app.use("*", secureHeaders());
// Build the CORS allowlist. If ALLOWED_ORIGINS is not set we use the string
// "null" so Hono's CORS middleware explicitly sets Access-Control-Allow-Origin: null
// (i.e. deny all), rather than falling through to an implementation-specific empty-array
// behaviour that could accidentally widen access on certain Hono versions.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn("[startup] ALLOWED_ORIGINS is not set — all cross-origin API requests will be blocked.");
}
app.use(
  "/api/*",
  cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : "null" })
);

// ── Public routes ─────────────────────────────────────────────────────────────
app.route("/auth", authRoutes);
app.route("/webhook", webhookRoutes);
app.route("/webhook", whatsappWebhookRoutes);

// ── Protected routes (auth middleware applied to all /api/* paths) ────────────
app.use("/api/*", authMiddleware);
app.use("/api/*", rateLimitMiddleware());
app.route("/api/users", userRoutes);
app.route("/api/integrations", integrationRoutes);
app.route("/api/messages", messageRoutes);
app.route("/api/actions", actionRoutes);

// ── Health endpoints ──────────────────────────────────────────────────────────
// GET /health        — liveness probe: always 200 while the process is running.
// GET /health/ready  — readiness probe: pings Supabase + Redis, returns 503 if
//                      a required dependency is unreachable.
app.route("/health", createHealthRoutes());
