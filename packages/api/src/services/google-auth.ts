/**
 * Per-user Google OAuth2 client.
 *
 * Tokens come from the decrypted user_integrations row — not from disk.
 * When the access token is within 60 seconds of expiry, it is refreshed
 * automatically and the caller's `onTokenRefresh` callback is invoked so
 * the new tokens can be persisted back to the DB.
 */

import { google, type Auth } from "googleapis";

export interface GoogleSecrets {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  client_id: string;
  client_secret: string;
}

export type OnTokenRefresh = (updated: Partial<GoogleSecrets>) => Promise<void>;

const REFRESH_BUFFER_MS = 60_000; // refresh if expiring within 60 seconds

/**
 * Build an authenticated OAuth2Client for a user.
 * Auto-refreshes the access token if needed and calls onTokenRefresh to persist it.
 */
export async function getPerUserAuthClient(
  secrets: GoogleSecrets,
  onTokenRefresh: OnTokenRefresh
): Promise<Auth.OAuth2Client> {
  const oauth2 = new google.auth.OAuth2(
    secrets.client_id,
    secrets.client_secret,
    // redirect_uri not needed post-exchange
  );

  oauth2.setCredentials({
    access_token: secrets.access_token,
    refresh_token: secrets.refresh_token,
    expiry_date: secrets.expiry_date,
  });

  // Proactively refresh if within the buffer window
  if (secrets.expiry_date - Date.now() < REFRESH_BUFFER_MS) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      // Google omits refresh_token in refresh responses — always merge with stored value
      const updated: Partial<GoogleSecrets> = {
        access_token: credentials.access_token ?? secrets.access_token,
        expiry_date: (credentials.expiry_date as number) ?? secrets.expiry_date,
      };
      oauth2.setCredentials({ ...credentials, refresh_token: secrets.refresh_token });
      await onTokenRefresh(updated);
    } catch (err: any) {
      // Log message only — never log the credentials object
      console.error("Google token refresh failed:", err.message);
    }
  }

  return oauth2;
}
