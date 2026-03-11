# roy-relay-core

Multi-tenant backend for the Roy Telegram Relay — turns the single-user bot into a hosted service where each user manages their own integrations, conversation history, and AI settings.

## What this is

The original bot (`roy-telegram-relay-bot`) runs on one person's VPS with flat-file config. This project extracts its logic into a proper multi-tenant API:

- **`packages/core`** — pure TypeScript functions with zero runtime dependencies (prompt builder, action parser, action executor)
- **`packages/api`** — Hono HTTP API backed by Supabase and Redis

---

## Repository layout

```
roy-relay-core/
├── packages/
│   ├── core/                   # @relay/core — pure functions, no I/O
│   │   ├── src/
│   │   │   ├── types.ts        # shared types (PendingAction, PromptConfig, …)
│   │   │   ├── parse.ts        # safeParseJson, parseActionIntent, needsWebSearch, sanitizeUserInput
│   │   │   ├── prompt.ts       # buildPrompt
│   │   │   ├── execute.ts      # executeAction + IntegrationLoaders interface
│   │   │   └── index.ts        # re-exports everything
│   │   └── tests/
│   │       ├── parse.test.ts
│   │       ├── prompt.test.ts
│   │       └── execute.test.ts
│   └── api/                    # @relay/api — Hono HTTP server
│       ├── db/
│       │   ├── 001_multi_tenant.sql   # Supabase migration — core tables + RLS
│       │   └── 002_whatsapp.sql       # WhatsApp phone column + index
│       ├── src/
│       │   ├── index.ts        # app entry — wires all routes + middleware
│       │   ├── server.ts       # Bun serve() entry point
│       │   ├── middleware/
│       │   │   ├── auth.ts     # JWT verification, sets userId/userPlan on context
│       │   │   └── rate-limit.ts   # sliding-window rate limiter middleware
│       │   ├── routes/
│       │   │   ├── auth.ts              # POST /auth/magic-link, GET /auth/callback, …
│       │   │   ├── users.ts             # GET/PATCH /api/users/me, agent topics
│       │   │   ├── integrations.ts      # connect/disconnect Google, Notion, VAPI, …
│       │   │   ├── messages.ts          # POST /api/messages, GET /api/messages/history
│       │   │   ├── actions.ts           # HitL approve/reject
│       │   │   ├── webhook.ts           # POST /webhook/telegram (multi-user bot)
│       │   │   └── webhook-whatsapp.ts  # GET+POST /webhook/whatsapp (WhatsApp Cloud API)
│       │   ├── services/
│       │   │   ├── encrypt.ts          # AES-256-GCM for secrets at rest
│       │   │   ├── groq.ts             # callGroq (chat), callGroqVision (llama-3.2-11b-vision-preview), transcribeAudio (whisper-large-v3)
│       │   │   ├── rate-limiter.ts     # RedisRateLimiter, NoopRateLimiter
│       │   │   ├── google-auth.ts      # per-user OAuth2 client + token refresh
│       │   │   ├── gmail.ts            # sendEmail, searchEmails
│       │   │   ├── calendar.ts         # createCalendarEvent, listUpcomingEvents
│       │   │   ├── notion.ts           # createNotionPage (dynamic property mapping)
│       │   │   ├── vapi.ts             # makeVapiCall
│       │   │   └── integration-validators.ts  # live HTTP checks for connect flows
│       │   └── db/
│       │       ├── client.ts           # Supabase singleton clients
│       │       ├── messages.ts         # getHistory, saveMessage, buildContextId
│       │       ├── memory.ts           # getMemoryContext, getRelevantContext, processMemoryIntents
│       │       ├── integrations.ts     # listIntegrations, getSecrets, upsertIntegration, …
│       │       ├── load-integrations.ts    # loadUserIntegrations → IntegrationLoaders
│       │       └── pending-actions.ts  # insertPendingAction, claimPendingAction, …
│       └── tests/
│           ├── encrypt.test.ts
│           ├── auth.test.ts
│           ├── users.test.ts
│           ├── integrations.test.ts
│           ├── load-integrations.test.ts
│           ├── messages.test.ts
│           ├── actions.test.ts
│           ├── rate-limit.test.ts
│           ├── webhook.test.ts
│           └── webhook-whatsapp.test.ts
└── package.json                # Bun workspace root
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Bun](https://bun.sh) | ≥ 1.1 | Runtime + package manager |
| [Supabase](https://supabase.com) | — | Free tier works |
| Redis | ≥ 7 | Optional — falls back to no-op without `REDIS_URL` |

---

## Quick start

```bash
git clone https://github.com/your-org/roy-relay-core
cd roy-relay-core
bun install
bun run setup       # interactive wizard — configures .env, tests connections, sets up Telegram + WhatsApp
bun test            # 253 tests, all offline
bun run dev:api     # starts on :3000
```

The setup wizard walks through every service step-by-step, tests each connection before saving, and writes `packages/api/.env` progressively (Ctrl+C saves your progress). Run it again at any time to update settings.

---

## Environment variables

All variables go in `packages/api/.env`.

### Required

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Public anon key — used for JWT verification |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasses RLS for server-side writes |
| `ENCRYPTION_KEY` | 32-byte AES key, base64-encoded. Generate with the command below. |
| `GROQ_API_KEY` | Default Groq key (users can override with their own) |

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `REDIS_URL` | — | Redis connection string. Without this, rate limiting is a no-op. |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS origins, e.g. `https://app.example.com` |
| `TELEGRAM_BOT_TOKEN` | — | Shared bot token for the webhook handler |
| `TELEGRAM_WEBHOOK_SECRET` | — | Secret header value Telegram sends with each update |
| `WHATSAPP_ACCESS_TOKEN` | — | Permanent access token from Meta for Developers |
| `WHATSAPP_PHONE_NUMBER_ID` | — | Phone Number ID from WhatsApp API Setup page |
| `WHATSAPP_VERIFY_TOKEN` | — | Token you choose when registering the Meta webhook |
| `WHATSAPP_APP_SECRET` | — | App Secret (App Settings → Basic) for signature verification |
| `API_BASE_URL` | — | Public URL of this API — used to build magic-link URLs for WhatsApp account linking |
| `ALLOWED_EMAIL_DOMAINS` | — | Comma-separated domains allowed for `email_send` actions |

