# SECURITY.md

Security audit findings and fixes for `roy-relay-core`.
Scope: all routes, middleware, services, DB helpers, core package, and webhook handlers.
Audit model: authenticated attacker (valid JWT), unauthenticated attacker, LLM-as-adversary.

---

## Status overview

| ID  | Severity | Title                                               | Status  |
|-----|----------|-----------------------------------------------------|---------|
| C1  | CRITICAL | `claimPendingAction` missing ownership check        | ✅ Fixed |
| C2  | CRITICAL | OAuth `redirect_uri` not re-validated on code exchange | ✅ Fixed |
| H1  | HIGH     | Webhook misconfiguration leaks via HTTP 500 body    | ✅ Fixed |
| H2  | HIGH     | Unbounded `thread_id` and unenumerated `channel`    | ✅ Fixed |
| H3  | HIGH     | Non-atomic Google token refresh (race condition)    | ✅ Fixed |
| H4  | HIGH     | `ALLOWED_EMAIL_DOMAINS` opt-in permits open relay   | ✅ Fixed |
| H5  | HIGH     | No replay deduplication on WhatsApp webhooks        | ✅ Fixed |
| M1  | MEDIUM   | Invalid timezone and `ai_model` accepted without validation | ✅ Fixed |
| M2  | MEDIUM   | Notion database key error leaks available key names | ✅ Fixed |
| M3  | MEDIUM   | Rate limiter catch block logs `err.message` (may contain Redis credentials) | ✅ Fixed |
| L1  | LOW      | No test asserting that body tampering invalidates HMAC signature | ✅ Fixed |
| L2  | LOW      | `profile_md` injected into system prompt unsanitized | ✅ Fixed |

---

## Critical

### C1 — `claimPendingAction` missing ownership check

**Files:** `packages/api/src/db/pending-actions.ts`, `routes/actions.ts`, `routes/webhook.ts`, `routes/webhook-whatsapp.ts`

**Vulnerability:** `claimPendingAction` atomically transitioned a `pending_actions` row to `executing` using only `WHERE id = $id AND status = 'pending'`. The caller's `userId` was not included in the `UPDATE` predicate. Because `getPendingAction` checked ownership but `claimPendingAction` did not, a two-step race was possible: User B could call `claimPendingAction(actionId)` on User A's action ID immediately after `getPendingAction` returned null to B — executing User A's email, calendar event, or phone call on User B's behalf.

**Fix:**
- Added `userId: string` parameter to `claimPendingAction` and the corresponding `ActionDeps.claimAction` / `WebhookDeps.claimAction` interfaces.
- Added `.eq("user_id", userId)` to the `UPDATE` predicate in `claimPendingAction`.
- Updated all three call sites (`routes/actions.ts`, `routes/webhook.ts`, `routes/webhook-whatsapp.ts`) to pass `userId`.
- Updated default dep wiring in `defaultActionDeps`, `defaultWebhookDeps`, `defaultWhatsAppDeps`.

**Tests:** Updated `claimAction` call expectation in `actions.test.ts`; fixed pre-existing UUID fixture bug in `webhook.test.ts` and `webhook-whatsapp.test.ts` (callback data IDs must pass the existing UUID regex guard).

---

### C2 — OAuth `redirect_uri` not re-validated on code exchange

**Files:** `packages/api/src/routes/integrations.ts`, `packages/api/src/services/integration-validators.ts`

**Vulnerability:** The origin check on `redirect_uri` only ran on `GET /google/auth-url` (which generates the consent URL). `POST /google/connect` (which exchanges the authorization code) accepted any caller-supplied `redirect_uri` and forwarded it directly to `https://oauth2.googleapis.com/token`. An attacker who captured a valid authorization code could exchange it using their own `redirect_uri`, obtaining Google tokens for the victim.

**Fix:**
- Extracted the origin comparison into a shared `isAllowedRedirectUri(uri)` function inside the route factory.
- Added an `isAllowedRedirectUri` check at the top of the `/google/connect` handler, returning `400 "redirect_uri is not allowed."` before the token exchange.
- Both endpoints now enforce the same origin constraint against `API_BASE_URL`.

