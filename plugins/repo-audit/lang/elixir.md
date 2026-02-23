# Elixir Audit Guide

## File-Level Analysis

### Patterns & Idioms
- Missing pattern matching where `if` / `case` / `cond` is used
- Using `Enum.map` + `Enum.filter` separately where `Enum.reduce` or comprehensions work
- Missing pipe operator (`|>`) for readable data transformation chains
- Nested `case` / `with` statements deeper than 3 levels
- Missing `with` for multi-step operations that can fail
- Using `try/rescue` for control flow instead of pattern matching on `{:ok, _}` / `{:error, _}`
- Raw string keys in maps where atom keys are appropriate (and vice versa for external data)
- Missing `@spec` type specifications on public functions
- Missing `@doc` on public module functions
- `String.to_atom()` on user input (atom table is not garbage collected — memory leak / DoS)
- Missing `@moduledoc` on modules

### Process & OTP
- Spawned processes without supervision (bare `spawn` instead of `Task` or GenServer under supervisor)
- GenServer with too many responsibilities (should be split)
- Missing `handle_info` catch-all clause (unhandled messages silently dropped)
- Synchronous `GenServer.call` where `cast` is appropriate (unnecessary blocking)
- Missing timeouts on `GenServer.call` (default 5s can hang)
- State in GenServer growing unbounded (no eviction strategy)
- Missing `terminate/2` for cleanup when GenServer manages resources
- Nested `GenServer.call` between processes (deadlock risk)
- Using `Agent` for complex state that should be a `GenServer`
- Missing circuit breakers for external service calls

### Phoenix (if detected)
- Business logic in controllers (should be in context modules)
- N+1 queries: accessing associations without `Repo.preload` / `Ecto.assoc`
- Missing changesets for data validation
- Raw SQL without parameterization (`Repo.query` with interpolation)
- Missing authorization plugs on routes
- Missing CSRF protection on non-GET routes
- LiveView: heavy computation in `handle_event` (should delegate to async process)
- LiveView: assigns growing unbounded (large state in process memory)
- Missing rate limiting on authentication endpoints
- Missing input sanitization in templates (`raw` helper on user content)
- Channels without authentication/authorization

### Ecto (if detected)
- Missing indexes on foreign keys and commonly queried fields
- Queries without `select` loading entire schema when only a few fields needed
- Missing `Repo.transaction` for multi-step database operations
- N+1 queries in association traversal
- Dynamic queries built with string interpolation instead of Ecto.Query
- Missing unique constraints in migrations
- Missing database-level constraints (relying only on changeset validation)
- Schema modules with too many fields (suggest decomposition)

### Testing (ExUnit)
- Tests without assertions (`assert` / `refute`)
- Missing `async: true` on test modules that can run in parallel
- Missing ExMachina or factory setup for test data
- Tests hitting external services without Mox / Bypass
- Missing property-based tests (StreamData) for parsing/validation
- Database tests without `Sandbox` adapter
- Missing doctests on well-documented functions

### Performance
- `Enum` operations on large lists where `Stream` would be lazy
- Missing `ETS` / `Cachex` for frequently accessed data
- String concatenation in loops instead of `IO.iodata`
- Missing `Task.async_stream` for concurrent processing of collections
- Large messages passed between processes (consider ETS for shared state)
- Blocking operations in GenServer callbacks (blocks the process mailbox)

### Project Structure
- Missing umbrella app for large projects with distinct bounded contexts
- Circular dependencies between contexts
- Missing boundary enforcement between Phoenix contexts
- Config values hardcoded instead of using `Application.get_env`
- Missing `config/runtime.exs` for runtime configuration (12-factor)
- Dependencies not pinned in `mix.lock`

## Cross-Module Checks (used in Phase 2)

- Inconsistent error handling ({:ok, _}/{:error, _} in some, exceptions in others)
- Mixed naming: some contexts use `create_user`, others use `new_user`, others `register_user`
- Inconsistent use of typespecs (some modules fully specced, others not at all)
- Different patterns for external service integration across contexts
- Duplicated query patterns that should be shared or extracted
- Inconsistent supervision tree structure
