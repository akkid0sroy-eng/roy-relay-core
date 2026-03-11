# CLAUDE.md

Project guide for **roy-relay-core** (read by Claude Code when working in this repo).

## Commands

```bash
# Run all tests (273 total)
bun test packages/core packages/api

# Run tests for a single package
bun test packages/core
bun test packages/api

# Run a single test file
bun test packages/api/tests/webhook.test.ts

# Start API server with hot reload
bun run dev:api

# Interactive setup wizard (generates .env)
bun run setup
```

No separate build step — Bun runs TypeScript directly.

## Architecture

This is a **Bun monorepo** with two packages:

- **`packages/core`** (`@relay/core`) — Zero-dependency pure TypeScript. Contains domain logic: prompt building (`buildPrompt`), action intent parsing (`parseActionIntent`), and action execution (`executeAction`). All I/O is injected via `IntegrationLoaders`, making it fully testable offline.

- **`packages/api`** (`@relay/api`) — Hono HTTP server on port 3000. Multi-tenant REST API backed by Supabase (auth + DB) and optional Redis (rate limiting).

### Request Flow

```
Telegram/WhatsApp/REST → Webhook/Route Handler
  → Auth middleware (JWT verification via SUPABASE_JWT_SECRET)
  → Rate limit middleware (sliding window per plan tier)
  → Load user profile + integrations from Supabase
  → Decrypt secrets (AES-256-GCM via services/encrypt.ts)
  → Fetch conversation history + memory context
  → [Telegram only] startTypingLoop() — sends "typing" every 4 s until reply
  → [Photo] downloadTelegramFile() → callGroqVision()
    [Voice] downloadTelegramFile() → transcribeAudio() → text pipeline
    [Text]  optional web search → buildPrompt() → callGroq()
  → parseActionIntent()
  → If action detected: create pending_actions row, send approval button
  → If no action: send reply immediately, save to messages
```

### Human-in-the-Loop (HitL) Actions

When the LLM proposes an action (email, calendar, Notion page, phone call), it creates a `pending_actions` row with 30-minute TTL. The user sees an approval button in Telegram/WhatsApp. On approval, the webhook atomically claims the action (`UPDATE WHERE status = 'pending'`) to prevent double-execution, then calls `executeAction()` from `@relay/core`.

Action types: `note | reminder | email_send | calendar_create | notion_create | phone_call`

### Key Patterns

- **Dependency injection** — `IntegrationLoaders` interface in `packages/core/src/types.ts` decouples core logic from HTTP/DB layers. Tests pass mock loaders.
- **Encrypted secrets** — All integration credentials stored AES-256-GCM encrypted in `user_integrations.secrets_enc`. Key from `ENCRYPTION_KEY` env var (32-byte base64).
- **Multi-tenant isolation** — Supabase RLS enforces `auth.uid() = user_id` on all tables. API middleware sets `userId` on Hono context from verified JWT.
- **Per-user models** — Each user can override the default Groq model in their profile. `services/groq.ts` has fallback model + retry logic.
- **Agent topics** — `user_profiles.agent_topics` (JSONB) maps `threadId → agentKey`, allowing different AI personas per conversation thread.

### Database Schema

Three main tables in Supabase (see `packages/api/db/001_multi_tenant.sql`):
- `user_profiles` — per-user settings, plan, telegram_id, whatsapp_phone
- `user_integrations` — encrypted credentials per provider (google | notion | vapi | elevenlabs | tavily | groq)
- `pending_actions` — HitL action queue with status state machine

### Integrations

- **Google** (OAuth2) — Gmail send/search, Calendar events via `services/gmail.ts` / `services/calendar.ts`
- **Notion** — Page creation with dynamic property mapping via `@notionhq/client`
- **VAPI** — AI phone calls via `services/vapi.ts`
- **Tavily** — Web search (checked via `needsWebSearch()` before LLM call)
- **Groq** — LLM inference: `callGroq` (chat, default `llama-3.3-70b-versatile`), `callGroqVision` (`llama-3.2-11b-vision-preview`), `transcribeAudio` (`whisper-large-v3`)
- **ElevenLabs** — Voice (stored as integration, used externally)

### Multi-Modal Telegram Inputs

The Telegram webhook dispatches by message type before the LLM call:

| Type | Handler | Behaviour |
|------|---------|-----------|
| `text` | `handleTextMessage` | Full pipeline + typing indicator |
| `photo` | `handlePhotoMessage` | Download → Groq vision → full pipeline |
| `voice` / `audio` | `handleVoiceMessage` | Download → Whisper transcription → text pipeline |
| `document` | `handleDocumentMessage` | Graceful acknowledgment |

Vision and transcription deps (`callGroqVision`, `transcribeAudio`, `downloadTelegramFile`, `sendChatAction`) are optional in `WebhookDeps` — absent deps produce user-friendly fallback messages rather than errors.

### Environment Variables

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `ENCRYPTION_KEY`, `GROQ_API_KEY`

Optional: `PORT` (default 3000), `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `API_BASE_URL`, `ALLOWED_ORIGINS`, `ALLOWED_EMAIL_DOMAINS`

### Reliability (Phase 2 — done)

- **`executeAction` timeout** — `Promise.race([_executeAction(...), createTimeout(30 s)])` prevents runaway integration calls (`execute.ts`). Injectable `_timeoutMs` param for tests.
- **`/health/ready` probe** — `GET /health/ready` pings Supabase + Redis with 5 s timeout each; returns 200 when both ok (Redis "skipped" counts as ok). Injectable `HealthDeps` for tests (`routes/health.ts`).
- **pg_cron cleanup** — `cleanup_pending_actions()` runs every 10 min: marks expired rows, hard-deletes terminal rows older than 7 days (`db/003_pending_actions_cleanup.sql`).
- **Redis retry queue** — `enqueueMessage` / `drainMessageRetryQueue` / `startDrainLoop` in `services/message-queue.ts`. Messages older than 24 h are discarded; max 5 retries per message. `persistWithRetry()` helper in `routes/messages.ts` silently enqueues on Supabase save failure. Drain loop runs every 30 s if `REDIS_URL` is set.

### Security Hardening (Phase 1 — done)

- **Timing-safe webhook secrets** — `timingSafeEqual` for both `TELEGRAM_WEBHOOK_SECRET` and `WHATSAPP_VERIFY_TOKEN` comparisons (`webhook.ts`, `webhook-whatsapp.ts`)
- **Security headers** — `secureHeaders()` middleware on every response (`index.ts`): HSTS, `X-Content-Type-Options`, `X-Frame-Options`, CSP, `Referrer-Policy`
- **Search-result sandboxing** — `sanitizeExternalContent()` + `<search_results>` trust-boundary wrapper with explicit system-prompt rule (`parse.ts`, `prompt.ts`)
- **Minimal health endpoint** — `/health` returns `{ ok: true }` only; internal package name removed (`index.ts`)
- **GDPR erasure** — `DELETE /api/users/me` revokes Google OAuth, deletes auth user (cascades all data), clears cookies (`routes/users.ts`)
