# Java / Kotlin Audit Guide

## File-Level Analysis

### Java-Specific Issues
- Missing `@Override` annotations on overridden methods
- Raw types (`List` instead of `List<String>`) — missing generics
- Checked exceptions caught and swallowed with empty catch blocks
- `NullPointerException` risk: missing null checks, no use of `Optional`
- Mutable data exposed via getters (returning `List` directly instead of `Collections.unmodifiableList`)
- String concatenation with `+` in loops (use `StringBuilder`)
- `==` instead of `.equals()` for object comparison
- Public fields instead of proper encapsulation
- God classes with 500+ lines or 15+ methods
- Missing `final` on fields that shouldn't change
- Missing `@Nullable` / `@NonNull` annotations
- Static mutable state (shared `static` fields without synchronization)
- `System.out.println` instead of proper logging framework
- Missing `try-with-resources` for `AutoCloseable` resources

### Kotlin-Specific Issues
- Unnecessary `!!` (non-null assertion) — flag every instance
- `var` where `val` would be immutable and safer
- Not using data classes for simple value types
- Java-style getters/setters instead of properties
- Missing sealed classes/interfaces where exhaustive when is needed
- Not using `require()` / `check()` for preconditions
- Coroutine scope leaks (missing `supervisorScope`, `viewModelScope`)
- Blocking calls inside coroutine context
- Not using `sequence` / `flow` for lazy evaluation of large collections

### Spring Boot (if detected)
- Missing `@Transactional` on service methods that modify data
- N+1 queries with JPA/Hibernate (missing `@EntityGraph` or `JOIN FETCH`)
- Business logic in controllers instead of service layer
- Missing validation annotations (`@Valid`, `@NotNull`, etc.)
- Circular bean dependencies
- Missing exception handlers (`@ExceptionHandler` / `@ControllerAdvice`)
- Hardcoded configuration instead of externalized (`@Value`, `@ConfigurationProperties`)
- Missing actuator/health endpoints
- `@Autowired` field injection instead of constructor injection
- Missing profiles for environment-specific configuration

### Concurrency
- Missing `synchronized` or concurrent collections for shared mutable state
- `HashMap` used in concurrent context (use `ConcurrentHashMap`)
- Thread creation without pool management (`new Thread()` directly)
- Missing `volatile` on flags shared between threads
- `ExecutorService` not shut down properly
- Kotlin: `GlobalScope.launch` instead of structured concurrency

### Testing (JUnit / TestNG / Kotest)
- Tests without assertions (just calling methods)
- Missing `@BeforeEach` / `@AfterEach` for setup/teardown
- Tests that depend on execution order
- Missing parameterized tests for similar test cases
- Mocking frameworks used inconsistently (Mockito in some, MockK in others)
- Integration tests mixed with unit tests (no separation)
- Missing test for exception paths

### Build & Structure
- Missing `module-info.java` for Java 9+ modules
- Overly broad dependency scopes in Maven/Gradle (`compile` instead of `implementation`)
- Unused dependencies in build file
- Missing BOM (Bill of Materials) for dependency version management
- Package structure not matching domain boundaries
- Circular package dependencies

## Cross-Module Checks (used in Phase 2)

- Mixed Java and Kotlin without clear boundary rules
- Inconsistent exception handling (checked vs unchecked strategy)
- Different DTO/entity mapping approaches across services
- Multiple logging frameworks (SLF4J vs Log4j vs java.util.logging)
- Inconsistent naming: `UserService` vs `UserManager` vs `UserHandler`
- Mixed dependency injection styles (constructor vs field vs setter)
- Inconsistent use of Optional vs nullable types
