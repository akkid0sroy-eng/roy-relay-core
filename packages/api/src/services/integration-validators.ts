/**
 * Provider-specific validation functions.
 *
 * Each validator confirms that credentials are valid before we encrypt and
 * store them. They return provider-specific metadata (e.g. email, workspace
 * name) that we store in the non-sensitive `meta` column.
 *
 * The IntegrationValidators interface is injected into the route factory
 * so tests can swap in mocks without HTTP calls.
 */

// ── Result types ──────────────────────────────────────────────────────────────

export interface GoogleSecrets {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  client_id: string;
  client_secret: string;
}

export interface GoogleValidationResult {
  secrets: GoogleSecrets;
  meta: { email: string; scope: string[] };
}

export interface NotionValidationResult {
  meta: { workspace_name: string; bot_id: string };
}

// ── Validator interface ───────────────────────────────────────────────────────

export interface IntegrationValidators {
  /** Exchange an OAuth code for Google tokens and return user email. */
  validateGoogle(
    code: string,
    redirectUri: string
  ): Promise<GoogleValidationResult>;

  /** Confirm a Notion integration token is valid and return workspace info. */
  validateNotion(token: string): Promise<NotionValidationResult>;

  /** Validate a VAPI API key by fetching a phone number resource. */
  validateVapi(apiKey: string, phoneNumberId: string): Promise<boolean>;

  /** Validate an ElevenLabs API key. */
  validateElevenLabs(apiKey: string): Promise<boolean>;

  /** Validate a Tavily API key with a minimal search. */
  validateTavily(apiKey: string): Promise<boolean>;

  /** Validate a Groq API key with a minimal completion. */
  validateGroq(apiKey: string): Promise<boolean>;
}

// ── Default validators (real HTTP calls) ─────────────────────────────────────

export const defaultValidators: IntegrationValidators = {
  async validateGoogle(code, redirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.");

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      throw new Error(`Google token exchange failed: ${(err as any).error_description ?? tokenRes.statusText}`);
    }
    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };
    if (!tokens.refresh_token)
      throw new Error("Google did not return a refresh_token. Ensure access_type=offline and prompt=consent in the auth URL.");

    // Get user email to store as non-sensitive meta
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) throw new Error("Failed to fetch Google user info.");
    const userInfo = await userRes.json() as { email: string };

    return {
      secrets: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + tokens.expires_in * 1000,
        client_id: clientId,
        client_secret: clientSecret,
      },
      meta: {
        email: userInfo.email,
        scope: tokens.scope.split(" "),
      },
    };
  },

  async validateNotion(token) {
    const res = await fetch("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    });
    if (!res.ok) throw new Error("Invalid Notion integration token.");
    const user = await res.json() as { bot?: { workspace_name?: string }; id: string };
    return {
      meta: {
        workspace_name: user.bot?.workspace_name ?? "Notion workspace",
        bot_id: user.id,
      },
    };
  },

  async validateVapi(apiKey, phoneNumberId) {
    const res = await fetch(`https://api.vapi.ai/phone-number/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  },

  async validateElevenLabs(apiKey) {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": apiKey },
    });
    return res.ok;
  },

  async validateTavily(apiKey) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query: "test", max_results: 1 }),
    });
    return res.ok;
  },

  async validateGroq(apiKey) {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  },
};

// ── Auth URL builder (no validation needed, just constructs the URL) ──────────

export function buildGoogleAuthUrl(redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set.");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
    access_type: "offline",
    prompt: "consent", // always ask — ensures refresh_token is returned
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
