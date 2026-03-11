/**
 * Tests for the Notion service — focuses on database key validation (M2 fix).
 *
 * The actual Notion API call is short-circuited by using a `databases` map
 * that contains the key under test, then letting the Client constructor throw
 * because there is no real auth token (we validate before reaching the API).
 */

import { describe, expect, test, mock } from "bun:test";
import type { NotionDatabasesMap } from "@relay/core";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DATABASES: NotionDatabasesMap = {
  tasks:  { id: "db-uuid-tasks",  description: "Task tracker" },
  notes:  { id: "db-uuid-notes",  description: "Quick notes"  },
};

// Import the function under test. It will attempt to call Notion API on success
// paths, so we only test the validation paths that throw before the API call.
import { createNotionPage } from "../src/services/notion.ts";

// ── Database key validation ───────────────────────────────────────────────────

describe("createNotionPage — database key validation (M2)", () => {
  test("throws when database key is not in the user's map", async () => {
    await expect(
      createNotionPage("token", DATABASES, {
        title: "Test",
        content: "Hello",
        database: "nonexistent",
      })
    ).rejects.toThrow("not in your Notion integration settings");
  });

  test("error message does not reveal the available database keys", async () => {
    let errorMessage = "";
    try {
      await createNotionPage("token", DATABASES, {
        title: "Test",
        content: "Hello",
        database: "secret_probe",
      });
    } catch (err: any) {
      errorMessage = err.message;
    }
    expect(errorMessage).toBeTruthy();
    // Must NOT expose the real keys ("tasks", "notes") to an attacker probing via LLM injection
    expect(errorMessage).not.toContain("tasks");
    expect(errorMessage).not.toContain("notes");
  });

  test("throws with 'no databases configured' when map is empty", async () => {
    await expect(
      createNotionPage("token", {}, {
        title: "Test",
        content: "Hello",
        database: "",
      })
    ).rejects.toThrow("No Notion databases are configured");
  });
});
