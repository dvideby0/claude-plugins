# Dart / Flutter Audit Guide

## File-Level Analysis

### Type Safety & Null Safety
- Missing sound null safety (check `environment.sdk` constraint in `pubspec.yaml`)
- Unnecessary `!` bang operator (force unwrapping nullable) — flag every instance
- `dynamic` type used where a specific type is possible
- Missing type annotations on public API (function params, return types)
- Using `as` casts without type checking (`is` check first)
- `late` keyword used as a workaround for initialization (may hide bugs)
- Missing `final` on variables that shouldn't be reassigned
- Using `var` where `final` is appropriate (immutability preference)

### Flutter-Specific (if Flutter detected)
- Massive `build()` methods (> 100 lines — extract widgets)
- Missing `const` constructors on stateless widgets and immutable objects
- `setState()` called with heavy computation (should compute first, then setState)
- Missing `key` parameter on list items and conditional widgets
- `BuildContext` used after async gap (context may be invalid after await)
- Missing `mounted` check before `setState` in async callbacks
- Nested `MediaQuery.of()` / `Theme.of()` calls (cache in variable)
- Hardcoded colors/dimensions instead of theme values
- Missing responsive design (hardcoded pixel values)
- Images without `cacheWidth` / `cacheHeight` (full resolution decoded into memory)
- Platform-specific code without proper abstraction

### State Management
- `StatefulWidget` used where stateless + state management is cleaner
- State management approach mixed (Provider in some, Riverpod in others, BLoC elsewhere)
- Business logic in widgets instead of in state management layer
- Missing `dispose()` for controllers, subscriptions, streams
- Streams not closed (memory leak)
- `StreamBuilder` / `FutureBuilder` without handling loading, error, and data states
- State rebuilding too broadly (entire widget tree instead of targeted rebuild)

### Architecture
- Business logic in UI layer (widgets calling repositories directly)
- Missing repository pattern for data access
- Navigation logic scattered through widgets instead of centralized routing
- Missing dependency injection (hardcoded dependencies, singletons everywhere)
- Circular imports between feature modules
- Missing feature-first or layer-first folder organization

### Async Patterns
- `Future` without error handling (missing `.catchError` or try/catch on await)
- Unawaited futures (fire-and-forget without `unawaited()` annotation)
- Blocking the UI thread with heavy synchronous computation
- Missing `Isolate` / `compute()` for CPU-intensive work
- Multiple `FutureBuilder` nesting instead of combining futures
- Missing debounce/throttle on user input handlers
- Stream subscriptions not cancelled in `dispose()`

### Networking
- Missing timeout configuration on HTTP requests
- No retry logic for transient failures
- Missing offline support / caching strategy
- API responses not validated against expected schema
- Missing error mapping (HTTP errors to domain errors)
- Hardcoded base URLs instead of configuration

### Testing
- Missing widget tests for critical UI components
- Missing unit tests for business logic / state management
- Missing integration tests for critical user flows
- Tests without `pump()` / `pumpAndSettle()` for widget rendering
- Missing golden tests for pixel-perfect UI requirements
- Missing mock generation (Mockito / Mocktail)
- Tests depending on real network / platform APIs

### Performance
- Missing `const` on widgets and constructors that can be const
- `ListView` without `ListView.builder` for long lists (all items built at once)
- Large images loaded without caching or size constraints
- Missing `RepaintBoundary` on frequently updating widgets
- Expensive computation in `build()` method
- Missing `AutomaticKeepAliveClientMixin` for tab views with expensive children

### Project Structure
- Missing `analysis_options.yaml` with strict linting rules
- Dev dependencies in regular dependencies
- Missing `pubspec.lock` in version control (for apps, not packages)
- Generated files (`.g.dart`, `.freezed.dart`) not in `.gitignore` or missing build_runner
- Assets not organized by type/resolution
- Missing localization setup (hardcoded strings)
- Platform-specific code (android/, ios/) with custom modifications not documented

## Cross-Module Checks (used in Phase 2)

- Mixed state management approaches without clear rationale
- Inconsistent error handling (some throw, some return Result, some use Either)
- Different naming conventions across features (`UserBloc` vs `UserCubit` vs `UserNotifier`)
- Duplicated model classes across features
- Inconsistent navigation patterns
- Mixed DI approaches (get_it in some, provider in others, manual elsewhere)
- Different HTTP client wrappers across features
