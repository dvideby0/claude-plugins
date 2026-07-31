# Performance lens

Only report what will bite at realistic scale, and say what that scale is.

## Data access

- N+1 queries: a query inside a loop over results, or an ORM relation accessed
  per item without eager loading.
- Unbounded reads: `SELECT *` with no limit, `findAll()` on a growing table,
  paging implemented in application code after fetching everything.
- Missing filters that push work to the client, and repeated identical queries
  inside one request.
- Writes in a loop that should be a single batch statement.

## Work per request

- Synchronous CPU-heavy work on the request path (hashing, image work, large
  JSON transforms, regex over big inputs).
- Sequential awaits that are independent and could be concurrent.
- Repeated parsing/compiling inside a hot function (regex construction, schema
  compilation, config re-read).

## Memory and lifetime

- Accumulating collections that are never bounded or evicted — caches, arrays
  on module-level state, event listeners added per request and never removed.
- Reading whole files or responses into memory when streaming is available.
- Closures capturing large objects that outlive their use.

## Async correctness under load

- Missing timeouts and retry storms without backoff.
- Connection pools created per call rather than shared.
- Locks held across an `await`.

Anchor each finding to the code path and the input that makes it expensive. If
the module is small and rarely called, note that and lower the severity.
