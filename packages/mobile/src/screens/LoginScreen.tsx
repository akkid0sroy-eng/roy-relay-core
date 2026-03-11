import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { supabase } from "../lib/supabase";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: "roy://auth/callback" },
    });
    setLoading(false);
    if (err) {
      setError(err.message);
    } else {
      setSent(true);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.logo}>Roy</Text>
        <Text style={styles.tagline}>Your AI relay</Text>

        {!sent ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="your@email.com"
              placeholderTextColor="#555"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              returnKeyType="send"
              onSubmitEditing={handleSend}
              editable={!loading}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleSend}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Send magic link</Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.sentBox}>
            <Text style={styles.sentIcon}>✉️</Text>
            <Text style={styles.sentTitle}>Check your email</Text>
            <Text style={styles.sentBody}>
              We sent a sign-in link to{"\n"}
              <Text style={styles.sentEmail}>{email}</Text>
            </Text>
            <Text style={styles.sentHint}>
              Tap the link in the email to open Roy automatically.
            </Text>
            <TouchableOpacity onPress={() => setSent(false)}>
              <Text style={styles.resend}>Use a different email</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  inner: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  logo: { fontSize: 48, fontWeight: "700", color: "#fff", letterSpacing: -1 },
  tagline: { fontSize: 16, color: "#666", marginTop: 6, marginBottom: 48 },
  input: {
    width: "100%",
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#2A2A2A",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: "#fff",
    marginBottom: 12,
  },
  error: { color: "#EF4444", fontSize: 13, marginBottom: 10, alignSelf: "flex-start" },
  button: {
    width: "100%",
    backgroundColor: "#6366F1",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  sentBox: { alignItems: "center", gap: 10 },
  sentIcon: { fontSize: 48, marginBottom: 8 },
  sentTitle: { fontSize: 22, fontWeight: "700", color: "#fff" },
  sentBody: { fontSize: 15, color: "#aaa", textAlign: "center", lineHeight: 22 },
  sentEmail: { color: "#fff", fontWeight: "600" },
  sentHint: { fontSize: 13, color: "#555", textAlign: "center", marginTop: 8 },
  resend: { color: "#6366F1", fontSize: 14, marginTop: 24 },
});
