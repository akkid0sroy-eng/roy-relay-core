#!/usr/bin/env bun
/**
 * @relay/api — Interactive setup wizard
 *
 * Walks through all required and optional service configuration,
 * tests each connection, writes packages/api/.env, and verifies the setup.
 *
 * Usage:
 *   bun run setup          (from packages/api/ or repo root)
 *   bun packages/api/setup.ts
 */

import { createInterface } from "readline";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const A = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
};

const bold   = (s: string) => `${A.bold}${s}${A.reset}`;
const dim    = (s: string) => `${A.dim}${s}${A.reset}`;
const green  = (s: string) => `${A.green}${s}${A.reset}`;
const yellow = (s: string) => `${A.yellow}${s}${A.reset}`;
const red    = (s: string) => `${A.red}${s}${A.reset}`;
const cyan   = (s: string) => `${A.cyan}${s}${A.reset}`;

const OK   = green("✓");
const WARN = yellow("!");
const SKIP = dim("–");
const FAIL = red("✗");

// ── Types ─────────────────────────────────────────────────────────────────────

interface StepResult {
  label:  string;
  status: "ok" | "warn" | "skip";
  detail: string;
}

// ── .env read / write ─────────────────────────────────────────────────────────

const ENV_PATH = join(import.meta.dir, ".env");
const ENV_EXAMPLE_PATH = join(import.meta.dir, ".env.example");

function readEnv(): Record<string, string> {
  const src = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, "utf8")
    : existsSync(ENV_EXAMPLE_PATH)
      ? readFileSync(ENV_EXAMPLE_PATH, "utf8")
      : "";

  const out: Record<string, string> = {};
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function writeEnv(env: Record<string, string>): void {
  const lines: string[] = [];

  // Preserve structure of existing file, update in-place
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const written = new Set<string>();

  for (const line of existing.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      lines.push(line);
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 1) { lines.push(line); continue; }
    const key = trimmed.slice(0, idx).trim();
    if (key in env) {
      lines.push(`${key}=${env[key]}`);
      written.add(key);
    } else {
      lines.push(line);
    }
  }

  // Append new keys that weren't in the original file
  for (const [key, val] of Object.entries(env)) {
    if (!written.has(key) && val !== "") {
      lines.push(`${key}=${val}`);
    }
  }

  Bun.write(ENV_PATH, lines.join("\n") + "\n");
}

// ── Readline helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return v;
  return v.slice(0, 6) + "…" + v.slice(-4);
}

async function prompt(label: string, current?: string, secret = false): Promise<string> {
  const hint = current ? dim(` [${secret ? mask(current) : current}]`) : "";
  const answer = (await ask(`  ${label}${hint}: `)).trim();
  return answer || current || "";
}

async function confirm(label: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`  ${label} ${dim(hint)}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// ── Spinner ───────────────────────────────────────────────────────────────────

const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

function startSpinner(label: string): () => void {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${A.cyan}${FRAMES[i++ % FRAMES.length]}${A.reset} ${label}   `);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write(`\r${" ".repeat(label.length + 8)}\r`);
  };
}

async function spin<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const stop = startSpinner(label);
  try { return await fn(); } finally { stop(); }
}

// ── Connection testers ────────────────────────────────────────────────────────

async function testSupabase(url: string, serviceKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/rest/v1/user_profiles?select=*&limit=0`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (res.status === 200 || res.status === 406) return null; // 406 = table missing (pre-migration)
    if (res.status === 401) return "Invalid service role key (401 Unauthorized)";
    if (res.status === 404) return "Project not found — check your SUPABASE_URL";
    return `Unexpected status ${res.status}`;
  } catch (e: any) {
    return `Cannot reach Supabase: ${e.message}`;
  }
}

async function tablesExist(url: string, serviceKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/rest/v1/user_profiles?select=*&limit=0`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    return res.status === 200;
  } catch { return false; }
}

async function testGroq(apiKey: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { ok: false, error: "Invalid API key" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json() as { data: unknown[] };
    return { ok: true, count: data.data?.length };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function testTelegram(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string }; description?: string };
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, username: data.result?.username };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function setTelegramWebhook(token: string, url: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret }),
    });
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch { return false; }
}

