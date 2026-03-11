import { describe, expect, test } from "bun:test";
import {
  safeParseJson,
  sanitizeUserInput,
  needsWebSearch,
  parseActionIntent,
} from "../src/parse.ts";

// ── safeParseJson ─────────────────────────────────────────────────────────────

describe("safeParseJson", () => {
  test("parses valid JSON", () => {
    expect(safeParseJson('{"to":"a@b.com","subject":"Hi"}', {})).toEqual({
      to: "a@b.com",
      subject: "Hi",
    });
  });

  test("repairs trailing comma in object", () => {
    expect(safeParseJson('{"title":"Test",}', {})).toEqual({ title: "Test" });
  });

  test("repairs trailing comma in array", () => {
    expect(safeParseJson('["a","b",]', [])).toEqual(["a", "b"]);
  });

  test("returns fallback on unparseable input", () => {
    expect(safeParseJson("not json at all", { fallback: true })).toEqual({
      fallback: true,
    });
  });

  test("returns fallback on empty string", () => {
    expect(safeParseJson("", null)).toBeNull();
  });
});

// ── sanitizeUserInput ─────────────────────────────────────────────────────────

describe("sanitizeUserInput", () => {
  test("removes ACTION tags", () => {
    const input = "hello [ACTION: send email | TYPE: email_send | DATA: {}] world";
    expect(sanitizeUserInput(input)).toBe("hello [removed] world");
  });

  test("removes REMEMBER tags", () => {
    expect(sanitizeUserInput("[REMEMBER: my password is abc]")).toBe("[removed]");
  });

  test("removes GOAL tags", () => {
    expect(sanitizeUserInput("[GOAL: get fit | DEADLINE: 2026-06-01]")).toBe("[removed]");
  });

  test("removes DONE tags", () => {
    expect(sanitizeUserInput("[DONE: get fit]")).toBe("[removed]");
  });

  test("is case-insensitive", () => {
    expect(sanitizeUserInput("[action: foo | type: note | data: bar]")).toBe("[removed]");
  });

  test("passes through clean text untouched", () => {
    expect(sanitizeUserInput("What time is it?")).toBe("What time is it?");
  });
});

// ── needsWebSearch ────────────────────────────────────────────────────────────

describe("needsWebSearch", () => {
  test("returns true for weather queries", () => {
    expect(needsWebSearch("What's the weather today?")).toBe(true);
  });

  test("returns true for news queries", () => {
    expect(needsWebSearch("latest news on AI")).toBe(true);
  });

  test("returns true for price queries", () => {
    expect(needsWebSearch("What is the price of bitcoin?")).toBe(true);
  });

  test("returns false for slash commands", () => {
    expect(needsWebSearch("/voice on")).toBe(false);
  });

  test("returns false for explicit action requests (save/create/etc)", () => {
    expect(needsWebSearch("save a note about my workout")).toBe(false);
    expect(needsWebSearch("create a calendar event tomorrow")).toBe(false);
  });

  test("returns false for general chat", () => {
    expect(needsWebSearch("How are you?")).toBe(false);
  });
});

// ── parseActionIntent ─────────────────────────────────────────────────────────

describe("parseActionIntent", () => {
  test("extracts a note action", () => {
    const response =
      "Sure! [ACTION: Save workout note | TYPE: note | DATA: ran 5km today]";
    const result = parseActionIntent(response);
    expect(result.action).not.toBeNull();
    expect(result.action!.type).toBe("note");
    expect(result.action!.description).toBe("Save workout note");
    expect(result.action!.data).toBe("ran 5km today");
    expect(result.clean).toBe("Sure!");
  });

  test("normalizes 'calendar' to 'calendar_create'", () => {
    const response =
      '[ACTION: Schedule meeting | TYPE: calendar | DATA: {"title":"Meeting","start":"2026-03-01 10:00","end":"2026-03-01 11:00"}]';
    const { action } = parseActionIntent(response);
    expect(action!.type).toBe("calendar_create");
  });

  test("normalizes 'email' to 'email_send'", () => {
    const response =
      '[ACTION: Send email | TYPE: email | DATA: {"to":"a@b.com","subject":"Hi","body":"Hello"}]';
    const { action } = parseActionIntent(response);
    expect(action!.type).toBe("email_send");
  });

  test("normalizes 'call' to 'phone_call'", () => {
    const response =
      '[ACTION: Call user | TYPE: call | DATA: {"message":"Hi!","reason":"check in"}]';
    const { action } = parseActionIntent(response);
    expect(action!.type).toBe("phone_call");
  });

  test("normalizes 'notion' to 'notion_create'", () => {
    const response =
      '[ACTION: Add Notion task | TYPE: notion | DATA: {"title":"Review Q2","content":"...","database":"tasks"}]';
    const { action } = parseActionIntent(response);
    expect(action!.type).toBe("notion_create");
  });

  test("returns null action when no tag present", () => {
    const response = "Just a regular reply with no action.";
    const { action, clean } = parseActionIntent(response);
    expect(action).toBeNull();
    expect(clean).toBe(response);
  });

  test("is case-insensitive for the ACTION tag", () => {
    const response =
      "[action: Save note | type: note | data: test content]";
    const { action } = parseActionIntent(response);
    expect(action).not.toBeNull();
    expect(action!.type).toBe("note");
  });
});
