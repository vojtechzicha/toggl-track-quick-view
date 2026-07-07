// Error taxonomy shared by every track source. The UI only ever imports the
// classifiers — callers switch on "is this a rate limit / a password-gate
// re-login" without caring which backend threw.

export class ApiError extends Error {
  status: number;
  /** Server-provided explanation (e.g. the store's underlying DB error). */
  detail?: string;
  constructor(status: number, detail?: string) {
    super(detail ? `Request failed (${status}): ${detail}` : `Request failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

/** The server-side explanation carried by an error, if there is one. */
export function errorDetail(e: unknown): string | null {
  return e instanceof ApiError && e.detail ? e.detail : null;
}

/** Thrown when the server's password gate needs a (re)login before serving data. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Password required');
  }
}

/** True for rate-limit responses (Toggl uses 402 per its docs; 429 elsewhere). */
export function isRateLimit(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 402 || e.status === 429);
}

export function isAuthRequired(e: unknown): boolean {
  return e instanceof AuthRequiredError;
}
