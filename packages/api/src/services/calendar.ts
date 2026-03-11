/**
 * Google Calendar service — create events and list upcoming events.
 * Dates use the user's configured timezone from their profile.
 */

import { google, type Auth } from "googleapis";

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  link?: string;
}

/**
 * Convert "YYYY-MM-DD HH:MM" to a full ISO datetime string in the given timezone.
 * Throws if the format doesn't match.
 */
function parseDateTime(dt: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dt)) {
    throw new Error(`Date format must be YYYY-MM-DD HH:MM (e.g. 2026-03-01 14:00), got: "${dt}"`);
  }
  // Convert to ISO with seconds so Calendar API accepts it
  return dt.replace(" ", "T") + ":00";
}

export async function createCalendarEvent(
  auth: Auth.OAuth2Client,
  params: { title: string; start: string; end: string; description?: string },
  timezone: string
): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth });

  const startDt = parseDateTime(params.start, timezone);
  const endDt = parseDateTime(params.end, timezone);

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: params.title,
      description: params.description ?? "",
      start: { dateTime: startDt, timeZone: timezone },
      end: { dateTime: endDt, timeZone: timezone },
    },
  });

  const link = res.data.htmlLink ?? "";
  console.log(`Calendar event created: "${params.title}" — ${link}`);
  return `Event created: "${params.title}" on ${params.start}${link ? ` — ${link}` : ""}`;
}

export async function listUpcomingEvents(
  auth: Auth.OAuth2Client,
  timezone: string,
  days = 7
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
    timeZone: timezone,
  });

  return (res.data.items ?? []).map((event) => ({
    title: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    link: event.htmlLink ?? undefined,
  }));
}
