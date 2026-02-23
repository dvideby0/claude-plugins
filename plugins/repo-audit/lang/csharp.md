# C# / .NET Audit Guide

## File-Level Analysis

### Type Safety & Patterns
- Nullable reference types not enabled (`<Nullable>enable</Nullable>` in csproj)
- Missing null checks on reference types (pre-nullable reference types code)
- Using `object` or `dynamic` where a generic or specific type is appropriate
- Missing `sealed` on classes not designed for inheritance
- `IDisposable` implemented without proper dispose pattern (missing finalizer or `using`)
- Missing `using` / `await using` statements for disposable resources
- String comparison without `StringComparison` ordinal specification
- Mutable structs (structs should generally be immutable)
- Missing `readonly` on struct fields and `init` on record properties

### Async/Await
- `async void` methods (should be `async Task` — async void swallows exceptions)
- `.Result` or `.Wait()` on tasks (synchronous blocking of async code, potential deadlock)
- Missing `ConfigureAwait(false)` in library code
- `Task.Run` wrapping already-async methods (unnecessary thread pool usage)
- Missing cancellation token propagation through async call chains
- Fire-and-forget tasks without error handling
- Sequential `await` where `Task.WhenAll` would parallelize

### ASP.NET Core (if detected)
- Missing model validation (`[Required]`, `[Range]`, etc.)
- Business logic in controllers (should be in services)
- Missing exception handling middleware
- Hardcoded connection strings or secrets (use `IConfiguration`, `IOptions<T>`)
- Missing `[Authorize]` attributes on protected endpoints
- Missing CORS configuration
- Synchronous database calls in async endpoints
- Missing health check endpoints
- Scoped services injected into singletons (captive dependency)
- Missing response caching / output caching for appropriate endpoints

### Entity Framework (if detected)
- N+1 queries: accessing navigation properties in loops without `Include()`
- Missing `AsNoTracking()` for read-only queries
- Lazy loading enabled globally (performance trap)
- Missing indexes on commonly filtered/sorted columns
- Raw SQL without parameterization
- Missing migration for schema changes
- Context used across multiple requests (should be scoped)
- Missing transaction boundaries for multi-entity operations

### Dependency Injection
- `new`-ing services directly instead of injecting them
- Service registration with wrong lifetime (Singleton with Scoped dependency)
- Missing interface abstractions (depending on concrete classes)
- God constructors with 8+ dependencies (class doing too much)
- Static helper classes that should be injectable services
- Missing `IServiceScope` for background service dependency resolution

### Testing (xUnit / NUnit / MSTest)
- Missing `[Theory]` / `[InlineData]` for parameterized tests
- Tests without assertions
- Missing mocking framework (Moq, NSubstitute, FakeItEasy)
- Integration tests without `WebApplicationFactory`
- Tests that depend on execution order
- Missing test coverage for exception paths
- No architectural tests (NetArchTest for dependency rules)

### Performance
- LINQ `ToList()` / `ToArray()` called too early (materializing before filtering)
- String concatenation in loops (use `StringBuilder`)
- Missing `Span<T>` / `Memory<T>` for hot-path buffer operations
- Excessive boxing of value types
- Allocating in hot paths (consider `ArrayPool<T>`, `ObjectPool<T>`)
- Missing `IAsyncEnumerable` for streaming large result sets
- Regex not compiled or cached (`new Regex()` in loops)

### Security
- SQL injection via string concatenation
- Missing input validation and sanitization
- Missing anti-forgery tokens on forms
- Hardcoded credentials or API keys
- Missing HTTPS redirection middleware
- Insecure deserialization (BinaryFormatter, Newtonsoft TypeNameHandling)
- Missing Content Security Policy headers

### Project Structure
- Projects with too many classes (> 50 suggests splitting)
- Missing solution folders for organization
- Circular project references
- Missing `Directory.Build.props` for shared settings
- Missing `GlobalUsings` for common imports
- Inconsistent project SDK targeting

## Cross-Module Checks (used in Phase 2)

- Inconsistent error handling (some throw, others return Result, others use middleware)
- Mixed logging approaches (ILogger vs static logger vs Console.Write)
- Different DTO mapping strategies (AutoMapper in some, manual in others)
- Inconsistent naming: `IUserService` vs `IUserManager` vs `IUserRepository`
- Mixed nullable reference type adoption across projects
- Different serialization settings (System.Text.Json vs Newtonsoft)
- Inconsistent async patterns across services
