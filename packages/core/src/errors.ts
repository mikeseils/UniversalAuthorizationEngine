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

/**
 * A requested policy version does not exist (ADR-0019).
 *
 * Raised when a caller pins an exact policy version that the store cannot
 * resolve. It is a **caller** error, not infrastructure: the store answered
 * correctly. The distinction matters because silently falling back to the
 * active version would produce a decision attributed to a policy that did not
 * actually produce it — corrupting exactly the audit trail pinning exists to
 * protect.
 */
export class PolicyNotFoundError extends Error {
  public readonly version: string;

  constructor(version: string) {
    super(`policy version "${version}" not found`);
    this.name = "PolicyNotFoundError";
    this.version = version;
  }
}
