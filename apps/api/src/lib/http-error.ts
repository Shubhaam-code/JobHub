/** An error carrying the HTTP status code that should be sent to the client. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, HttpError);
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, message, details);

/** No usable credentials were presented — the caller is not authenticated. */
export const unauthorized = (message = 'Authentication required'): HttpError =>
  new HttpError(401, message);

/** Credentials were valid but the role is not allowed to do this. */
export const forbidden = (message = 'Forbidden'): HttpError => new HttpError(403, message);

export const notFound = (message = 'Resource not found'): HttpError => new HttpError(404, message);

export const internalError = (message = 'Internal Server Error'): HttpError =>
  new HttpError(500, message);