---

## Database setup

### 1. Apply the migration

In the Supabase SQL editor (or via the Supabase MCP), run:

```
packages/api/db/001_multi_tenant.sql
```

This creates three new tables on top of the existing single-user schema:

| Table | Purpose |
|-------|---------|
| `user_profiles` | Per-user settings: timezone, AI model, feature toggles, plan tier |
| `user_integrations` | Encrypted secrets for Google, Notion, VAPI, etc. |
| `pending_actions` | HitL action queue with state machine (pending → executing → approved/rejected) |

It also adds `user_id` to the existing `messages`, `memory`, and `logs` tables and replaces the permissive `USING (true)` RLS policies with `auth.uid() = user_id` scoped ones.

### 2. Backfill existing data (single-user migration)

After registering your original account via magic link, backfill old rows:

```sql
UPDATE messages SET user_id = '<your-uuid>' WHERE user_id IS NULL;
UPDATE memory   SET user_id = '<your-uuid>' WHERE user_id IS NULL;
UPDATE logs     SET user_id = '<your-uuid>' WHERE user_id IS NULL;
```

Then optionally enforce `NOT NULL`:

```sql
ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE memory   ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE logs     ALTER COLUMN user_id SET NOT NULL;
```

---

## Running the API

```bash
# Development (auto-restart on file changes)
bun run dev:api

# Production
bun run --cwd packages/api start
```

The server starts on `http://localhost:3000`. Check liveness:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

---

## Testing

All 253 tests run fully offline — no Supabase, Groq, Redis, Telegram, or WhatsApp connections needed:

```bash
bun test              # all packages
bun run test:core     # packages/core only (54 tests)
bun run test:api      # packages/api only (199 tests)
```

