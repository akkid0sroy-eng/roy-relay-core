import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, rm, readdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { executeAction, EXECUTE_TIMEOUT_MS } from "../src/execute.ts";
import type { ExecuteConfig, PendingAction } from "../src/types.ts";

// ── Test fixtures ─────────────────────────────────────────────────────────────

let testDir: string;
let notesDir: string;
let remindersDir: string;
let config: ExecuteConfig;

beforeEach(async () => {
  testDir = join(tmpdir(), `relay-core-test-${Date.now()}`);
  notesDir = join(testDir, "notes");
  remindersDir = join(testDir, "reminders");
  await mkdir(notesDir, { recursive: true });
  await mkdir(remindersDir, { recursive: true });
  config = {
    notesDir,
    remindersDir,
    userTimezone: "America/New_York",
    userName: "Alice",
  };
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── note ──────────────────────────────────────────────────────────────────────

describe("executeAction — note", () => {
  test("saves a note file and returns filename", async () => {
    const action: PendingAction = {
      type: "note",
      description: "Save workout",
      data: "ran 5km today",
    };
    const result = await executeAction(action, config);
    expect(result).toMatch(/Note saved as `note_\d+\.md`/);
    const files = await readdir(notesDir);
    expect(files).toHaveLength(1);
    expect(await readFile(join(notesDir, files[0]), "utf-8")).toBe("ran 5km today");
  });
});

// ── reminder ──────────────────────────────────────────────────────────────────

describe("executeAction — reminder", () => {
  test("saves a reminder file and returns filename", async () => {
    const action: PendingAction = {
      type: "reminder",
      description: "Call John",
      data: "Call John at 5pm tomorrow",
    };
    const result = await executeAction(action, config);
    expect(result).toMatch(/Reminder saved as `reminder_\d+\.txt`/);
    const files = await readdir(remindersDir);
    expect(files).toHaveLength(1);
    expect(await readFile(join(remindersDir, files[0]), "utf-8")).toBe(
      "Call John at 5pm tomorrow"
    );
  });
});

// ── email_send ────────────────────────────────────────────────────────────────

describe("executeAction — email_send", () => {
  // ALLOWED_EMAIL_DOMAINS is now mandatory — set it for the duration of this block.
  beforeEach(() => { process.env.ALLOWED_EMAIL_DOMAINS = "example.com"; });
  afterAll(() => { delete process.env.ALLOWED_EMAIL_DOMAINS; });

  test("calls sendEmail and returns result", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "bob@example.com", subject: "Hi", body: "Hello!" }),
    };
    const loaders = {
      loadGmail: async () => ({
        gmailEnabled: true,
        sendEmail: async () => "Email sent to bob@example.com",
      }),
    };
    const result = await executeAction(action, config, loaders);
    expect(result).toBe("Email sent to bob@example.com");
  });

  test("throws when gmailEnabled is false", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "bob@example.com", subject: "Hi", body: "Hello!" }),
    };
    await expect(
      executeAction(action, config, {
        loadGmail: async () => ({ gmailEnabled: false, sendEmail: async () => "" }),
      })
    ).rejects.toThrow("Gmail not configured");
  });

  test("throws when ALLOWED_EMAIL_DOMAINS is not configured", async () => {
    delete process.env.ALLOWED_EMAIL_DOMAINS;
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "bob@example.com", subject: "Hi", body: "Hello!" }),
    };
    await expect(
      executeAction(action, config, {
        loadGmail: async () => ({ gmailEnabled: true, sendEmail: async () => "" }),
      })
    ).rejects.toThrow("ALLOWED_EMAIL_DOMAINS must be configured");
  });

  test("throws when loader is not provided", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: "{}",
    };
    await expect(executeAction(action, config, {})).rejects.toThrow(
      "Gmail loader not provided"
    );
  });

  test("throws on invalid email address", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "notanemail", subject: "Hi", body: "Hello!" }),
    };
    await expect(
      executeAction(action, config, {
        loadGmail: async () => ({ gmailEnabled: true, sendEmail: async () => "" }),
      })
    ).rejects.toThrow("invalid 'to' address");
  });

  test("throws on empty subject", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "bob@example.com", subject: "", body: "Hello!" }),
    };
    await expect(
      executeAction(action, config, {
        loadGmail: async () => ({ gmailEnabled: true, sendEmail: async () => "" }),
      })
    ).rejects.toThrow("missing 'subject'");
  });

  test("throws on empty body", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Send email",
      data: JSON.stringify({ to: "bob@example.com", subject: "Hi", body: "" }),
    };
    await expect(
      executeAction(action, config, {
        loadGmail: async () => ({ gmailEnabled: true, sendEmail: async () => "" }),
      })
    ).rejects.toThrow("body is empty");
  });
});

// ── calendar_create ───────────────────────────────────────────────────────────

