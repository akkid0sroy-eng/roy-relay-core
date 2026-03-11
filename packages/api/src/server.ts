import { app } from "./index.ts";
import { startDrainLoop } from "./services/message-queue.ts";
import { saveMessage } from "./db/messages.ts";

const port = parseInt(process.env.PORT ?? "3000");

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`@relay/api running on http://localhost:${port}`);

// ── Background: message retry queue drain loop ────────────────────────────────
// Only starts when Redis is configured. Periodically retries saveMessage calls
// that failed during request processing (e.g. Supabase temporarily down).
if (process.env.REDIS_URL) {
  startDrainLoop(saveMessage);
  console.log("[message-queue] drain loop started (30 s interval)");
}