---

## API reference

### Authentication

All `/api/*` routes require `Authorization: Bearer <access_token>`.

The token is a Supabase JWT obtained through the auth flow below.

---

#### `POST /auth/magic-link`

Send a passwordless sign-in link to an email address.

**Request**
```json
{
  "email": "user@example.com",
  "telegram_id": "123456789"   // optional — links Telegram account at sign-up
}
```

**Response `200`**
```json
{ "message": "Check your email for a sign-in link." }
```

---

#### `GET /auth/callback?code=<code>`

Exchange the one-time code from the email link for session tokens. Also creates the `user_profiles` row on first login.

**Response `200`**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "...",
  "expires_in": 3600,
  "user": { "id": "uuid", "email": "user@example.com" },
  "next": "/"
}
```

---

#### `POST /auth/refresh`

Exchange a refresh token for a new access token.

**Request**
```json
{ "refresh_token": "..." }
```

**Response `200`**
```json
{ "access_token": "eyJ...", "refresh_token": "...", "expires_in": 3600 }
```

---

#### `POST /auth/logout`

Invalidate the current session. Requires `Authorization: Bearer <token>`.

**Response `200`**
```json
{ "message": "Logged out." }
```

---

### User profile

#### `GET /api/users/me`

Returns the current user's profile.

**Response `200`**
```json
{
  "user_id": "uuid",
  "display_name": "Alice",
  "timezone": "America/New_York",
  "profile_md": "Software engineer.",
  "ai_model": "llama-3.3-70b-versatile",
  "max_history": 10,
  "voice_mode": false,
  "web_search": true,
  "plan": "free"
}
```

---

#### `PATCH /api/users/me`

Update profile fields. All fields are optional.

**Request**
```json
{
  "display_name": "Alice",
  "timezone": "Europe/Berlin",
  "profile_md": "I'm a software engineer based in Berlin.",
  "ai_model": "llama-3.1-8b-instant",
  "max_history": 20,
  "voice_mode": false,
  "web_search": true
}
```

Available models: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen-qwq-32b`

---

---

#### `DELETE /api/users/me`

Permanently delete the current user's account and all associated data (GDPR Article 17 — Right to Erasure).