describe("executeAction — calendar_create", () => {
  const loader = {
    loadCalendar: async () => ({
      calendarEnabled: true,
      createCalendarEvent: async (p: any) => `Event created: ${p.title}`,
    }),
  };

  test("creates calendar event and returns confirmation", async () => {
    const action: PendingAction = {
      type: "calendar_create",
      description: "Team sync",
      data: JSON.stringify({
        title: "Team Sync",
        start: "2026-03-10 10:00",
        end: "2026-03-10 11:00",
      }),
    };
    const result = await executeAction(action, config, loader);
    expect(result).toBe("Event created: Team Sync");
  });

  test("throws when start >= end", async () => {
    const action: PendingAction = {
      type: "calendar_create",
      description: "Bad event",
      data: JSON.stringify({
        title: "Bad",
        start: "2026-03-10 11:00",
        end: "2026-03-10 10:00",
      }),
    };
    await expect(executeAction(action, config, loader)).rejects.toThrow(
      "start time must be before end time"
    );
  });

  test("throws on invalid date format", async () => {
    const action: PendingAction = {
      type: "calendar_create",
      description: "Bad date",
      data: JSON.stringify({
        title: "Meeting",
        start: "tomorrow",
        end: "later",
      }),
    };
    await expect(executeAction(action, config, loader)).rejects.toThrow(
      "Invalid start date"
    );
  });

  test("throws when calendarEnabled is false", async () => {
    const action: PendingAction = {
      type: "calendar_create",
      description: "Meeting",
      data: JSON.stringify({ title: "X", start: "2026-03-10 10:00", end: "2026-03-10 11:00" }),
    };
    await expect(
      executeAction(action, config, {
        loadCalendar: async () => ({
          calendarEnabled: false,
          createCalendarEvent: async () => "",
        }),
      })
    ).rejects.toThrow("Calendar not configured");
  });
});

// ── notion_create ─────────────────────────────────────────────────────────────

describe("executeAction — notion_create", () => {
  test("creates Notion page and returns confirmation", async () => {
    const action: PendingAction = {
      type: "notion_create",
      description: "Add task",
      data: JSON.stringify({
        title: "Review Q2 roadmap",
        content: "Check with stakeholders",
        database: "tasks",
      }),
    };
    const loaders = {
      loadNotion: async () => ({
        notionEnabled: true,
        createNotionPage: async (p: any) => `Page created: ${p.title}`,
      }),
    };
    const result = await executeAction(action, config, loaders);
    expect(result).toBe("Page created: Review Q2 roadmap");
  });

  test("throws on title too long", async () => {
    const action: PendingAction = {
      type: "notion_create",
      description: "Long title",
      data: JSON.stringify({
        title: "x".repeat(2001),
        content: "",
        database: "tasks",
      }),
    };
    await expect(
      executeAction(action, config, {
        loadNotion: async () => ({ notionEnabled: true, createNotionPage: async () => "" }),
      })
    ).rejects.toThrow("too long");
  });

  test("throws when notionEnabled is false", async () => {
    const action: PendingAction = {
      type: "notion_create",
      description: "Add task",
      data: JSON.stringify({ title: "Task", content: "", database: "tasks" }),
    };
    await expect(
      executeAction(action, config, {
        loadNotion: async () => ({
          notionEnabled: false,
          createNotionPage: async () => "",
        }),
      })
    ).rejects.toThrow("Notion not configured");
  });
});

// ── timeout (R7) ──────────────────────────────────────────────────────────────

describe("executeAction — timeout", () => {
  test("EXECUTE_TIMEOUT_MS is 30 000", () => {
    expect(EXECUTE_TIMEOUT_MS).toBe(30_000);
  });

  test("rejects with timeout error when action hangs beyond _timeoutMs", async () => {
    const action: PendingAction = {
      type: "email_send",
      description: "Slow email",
      data: JSON.stringify({ to: "bob@example.com", subject: "Hi", body: "Hello!" }),
    };
    const originalDomains = process.env.ALLOWED_EMAIL_DOMAINS;
    process.env.ALLOWED_EMAIL_DOMAINS = "example.com";
    try {
      await expect(
        executeAction(
          action,
          config,
          {
            // loader that never resolves — simulates a hung integration
            loadGmail: () => new Promise(() => {}),
          },
          50 // 50 ms timeout in test
        )
      ).rejects.toThrow("Action timed out after 0.05s");
    } finally {
      if (originalDomains === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
      else process.env.ALLOWED_EMAIL_DOMAINS = originalDomains;
    }
  });
});

// ── phone_call ────────────────────────────────────────────────────────────────

describe("executeAction — phone_call", () => {
  test("initiates a call and returns call ID", async () => {
    const action: PendingAction = {
      type: "phone_call",
      description: "Call user",
      data: JSON.stringify({ message: "calling to check in", reason: "user requested" }),
    };
    const loaders = {
      loadVapi: async () => ({
        vapiEnabled: true,
        makeVapiCall: async () => "call-abc123xyz",
      }),
    };
    const result = await executeAction(action, config, loaders);
    expect(result).toContain("Call initiated");
    expect(result).toContain("call-abc");
  });

  test("throws when vapiEnabled is false", async () => {
    const action: PendingAction = {
      type: "phone_call",
      description: "Call",
      data: "{}",
    };
    await expect(
      executeAction(action, config, {
        loadVapi: async () => ({
          vapiEnabled: false,
          makeVapiCall: async () => "",
        }),
      })
    ).rejects.toThrow("VAPI not configured");
  });
});
