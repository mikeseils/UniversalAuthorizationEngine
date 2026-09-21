/**
 * Validation failure for untrusted authorization-domain input.
 *
 * Security note (ADR-0006): malformed input is always rejected at the
 * boundary — it is never silently coerced into something "close enough".
 */
export class ValidationError extends Error {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}
