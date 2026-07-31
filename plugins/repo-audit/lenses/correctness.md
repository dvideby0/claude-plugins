# Correctness lens

Semantic bugs and failure handling — the things that compile, lint clean, and
still break in production.

## Error handling

- Swallowed errors: empty catch, `except: pass`, `.catch(() => {})`, errors
  logged and then execution continues as if nothing happened.
- Over-broad catches that hide programmer errors alongside expected failures.
- Fallbacks that mask failure — returning `[]`, `null` or a default where the
  caller cannot distinguish "no data" from "the call failed".
- Cleanup that doesn't run on the error path (missing `finally`, unclosed
  handles, transactions never rolled back).
- Async: unawaited promises, floating async calls, `Promise.all` where one
  rejection loses the rest, missing timeouts on network calls.

## Contracts

- Callers and callees disagreeing about nullability, units, ordering, or
  whether a function throws vs returns an error.
- Return values that are silently ignored at the call site.
- Partial writes: multi-step mutations with no rollback if step two fails.
- Off-by-one and boundary handling on slices, ranges, pagination and retries.

## State

- Mutable module-level state shared across requests.
- Race conditions: check-then-act, concurrent writes to the same record,
  cache reads that can see a half-written value.
- Idempotency: retried operations that double-charge, double-send or
  double-insert.

## Data

- Unvalidated external payloads used as if they matched a schema.
- Number/precision issues on money, timestamps parsed without timezone,
  string comparisons that should be normalized.

Use the graph context: if a function is imported by many files, an unchecked
assumption in it is higher severity than the same code in a leaf module.
