import { writeFile } from "fs/promises";
import { join } from "path";
import type { PendingAction, ExecuteConfig } from "./types.ts";
import { safeParseJson } from "./parse.ts";

// ── Integration loader interface ──────────────────────────────────────────────
// Callers inject these so the core package has zero dependency on integration
// modules. Also makes the function fully testable with mocks.

export interface IntegrationLoaders {
  loadGmail?: () => Promise<{
    sendEmail: (p: { to: string; subject: string; body: string }) => Promise<string>;
    gmailEnabled: boolean;
  }>;
  loadCalendar?: () => Promise<{
    createCalendarEvent: (p: {
      title: string;
      start: string;
      end: string;
      description?: string;
    }) => Promise<string>;
    calendarEnabled: boolean;
  }>;
  loadNotion?: () => Promise<{
    createNotionPage: (p: {
      title: string;
      content: string;
      database: string;
      properties?: Record<string, string>;
    }) => Promise<string>;
    notionEnabled: boolean;
  }>;
  loadVapi?: () => Promise<{
    makeVapiCall: (p: { firstMessage: string; systemPrompt: string }) => Promise<string>;
    vapiEnabled: boolean;
  }>;
}

// ── executeAction ─────────────────────────────────────────────────────────────

/** Hard cap on how long a single action may run before being aborted. */
export const EXECUTE_TIMEOUT_MS = 30_000;

/** Rejects after `ms` milliseconds with a descriptive error. */
function createTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Action timed out after ${ms / 1000}s`)), ms)
  );
}

/**
 * Execute an approved HitL action.
 *
 * Integration modules are loaded via the `loaders` argument so this function
 * has no hard dependency on gmail/calendar/notion/vapi packages — making it
 * testable in isolation and reusable outside the main bot.
 *
 * The call is automatically aborted and rejects with a timeout error if it has
 * not completed within `_timeoutMs` ms (default: `EXECUTE_TIMEOUT_MS` = 30 s).
 * Pass a shorter value in tests to avoid slow tests.
 */
export async function executeAction(
  action: PendingAction,
  config: ExecuteConfig,
  loaders: IntegrationLoaders = {},
  _timeoutMs: number = EXECUTE_TIMEOUT_MS
): Promise<string> {
  return Promise.race([_executeAction(action, config, loaders), createTimeout(_timeoutMs)]);
}

async function _executeAction(
  action: PendingAction,
  config: ExecuteConfig,
  loaders: IntegrationLoaders
): Promise<string> {
  const { notesDir, remindersDir, userTimezone, userName, profileContext } = config;
  const timestamp = Date.now();

  if (action.type === "note") {
    const fileName = `note_${timestamp}.md`;
    await writeFile(join(notesDir, fileName), action.data);
    return `Note saved as \`${fileName}\``;
  }

  if (action.type === "reminder") {
    const fileName = `reminder_${timestamp}.txt`;
    await writeFile(join(remindersDir, fileName), action.data);
    return `Reminder saved as \`${fileName}\``;
  }

  if (action.type === "email_send") {
    if (!loaders.loadGmail)
      throw new Error("Gmail loader not provided. Pass loadGmail to executeAction.");
    const { sendEmail, gmailEnabled } = await loaders.loadGmail();
    if (!gmailEnabled)
      throw new Error("Gmail not configured. Run: bun run setup:google");
    const p = safeParseJson(action.data, { to: "", subject: "", body: "" });
    if (!p.to || !p.to.includes("@"))
      throw new Error("Email missing or invalid 'to' address.");
    if (!p.subject || p.subject.trim().length === 0)
      throw new Error("Email missing 'subject'.");
    if (p.subject.length > 500)
      throw new Error("Email subject too long (max 500 chars).");
    if (!p.body || p.body.trim().length === 0)
      throw new Error("Email body is empty.");
    const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (allowedDomains.length === 0)
      throw new Error(
        "ALLOWED_EMAIL_DOMAINS must be configured before email_send actions are permitted."
      );
    const recipientDomain = p.to.split("@")[1]?.toLowerCase();
    if (!allowedDomains.includes(recipientDomain))
      throw new Error(
        `Recipient domain "${recipientDomain}" is not in ALLOWED_EMAIL_DOMAINS.`
      );
    return await sendEmail(p);
  }

  if (action.type === "calendar_create") {
    if (!loaders.loadCalendar)
      throw new Error("Calendar loader not provided. Pass loadCalendar to executeAction.");
    const { createCalendarEvent, calendarEnabled } = await loaders.loadCalendar();
    if (!calendarEnabled)
      throw new Error("Calendar not configured. Run: bun run setup:google");
    const p = safeParseJson(action.data, {
      title: "",
      start: "",
      end: "",
      description: "",
    });
    if (!p.title || p.title.trim().length === 0)
      throw new Error("Calendar event missing 'title'.");
    if (!p.start || !p.end)
      throw new Error("Calendar event missing 'start' or 'end'.");
    const startDate = new Date(p.start);
    const endDate = new Date(p.end);
    if (isNaN(startDate.getTime()))
      throw new Error(`Invalid start date: "${p.start}". Use YYYY-MM-DD HH:MM format.`);
    if (isNaN(endDate.getTime()))
      throw new Error(`Invalid end date: "${p.end}". Use YYYY-MM-DD HH:MM format.`);
    if (startDate >= endDate)
      throw new Error("Event start time must be before end time.");
    return await createCalendarEvent(p);
  }

  if (action.type === "notion_create") {
    if (!loaders.loadNotion)
      throw new Error("Notion loader not provided. Pass loadNotion to executeAction.");
    const { createNotionPage, notionEnabled } = await loaders.loadNotion();
    if (!notionEnabled)
      throw new Error(
        "Notion not configured. Add NOTION_TOKEN and set up config/notion-databases.json."
      );
    const p = safeParseJson(action.data, {
      title: "",
      content: "",
      database: "",
      properties: {} as Record<string, string>,
    });
    if (!p.title || p.title.trim().length === 0)
      throw new Error("Notion page missing 'title'.");
    if (p.title.length > 2000)
      throw new Error("Notion title too long (max 2000 chars).");
    if (p.content && p.content.length > 50_000)
      throw new Error("Notion content too long (max 50 000 chars).");
    if (p.database && p.database.length > 100)
      throw new Error("Notion database key too long (max 100 chars).");
    return await createNotionPage(p);
  }

  if (action.type === "phone_call") {
    if (!loaders.loadVapi)
      throw new Error("VAPI loader not provided. Pass loadVapi to executeAction.");
    const { makeVapiCall, vapiEnabled } = await loaders.loadVapi();
    if (!vapiEnabled)
      throw new Error(
        "VAPI not configured. Add VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_DESTINATION_PHONE to .env"
      );
    const p = safeParseJson(action.data, { message: "", reason: "" });
    const now = new Date().toLocaleString("en-US", {
      timeZone: userTimezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const callId = await makeVapiCall({
      firstMessage: `Hi ${userName || "there"}, ${p.message || "I'm calling about your pending items."}`,
      systemPrompt: [
        `You are ${userName || "the user"}'s personal AI assistant on a voice call.`,
        `Current time: ${now}.`,
        profileContext ? `User profile:\n${profileContext}` : "",
        `Call reason: ${p.reason || p.message}`,
        "Be concise, warm, and conversational. Keep responses short — this is a phone call.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return `Call initiated (ID: ${callId.slice(0, 8)}...). Your phone should ring shortly.`;
  }

  return "Done.";
}