**Sequence:**
1. Best-effort revoke Google OAuth refresh token (clears the grant on Google's side)
2. Delete the Supabase Auth user — cascades via FK to: `user_profiles`, `messages`, `memory`, `logs`, `user_integrations`, `pending_actions`
3. Clear `at` and `rt` session cookies

**Response `204 No Content`** — no body.

**Error responses**

| Status | Meaning |
|--------|---------|
| `500` | Supabase auth deletion failed — account not deleted |

---

#### `GET /api/users/me/agents`

Returns the current Telegram thread → agent mapping.

**Response `200`**
```json
{ "123456": "research", "789012": "finance" }
```

---

#### `PATCH /api/users/me/agents`

Register or unregister a Telegram thread as an agent topic.

**Request — register**
```json
{ "thread_id": "123456", "agent_key": "research" }
```

**Request — unregister**
```json
{ "thread_id": "123456", "agent_key": null }
```

Available agent keys: `general`, `research`, `content`, `finance`, `strategy`, `critic`

---

### Integrations

#### `GET /api/integrations`

List all integrations for the current user. Does not include secrets.

**Response `200`**
```json
[
  { "provider": "google", "enabled": true, "meta": { "email": "user@gmail.com" } },
  { "provider": "notion", "enabled": true, "meta": { "databases": ["tasks", "docs"] } }
]
```

---

#### `GET /api/integrations/:provider/status`

Check whether a specific integration is connected and enabled.

`:provider` — one of `google`, `notion`, `vapi`, `elevenlabs`, `tavily`, `groq`

**Response `200`**
```json
{ "provider": "google", "enabled": true, "connected": true }
```

---

#### `GET /api/integrations/google/auth-url`

Get the OAuth2 URL to redirect the user to for Google sign-in.

**Query params**
- `redirect_uri` (required) — where Google should redirect after consent

**Response `200`**
```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

---

#### `POST /api/integrations/google/connect`

Exchange an OAuth2 authorization code for tokens and save them encrypted.

**Request**
```json
{
  "code": "4/0AX...",
  "redirect_uri": "https://yourapp.com/callback"
}
```

**Response `200`**
```json
{ "ok": true, "meta": { "email": "user@gmail.com", "scope": ["gmail.send", "calendar.events"] } }
```

---

#### `POST /api/integrations/notion/connect`

Connect a Notion integration.

**Request**
```json
{
  "token": "secret_abc123...",
  "databases": {
    "tasks": {
      "id": "abc123...",
      "titleProperty": "Name",
      "description": "Task tracker",
      "properties": {
        "Status": { "type": "status", "options": ["Not started", "In progress", "Done"] },
        "Due date": { "type": "date" }
      }
    }
  }
}
```

**Response `200`**
```json
{ "ok": true }
```

---

#### `POST /api/integrations/vapi/connect`

Connect VAPI for outbound AI phone calls.

**Request**
```json
{
  "api_key": "vapi_...",
  "phone_number_id": "...",
  "destination_phone": "+15551234567"
}
```

---

#### `POST /api/integrations/:provider/connect`

Generic connect for `elevenlabs`, `tavily`, and `groq` — all just need an API key.

**Request**
```json
{ "api_key": "sk-..." }
```

---

#### `DELETE /api/integrations/:provider`

Disconnect and delete an integration.

**Response `200`**
```json
{ "ok": true }
```

---

### Messages

#### `POST /api/messages`

Send a message and get an AI reply. Runs the full pipeline:
load profile → integration flags → conversation history → optional web search → memory context → build prompt → call Groq → parse action intent → store pending action → persist messages.

**Request**
```json
{
  "content": "Schedule a team sync tomorrow at 10am",
  "thread_id": "123456",   // optional — Telegram thread/topic ID
  "channel": "api"         // optional — default: "api"
}
```

**Response `200` — plain reply**
```json
{ "reply": "Done! I've added the event to your calendar." }
```

**Response `200` — reply with HitL action**
```json
{
  "reply": "Sure, I'll schedule that.",
  "action_id": "uuid",
  "action_description": "Schedule team sync"
}
```

When `action_id` is present, the action is pending approval. Use `POST /api/actions/:id/approve` to execute it or `POST /api/actions/:id/reject` to cancel.

**Error responses**

| Status | Meaning |
|--------|---------|
| `400` | Empty or missing `content` |
| `404` | User profile not found |
| `429` | Rate limit exceeded |
| `503` | Groq unavailable |

---

#### `GET /api/messages/history`

Fetch recent conversation history for the current user.

**Query params**
- `thread_id` — optional, filter to a specific thread
- `limit` — optional, default 20, max 100

**Response `200`**
```json
[
  { "role": "user", "content": "What's on my calendar?" },
  { "role": "assistant", "content": "You have a team sync at 10am." }
]
```

---

### Actions (Human-in-the-Loop)

#### `GET /api/actions/:id`

Fetch the current status of a pending action.

**Response `200`**
```json
{
  "id": "uuid",
  "type": "calendar_create",
  "description": "Schedule team sync",
  "status": "pending",
  "created_at": "2026-03-09T10:00:00Z",
  "expires_at": "2026-03-09T10:30:00Z"
}
```

Possible `status` values: `pending`, `executing`, `approved`, `rejected`, `expired`

---

#### `POST /api/actions/:id/approve`

Execute an approved action.

1. Ownership check — verifies the action belongs to the current user
2. Status check — must be `pending`
3. Atomic claim — transitions `pending → executing` (prevents double-execution)
4. Executes via `@relay/core executeAction` with the user's loaded integrations
5. Marks `approved` with result, or `rejected` with error

**Response `200`**
```json
{ "ok": true, "result": "Event created: Team Sync — Mon Mar 10, 10:00–11:00 AM" }
```

**Error responses**

| Status | Meaning |
|--------|---------|
| `404` | Action not found or not owned by user |
| `409` | Action already processed, or race condition on claim |
| `502` | Integration call failed (result stored as `rejected`) |

---

#### `POST /api/actions/:id/reject`

Cancel a pending action without executing it.

**Response `200`**
```json
{ "ok": true }
```

---

### Webhook (Telegram)

#### `POST /webhook/telegram`

Receives Telegram update objects. This is a **public route** — no JWT required. Security comes from the `X-Telegram-Bot-Api-Secret-Token` header.

Set the webhook in Telegram:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-api.com/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**Supported update types**

| Type | Behaviour |
|------|-----------|
| `message.text` | Shows typing indicator, runs full pipeline, sends reply (or HitL keyboard if action detected) |
| `message.photo` | Shows typing indicator, downloads image, calls Groq vision model (`llama-3.2-11b-vision-preview`), runs full pipeline |
| `message.voice` / `message.audio` | Shows typing indicator, downloads audio, transcribes with Whisper (`whisper-large-v3`), runs text pipeline with transcript |
| `message.document` | Acknowledges file receipt; asks user to paste text content |
| `callback_query` with `approve:<id>` | Claims action, executes, edits the message with result |
| `callback_query` with `reject:<id>` | Rejects action, edits the message |
| `/start` command | Sends welcome message |

**Error responses**

| Status | Meaning |
|--------|---------|
| `400` | Invalid JSON body |
| `403` | Missing or wrong `X-Telegram-Bot-Api-Secret-Token` |

Always returns `200` for valid authenticated updates (even if the user isn't found) — Telegram retries on non-200.

---

### Webhook (WhatsApp)

#### `GET /webhook/whatsapp`

Meta webhook verification endpoint. Called once by Meta when you register the webhook URL.

**Query params**
- `hub.mode` — must be `subscribe`
- `hub.verify_token` — must match `WHATSAPP_VERIFY_TOKEN`
- `hub.challenge` — echoed back on success

**Response `200`** — returns the raw challenge string (not JSON).

**Response `403`** — wrong verify token.
**Response `500`** — `WHATSAPP_VERIFY_TOKEN` not configured.

---

#### `POST /webhook/whatsapp`

Receives WhatsApp update events from Meta. **Public route** — no JWT required. Security comes from HMAC-SHA256 signature verification (`X-Hub-Signature-256` header).

If `WHATSAPP_APP_SECRET` is not set, the signature check is skipped (development only).

**Supported update types**

| Type | Behaviour |
|------|-----------|
| `message.text` — linked user | Runs full message pipeline, sends AI reply (or HitL buttons if action detected) |
| `message.text` — unknown phone | Asks for email address to link the account |
| `message.text` — email reply from unknown phone | Sends a magic-link to that email with `whatsapp_phone` in metadata |
| `interactive.button_reply` with `approve:<id>` | Claims action, executes it, sends result message |
| `interactive.button_reply` with `reject:<id>` | Rejects action, sends cancellation message |
| Delivery status updates | Silently acknowledged (no processing) |

Always returns `200` for authenticated updates — Meta retries on non-200.

**HitL buttons format (WhatsApp interactive)**
```json
{
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "On it! [action preview text]" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "approve:<uuid>", "title": "✅ Approve" } },
        { "type": "reply", "reply": { "id": "reject:<uuid>",  "title": "❌ Cancel"  } }
      ]
    }
  }
}
```

---

### Health check

#### `GET /health`

No authentication required.

**Response `200`**
```json
{ "ok": true }
```

---

## Rate limiting

Rate limits are applied per-user on all `/api/*` routes after authentication.

| Plan | Limit |
|------|-------|
| `free` | 20 requests / minute |
| `pro` | 100 requests / minute |
| `enterprise` | 1000 requests / minute |

Every response includes:
```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 1741500060   (unix seconds)
```

On limit exceeded (`429`):
```json
{ "error": "Rate limit exceeded. Please slow down.", "retry_after": 42 }
```
```
Retry-After: 42
```

Redis is required for distributed rate limiting. Without `REDIS_URL`, limits are not enforced (no-op in development).

---

## Security

### Secrets at rest

Integration secrets (Google tokens, API keys) are encrypted with AES-256-GCM before being stored in `user_integrations.secrets_enc`.

Wire format: `base64( iv[12 bytes] | authTag[16 bytes] | ciphertext )`

- Fresh random IV per encrypt call — identical inputs produce different ciphertexts
- GCM auth tag detects any tampering
- Master key (`ENCRYPTION_KEY`) never logged or stored in DB

### Authentication

- Passwordless email (Supabase magic link) — no passwords to leak
- Short-lived JWTs (default: 1 hour), refreshed via `POST /auth/refresh`
- All `/api/*` routes verify the JWT on every request

### Row Level Security

All Supabase tables have `USING (auth.uid() = user_id)` RLS policies. The API server uses the service-role key (which bypasses RLS) but ownership is enforced explicitly in route handlers for all mutation operations.

### Action replay protection

`POST /api/actions/:id/approve` uses an atomic `UPDATE ... WHERE status = 'pending'` to claim the action before execution. If two concurrent requests race, only one succeeds — the other gets `409`.

### Timing-safe webhook verification

Both the Telegram (`X-Telegram-Bot-Api-Secret-Token`) and WhatsApp (`WHATSAPP_VERIFY_TOKEN`) secret comparisons use `crypto.timingSafeEqual`, preventing byte-by-byte enumeration attacks via response-time differences.

### Security response headers

`secureHeaders()` middleware is applied globally. Every response includes:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `no-referrer` |
| `Content-Security-Policy` | Restrictive default-src policy |

### Prompt injection sandboxing

Web search results (Tavily) are passed through `sanitizeExternalContent()` and wrapped in `<search_results>` XML tags. The system prompt explicitly instructs the LLM never to follow instructions found within those tags.

### GDPR right to erasure

`DELETE /api/users/me` provides a complete account deletion: revokes Google OAuth, deletes the Supabase Auth user (cascades all data via FK), and clears session cookies. See the [API reference](#delete-apiusersme) for details.

---

## `@relay/core` package

Zero-dependency TypeScript functions exported from `packages/core`:

```typescript
import {
  buildPrompt,
  parseActionIntent,
  executeAction,
  needsWebSearch,
  safeParseJson,
  sanitizeUserInput,
  sanitizeExternalContent,
} from "@relay/core";
```

### `buildPrompt(content, config, opts?)`

Assembles the full system + user prompt sent to the LLM.

```typescript
const prompt = buildPrompt("What's on my calendar?", {
  userName: "Alice",
  userTimezone: "America/New_York",
  profileContext: "Software engineer.",
  calendarEnabled: true,
  gmailEnabled: true,
}, {
  memoryContext: "FACTS: likes coffee",
  relevantContext: "RELEVANT: asked about calendar last week",
  searchResults: "SEARCH: ...",
});
```

### `parseActionIntent(response)`

Extracts and strips `[ACTION: ... | TYPE: ... | DATA: ...]` tags from an LLM response.

```typescript
const { clean, action } = parseActionIntent(
  'Sure! [ACTION: Save note | TYPE: note | DATA: ran 5km]'
);
// clean  → "Sure!"
// action → { type: "note", description: "Save note", data: "ran 5km" }
```

Type aliases normalised automatically:
- `calendar` → `calendar_create`
- `email` → `email_send`
- `call` / `phone` → `phone_call`
- `notion` → `notion_create`

### `executeAction(action, config, loaders)`

Executes an approved HitL action. Integration modules are injected via `loaders` — no hardcoded imports.

```typescript
const result = await executeAction(action, {}, {
  loadGmail: async () => ({
    sendEmail: myGmailSendFn,
    gmailEnabled: true,
  }),
});
```

### `needsWebSearch(text)`

Returns `true` if the query likely requires current information (prices, news, weather, sports results, etc.).

### `safeParseJson<T>(raw, fallback)`

JSON parse with trailing-comma repair. Returns `fallback` on parse failure.

### `sanitizeUserInput(text)`

Strips injection tags (`[ACTION:]`, `[REMEMBER:]`, `[GOAL:]`, `[DONE:]`) from user input.

### `sanitizeExternalContent(text)`

Extends `sanitizeUserInput` with additional patterns for untrusted external sources (web search results, scraped content):
- Strips "ignore all previous instructions" phrasing
- Neutralises `System:` / `User:` / `Assistant:` role-block openers
- Prevents `</search_results>` escape from the trust-boundary wrapper

Used by `buildPrompt` when wrapping Tavily results in `<search_results>` tags.

---

## HitL action tag format

The LLM includes a structured tag in its response when it wants to perform an action. The tag is stripped from the reply shown to the user.

```
[ACTION: description | TYPE: type | DATA: payload]
```

| Type | `DATA` shape |
|------|-------------|
| `note` | Plain text string |
| `reminder` | Plain text string |
| `email_send` | `{"to":"...","subject":"...","body":"..."}` |
| `calendar_create` | `{"title":"...","start":"YYYY-MM-DD HH:MM","end":"YYYY-MM-DD HH:MM"}` |
| `notion_create` | `{"title":"...","content":"...","database":"tasks"}` |
| `phone_call` | `{"message":"opening line","reason":"context for AI"}` |

---

## Memory tags

The LLM can persist facts and goals by including tags in its response:

```
[REMEMBER: user prefers morning meetings]
[GOAL: learn TypeScript | DEADLINE: 2026-06-01]
[DONE: learn TypeScript]
```

These are extracted and written to the `memory` table via `processMemoryIntents`. The memory context is injected back into the prompt on subsequent messages.

---

## Connecting a Telegram bot

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in `.env`
3. Register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://your-api.com/webhook/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
4. Users link their Telegram account by sending their chat ID at sign-up:
   ```bash
   curl -X POST https://your-api.com/auth/magic-link \
     -H "Content-Type: application/json" \
     -d '{"email":"user@example.com","telegram_id":"123456789"}'
   ```
   The `telegram_id` is stored in `user_profiles.telegram_id` and used by the webhook to route incoming messages to the correct user.

---

## Connecting a WhatsApp number

WhatsApp support uses the [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). Users are linked to their account via a magic-link flow entirely inside the WhatsApp chat — no web app needed.

### 1. Create a Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**
2. Choose **Business** type
3. Add the **WhatsApp** product to your app

### 2. Get credentials

From **WhatsApp → API Setup** in your app dashboard, copy:
- **Temporary or permanent access token** — generate a System User token in Business Manager for production
- **Phone Number ID** (not the phone number itself)

From **App Settings → Basic**, copy:
- **App Secret** — used to verify the `X-Hub-Signature-256` signature on webhook calls

### 3. Configure the server

Set these in `packages/api/.env`:
```
WHATSAPP_ACCESS_TOKEN=EAAxxxxxx...
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=your-random-secret
WHATSAPP_APP_SECRET=abc123...
API_BASE_URL=https://your-api.com
```

Or run `bun run setup` — step 8 walks through it interactively and prints the webhook registration instructions.

Apply the WhatsApp migration in Supabase:
```
packages/api/db/002_whatsapp.sql
```

### 4. Register the webhook

In your Meta App dashboard, go to **WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://your-api.com/webhook/whatsapp`
- **Verify Token**: the value you set for `WHATSAPP_VERIFY_TOKEN`
- **Subscribe to**: `messages` field

### 5. User account linking

When a new phone number messages your WhatsApp number, the bot asks for their email address. They reply with it and receive a magic-link. Clicking that link:

1. Creates their Supabase account (or signs them in)
2. Stores their phone number in `user_profiles.whatsapp_phone`

Subsequent messages are routed to the correct user automatically. The full pipeline — conversation history, memory, integrations, HitL buttons — works identically to Telegram.
