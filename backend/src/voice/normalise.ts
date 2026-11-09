/**
 * Text normalisation before TTS (AGENTS.md 5.6 subset for the voice loop).
 *
 * Pure functions: naira amounts, Nigerian phone numbers, "ending in" digit
 * strings, times, dates, acronym spelling, and removal of markdown, emoji,
 * bullets, URLs and emails (never read aloud).
 */

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const ORDINAL_ONES = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
  "eighteenth", "nineteenth",
];

const ORDINAL_TENS = ["", "", "twentieth", "thirtieth"];

const MONTHS: Record<string, string> = {
  jan: "January", january: "January",
  feb: "February", february: "February",
  mar: "March", march: "March",
  apr: "April", april: "April",
  may: "May",
  jun: "June", june: "June",
  jul: "July", july: "July",
  aug: "August", august: "August",
  sep: "September", sept: "September", september: "September",
  oct: "October", october: "October",
  nov: "November", november: "November",
  dec: "December", december: "December",
};

/** Spell each digit of `digits`, joined with ", " ("4421" -> "four, four, two, one"). */
export function spellDigits(digits: string): string {
  return [...digits].map((d) => DIGITS[Number(d)] ?? d).join(", ");
}

function intWords(n: number): string {
  if (n < 0) return `minus ${intWords(-n)}`;
  if (n < 20) return ONES[n] as string;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] as string;
    return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10] as string}`;
  }
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)] as string} hundred${rest === 0 ? "" : ` ${intWords(rest)}`}`;
  }
  if (n < 1_000_000) return scale(n, 1000, "thousand");
  if (n < 1_000_000_000) return scale(n, 1_000_000, "million");
  return scale(n, 1_000_000_000, "billion");
}

function scale(n: number, unit: number, name: string): string {
  const head = Math.floor(n / unit);
  const rest = n % unit;
  return `${intWords(head)} ${name}${rest === 0 ? "" : ` ${intWords(rest)}`}`;
}

function decimalWords(value: string): string {
  const [head, tail] = value.split(".");
  const words = intWords(Number(head));
  if (tail === undefined || tail === "") return words;
  return `${words} point ${[...tail].map((d) => DIGITS[Number(d)] as string).join(" ")}`;
}

function ordinalDay(day: number): string {
  if (day <= 0 || day > 31) return intWords(day);
  if (day < 20) return `the ${ORDINAL_ONES[day] as string}`;
  if (day % 10 === 0) return `the ${ORDINAL_TENS[day / 10] as string}`;
  return `the ${TENS[Math.floor(day / 10)] as string}-${ORDINAL_ONES[day % 10] as string}`;
}

function yearWords(year: number): string {
  if (year < 100) return intWords(year);
  if (year % 100 === 0) return `${intWords(Math.floor(year / 100))} hundred`;
  const head = Math.floor(year / 100);
  const tail = year % 100;
  const tailWords = tail < 10 ? `oh ${ONES[tail] as string}` : intWords(tail);
  return `${intWords(head)} ${tailWords}`;
}

