// ── Action types ──────────────────────────────────────────────────────────────

export type ActionType =
  | "note"
  | "reminder"
  | "email_send"
  | "calendar_create"
  | "notion_create"
  | "phone_call";

export interface PendingAction {
  type: ActionType;
  description: string;
  data: string;
  /** Replay-protection flag — set to true while executeAction is running */
  executing?: boolean;
}

// ── Conversation history ──────────────────────────────────────────────────────

export type HistoryMessage = { role: "user" | "assistant"; content: string };

// ── Notion config (mirrors src/integrations/notion.ts) ───────────────────────

export interface NotionPropertyConfig {
  type: string;
  /** Valid values for select/status properties — surfaced in the prompt */
  options?: string[];
}

export interface NotionDatabaseConfig {
  id: string;
  titleProperty?: string;
  description?: string;
  properties?: Record<string, NotionPropertyConfig | string>;
}

export type NotionDatabasesMap = Record<string, NotionDatabaseConfig>;

// ── Configuration objects passed to core functions ────────────────────────────

export interface PromptConfig {
  userName?: string;
  userTimezone: string;
  profileContext?: string;
  tavilyEnabled?: boolean;
  gmailEnabled?: boolean;
  calendarEnabled?: boolean;
  notionEnabled?: boolean;
  notionDatabases?: NotionDatabasesMap;
  vapiEnabled?: boolean;
}

export interface ExecuteConfig {
  notesDir: string;
  remindersDir: string;
  userTimezone: string;
  userName?: string;
  profileContext?: string;
}
