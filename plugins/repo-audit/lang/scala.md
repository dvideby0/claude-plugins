# Scala Audit Guide

## File-Level Analysis

### Type Safety & Patterns
- Using `null` instead of `Option` (Scala convention: avoid null entirely)
- Using `Any` / `AnyRef` where a specific type or generic is possible
- Missing sealed traits for ADTs (algebraic data types)
- Pattern matches without exhaustiveness (missing cases on sealed types)
- Catching `Throwable` or bare `Exception` (swallows fatal errors)
- Using `return` keyword (non-idiomatic, changes control flow in unexpected ways)
- Mutable `var` where `val` is appropriate
- Missing type annotations on public methods
- Using Java collections instead of Scala collections
- Implicit conversions that obscure behavior (Scala 2)
- Missing `given` / `using` instead of old-style implicits (Scala 3)

### Functional Patterns
- Side effects in pure functions (IO, mutation, printing)
- Missing `for` comprehension where nested `flatMap`/`map` is hard to read
- `Option.get` / `Try.get` / `Either.right.get` — defeats the purpose of the wrapper
- Missing `Either` for error handling (throwing exceptions instead)
- Mutable collections used where immutable would be thread-safe
- Missing `IO` / `ZIO` / `Cats Effect` for effect management (if FP style is used)
- Heavy nesting instead of monadic composition

### Akka / Pekko (if detected)
- Actors with too many responsibilities
- Missing supervision strategy on actor systems
- Blocking operations inside actor receive (blocks the dispatcher)
- Missing back-pressure in stream processing
- Unhandled messages without logging
- Missing typed actors (using classic untyped API)

### Play Framework (if detected)
- Business logic in controllers
- Missing form validation
- Blocking calls in async action handlers
- Missing CSRF protection
- Hardcoded configuration instead of `application.conf`
- Missing error handlers

### Testing (ScalaTest / Specs2 / MUnit)
- Tests without assertions
- Missing property-based tests (ScalaCheck) for data transformations
- Tests depending on external services without mocking
- Missing test for error/failure paths
- Inconsistent test style (FunSpec in some, WordSpec in others)

### Build & Structure (SBT / Mill)
- Circular dependencies between subprojects
- Missing `scalacOptions` for warnings (`-Werror`, `-deprecation`, `-unchecked`)
- Wildcard imports (`import foo._`) polluting namespace
- Missing package objects or clear module boundaries
- Mixed Scala 2 and Scala 3 syntax without migration plan

## Cross-Module Checks (used in Phase 2)

- Mixed effect systems (cats-effect in some, ZIO in others, bare Futures elsewhere)
- Inconsistent error handling (Try vs Either vs exceptions)
- Different JSON libraries across modules (circe, play-json, spray-json)
- Inconsistent naming conventions
- Mixed Scala 2/3 idioms across modules
