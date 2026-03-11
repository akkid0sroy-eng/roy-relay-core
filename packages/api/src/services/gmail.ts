/**
 * Gmail service — send and search emails using a per-user OAuth2 client.
 * Returns only summaries for search results — never full message bodies.
 */

import { google, type Auth } from "googleapis";

export interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export async function sendEmail(
  auth: Auth.OAuth2Client,
  params: { to: string; subject: string; body: string }
): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });

  // Build RFC 2822 message
  const raw = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  // Log recipient only — never log body
  console.log(`Email sent to ${params.to}, messageId: ${res.data.id}`);
  return `Email sent to ${params.to} (id: ${res.data.id})`;
}

export async function searchEmails(
  auth: Auth.OAuth2Client,
  query: string,
  maxResults = 5
): Promise<EmailSummary[]> {
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const ids = list.data.messages ?? [];
  if (ids.length === 0) return [];

  const messages = await Promise.all(
    ids.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      })
    )
  );

  return messages.map((msg) => {
    const headers = msg.data.payload?.headers ?? [];
    const h = (name: string) =>
      headers.find((hdr) => hdr.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
    return {
      from: h("From"),
      subject: h("Subject"),
      snippet: msg.data.snippet ?? "",
      date: h("Date"),
    };
  });
}