**Tests:** Updated existing connect tests to use a matching origin (`https://myapp.com/callback`); added an explicit test asserting `https://attacker.com/steal` receives `400`.

---

## High

### H1 — Webhook misconfiguration leaks via HTTP 500 body

**Files:** `packages/api/src/routes/webhook.ts`, `packages/api/src/routes/webhook-whatsapp.ts`

**Vulnerability:** When `TELEGRAM_WEBHOOK_SECRET` or `WHATSAPP_APP_SECRET` were absent, the handlers returned `HTTP 500` with the body `"Webhook secret not configured."`. This told a caller that the endpoint was currently accepting unauthenticated traffic, distinguishing the "misconfigured" state from the "wrong secret" state.

**Fix:** Merged both branches into a single `!secret || header !== secret` condition that always returns `403 Forbidden` with a generic body. The `console.error` log is retained for operator visibility but no longer surfaces in the HTTP response.

**Tests:** Updated two tests from `expect(res.status).toBe(500)` to `.toBe(403)`.

---

### H2 — Unbounded `thread_id` and unenumerated `channel`

**File:** `packages/api/src/routes/messages.ts`

**Vulnerability:** The `POST /api/messages` Zod schema had no length limit on `thread_id` (which flows into `buildContextId` and is stored as a DB key) and accepted any string for `channel` (an internal routing label).

**Fix:**
- `thread_id`: added `.max(256)`.
- `channel`: changed from `z.string()` to `z.enum(["api", "telegram", "whatsapp"])`.

---

### H3 — Non-atomic Google token refresh (race condition)

**File:** `packages/api/src/db/load-integrations.ts`

**Vulnerability:** `makeTokenRefresher` used a read-modify-write pattern: (1) read `secrets_enc`, (2) decrypt and merge updated fields in memory, (3) write back. If a user reconnected Google between steps 1 and 3, the new tokens were silently overwritten with the merged result of the old ones, invalidating the new connection.

**Fix:** Replaced with optimistic concurrency control. The callback now reads `secrets_enc` and `updated_at` together, then writes back with `WHERE updated_at = $original_updated_at`. If the row was updated between the read and write, the `UPDATE` returns 0 rows and the refresh is skipped — the concurrent write (which contains newer tokens) wins. Added `decryptJson` import from `services/encrypt.ts`.

---

### H4 — `ALLOWED_EMAIL_DOMAINS` opt-in permits open email relay

**File:** `packages/core/src/execute.ts`

**Vulnerability:** The `email_send` action only enforced the domain allowlist if `ALLOWED_EMAIL_DOMAINS` was set. If the env var was absent (e.g. staging/dev deployments), the bot would send email to any address the LLM produced — making it trivially usable as a phishing relay when combined with a compromised Telegram account or a prompt injection.

**Fix:** Changed the guard from opt-in (`if (allowedDomains.length > 0)`) to mandatory — throws `"ALLOWED_EMAIL_DOMAINS must be configured before email_send actions are permitted."` when the variable is empty or unset, blocking all `email_send` actions until an operator explicitly configures it.

**Tests:** Added `beforeEach`/`afterAll` in the `email_send` describe block to set `ALLOWED_EMAIL_DOMAINS = "example.com"`; added a dedicated test asserting the new mandatory error when the variable is absent.

---

### H5 — No replay deduplication on WhatsApp webhooks

**File:** `packages/api/src/routes/webhook-whatsapp.ts`

**Vulnerability:** WhatsApp webhooks were verified with HMAC-SHA256 (correct), but there was no deduplication by message ID. A network-level attacker who captured a signed request could replay it, triggering duplicate LLM calls, duplicate action creation, and duplicate rate-limit consumption.

**Fix:**
- Added an injectable `isDuplicate(msgId: string): boolean` dep to `WebhookWhatsAppDeps`.
- Default implementation (`defaultIsDuplicate`) uses a module-level `Map<string, timestamp>` with 5-minute TTL eviction. On each incoming message ID, the function checks if it has been seen, marks it, and evicts stale entries.
- The check runs before rate limiting and message handling in the inner message loop.
- For multi-process deployments the dep can be replaced with a Redis-backed implementation.

**Tests:** Added dedup test verifying the second delivery of the same `msg.id` is skipped by the injected `isDuplicate` dep.

