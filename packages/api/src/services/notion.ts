/**
 * Notion service — create pages across user-configured databases.
 * The Notion token and database map come from the decrypted user_integrations row.
 */

import { Client } from "@notionhq/client";
import type { NotionDatabasesMap, NotionPropertyConfig } from "@relay/core";

export async function createNotionPage(
  token: string,
  databases: NotionDatabasesMap,
  params: {
    title: string;
    content: string;
    database: string;
    properties?: Record<string, string>;
  }
): Promise<string> {
  const notion = new Client({ auth: token });

  // Resolve which database to write to.
  // Only keys already present in the user's encrypted databases map are permitted —
  // this prevents LLM-injected keys from targeting unintended databases.
  const dbKey = params.database || Object.keys(databases)[0];
  if (!dbKey || !(dbKey in databases)) {
    // Don't reveal the available keys in the error — that would let a prompt-injected
    // LLM enumerate the user's database configuration.
    throw new Error(
      params.database
        ? `Database key "${params.database}" is not in your Notion integration settings.`
        : "No Notion databases are configured in your integration settings."
    );
  }
  const dbConfig = databases[dbKey];

  // Discover the title property name (use config or detect from schema)
  const titleProp = dbConfig.titleProperty ?? (await detectTitleProperty(notion, dbConfig.id));

  // Build the properties payload
  const properties: Record<string, unknown> = {
    [titleProp]: { title: [{ text: { content: params.title } }] },
  };

  // Map any extra properties the LLM provided
  if (params.properties && dbConfig.properties) {
    for (const [propName, rawValue] of Object.entries(params.properties)) {
      const propDef = dbConfig.properties[propName];
      if (!propDef) continue;
      const cfg: NotionPropertyConfig =
        typeof propDef === "string" ? { type: propDef } : propDef;
      properties[propName] = buildPropertyValue(cfg.type, rawValue);
    }
  }

  const page = await notion.pages.create({
    parent: { database_id: dbConfig.id },
    properties: properties as any,
    children: params.content
      ? [
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [{ type: "text" as const, text: { content: params.content } }],
            },
          },
        ]
      : [],
  });

  const url = (page as any).url ?? "";
  console.log(`Notion page created: "${params.title}" in ${dbKey} — ${url}`);
  return `Notion page created: "${params.title}"${url ? ` — ${url}` : ""}`;
}

/** Fetch the database schema and find the property of type "title". Cached per process lifetime. */
const titlePropCache = new Map<string, string>();

async function detectTitleProperty(notion: Client, databaseId: string): Promise<string> {
  if (titlePropCache.has(databaseId)) return titlePropCache.get(databaseId)!;

  const db = await notion.databases.retrieve({ database_id: databaseId });
  const titleEntry = Object.entries(db.properties).find(
    ([, v]) => v.type === "title"
  );
  if (!titleEntry) throw new Error(`Could not detect title property for database ${databaseId}`);

  titlePropCache.set(databaseId, titleEntry[0]);
  return titleEntry[0];
}

/** Map a simple string value to the correct Notion property shape. */
function buildPropertyValue(type: string, value: string): unknown {
  switch (type) {
    case "rich_text":
      return { rich_text: [{ text: { content: value } }] };
    case "select":
      return { select: { name: value } };
    case "multi_select":
      return { multi_select: value.split(",").map((v) => ({ name: v.trim() })) };
    case "status":
      return { status: { name: value } };
    case "date":
      return { date: { start: value } };
    case "number":
      return { number: parseFloat(value) };
    case "checkbox":
      return { checkbox: value === "true" || value === "yes" };
    case "url":
      return { url: value };
    case "email":
      return { email: value };
    default:
      return { rich_text: [{ text: { content: value } }] };
  }
}
