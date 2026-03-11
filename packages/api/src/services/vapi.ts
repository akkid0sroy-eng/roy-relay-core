/**
 * VAPI service — make outbound phone calls.
 * Credentials come from the decrypted user_integrations row.
 */

export interface VapiSecrets {
  api_key: string;
  phone_number_id: string;
  destination_phone: string;
}

export async function makeVapiCall(
  secrets: VapiSecrets,
  params: { firstMessage: string; systemPrompt: string }
): Promise<string> {
  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secrets.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumberId: secrets.phone_number_id,
      customer: { number: secrets.destination_phone },
      assistant: {
        firstMessage: params.firstMessage,
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: params.systemPrompt }],
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`VAPI call failed: ${(err as any).message ?? res.statusText}`);
  }

  const data = await res.json() as { id: string };
  console.log(`VAPI call initiated: ${data.id}`);
  return data.id;
}
