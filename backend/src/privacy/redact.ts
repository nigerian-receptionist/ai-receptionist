/**
 * Redaction before storage (AGENTS.md 9.2 rule 10): pure function that replaces
 * sensitive values with typed placeholders. Order matters: URLs first (they may
 * contain digits), then phones before cards (a `+234…` digit run must not be
 * mistaken for a card), cards before plain 10/11-digit runs.
 *
 * STT emits dictated digits in groups ("2212 345 6789"), so every digit rule
 * allows single spaces/dashes between digits and classifies by digit count.
 */

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (doubleDigit) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleDigit = !doubleDigit;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const URL_RE = /https?:\/\/\S+|www\.\S+\.\S+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 4-8 digits after code/OTP/PIN/password; longer runs are left for card/phone rules.
const OTP_RE = /(\b(?:code|otp|pin|password)\s*(?:is|:|#|-|=)?\s*)(?<!\d)(\d(?:[\s-]?\d){3,7})(?!\d)/gi;
const PHONE_PLUS234_RE = /(?<!\d)\+234(?:[\s-]?\d){10}(?!\d)/g;
const PHONE_LOCAL_RE = /(?<!\d)0[789][01](?:[\s-]?\d){8}(?!\d)/g;
const CARD_CANDIDATE_RE = /(?<!\d)\d(?:[\s-]?\d){12,18}(?!\d)/g;
const BVN_RE = /(?<!\d)\d(?:[\s-]?\d){10}(?!\d)/g;
const NUBAN_RE = /(?<!\d)\d(?:[\s-]?\d){9}(?!\d)/g;
// Trailing punctuation that belongs to the sentence, not the URL.
const URL_TRAILING_PUNCT_RE = /[.,!?;:)\]}>]+$/;

export function redact(text: string): string {
  return text
    .replace(URL_RE, (match) => {
      const trailing = match.match(URL_TRAILING_PUNCT_RE)?.[0] ?? "";
      return `[URL]${trailing}`;
    })
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(OTP_RE, "$1[OTP]")
    .replace(PHONE_PLUS234_RE, "[PHONE]")
    .replace(PHONE_LOCAL_RE, "[PHONE]")
    .replace(CARD_CANDIDATE_RE, (match) => {
      const digits = match.replace(/[\s-]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
        ? "[CARD]"
        : match;
    })
    .replace(BVN_RE, "[BVN_OR_NIN]")
    .replace(NUBAN_RE, "[ACCOUNT]");
}