---

## Medium

### M1 — Invalid timezone and `ai_model` accepted without validation

**File:** `packages/api/src/routes/users.ts`

**Vulnerability:** `PATCH /api/users/me` accepted any string up to 60 chars for `timezone` and 100 chars for `ai_model`. An invalid timezone would cause `toLocaleString()` to throw at runtime (inside `executeAction` for phone calls and calendar events). An unrecognised model name would silently cause every subsequent Groq call to fail until the user noticed.

**Fix:** Added two Zod refinements to `updateSchema` (now exported for direct testing):

- `timezone`: `Intl.DateTimeFormat(undefined, { timeZone: tz })` — rejects any non-IANA timezone string.
- `ai_model`: `/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/` — allows all current Groq/Anthropic model IDs while blocking spaces, SQL fragments, and angle brackets.

**Tests (10 new cases):** valid timezones accepted; `"garbage"`, `"America"`, `"Not/A/Zone"` rejected; valid model IDs accepted; `"bad model name"`, `"model; DROP TABLE"`, `"<script>"` rejected; both fields remain optional.

---

### M2 — Notion database key error leaks available key names

**File:** `packages/api/src/services/notion.ts`

**Vulnerability:** When the LLM supplied an unknown database key, the error message enumerated all configured keys: `"Unknown database "x". Available: tasks, notes"`. A prompt-injected LLM could iterate over arbitrary keys, read the structured error responses, and build a map of the user's entire Notion workspace configuration without the user's knowledge.

**Fix:**
- Replaced `if (!dbConfig)` with `!(dbKey in databases)` to make the intent explicit.
- Replaced the enumerated error message with `"Database key "${key}" is not in your Notion integration settings."` — the available keys are not disclosed.
- Empty-map case now returns `"No Notion databases are configured in your integration settings."`.

**Tests (`notion.test.ts`, 3 new cases):** unknown key throws the right message; error body does not contain any of the real key names; empty map returns the "none configured" message.

---

### M3 — Rate limiter catch block logs `err.message`

**File:** `packages/api/src/middleware/rate-limit.ts`

**Vulnerability:** The catch block in `rateLimitMiddleware` logged `err.message` on Redis failures. Redis client errors frequently include the full connection URL in the message (e.g. `connect ECONNREFUSED redis://:password@host/0`), which would land verbatim in log aggregators and monitoring dashboards.

**Fix:** Removed `err: any` from the catch clause and replaced the log statement with a static string: `"Rate limiter unavailable, failing open."` No dynamic content from the error is included.

**Tests:** Added a test that injects a broken limiter whose error message contains a credential-bearing Redis URL, then asserts the HTTP response body contains none of the sensitive strings.

---

## Low

### L1 — No test asserting body tampering invalidates HMAC signature

**File:** `packages/api/tests/webhook-whatsapp.test.ts`

**Issue:** The HMAC-SHA256 signature verification logic was correct, but there was no test asserting that modifying the body after signing produces a 403. A future refactor that accidentally passed parsed JSON instead of raw body to the HMAC would not be caught.

**Fix:** Added a test that computes a valid signature over an original body, modifies the body string, then posts with the original (now-invalid) signature and asserts `403`.

---

### L2 — `profile_md` injected into system prompt unsanitized

**Files:** `packages/core/src/prompt.ts`

**Issue:** `profile_md` (up to 10,000 chars, fully user-controlled) was embedded directly into the system prompt via `buildPrompt()`. While `sanitizeUserInput()` stripped structural tags from *message* content, `profileContext`, `memoryContext`, `relevantContext`, and `searchResults` all bypassed sanitization. A user who understands the prompt format could override system instructions by crafting their profile — a self-injection attack vector.

**Fix:** Applied `sanitizeUserInput()` to all four user-influenced context strings before they are pushed into the `parts` array in `buildPrompt()`:

```typescript
if (profileContext)  parts.push(`\nProfile:\n${sanitizeUserInput(profileContext)}`);
if (memoryContext)   parts.push(`\n${sanitizeUserInput(memoryContext)}`);
if (relevantContext) parts.push(`\n${sanitizeUserInput(relevantContext)}`);
if (searchResults)   parts.push(`\n${sanitizeUserInput(searchResults)}`);
```