async function testNotion(token: string): Promise<{ ok: boolean; workspace?: string }> {
  try {
    const res = await fetch("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
    });
    if (!res.ok) return { ok: false };
    const data = await res.json() as { bot?: { workspace_name?: string } };
    return { ok: true, workspace: data.bot?.workspace_name };
  } catch { return { ok: false }; }
}

async function testTavily(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query: "test", max_results: 1 }),
    });
    return res.ok;
  } catch { return false; }
}

async function testElevenLabs(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": apiKey },
    });
    return res.ok;
  } catch { return false; }
}

async function testVapi(apiKey: string, phoneId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch { return false; }
}

// ── Banner + step headers ─────────────────────────────────────────────────────

function printBanner() {
  console.log();
  console.log(`  ${bold("╔══════════════════════════════════════════╗")}`);
  console.log(`  ${bold("║")}     ${cyan(bold("@relay/api"))} — Setup Wizard              ${bold("║")}`);
  console.log(`  ${bold("║")}     Bun · Hono · Supabase · Groq        ${bold("║")}`);
  console.log(`  ${bold("╚══════════════════════════════════════════╝")}`);
  console.log();
  console.log(dim("  This wizard configures your API server and writes packages/api/.env"));
  console.log(dim("  Press Enter to keep an existing value. Type 'skip' on optional steps."));
  console.log();
}

function stepHeader(n: number, total: number, title: string) {
  console.log();
  console.log(`  ${cyan(bold(`Step ${n} of ${total}`))}  ${bold(title)}`);
  console.log(`  ${dim("─".repeat(44))}`);
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function stepSupabase(env: Record<string, string>): Promise<StepResult> {
  stepHeader(1, 9, "Supabase (required)");
  console.log(dim("  Find these at: supabase.com/dashboard/project/_/settings/api"));
  console.log();

  for (let attempt = 1; attempt <= 3; attempt++) {
    env.SUPABASE_URL = await prompt("Project URL", env.SUPABASE_URL);
    env.SUPABASE_ANON_KEY = await prompt("Anon public key", env.SUPABASE_ANON_KEY, true);
    env.SUPABASE_SERVICE_ROLE_KEY = await prompt("Service role key", env.SUPABASE_SERVICE_ROLE_KEY, true);

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.log(`  ${FAIL} All three Supabase values are required.`);
      continue;
    }

    const err = await spin("Testing Supabase connection…", () =>
      testSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
    );

    if (!err) {
      console.log(`  ${OK} Connected to Supabase`);
      writeEnv(env);
      return { label: "Supabase", status: "ok", detail: new URL(env.SUPABASE_URL).hostname };
    }

    console.log(`  ${FAIL} ${err}`);
    if (attempt < 3) console.log(dim("  Please try again...\n"));
  }

  console.log(`\n  ${red("Too many failed attempts. Fix the issue and re-run: bun run setup")}`);
  process.exit(1);
}

async function stepEncryption(env: Record<string, string>): Promise<StepResult> {
  stepHeader(2, 9, "Encryption key");

  const existing = env.ENCRYPTION_KEY;
  if (existing) {
    try {
      const key = Buffer.from(existing, "base64");
      if (key.length === 32) {
        console.log(`  ${OK} ENCRYPTION_KEY already set (32 bytes, AES-256-GCM)`);
        return { label: "Encryption", status: "ok", detail: "existing key kept" };
      }
    } catch {}
  }

  const key = randomBytes(32).toString("base64");
  env.ENCRYPTION_KEY = key;
  writeEnv(env);

  console.log(`  ${OK} ENCRYPTION_KEY generated (32 bytes, AES-256-GCM)`);
  console.log();
  console.log(yellow("  ⚠  Keep this key safe. Losing it makes all stored integration"));
  console.log(yellow("     secrets unrecoverable. Back it up somewhere secure."));

  return { label: "Encryption", status: "ok", detail: "AES-256-GCM key generated" };
}

