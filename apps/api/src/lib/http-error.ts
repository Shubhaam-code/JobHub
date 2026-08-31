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

export const notFound = (message = 'Resource not found'): HttpError => new HttpError(404, message);

export const internalError = (message = 'Internal Server Error'): HttpError =>
  new HttpError(500, message);