**Tests (4 new cases in `prompt.test.ts`):** ACTION tags in `profileContext` stripped; REMEMBER tags in `memoryContext` stripped; ACTION tags in `relevantContext` stripped; GOAL tags in `searchResults` stripped.

---

## Phase 1 additions (hardening beyond original audit scope)

The following were added during Phase 1 security hardening:

### S1-ext — Timing-safe Telegram + WhatsApp verify-token comparison

**Files:** `packages/api/src/routes/webhook.ts`, `packages/api/src/routes/webhook-whatsapp.ts`

Both the `X-Telegram-Bot-Api-Secret-Token` header check and the WhatsApp `hub.verify_token` GET check now use `timingSafeEqual(Buffer.from(secret), Buffer.from(header))`. The Telegram check was plain `header !== secret`; the WhatsApp verify-token check had the same problem (the POST HMAC check was already timing-safe).

---

### S5-ext — Security response headers (`secureHeaders()`)

**File:** `packages/api/src/index.ts`

Added Hono's `secureHeaders()` middleware applied globally before all routes. Sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `Referrer-Policy: no-referrer`, and a restrictive `Content-Security-Policy`.

---

### S3-ext — Prompt injection sandboxing for web search results

**Files:** `packages/core/src/parse.ts`, `packages/core/src/prompt.ts`

Two-layer defence:

1. **`sanitizeExternalContent(text)`** — new export in `parse.ts`. Extends `sanitizeUserInput` with: stripping `ignore [all] [previous|prior|above] instructions` phrases; neutralising `System:` / `User:` / `Assistant:` role-block openers; preventing `</search_results>` tag escape.

2. **Trust boundary in `buildPrompt`** — Tavily results are now wrapped in `<search_results>…</search_results>` XML tags and passed through `sanitizeExternalContent` before injection. A security rule at the top of the system prompt explicitly instructs the LLM never to follow directives inside those tags.

---

### S7-ext — Minimal health endpoint

**File:** `packages/api/src/index.ts`

`GET /health` previously returned `{ ok: true, service: "@relay/api", ts: Date.now() }`. The `service` field advertised the internal package name to unauthenticated callers. Response trimmed to `{ ok: true }`.

---

### P2-ext — GDPR Article 17 right to erasure (`DELETE /api/users/me`)

**File:** `packages/api/src/routes/users.ts`

New endpoint sequence: (1) best-effort revoke Google OAuth refresh token via `oauth2.googleapis.com/revoke`; (2) `auth.admin.deleteUser(userId)` — cascades via FK to `user_profiles → messages, memory, logs, user_integrations, pending_actions`; (3) clear `at` and `rt` HttpOnly cookies; (4) return 204.

---

## What was already done well

| Area | Detail |
|------|--------|
| AES-256-GCM encryption | Fresh random IV per call, 128-bit auth tag, key length validated at startup |
| HMAC verification | `timingSafeEqual` used for JWT verification, WhatsApp POST signature, Telegram secret, and WhatsApp verify-token |
| Security headers | `secureHeaders()` middleware — HSTS, `X-Content-Type-Options`, `X-Frame-Options`, CSP, `Referrer-Policy` |
| Supabase RLS | `auth.uid() = user_id` enforced at the DB layer on all tables |
| Passwordless auth | Magic-link only — no password storage or hashing required |
| Prompt injection (user input) | `sanitizeUserInput()` strips structural tags; `sanitizeExternalContent()` defends against web-sourced injections |
| Search result sandboxing | `<search_results>` trust boundary + explicit system-prompt security rule |
| HttpOnly cookies | Auth tokens set with `HttpOnly; Secure; SameSite=Strict` |
| Rate limiting | Sliding-window per user, per plan, with graceful Redis fail-open |
| Input validation | Zod schemas on all state-changing routes |
| Dependency injection | All routes fully testable offline — 253 tests, 0 external calls needed |
| Atomic action claiming | `UPDATE WHERE status = 'pending'` is atomic in PostgreSQL — no double-execution |
| GDPR right to erasure | `DELETE /api/users/me` — full cascade deletion with OAuth revocation |
