/** The session cookie is missing/expired (redirect to /login, 401, 419). Callers may re-login once. */
export class AuthExpiredError extends Error {
  constructor(message = 'ReservaPlay session expired') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/** Login was rejected (wrong credentials or unexpected login page). Never retried automatically. */
export class LoginFailedError extends Error {
  constructor(message = 'ReservaPlay login failed') {
    super(message);
    this.name = 'LoginFailedError';
  }
}

/** The site answered in a way the client does not understand. Carries no response body (privacy, debug pages). */
export class UnexpectedResponseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}