async function stepGroq(env: Record<string, string>): Promise<StepResult> {
  stepHeader(3, 9, "Groq AI backend (required)");
  console.log(dim("  Free API key at: console.groq.com/keys"));
  console.log();

  for (let attempt = 1; attempt <= 3; attempt++) {
    env.GROQ_API_KEY = await prompt("Groq API key", env.GROQ_API_KEY, true);

    if (!env.GROQ_API_KEY) {
      console.log(`  ${FAIL} GROQ_API_KEY is required.`);
      continue;
    }

    const result = await spin("Testing Groq…", () => testGroq(env.GROQ_API_KEY));

    if (result.ok) {
      console.log(`  ${OK} Groq connected — ${result.count ?? "?"} models available`);
      writeEnv(env);
      return { label: "Groq", status: "ok", detail: mask(env.GROQ_API_KEY) };
    }

    console.log(`  ${FAIL} ${result.error}`);
    if (attempt < 3) console.log(dim("  Please try again...\n"));
  }

  console.log(`\n  ${red("Too many failed attempts. Fix the issue and re-run: bun run setup")}`);
  process.exit(1);
}

async function stepMigration(env: Record<string, string>): Promise<StepResult> {
  stepHeader(4, 9, "Database migration");

  const alreadyApplied = await spin("Checking tables…", () =>
    tablesExist(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  );

  if (alreadyApplied) {
    console.log(`  ${OK} Migration already applied (user_profiles, user_integrations, pending_actions)`);
    return { label: "Database", status: "ok", detail: "all tables present" };
  }

  const sqlPath = join(import.meta.dir, "db", "001_multi_tenant.sql");
  console.log(`\n  Run this SQL in the Supabase SQL editor:\n`);
  console.log(cyan(`  https://supabase.com/dashboard/project/_/sql`));
  console.log();
  console.log(dim(`  File: ${sqlPath}`));
  console.log();
  console.log("  Steps:");
  console.log("    1. Open the URL above in your browser");
  console.log("    2. Click 'New query'");
  console.log("    3. Paste the contents of db/001_multi_tenant.sql");
  console.log("    4. Click Run");
  console.log();

  const skip = (await prompt("Press Enter when done (or type 'skip' to continue anyway)", "")).toLowerCase();

  if (skip === "skip") {
    console.log(`  ${WARN} Skipped — run the migration before starting the server`);
    return { label: "Database", status: "warn", detail: "migration not applied yet" };
  }

  const applied = await spin("Verifying tables…", () =>
    tablesExist(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  );

  if (applied) {
    console.log(`  ${OK} Tables verified`);
    return { label: "Database", status: "ok", detail: "all tables present" };
  }

  console.log(`  ${WARN} Tables not found yet — you can re-run this wizard after applying the migration`);
  return { label: "Database", status: "warn", detail: "migration not verified" };
}

async function stepServerConfig(env: Record<string, string>): Promise<StepResult> {
  stepHeader(5, 9, "Server configuration");

  env.PORT = await prompt("Port", env.PORT || "3000");
  if (!/^\d+$/.test(env.PORT) || +env.PORT < 1 || +env.PORT > 65535) env.PORT = "3000";

  env.ALLOWED_ORIGINS = await prompt("CORS origins (comma-separated, blank = none)", env.ALLOWED_ORIGINS || "");
  env.ALLOWED_EMAIL_DOMAINS = await prompt("Allowed email domains for email_send (blank = any)", env.ALLOWED_EMAIL_DOMAINS || "");

  writeEnv(env);

  const corsNote = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : "none (direct API clients only)";
  console.log(`  ${OK} Port: ${env.PORT},  CORS: ${corsNote}`);
  return { label: "Server", status: "ok", detail: `port ${env.PORT}` };
}

async function stepRedis(env: Record<string, string>): Promise<StepResult> {
  stepHeader(6, 9, "Redis rate limiting (optional)");
  console.log(dim("  Required for distributed rate limiting across multiple instances."));
  console.log(dim("  Without Redis the API still works — limits are a no-op per instance."));
  console.log();

  const redisInput = await prompt(
    "Redis URL (Enter to skip)",
    env.REDIS_URL || ""
  );

  if (!redisInput || redisInput.toLowerCase() === "skip") {
    delete env.REDIS_URL;
    writeEnv(env);
    console.log(`  ${SKIP} Skipped — rate limiting is a no-op`);
    return { label: "Redis", status: "skip", detail: "rate limiting disabled" };
  }

  env.REDIS_URL = redisInput;

  // Test by spawning a minimal Bun subprocess to avoid top-level ioredis import
  const ok = await spin("Testing Redis…", async () => {
    const code = `
      const Redis = require("ioredis");
      const r = new Redis(${JSON.stringify(redisInput)}, {lazyConnect:true,connectTimeout:3000,maxRetriesPerRequest:0});
      r.connect().then(()=>r.ping()).then(()=>{r.disconnect();process.exit(0)}).catch(()=>process.exit(1));
    `;
    const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  });

  if (ok) {
    console.log(`  ${OK} Redis connected`);
    writeEnv(env);
    return { label: "Redis", status: "ok", detail: redisInput };
  }

  console.log(`  ${WARN} Redis unreachable — rate limiting will be a no-op`);
  console.log(dim("  You can add REDIS_URL to .env later to enable it."));
  delete env.REDIS_URL;
  writeEnv(env);
  return { label: "Redis", status: "warn", detail: "unreachable, skipped" };
}

async function stepTelegram(env: Record<string, string>): Promise<StepResult> {
  stepHeader(7, 9, "Telegram webhook (optional)");
  console.log(dim("  Create a bot at t.me/BotFather, then paste the token here."));
  console.log();

  const tokenInput = await prompt("Bot token (Enter to skip)", env.TELEGRAM_BOT_TOKEN || "", true);

  if (!tokenInput || tokenInput.toLowerCase() === "skip") {
    console.log(`  ${SKIP} Skipped`);
    return { label: "Telegram", status: "skip", detail: "not configured" };
  }

  const tg = await spin("Verifying bot token…", () => testTelegram(tokenInput));

  if (!tg.ok) {
    console.log(`  ${WARN} ${tg.error ?? "Invalid token"}`);
    return { label: "Telegram", status: "warn", detail: "invalid token" };
  }

  env.TELEGRAM_BOT_TOKEN = tokenInput;
  console.log(`  ${OK} Bot verified: @${tg.username}`);

  // Webhook secret
  const existingSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const genSecret = !existingSecret || await confirm("Generate a new webhook secret?", false);
  if (genSecret) {
    env.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString("hex");
    console.log(`  ${OK} Webhook secret generated`);
  }

  // Register webhook
  console.log();
  const serverUrl = await prompt("Your public server URL for webhook registration (Enter to skip)", "");

  if (serverUrl && serverUrl.toLowerCase() !== "skip") {
    const webhookUrl = `${serverUrl.replace(/\/$/, "")}/webhook/telegram`;
    const registered = await spin("Registering webhook with Telegram…", () =>
      setTelegramWebhook(tokenInput, webhookUrl, env.TELEGRAM_WEBHOOK_SECRET)
    );

    if (registered) {
      console.log(`  ${OK} Webhook registered → ${webhookUrl}`);
    } else {
      console.log(`  ${WARN} Webhook registration failed. Run manually:`);
      console.log(dim(`\n  curl -X POST "https://api.telegram.org/bot${mask(tokenInput)}/setWebhook" \\`));
      console.log(dim(`    -d "url=${webhookUrl}" \\`));
      console.log(dim(`    -d "secret_token=${env.TELEGRAM_WEBHOOK_SECRET}"\n`));
    }
  } else {
    console.log();
    console.log(dim("  To register the webhook later:"));
    console.log(dim(`  curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \\`));
    console.log(dim(`    -d "url=https://your-server.com/webhook/telegram" \\`));
    console.log(dim(`    -d "secret_token=${env.TELEGRAM_WEBHOOK_SECRET}"`));
  }

  writeEnv(env);
  return { label: "Telegram", status: "ok", detail: `@${tg.username}` };
}

async function stepWhatsApp(env: Record<string, string>): Promise<StepResult> {
  stepHeader(8, 9, "WhatsApp Cloud API (optional)");
  console.log(dim("  Create an app at: developers.facebook.com → WhatsApp → API Setup"));
  console.log();

  const tokenInput = await prompt("Permanent access token (Enter to skip)", env.WHATSAPP_ACCESS_TOKEN || "", true);

  if (!tokenInput || tokenInput.toLowerCase() === "skip") {
    console.log(`  ${SKIP} Skipped`);
    return { label: "WhatsApp", status: "skip", detail: "not configured" };
  }

  const phoneId = await prompt("Phone Number ID", env.WHATSAPP_PHONE_NUMBER_ID || "");

  if (!phoneId) {
    console.log(`  ${WARN} Phone Number ID is required for WhatsApp`);
    return { label: "WhatsApp", status: "warn", detail: "incomplete config" };
  }

  // Test token by fetching phone number details
  const ok = await spin("Verifying WhatsApp credentials…", async () => {
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}`, {
        headers: { Authorization: `Bearer ${tokenInput}` },
      });
      return res.ok;
    } catch { return false; }
  });

  if (!ok) {
    console.log(`  ${WARN} Invalid token or phone number ID`);
    return { label: "WhatsApp", status: "warn", detail: "invalid credentials" };
  }

  env.WHATSAPP_ACCESS_TOKEN    = tokenInput;
  env.WHATSAPP_PHONE_NUMBER_ID = phoneId;
  console.log(`  ${OK} WhatsApp credentials verified`);

  // Webhook verify token
  if (!env.WHATSAPP_VERIFY_TOKEN) {
    env.WHATSAPP_VERIFY_TOKEN = randomBytes(24).toString("hex");
    console.log(`  ${OK} Webhook verify token generated`);
  } else {
    const regen = await confirm("Regenerate webhook verify token?", false);
    if (regen) {
      env.WHATSAPP_VERIFY_TOKEN = randomBytes(24).toString("hex");
      console.log(`  ${OK} Webhook verify token regenerated`);
    }
  }

  // App Secret
  env.WHATSAPP_APP_SECRET = await prompt(
    "App Secret (from App Settings → Basic, for signature verification)",
    env.WHATSAPP_APP_SECRET || "",
    true
  );

  // API base URL for magic-link emails
  const apiUrl = await prompt(
    "Your public API base URL (e.g. https://api.yoursite.com) — used for magic links",
    env.API_BASE_URL || ""
  );
  if (apiUrl && apiUrl.toLowerCase() !== "skip") env.API_BASE_URL = apiUrl;

  writeEnv(env);

  // Webhook registration instructions
  console.log();
  console.log(dim("  Register the webhook in the Meta for Developers dashboard:"));
  console.log(dim("    1. Go to: developers.facebook.com → your App → WhatsApp → Configuration"));
  console.log(dim("    2. Click 'Edit' next to Webhook"));
  console.log(dim(`    3. Callback URL:  https://your-server.com/webhook/whatsapp`));
  console.log(dim(`    4. Verify Token:  ${env.WHATSAPP_VERIFY_TOKEN}`));
  console.log(dim("    5. Subscribe to the 'messages' field"));
  console.log();

  return { label: "WhatsApp", status: "ok", detail: `phone ID ${phoneId}` };
}

async function stepIntegrations(env: Record<string, string>): Promise<StepResult> {
  stepHeader(9, 9, "Optional integrations");
  console.log(dim("  Per-user API keys are stored encrypted in the database."));
  console.log(dim("  Here you can test connectivity and save server-level defaults."));
  console.log();

  const configured: string[] = [];
  const skipped: string[] = [];

  // ── Google OAuth credentials (server-level: client_id + client_secret) ──────
  if (await confirm("Configure Google (Gmail + Calendar)?", false)) {
    console.log();
    console.log(dim("  Create OAuth credentials at: console.cloud.google.com"));
    console.log(dim("  APIs to enable: Gmail API, Google Calendar API"));
    console.log(dim("  OAuth type: Desktop app"));
    console.log();
    env.GOOGLE_CLIENT_ID = await prompt("Google client ID", env.GOOGLE_CLIENT_ID || "");
    env.GOOGLE_CLIENT_SECRET = await prompt("Google client secret", env.GOOGLE_CLIENT_SECRET || "", true);

    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      console.log(`  ${OK} Google client credentials saved`);
      console.log(dim("  Users connect Gmail/Calendar via POST /api/integrations/google/connect"));
      configured.push("Google");
      writeEnv(env);
    } else {
      console.log(`  ${SKIP} Skipped — credentials incomplete`);
      skipped.push("Google");
    }
  } else {
    skipped.push("Google");
  }

  // ── Notion test token (optional connectivity check) ────────────────────────
  if (await confirm("Test Notion connectivity?", false)) {
    console.log();
    const token = await prompt("Notion integration token (secret_...)", "", true);
    if (token) {
      const result = await spin("Testing Notion…", () => testNotion(token));
      if (result.ok) {
        console.log(`  ${OK} Notion connected — workspace: ${result.workspace ?? "unknown"}`);
        configured.push("Notion");
      } else {
        console.log(`  ${WARN} Notion token invalid`);
        skipped.push("Notion");
      }
    }
  } else {
    skipped.push("Notion");
  }

  // ── Tavily web search ──────────────────────────────────────────────────────
  if (await confirm("Test Tavily web search?", false)) {
    console.log();
    const key = await prompt("Tavily API key", "", true);
    if (key) {
      const ok = await spin("Testing Tavily…", () => testTavily(key));
      if (ok) {
        console.log(`  ${OK} Tavily connected`);
        configured.push("Tavily");
      } else {
        console.log(`  ${WARN} Tavily key invalid`);
        skipped.push("Tavily");
      }
    }
  } else {
    skipped.push("Tavily");
  }

  // ── ElevenLabs TTS ────────────────────────────────────────────────────────
  if (await confirm("Test ElevenLabs TTS?", false)) {
    console.log();
    const key = await prompt("ElevenLabs API key", "", true);
    if (key) {
      const ok = await spin("Testing ElevenLabs…", () => testElevenLabs(key));
      if (ok) {
        console.log(`  ${OK} ElevenLabs connected`);
        configured.push("ElevenLabs");
      } else {
        console.log(`  ${WARN} ElevenLabs key invalid`);
        skipped.push("ElevenLabs");
      }
    }
  } else {
    skipped.push("ElevenLabs");
  }

  // ── VAPI phone calls ──────────────────────────────────────────────────────
  if (await confirm("Test VAPI phone calls?", false)) {
    console.log();
    const key    = await prompt("VAPI API key", "", true);
    const phoneId = await prompt("VAPI phone number ID", "");
    if (key && phoneId) {
      const ok = await spin("Testing VAPI…", () => testVapi(key, phoneId));
      if (ok) {
        console.log(`  ${OK} VAPI connected`);
        configured.push("VAPI");
      } else {
        console.log(`  ${WARN} VAPI credentials invalid`);
        skipped.push("VAPI");
      }
    }
  } else {
    skipped.push("VAPI");
  }

  const detail = configured.length
    ? configured.join(", ")
    : "all skipped";

  return {
    label:  "Integrations",
    status: configured.length > 0 ? "ok" : "skip",
    detail,
  };
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(results: StepResult[], env: Record<string, string>) {
  const line = "═".repeat(48);
  console.log();
  console.log(`  ${bold(line)}`);
  console.log(`  ${bold("  Setup complete")}`);
  console.log(`  ${bold(line)}`);
  console.log();

  for (const r of results) {
    const icon = r.status === "ok" ? OK : r.status === "warn" ? WARN : SKIP;
    const label = r.label.padEnd(16);
    console.log(`  ${icon} ${bold(label)} ${dim(r.detail)}`);
  }

  console.log();
  console.log(`  ${bold(line)}`);

  const allOk = results.every((r) => r.status !== "warn");
  if (allOk) {
    console.log(`\n  ${green(bold("Everything is configured and verified."))}`);
  } else {
    const warnings = results.filter((r) => r.status === "warn");
    console.log(`\n  ${yellow(`${warnings.length} warning(s) — see above.`)}`);
  }

  console.log();
  console.log(bold("  Next steps:"));
  console.log(`    ${cyan("bun run dev")}      Start the API in development (hot-reload)`);
  console.log(`    ${cyan("bun run start")}    Start in production`);
  console.log(`    ${cyan("bun test")}         Run the full test suite (210 tests)`);
  console.log();
  console.log(`  ${dim("API docs: packages/api/README.md  ·  Root docs: README.md")}`);
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log(`\n\n  ${yellow("Interrupted — progress saved to packages/api/.env")}`);
  rl.close();
  process.exit(0);
});

async function main() {
  printBanner();

  const env = readEnv();
  const results: StepResult[] = [];

  results.push(await stepSupabase(env));
  results.push(await stepEncryption(env));
  results.push(await stepGroq(env));
  results.push(await stepMigration(env));
  results.push(await stepServerConfig(env));
  results.push(await stepRedis(env));
  results.push(await stepTelegram(env));
  results.push(await stepWhatsApp(env));
  results.push(await stepIntegrations(env));

  rl.close();
  printSummary(results, env);
}

main();
