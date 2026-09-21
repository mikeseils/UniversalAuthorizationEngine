# Caching

Status: **Design only.** Do not prematurely optimize — but the invalidation
requirements below are **preconditions** for implementing decision caching.

## Cache types

| Cache              | Value                                      | Risk                                                           | Status        |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------- | ------------- |
| Policy cache       | Compiled policy artifact by version hash   | Low — artifacts are immutable                                  | Safe; trivial |
| Relationship cache | Relationship records / traversal results   | Medium — staleness affects decisions                           | Design        |
| **Decision cache** | ALLOW/DENY per (subject, action, resource) | **High** — a stale cached decision is a security vulnerability | Gated         |

## Decision cache rules (binding before implementation)

1. **Cache keys must incorporate authorization state versions**, not just TTLs:

   ```
   cache key = subject + action + resource + policy version + relationship version
   ```

   Invalidation becomes deterministic: when the relevant relationship version
   changes, decisions keyed to the old version are simply unreachable.

2. **Dependency tracking, not just TTL.** A relationship like
   `alice → member → Organization A` may affect 50,000 cached decisions.
   Removing it must invalidate all of them. This requires an efficient
   dependency graph (relationship → affected resources → affected decisions)
   and is a core differentiator (roadmap Phase 47). TTL-only caching is
   explicitly insufficient for revocation-sensitive grants.

3. **Negative caching needs stricter invalidation than positive caching.**
   A stale DENY after `Alice` gains access is an availability bug; a stale
   ALLOW after revocation is a **security breach**. Denials must never
   outlive the state that produced them; when in doubt, skip caching denials
   or bound them tightly.

4. **Consistency mode is explicit.** Cached decisions imply eventual
   consistency. Applications needing strong consistency bypass the cache
   (`consistency: "strong"` — roadmap Phase 12/78). The product exposes this
   rather than hiding it.

5. **Cache poisoning is a threat** (`../security/threat-model.md`): cache
   writes must be keyed and populated only from verified evaluation results;
   multi-tenant caches must never share entries across tenants.

## Relationship cache

Safe for immutable snapshots per relationship version. Traversal caches must
be keyed by the same state versions as decisions.

## Policy cache

Trivially safe: compiled artifacts are immutable and versioned. A node either
holds a complete artifact or none — never "sort of current" policy state.
