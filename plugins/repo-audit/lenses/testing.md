# Testing lens

Judge whether the tests would actually catch a regression. Coverage percentage
is not the question.

## Tests that don't test

- Assertions that can't fail: `expect(result).toBeDefined()`, `assert result`,
  snapshot-only tests over trivial output, tests with no assertion at all.
- Tests that assert on the mock rather than the behaviour — every dependency
  stubbed, so the test passes even if the real integration is broken.
- Tests that restate the implementation line by line and would need editing for
  any refactor.

## Missing coverage that matters

Use the graph context. A file with many importers and no importing test is a
higher-priority gap than an untested leaf.

- Error paths: the happy path is tested, the failure branch never is.
- Boundaries: empty input, single element, maximum size, unicode, timezone
  edges, concurrent access.
- The specific behaviours the module exists to guarantee (auth checks,
  permission rules, money arithmetic, retry semantics).

## Test suite health

- Shared mutable fixtures that make tests order-dependent.
- Sleeps and real timers standing in for synchronization.
- Tests hitting the network, the clock, or the real filesystem without
  isolation.
- Skipped or commented-out tests, and tests that catch their own failures.

Report the gap with the concrete regression it would let through — "no test
covers the expired-token branch of verifySession, so an auth bypass here ships
silently" — not just "needs more tests".
