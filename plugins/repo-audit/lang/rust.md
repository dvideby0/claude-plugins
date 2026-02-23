# Rust Audit Guide

## File-Level Analysis

When analyzing each Rust file, check for these language-specific issues:

### Safety & Correctness
- `unsafe` blocks — flag every instance, verify each has a SAFETY comment explaining invariants
- `.unwrap()` / `.expect()` outside of tests and main — can panic in production
- `panic!()` / `todo!()` / `unimplemented!()` in library code
- Unchecked `as` casts (especially narrowing: `u64 as u32`, `i64 as i32`)
- Index access (`arr[i]`) in hot paths without bounds checking consideration
- `mem::transmute` usage (almost always wrong)
- `std::mem::forget` on types with Drop implementations

### Error Handling
- Using `.unwrap()` where `?` operator would propagate cleanly
- Inconsistent error types (some functions return `String` errors, others `anyhow`, others custom)
- Missing `thiserror` / `anyhow` — raw `Box<dyn Error>` everywhere
- Error types without `Display` and `Error` implementations
- `Result` return types without documenting error conditions
- Swallowing errors with `let _ = fallible_call()`

### Ownership & Borrowing
- Unnecessary `.clone()` calls (often a sign of fighting the borrow checker)
- Taking `String` params where `&str` would avoid allocation
- Taking `Vec<T>` params where `&[T]` would suffice
- Missing `Cow<str>` for functions that sometimes need owned, sometimes borrowed
- `Rc` / `Arc` used where a simple reference would work
- `RefCell` / `Mutex` indicating potential design issues (interior mutability as workaround)

### Async (if tokio / async-std detected)
- Blocking operations (`std::fs`, `std::thread::sleep`) inside async contexts
- Missing `tokio::spawn_blocking` for CPU-intensive work
- Holding `MutexGuard` across `.await` points (potential deadlock)
- Unbounded channels/queues (`mpsc::unbounded_channel`) without backpressure
- Missing timeouts on async operations (`tokio::time::timeout`)
- `async` functions that never actually `.await` (unnecessary overhead)
- Spawned tasks without JoinHandle management (fire and forget)

### Actix / Axum / Web Framework (if detected)
- Missing extractors validation (accepting raw JSON without type validation)
- Shared mutable state without proper synchronization (`web::Data<Mutex<T>>` patterns)
- Missing error response types (returning strings instead of structured errors)
- Missing middleware for auth, logging, CORS
- Database connections without pooling (r2d2, deadpool, bb8)
- Missing graceful shutdown handling

### Struct & Type Design
- Structs with `pub` on all fields where builder pattern is more appropriate
- Missing `#[derive(Debug)]` on types (makes debugging impossible)
- Missing `#[derive(Clone)]` / `#[derive(PartialEq)]` where semantically useful
- Large enums without `#[non_exhaustive]` in library code
- Tuple structs for things that should have named fields
- Missing `Default` implementation where sensible
- `String` fields where an enum would be more type-safe

### Performance
- Repeated allocations in loops (push to vec inside loop without pre-allocating)
- Missing `with_capacity` on `Vec`, `HashMap`, `String` when size is predictable
- Returning `Vec<T>` where an iterator would avoid allocation
- String formatting with `format!` in hot paths (allocates)
- Missing `#[inline]` on small, frequently-called functions in library code
- Using `HashMap` where `BTreeMap` or `Vec` with binary search is more appropriate for small N
- Unnecessary `Arc<Mutex<>>` where atomics would suffice

### Testing
- Tests without `#[should_panic]` for functions expected to panic
- Missing property-based tests (proptest/quickcheck) for parsing/validation
- Integration tests in `src/` instead of `tests/` directory
- Missing `#[ignore]` on slow tests that need explicit opt-in
- Test helper functions without `#[cfg(test)]` gating
- No documentation tests (`///` examples) on public API

### Cargo & Module Structure
- Overly broad `pub` visibility (everything exported from lib.rs)
- Missing `pub(crate)` for internal-only items
- Feature flags not documented
- Missing `#![deny(missing_docs)]` for library crates
- Wildcard dependencies in Cargo.toml (`some-crate = "*"`)
- Dev dependencies in main dependencies section
- Missing `rust-version` field in Cargo.toml
- Large modules (> 500 lines) that should be split into submodules

### Clippy & Linting
- Check if `#![deny(clippy::all)]` or similar is configured
- Common clippy lints that indicate issues:
  - `clippy::needless_return`
  - `clippy::redundant_clone`
  - `clippy::manual_map` (could use `.map()`)
  - `clippy::large_enum_variant` (some variants much larger than others)

## Cross-Module Checks (used in Phase 2)

When comparing across modules:
- Inconsistent error handling strategy (anyhow in some, thiserror in others, raw strings elsewhere)
- Mixed async runtimes (tokio and async-std in same project)
- Duplicated utility functions across modules
- Inconsistent visibility patterns
- Different serialization approaches (serde vs manual)
- Some modules with comprehensive docs, others with none
- Inconsistent naming: `new()` vs `create()` vs `build()` for constructors
- Mixed testing patterns across modules
