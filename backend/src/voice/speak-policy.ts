import { redact } from "../privacy/redact";

/**
 * Speak policy (AGENTS.md 9.2 rule 9, code-enforced): every agent sentence is
 * screened for sensitive values BEFORE text normalisation and synthesis, and
 * before it is emitted as `agent.text`. Matches are replaced with safe spoken
 * phrases so the agent can never say a card number, BVN/NIN, account number,
 * OTP/PIN, phone number, email or URL aloud — even if the LLM echoes one.
 *
 * Must run on the raw LLM sentence: `normaliseForSpeech` expands digits into
 * words, which would destroy the patterns this screens for.
 */

const PLACEHOLDER_PHRASES: Array<{ placeholder: string; kind: string; phrase: string }> = [
  { placeholder: "[CARD]", kind: "card", phrase: "your card number" },
  { placeholder: "[BVN_OR_NIN]", kind: "bvn_or_nin", phrase: "your B V N" },
  { placeholder: "[ACCOUNT]", kind: "account", phrase: "your account number" },
  { placeholder: "[OTP]", kind: "otp", phrase: "that code" },
  { placeholder: "[PHONE]", kind: "phone", phrase: "your phone number" },
  { placeholder: "[EMAIL]", kind: "email", phrase: "your email address" },
  { placeholder: "[URL]", kind: "url", phrase: "that link" },
];

export interface SpeakPolicyResult {
  /** Sentence with sensitive values replaced by safe phrases. */
  safe: string;
  /** True when at least one replacement was made. */
  tripped: boolean;
  /** Which placeholder kinds were replaced (for guardrail logging, no values). */
  kinds: string[];
}

export function applySpeakPolicy(sentence: string): SpeakPolicyResult {
  const redacted = redact(sentence);
  const kinds: string[] = [];
  let safe = redacted;
  for (const { placeholder, kind, phrase } of PLACEHOLDER_PHRASES) {
    if (safe.includes(placeholder)) {
      kinds.push(kind);
      safe = safe.split(placeholder).join(phrase);
    }
  }
  return { safe, tripped: kinds.length > 0, kinds };
}
