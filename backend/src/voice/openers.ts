/**
 * Deterministic openers: at STT final (before the LLM call), the caller's
 * transcript is classified with simple rules (no extra model call) and mapped
 * to a pre-rendered opener block with a matching emotion. The opener always
 * plays while the LLM generates the rest of the reply, so the caller never
 * waits in silence; the LLM is told what was said and continues from there.
 */

import type { ChatMessage } from "./adapters/types";
import {
  OPENER_CONFIRMATION_BLOCKS,
  OPENER_PROBLEM_BLOCKS,
  OPENER_QUESTION_BLOCKS,
  type BlockDefinition,
} from "./blocks/block-cache";
import type { ToneName } from "./tone";

export type CallerCategory = "question" | "problem" | "confirmation" | "greeting" | "other";

/** Leading salutations are stripped before classification (the substance wins). */
const LEADING_GREETING_RE =
  /^(hi|hey|hello|good morning|good afternoon|good evening|good day|good night|greetings|bye|goodbye)[,.\s]+/i;

/**
 * Problem / complaint / distress. Checked first so escalation phrases
 * (self-harm, threats, abuse, legal) always land here: they get a sympathetic
 * opener, never a cheerful one. Includes common Pidgin distress markers.
 */
const PROBLEM_RE =
  /\b(problem|issues?|complain\w*|wrong|bad|angry|upset|frustrat\w*|annoy\w*|terrible|awful|horrible|poor|sorry|not working|doesn'?t work|does not work|won'?t work|fail\w*|error|mistake|overcharg\w*|incorrect|dispute|fraud|scam|stol\w*|lost|missing|broke|broken|damaged|late|delay\w*|never|nobody|can'?t|cannot|unable|won'?t|refus\w*|denied|denial|reject\w*|debt|harass\w*|cheat\w*|lied?|lying|threat\w*|kill\w*|died?|dying|dies|death|suicid\w*|self[\s-]?harm|hurt|abus\w*|lawyer|court|sue|sued|suing|police|legal|emergency|urgent|worried|scared|afraid|cry|crying|pain|hospital|sick|funeral|wahala|na wa)\b/i;

/** Greeting / thanks / small-talk: only when the turn is nothing else. */
const GREETING_FULL_RE =
  /^(hi|hey|hello|good morning|good afternoon|good evening|good day|good night|greetings|how are you|how far|how is it going|thanks|thank you|thank u|thx|welcome|bye|goodbye|see you|well done)[\s?!.]*$/i;

/** Question / request markers (plus any literal question mark). */
const QUESTION_WORD_RE =
  /\b(what|when|where|who|whom|whose|why|how|which|whether|can you|could you|would you|will you|do you|does|did|is there|are there|have you|tell me|show me|explain|check|confirm|verify|balance|mean|meaning|called|calling|abeg|please|kindly|want|need|wanna|like to|send|book|schedule|arrange|apply|register|open|close|transfer|pay|repay|borrow|loan|interest|rate|account)\b/i;

/** Yes / no / confirmation: the turn opens with an acknowledgement word. */
const CONFIRM_START_RE =
  /^(yes|yeah|yep|yup|no|nope|nah|correct|right|exactly|precisely|true|false|confirmed|confirm|agreed|okay|ok|sure|alright|all right)\b/i;

/**
 * Classify the caller's transcript. Order matters: problem first (escalation
 * safety), then greeting (so "how are you?" is small-talk, not a question),
 * then question, then confirmation; anything else (statements, other
 * languages) is `other` and gets no opener.
 */
export function classifyCallerTurn(text: string): CallerCategory {
  if (text.trim() === "") return "other";
  let rest = text.trim();
  for (let i = 0; i < 3 && rest !== ""; i += 1) {
    const stripped = rest.replace(LEADING_GREETING_RE, "").trim();
    if (stripped === rest) break;
    rest = stripped;
  }
  if (rest === "") return "greeting";
  if (PROBLEM_RE.test(rest)) return "problem";
  if (GREETING_FULL_RE.test(rest)) return "greeting";
  if (rest.includes("?") || QUESTION_WORD_RE.test(rest)) return "question";
  if (CONFIRM_START_RE.test(rest)) return "confirmation";
  return "other";
}

export interface OpenerOption {
  block: BlockDefinition;
  tone: ToneName;
}

/** Opener options per category, each rendered with its matching tone. */
export const OPENERS: Record<"question" | "problem" | "confirmation", OpenerOption[]> = {
  question: OPENER_QUESTION_BLOCKS.map((block) => ({ block, tone: "neutral" as ToneName })),
  problem: OPENER_PROBLEM_BLOCKS.map((block) => ({ block, tone: "empathetic" as ToneName })),
  confirmation: OPENER_CONFIRMATION_BLOCKS.map((block) => ({ block, tone: "warm" as ToneName })),
};

/**
 * Rotating opener picker (one per session). Alternates within a category so
 * the last opener never repeats; each category has an independent cursor.
 */
export class OpenerSelector {
  private readonly cursors: Record<"question" | "problem" | "confirmation", number> = {
    question: 0,
    problem: 0,
    confirmation: 0,
  };

  choose(category: CallerCategory): OpenerOption | null {
    if (category !== "question" && category !== "problem" && category !== "confirmation") {
      return null;
    }
    const options = OPENERS[category];
    const option = options[this.cursors[category] % options.length] as OpenerOption;
    this.cursors[category] += 1;
    return option;
  }
}

/**
 * Messages appended for the opener turn: the opener as the agent's own last
 * line, plus a system note quoting it so the LLM continues naturally instead
 * of opening with another acknowledgement.
 */
export function openerMessages(openerText: string): ChatMessage[] {
  return [
    { role: "assistant", content: openerText },
    {
      role: "system",
      content:
        `You already said "${openerText}" aloud and the caller is hearing it now. ` +
        `Continue naturally from there: do not open with another acknowledgement ` +
        `("Sure", "Okay", "Of course", "Certainly", ...); go straight to the substance of your reply.`,
    },
  ];
}
