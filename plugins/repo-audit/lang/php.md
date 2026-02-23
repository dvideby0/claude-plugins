# PHP Audit Guide

## File-Level Analysis

### Type Safety & Modern PHP
- Missing type declarations on function params and return types (PHP 7.0+)
- Missing union types where applicable (PHP 8.0+)
- Missing `readonly` properties (PHP 8.1+)
- Missing enums where string/int constants are used (PHP 8.1+)
- Using `mixed` type where a more specific type is possible
- Missing `strict_types` declaration (`declare(strict_types=1)`)
- Loose comparisons (`==`) where strict (`===`) is appropriate
- `@` error suppression operator usage
- Missing null-safe operator (`?->`) where null checks are chained (PHP 8.0+)
- Using `isset()` / `empty()` where null coalescing (`??`) is cleaner

### Error Handling
- Bare `catch (Exception $e)` or `catch (\Throwable $e)` swallowing all errors
- Empty catch blocks
- Using `die()` / `exit()` for error handling in non-CLI code
- Missing custom exception classes (everything throws generic `\Exception`)
- Error messages exposing internal paths or stack traces to users
- Missing `set_error_handler` / `set_exception_handler` configuration

### Laravel (if detected)
- Business logic in controllers (should be in services, actions, or form requests)
- N+1 queries: accessing relationships in loops without `with()` / `load()`
- Missing form request validation (validation in controllers)
- Missing authorization policies (inline auth checks instead of `Gate` / `Policy`)
- Mass assignment vulnerabilities (missing `$fillable` or `$guarded`)
- Raw queries without parameter binding
- Missing database indexes on foreign keys and commonly queried columns
- Facades used where dependency injection is more testable
- Missing queue jobs for slow operations in request cycle
- Missing `cache()` for expensive repeated queries
- Blade templates with raw PHP logic (should use components or view composers)
- Missing middleware for cross-cutting concerns
- Routes not using resource controllers where applicable
- Missing API resources / transformers (returning Eloquent models directly)
- Missing events/listeners for side effects (sending emails in controllers)
- `env()` called outside of config files (fails when config is cached)

### Symfony (if detected)
- Missing service autowiring configuration
- Business logic in controllers
- Missing form types for input validation
- Doctrine entities without proper mapping annotations
- Missing event subscribers for cross-cutting concerns
- Hardcoded service references instead of dependency injection

### Security
- SQL injection via string concatenation in queries
- XSS: echoing user input without `htmlspecialchars()` or framework escaping
- Missing CSRF protection on forms
- `eval()` / `preg_replace` with `e` modifier on user input
- `unserialize()` on untrusted data
- File upload without validation (type, size, extension)
- Hardcoded credentials or API keys
- Missing password hashing (storing plaintext or using MD5/SHA1)
- `extract()` on user input ($_GET, $_POST)
- Missing Content Security Policy headers
- Directory traversal via unsanitized file paths

### Performance
- Queries inside loops (N+1 problem)
- Missing opcode cache consideration (OPcache)
- Loading entire tables into memory
- Missing pagination on list endpoints
- Synchronous external API calls in request cycle
- Missing eager loading for relationships
- Autoloading issues (missing composer dump-autoload optimization)

### Testing (PHPUnit / Pest)
- Missing test coverage for critical paths
- Tests without assertions
- Tests hitting real database without transactions or RefreshDatabase
- Missing factory definitions for test data
- HTTP tests without response status assertions
- Missing mock/stub for external services

### Structure
- PSR-4 autoloading violations (class name/namespace doesn't match file path)
- Missing PSR-12 code style compliance
- God classes (500+ lines)
- Missing interface abstractions
- Circular dependencies between namespaces
- Vendor directory committed to version control
- Missing composer.lock in version control

## Cross-Module Checks (used in Phase 2)

- Mixed coding standards (PSR-12 in some files, different style in others)
- Inconsistent error handling (exceptions vs return codes vs null returns)
- Multiple HTTP client libraries (Guzzle in one module, cURL in another)
- Inconsistent naming: `UserService` vs `UserManager` vs `UserHandler`
- Mixed query approaches (Eloquent/Doctrine in some, raw SQL in others)
- Different validation strategies across modules
- Inconsistent use of PHP version features (modern in some files, legacy in others)
