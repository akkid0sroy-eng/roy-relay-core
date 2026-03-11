# What's Next — roy-relay-core

Roadmap of completed work and upcoming improvements. Updated 2026-03-11.

---

## Done

### Phase 1 — Security Hardening ✅

| Item | Change |
|------|--------|
| Timing-safe webhook secrets | `timingSafeEqual` for Telegram secret-token and WhatsApp verify-token |
| Security response headers | `secureHeaders()` middleware — HSTS, X-Content-Type-Options, X-Frame-Options, CSP |
| Search-result prompt injection | `sanitizeExternalContent()` + `<search_results>` trust boundary in system prompt |
| Minimal health endpoint | `/health` returns `{ ok: true }` only — no internal package info |
| GDPR right to erasure | `DELETE /api/users/me` — revoke OAuth, cascade delete, clear cookies |

### High-Priority Feature Gaps ✅

| Item | Change |
|------|--------|
| Typing indicator | `startTypingLoop()` sends `sendChatAction("typing")` every 4 s during LLM processing |
| Photo / image input | `handlePhotoMessage` — downloads image, calls `callGroqVision` (`llama-3.2-11b-vision-preview`) |
| Voice / audio input | `handleVoiceMessage` — downloads audio, transcribes via `transcribeAudio` (`whisper-large-v3`) |
| Document acknowledgment | `handleDocumentMessage` — friendly fallback message |

---

## Up Next

### Phase 2 — Reliability ✅

| ID | Task | Effort |
|----|------|--------|
| R7 | 30 s timeout wrapper around `executeAction()` — `Promise.race` + injectable timeout | 30 min |
| R3 | `/health/ready` dependency probe (Supabase + Redis ping) — injectable deps, 5 s probe timeout | 2 hrs |
| R2 | pg_cron job to purge expired `pending_actions` rows — every 10 min, hard-delete after 7 days | 1 hr |
| R1 | Redis-backed retry queue for fire-and-forget message persistence — `drainMessageRetryQueue`, `startDrainLoop`, `persistWithRetry` | 1 day |

### Phase 3 — Privacy & Compliance

| ID | Task | Effort |
|----|------|--------|
| P3 | PII scrubbing in logging — hash/redact Telegram IDs and phone numbers | 1 day |
| P4 | Tavily web-search consent flag + one-time in-chat disclosure | 2 hrs |
| P1 | Evaluate field-level encryption for `messages.content` | 2 days |

### Phase 4 — Portability

| ID | Task | Effort |
|----|------|--------|
| PT2 | `Dockerfile` + `docker-compose.yml` for one-command deployment | 2 hrs |
| PT3 | Extract common `processMessage` pipeline — reduce duplication across webhook handlers | 1 day |
| PT4 | Remove `fs.appendFile` disk fallback from `executeAction` for note/reminder | 30 min |

### Phase 5 — Scaling

| ID | Task | Effort |
|----|------|--------|
| SC1 | Redis-backed WhatsApp dedup (`SET NX EX 300`) | 1 hr |
| SC3 | Per-user token/cost limits — truncate history when over plan limit | 1 day |
| SC5 | Cache `getMemoryContext` in Redis (5 min TTL, invalidate on write) | 2 hrs |
| SC2 | Async job queue (BullMQ) — decouple webhook receipt from LLM processing | 2–3 days |

### Phase 6 — Key Management

| ID | Task | Effort |
|----|------|--------|
| S2 | Encryption key versioning — 1-byte version prefix on wire format | 3–5 days |
| S4 | Envelope encryption — per-user DEK encrypted with master KEK | 3–5 days |

---

## Medium-Priority Feature Gaps

| Gap | Priority | Effort |
|-----|----------|--------|
| Streaming responses — stream Groq output, edit Telegram message progressively | Medium | High |
| Per-user bot token — white-label bot support | Medium | Medium |
| Multiple LLM providers — OpenAI / Anthropic fallback | Medium | Medium |
| Webhook retry deduplication — Telegram retries on non-200 | Medium | Low |
| Token usage tracking — store tokens per request for billing | Medium | Low |
| Conversation export — `GET /api/messages/export` (JSON/CSV) | Low | Low |
| Admin dashboard — view users, actions, integrations | Low | High |

---

## Architecture notes for future contributors

- The async job queue (SC2) is the largest architectural investment. Prioritise it before onboarding more than ~100 active concurrent users — it decouples webhook latency from LLM processing time and enables horizontal worker scaling.
- Encryption key versioning (S2/S4) must be planned before any production key rotation. The migration is coordinated: read all `secrets_enc`, re-encrypt with new key, write back in a transaction.
- The common pipeline refactor (PT3) will make adding Discord/Slack channels trivial — extract `processMessage(input, sender)` first, then add new adapters.
