# Swift Audit Guide

## File-Level Analysis

### Type Safety & Optionals
- Force unwrapping (`!`) outside of IBOutlets — flag every instance
- Implicitly unwrapped optionals (`String!`) where regular optionals are safer
- Missing `guard let` / `if let` for optional unwrapping (using force unwrap instead)
- `as!` force casts where `as?` with handling is safer
- Missing `@frozen` on public enums in library code
- Stringly-typed APIs where enums would be type-safe
- `Any` / `AnyObject` where a protocol or generic would be specific

### Memory Management
- Strong reference cycles: delegates, closures, and parent-child references without `weak` / `unowned`
- Missing `[weak self]` in closures that capture `self` (especially escaping closures)
- `unowned` used where `weak` is safer (unowned crashes if referenced after dealloc)
- Large objects retained in closures unnecessarily
- Missing `autoreleasepool` in loops that create many temporary objects

### Concurrency (Swift Concurrency / GCD)
- Data races: mutable state accessed from multiple threads without synchronization
- Missing `@Sendable` on closures passed across concurrency boundaries
- Missing `actor` for shared mutable state (Swift 5.5+)
- `DispatchQueue.main.sync` called from main thread (deadlock)
- Missing `Task.cancel()` / `Task.checkCancellation()` in async work
- Blocking calls in async context
- GCD (`DispatchQueue`) mixed with Swift concurrency (`async/await`) without clear pattern
- Missing `@MainActor` on UI-updating code

### SwiftUI (if detected)
- Heavy computation in `body` property (should be extracted or cached)
- Missing `@StateObject` for owned observable objects (using `@ObservedObject` for owned)
- State management confusion: `@State` vs `@Binding` vs `@ObservedObject` vs `@EnvironmentObject` misuse
- Missing `.task` modifier for async data loading (using `onAppear` with Task)
- Views with more than 10 subviews in body (extract components)
- Missing `Equatable` conformance on data driving views (excessive redraws)
- Hardcoded strings instead of `LocalizedStringKey`

### UIKit (if detected)
- Missing `prepareForReuse()` in custom table/collection view cells
- Massive view controllers (> 300 lines — extract to child VCs, coordinators, or view models)
- UI updates not on main thread
- Missing `deinit` with observer/notification removal
- Autolayout constraints created in `layoutSubviews` (should be in setup)
- Navigation logic in view controllers instead of coordinators/routers

### Networking
- Missing `URLSession` configuration (using `.shared` for everything)
- No timeout configuration on network requests
- Missing retry logic for transient failures
- Parsing JSON manually instead of using `Codable`
- Missing certificate pinning for sensitive APIs
- Synchronous network calls on main thread

### Testing (XCTest / Swift Testing)
- Tests without assertions (`XCTAssert*` calls)
- Missing async test support (`XCTestExpectation` or `async` tests)
- UI tests that are brittle (relying on specific element positions)
- Missing mock/stub protocols for dependency injection
- Tests that depend on network or file system without mocking

### Package & Project Structure
- Massive `AppDelegate` or `SceneDelegate` (extract configuration)
- Missing Swift Package Manager for dependency management (Cocoapods/Carthage still used)
- Missing `Package.swift` for modular code
- Access control too broad (everything `public` or `open`)
- Missing `internal` (default) → `private` → `fileprivate` progression
- Missing module boundaries in large apps

## Cross-Module Checks (used in Phase 2)

- Mixed concurrency patterns (GCD in some modules, async/await in others)
- Inconsistent architecture (MVVM in some, MVC in others, VIPER elsewhere)
- Different networking approaches (URLSession direct, Alamofire, custom)
- Inconsistent error types across modules
- Mixed UI approaches (SwiftUI and UIKit without clear boundary)
- Duplicated model types across modules