function stripMarkdownAndEmoji(text: string): string {
  return (
    text
      // fenced code blocks and inline code keep their inner text
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ""))
      .replace(/`([^`]*)`/g, "$1")
      // images and links keep their visible text; bare URLs are dropped later
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,!?])/g, "$1$2")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^(\s*[-*+]|\s*\d+[.)])\s+/gm, "")
      .replace(/\|/g, ", ")
      .replace(/\p{Extended_Pictographic}/gu, "")
  );
}

const URL_PATTERN = /https?:\/\/\S+|www\.\S+\.\S+/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const NAIRA_PATTERN = /(?:₦\s?|NGN\s*|N(?=\d))([\d,]+(?:\.\d+)?)(?:\s*(k|m|bn|billion|million|thousand))?\b/gi;

function nairaWords(amount: string, suffix: string | undefined): string {
  const numeric = Number(amount.replace(/,/g, ""));
  const s = (suffix ?? "").toLowerCase();
  if (s === "k" || s === "thousand") return `${decimalWords(scaleNumber(numeric * 1000))} naira`;
  if (s === "m" || s === "million") {
    return Number.isInteger(numeric)
      ? `${intWords(numeric)} million naira`
      : `${decimalWords(String(numeric))} million naira`;
  }
  if (s === "bn" || s === "billion") {
    return Number.isInteger(numeric)
      ? `${intWords(numeric)} billion naira`
      : `${decimalWords(String(numeric))} billion naira`;
  }
  if (!Number.isInteger(numeric)) {
    const [whole, frac = ""] = String(numeric).split(".");
    if (frac.length <= 2 && whole !== undefined) {
      const kobo = Number(frac.padEnd(2, "0"));
      const nairaPart = Number(whole) === 0 ? "" : `${intWords(Number(whole))} naira`;
      const koboPart = kobo === 0 ? "" : `${intWords(kobo)} kobo`;
      return [nairaPart, koboPart].filter(Boolean).join(", ");
    }
    return `${decimalWords(String(numeric))} naira`;
  }
  return `${intWords(numeric)} naira`;
}

function scaleNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const ENDING_IN_PATTERN = /\bending in (\d{3,6})\b/gi;

/** Nigerian mobile formats: 0803 123 4567, +234 803 123 4567, 2348031234567, 08031234567. */
const PHONE_PATTERN = /(?:\+234[\s-]?|234[\s-]?)?(?:0?[789][01]\d[\s-]?\d{3}[\s-]?\d{4})\b/g;

function phoneWords(match: string): string {
  const compact = match.replace(/[\s-]/g, "");
  let national = compact;
  let prefix = "";
  if (compact.startsWith("+234")) {
    prefix = "plus two three four";
    national = compact.slice(4);
  } else if (compact.startsWith("234") && compact.length === 13) {
    prefix = "two three four";
    national = compact.slice(3);
  }
  const groups =
    national.length === 11 && national.startsWith("0")
      ? [national.slice(0, 4), national.slice(4, 7), national.slice(7)]
      : [national.slice(0, 3), national.slice(3, 6), national.slice(6)].filter(Boolean);
  const spoken = groups.map((g) => [...g].map((d) => DIGITS[Number(d)] as string).join(" ")).join(", ");
  return prefix === "" ? spoken : `${prefix}, ${spoken}`;
}

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/gi;

function timeWords(hourRaw: string, minuteRaw: string, suffixRaw: string | undefined): string {
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const suffix = suffixRaw?.replace(/\./g, "").toLowerCase();
  const minuteWords = minute < 10 ? `oh ${ONES[minute] as string}` : intWords(minute);
  if (suffix === "am" || suffix === "pm") {
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const hourWords = intWords(h12);
    const period = suffix === "am" ? "in the morning" : hour12IsEvening(hour) ? "in the evening" : "in the afternoon";
    if (minute === 0) return `${hourWords} o'clock ${period}`;
    if (minute === 30) return `half past ${hourWords} ${period}`;
    return `${hourWords} ${minuteWords} ${period}`;
  }
  const h24 = hour % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? "a m" : "p m";
  if (minute === 0) return `${intWords(h12)} o'clock ${meridiem}`;
  return `${intWords(h12)} ${minuteWords} ${meridiem}`;
}

function hour12IsEvening(hour: number): boolean {
  const h = hour % 12;
  return h >= 5 && h <= 11;
}

const DATE_SLASH_PATTERN = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const MONTH_NAMES = Object.keys(MONTHS).join("|");
const DATE_MONTH_FIRST_PATTERN = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const DATE_DAY_FIRST_PATTERN = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\.?\\b`, "gi");

function slashDateWords(dayRaw: string, monthRaw: string, yearRaw: string | undefined): string {
  let day = Number(dayRaw);
  let month = Number(monthRaw);
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > 31) return `${dayRaw}/${monthRaw}${yearRaw ? `/${yearRaw}` : ""}`;
  const monthName = monthNameByIndex(month);
  const base = `${ordinalDay(day)} of ${monthName}`;
  if (!yearRaw) return base;
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  return `${base}, ${yearWords(year)}`;
}

function monthNameByIndex(month: number): string {
  return (
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][
      month - 1
    ] as string
  );
}

const ACRONYM_PATTERN = /\b(BVN|NIN|POS|NUBAN)\b/g;

/**
 * Normalise display text into words safe to speak: expands amounts, numbers,
 * times and dates, and strips anything that must never be read aloud.
 */
export function normaliseForSpeech(input: string): string {
  let text = stripMarkdownAndEmoji(input);
  text = text.replace(EMAIL_PATTERN, "");
  text = text.replace(URL_PATTERN, "");
  text = text.replace(NAIRA_PATTERN, (_m, amount: string, suffix: string | undefined) =>
    nairaWords(amount, suffix),
  );
  text = text.replace(ENDING_IN_PATTERN, (_m, digits: string) => `ending in ${spellDigits(digits)}`);
  text = text.replace(PHONE_PATTERN, (m) => phoneWords(m));
  text = text.replace(TIME_PATTERN, (_m, h: string, min: string, suffix: string | undefined) =>
    timeWords(h, min, suffix),
  );
  text = text.replace(DATE_SLASH_PATTERN, (_m, d: string, mo: string, y: string | undefined) =>
    slashDateWords(d, mo, y),
  );
  text = text.replace(DATE_MONTH_FIRST_PATTERN, (_m, month: string, day: string) => {
    const name = MONTHS[month.toLowerCase()] as string;
    return `${ordinalDay(Number(day))} of ${name}`;
  });
  text = text.replace(DATE_DAY_FIRST_PATTERN, (_m, day: string, month: string) => {
    const name = MONTHS[month.toLowerCase()] as string;
    return `${ordinalDay(Number(day))} of ${name}`;
  });
  text = text.replace(ACRONYM_PATTERN, (_m, acronym: string) => [...acronym].join(" "));
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
