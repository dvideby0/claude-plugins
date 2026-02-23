# Go Audit Guide

## File-Level Analysis

When analyzing each Go file, check for these language-specific issues:

### Error Handling
- Ignored errors: `result, _ := someFunc()` — flag every instance
- Bare `if err != nil { return err }` without wrapping context (`fmt.Errorf("doing X: %w", err)`)
- Inconsistent error wrapping (some use `%w`, others `%v`, others don't wrap)
- Custom error types without implementing `Error()` or `Unwrap()`
- Panics in library code (panics should only be in main or init)
- `log.Fatal` / `os.Exit` in library packages (prevents graceful shutdown)
- Error strings starting with capitals or ending with punctuation (Go convention: lowercase, no punctuation)

### Concurrency
- Goroutine leaks: goroutines spawned without lifecycle management
- Missing `sync.WaitGroup` or channel-based coordination for goroutine cleanup
- Shared state access without mutex or channel protection
- Unbuffered channels causing unexpected blocking
- `sync.Mutex` copied by value (struct containing mutex passed by value)
- Missing `context.Context` propagation through call chains
- `time.Sleep` for synchronization instead of proper signaling
- Race conditions: check for `-race` flag in test/CI configuration

### Resource Management
- Missing `defer` for closing resources (files, HTTP response bodies, DB connections)
- `defer` inside loops (defers don't run until function exits)
- HTTP response body not closed (`resp.Body.Close()`)
- Database connections not returned to pool
- Missing timeouts on HTTP clients (default client has no timeout)
- Context without cancel/timeout in long-running operations

### Go Idioms
- Getters named `GetX()` instead of `X()` (Go convention: no Get prefix)
- Package names that stutter (`user.UserService` instead of `user.Service`)
- Interfaces declared in the implementor package instead of consumer package
- Overly broad interfaces (Go prefers small interfaces, 1-3 methods)
- Returning concrete types instead of interfaces from constructors
- `init()` functions with side effects (hidden initialization)
- Empty interface (`interface{}` / `any`) where a specific type is possible
- Exported names without documentation comments

### Struct & Type Patterns
- Structs with too many fields (> 10 suggests decomposition needed)
- Missing JSON/DB struct tags on types used for serialization
- Struct tags with typos or inconsistent naming (`json:"userId"` vs `json:"user_id"`)
- Pointer vs value receiver inconsistency on the same type
- Missing constructor functions for structs that need initialization

### HTTP / API (if net/http, gin, echo, chi, fiber detected)
- Missing request validation
- Hardcoded status codes instead of `http.StatusOK` constants
- Missing middleware for auth, logging, recovery
- Handler functions doing too much (business logic should be in service layer)
- Missing request timeouts
- Not using `http.Error()` for error responses consistently

### Database (if database/sql, GORM, sqlx, ent detected)
- SQL injection via string concatenation
- Missing prepared statements for repeated queries
- Not checking `rows.Err()` after iteration
- Missing transaction boundaries for multi-step operations
- N+1 queries in loops
- Missing connection pool configuration

### Testing
- Test files without table-driven tests (Go convention for multiple cases)
- Missing `t.Helper()` in test helper functions
- Tests using `time.Sleep` for async assertions instead of polling/channels
- Missing `t.Parallel()` on independent tests
- Test names that don't follow `TestFunction_Scenario_Expected` pattern
- No testify or similar assertion library (not wrong, but note if assertions are verbose)
- Missing benchmark tests for performance-critical paths

### Performance
- String concatenation in loops (use `strings.Builder`)
- Unnecessary allocations in hot paths (pre-allocate slices with `make([]T, 0, cap)`)
- Maps without size hints when size is predictable
- Repeated type assertions instead of type switch
- Reflection in hot paths
- Missing `sync.Pool` for frequently allocated/freed objects

### Module & Package Structure
- Packages that are too large (> 20 files suggests splitting)
- Circular dependencies between packages
- `internal/` not used for private implementation packages
- `cmd/` directory missing for multi-binary projects
- Mixed concerns in a single package (HTTP handler + DB logic + business rules)
- Vendor directory checked in without `go mod vendor` management

## Cross-Module Checks (used in Phase 2)

When comparing across packages:
- Inconsistent error wrapping strategies
- Different logging libraries or approaches (log vs slog vs zerolog vs zap)
- Mixed context propagation (some functions accept context, similar ones don't)
- Inconsistent naming: `NewUserService` vs `CreateUserService` vs `MakeUserService`
- Some packages with godoc comments, others without
- Mixed testing patterns (table-driven in some, sequential in others)
- Duplicated middleware or helper functions across packages
- Inconsistent struct tag conventions (camelCase vs snake_case in JSON tags)
