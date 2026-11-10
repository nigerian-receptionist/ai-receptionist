/**
 * Typed domain errors. Each carries an HTTP status and a stable problem type
 * (AGENTS.md 8.3, M35); the problem filter maps them to RFC 9457 responses.
 * Details never include secrets or raw PII.
 */

export const PROBLEM_BASE = "urn:ai-receptionist";

export class ProblemError extends Error {
  readonly status: number;
  readonly problemType: string;

  constructor(status: number, problemType: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.problemType = `${PROBLEM_BASE}:${problemType}`;
  }
}

/** 404: the id is well-formed but nothing is visible under this tenant. */
export class NotFoundError extends ProblemError {
  constructor(resource = "resource") {
    super(404, "not-found", `${resource} not found`);
  }
}

/** 400: cursor is malformed (never trust client cursors). */
export class InvalidCursorError extends ProblemError {
  constructor() {
    super(400, "invalid-cursor", "Invalid cursor");
  }
}

/** 400: public id is malformed (wrong prefix or encoding). */
export class InvalidIdError extends ProblemError {
  constructor(resource = "id") {
    super(400, "invalid-id", `Invalid ${resource}`);
  }
}

/** 400: turn record fails contract validation. */
export class InvalidTurnError extends ProblemError {
  constructor(detail = "invalid turn") {
    super(400, "invalid-turn", `Invalid turn: ${detail}`);
  }
}

/**
 * 409: state-machine or recording violation (illegal recording transition,
 * append before the notice handshake, duplicate seq).
 */
export class InvalidStateError extends ProblemError {
  constructor(detail: string) {
    super(409, "invalid-state", detail);
  }
}

/** 409: unique conflict (e.g. duplicate turn seq). */
export class ConflictError extends ProblemError {
  constructor(detail = "conflict") {
    super(409, "conflict", detail);
  }
}

/** 400: phone input is not a valid number (message carries no input). */
export class InvalidPhoneError extends ProblemError {
  constructor() {
    super(400, "invalid-phone", "Invalid phone number");
  }
}
