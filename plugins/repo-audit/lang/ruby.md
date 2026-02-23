# Ruby Audit Guide

## File-Level Analysis

### Ruby Idioms & Anti-Patterns
- Methods longer than 15 lines (Ruby strongly favors small methods)
- Classes longer than 200 lines (extract service objects, concerns)
- Monkey-patching core classes without isolation
- Missing frozen string literals (`# frozen_string_literal: true`)
- `eval` / `send` with user-controlled input
- Mutable constants (array/hash constants without `.freeze`)
- Nested conditionals deeper than 3 levels
- Missing `private` / `protected` visibility on internal methods
- Rescue without specific exception class (`rescue => e` catches everything)
- Long parameter lists (> 3 params suggests keyword arguments or param object)
- Missing `respond_to_missing?` when overriding `method_missing`

### Rails-Specific (if Rails detected)
- N+1 queries: accessing associations in loops without `includes` / `preload` / `eager_load`
- Business logic in controllers (should be in models, services, or concerns)
- Fat models (> 300 lines) — extract concerns, service objects, or form objects
- Missing strong parameters validation
- Missing database indexes on foreign keys and commonly queried columns
- Callbacks (`before_save`, `after_create`) with complex logic or side effects
- Missing `dependent: :destroy` / `:nullify` on has_many associations
- SQL injection via string interpolation in `where` clauses
- Missing scopes for common queries (raw `where` chains in controllers)
- Missing validations on model attributes
- Direct file upload handling without Active Storage or shrine
- Missing CSRF protection
- Missing authentication checks on controller actions
- Hardcoded URLs instead of route helpers
- Missing database migrations for schema changes (manual SQL)
- `default_scope` usage (often causes unexpected behavior)

### Testing (RSpec / Minitest)
- Tests without expectations/assertions
- Missing `let` / `let!` for shared setup (duplicated setup across tests)
- Excessive use of `before(:all)` (shared state between tests)
- Missing factory definitions (FactoryBot) — building objects manually
- Tests hitting external services without VCR/WebMock
- Missing request specs for API endpoints
- Feature/system specs missing for critical user journeys
- Test descriptions that don't read as sentences (`it 'works'`)

### Performance
- N+1 queries (the #1 Rails performance issue)
- Missing counter caches for `has_many` count displays
- Missing caching (`Rails.cache`, fragment caching) for expensive operations
- Loading entire tables into memory (`Model.all.each`)
- Missing background jobs (Sidekiq/DelayedJob) for slow operations in request cycle
- Missing database connection pooling configuration
- Synchronous external API calls in request cycle

### Security
- Mass assignment vulnerabilities (missing strong parameters)
- SQL injection via string interpolation
- XSS via `raw` / `html_safe` on user content
- Missing Content Security Policy headers
- Hardcoded secrets (should use Rails credentials or env vars)
- Missing rate limiting on authentication endpoints
- Insecure direct object references (missing authorization checks)

### Gem & Structure
- Outdated gems with known vulnerabilities (`bundle audit`)
- Gems in the wrong group (development gems in production)
- Missing `Gemfile.lock` in version control
- Circular dependencies between services/modules
- Missing `config/initializers` for third-party gem configuration
- Engine or mountable engine patterns not used for modular features

## Cross-Module Checks (used in Phase 2)

- Inconsistent service object patterns (some return booleans, others raise, others return Result)
- Mixed query patterns (some use scopes, others raw where chains)
- Different serialization approaches (JBuilder, ActiveModelSerializers, Blueprinter, manual)
- Inconsistent naming: `UserCreator` vs `CreateUser` vs `UserService` vs `Users::Create`
- Mixed testing styles (some RSpec, some Minitest, or inconsistent RSpec style)
- Callbacks doing things that should be explicit service calls
- Duplicated authorization logic across controllers
