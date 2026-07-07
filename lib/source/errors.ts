// Error taxonomy shared by every track source. The UI only ever imports the
// classifiers — callers switch on "is this a rate limit / a password-gate
// re-login" without caring which backend threw.

export class ApiError extends Error {
  status: number;
  constructor(status: number) {
    super(`Request failed (${status})`);
    this.status = status;
  }
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
