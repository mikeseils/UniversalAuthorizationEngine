/**
 * Canonical example domain fixture (docs/design/domain-model.md).
 *
 * Acme
 * ├── Alice  (admin → Acme, owner → Project Alpha)
 * ├── Bob    (member → Acme, viewer → Project Alpha)
 * └── Project Alpha
 *      ├── Document A
 *      └── Document B
 *
 * Exercised across docs, examples, and tests for RBAC, ReBAC, inheritance,
 * allow, deny, explanations, and tenant isolation.
 */

export const ACME_RELATIONSHIPS: readonly string[] = [
  "user:alice|admin|organization:acme",
  "user:bob|member|organization:acme",
  "organization:acme|owns|project:alpha",
  "user:alice|owner|project:alpha",
  "user:bob|viewer|project:alpha",
  "project:alpha|contains|document:a",
  "project:alpha|contains|document:b",
];

/** Parse the compact fixture form `subject|relation|resource`. */
export function parseFixtureLine(line: string): {
  subject: string;
  relation: string;
  resource: string;
} {
  const parts = line.split("|");
  const subject = parts[0];
  const relation = parts[1];
  const resource = parts[2];
  if (parts.length !== 3 || !subject || !relation || !resource) {
    throw new Error(`malformed fixture line: ${line}`);
  }
  return { subject, relation, resource };
}
