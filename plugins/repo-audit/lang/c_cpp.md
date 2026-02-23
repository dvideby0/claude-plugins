# C / C++ Audit Guide

## File-Level Analysis

### Memory Safety (Critical)
- Manual `malloc` / `new` without corresponding `free` / `delete` (memory leaks)
- Use-after-free: accessing memory after deallocation
- Double free: freeing the same pointer twice
- Buffer overflows: array access without bounds checking, `strcpy` / `sprintf` without length limits
- Missing null checks after `malloc` / `calloc` (can return NULL)
- Raw pointers in C++ where smart pointers (`unique_ptr`, `shared_ptr`) are appropriate
- `new` / `delete` in C++ instead of RAII patterns or smart pointers
- Missing virtual destructors on base classes with virtual methods
- Dangling pointers: returning pointer to local variable
- Stack buffer overflow: fixed-size buffers with unbounded input (`gets`, `scanf` without width)

### C-Specific Issues
- Missing `const` on function parameters that aren't modified
- Macro abuse: complex macros that should be `inline` functions
- Missing `static` on file-scope functions (should not be globally visible)
- Implicit function declarations (calling functions before declaring them)
- Missing `restrict` keyword on pointer parameters that don't alias
- Using `void*` excessively where `_Generic` or tagged unions would be type-safer
- Missing `_Noreturn` / `_Static_assert` where applicable (C11+)
- Global mutable state without thread safety consideration

### C++-Specific Issues
- Missing `override` keyword on virtual method overrides
- Missing `noexcept` on move constructors and move assignment operators
- Missing `[[nodiscard]]` on functions where ignoring return value is a bug
- `const_cast` to remove const (almost always wrong)
- `reinterpret_cast` usage (flag and verify each instance)
- Missing copy/move constructor or assignment operator (Rule of Five)
- Implicit conversions via single-argument constructors (missing `explicit`)
- `std::endl` where `'\n'` suffices (endl flushes, which is usually unnecessary)
- C-style casts `(int)x` instead of `static_cast<int>(x)`
- Missing `constexpr` on compile-time computable functions/values
- Exceptions used for control flow rather than error conditions
- Missing RAII wrappers for C library resources (file handles, sockets, etc.)
- `using namespace std;` in header files (pollutes all includers)
- Missing `= delete` on copy constructor/assignment for non-copyable types

### Concurrency
- Data races: shared variables without mutex/atomic protection
- Missing `std::atomic` for simple shared flags/counters
- `std::mutex` not wrapped in `std::lock_guard` / `std::unique_lock` (manual lock/unlock)
- Deadlock risk: acquiring multiple locks in inconsistent order
- Missing `volatile` on hardware-mapped registers (embedded context)
- Condition variables without predicate check (spurious wakeup)
- `pthread` functions without checking return codes

### Build & Headers
- Missing include guards (`#pragma once` or `#ifndef`) on headers
- Header files including unnecessary headers (increases compile time)
- Missing forward declarations (including full header where forward decl suffices)
- Circular includes between headers
- Missing `extern "C"` guards in headers used by both C and C++
- Compilation warnings treated as non-errors (`-Wall -Werror` not enabled)
- Missing `-fsanitize=address,undefined` in debug builds

### Security
- Buffer overflows via `strcpy`, `strcat`, `sprintf`, `gets` (use `strncpy`, `snprintf`, `fgets`)
- Format string vulnerabilities: `printf(user_input)` instead of `printf("%s", user_input)`
- Integer overflow: arithmetic without overflow checking
- Uninitialized variable usage
- `system()` calls with user-controlled input (command injection)
- Missing input validation on data from external sources
- TOCTOU (time-of-check-time-of-use) race conditions on file operations
- Hardcoded credentials or keys

### Performance
- Unnecessary copies: passing large structs by value instead of by reference/pointer
- Missing `std::move` on rvalue references
- Virtual function calls in hot loops (vtable overhead)
- Cache-unfriendly data layouts (array of structs vs struct of arrays)
- Missing `reserve()` on vectors when size is predictable
- String operations in hot paths without `string_view` (C++17)
- Heap allocation in hot loops (consider stack or pool allocation)
- Missing `constexpr` evaluation for compile-time computable expressions

### Testing (Google Test / Catch2 / CTest)
- Missing unit tests for critical functions
- Tests without assertions (EXPECT_* / ASSERT_*)
- Missing memory sanitizer runs in CI (ASan, MSan, UBSan)
- Tests that depend on file system or network without mocking
- Missing fuzz testing for parsing functions
- Benchmarks missing for performance-critical code

### Project Structure
- Source and headers not clearly separated (`include/` and `src/`)
- Missing `CMakeLists.txt` or `Makefile` organization
- Object files or binaries committed to version control
- Missing `.clang-format` / `.clang-tidy` configuration
- Third-party code copied in without clear vendoring strategy
- Missing `pkg-config` or `find_package` for dependency management

## Cross-Module Checks (used in Phase 2)

- Mixed C and C++ without clear boundary (which files use which standard)
- Inconsistent memory management (raw pointers in some, smart pointers in others)
- Different error handling approaches (error codes, exceptions, errno)
- Mixed string types (`char*`, `std::string`, custom string class)
- Inconsistent naming conventions (Google style, LLVM style, custom)
- Duplicated utility functions across translation units
- Missing shared header for common types and constants
- Inconsistent use of C++ standard version features
