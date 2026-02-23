# General Language Audit Guide

Use this guide when analyzing files in languages that don't have a dedicated
language-specific audit file. These checks are universal.

## Universal File-Level Checks

### Code Quality
- Functions/methods longer than 50 lines (suggest decomposition)
- Classes/modules longer than 500 lines (suggest splitting)
- Cyclomatic complexity: deeply nested conditionals (> 3 levels)
- Functions with more than 5 parameters (suggest parameter objects)
- Magic numbers and strings (should be named constants)
- Dead code: unreachable branches, commented-out code blocks
- TODO / FIXME / HACK comments (catalog them as tech debt)

### Naming Conventions
- Identify the dominant naming convention (camelCase, snake_case, PascalCase, etc.)
- Flag any deviations from the dominant convention
- Abbreviations and acronyms used inconsistently
- Names that don't reveal intent (single-letter variables outside loops, generic names like `data`, `temp`, `result`)
- Boolean names that don't read as questions (`status` vs `isActive`)

### Error Handling
- Empty catch/except/rescue blocks (silently swallowing errors)
- Overly broad exception catching (catching base Exception class)
- Error messages without context (what operation failed, what input caused it)
- Missing error handling on I/O operations, network calls, file access
- Inconsistent error propagation (some functions throw, others return null/error codes)

### DRY Violations
- Identical or near-identical code blocks across files
- Similar function signatures doing similar things with minor variations
- Copy-pasted validation logic
- Repeated configuration or boilerplate patterns
- String literals used in multiple places (should be constants)

### Security (Universal)
- Hardcoded credentials, API keys, tokens, passwords
- SQL queries built with string concatenation/interpolation
- User input used directly without validation or sanitization
- Missing authentication/authorization checks
- Sensitive data logged or exposed in error messages
- Disabled security features (SSL verification, CSRF protection)
- Secrets in version control (check for .env files committed)

### Performance (Universal)
- Operations inside loops that could be hoisted out
- Unnecessary data copying or allocation in hot paths
- Missing pagination on data queries
- Synchronous I/O where async would be appropriate
- Missing caching for expensive, repeated computations
- Loading entire datasets when only a subset is needed

### Testing (Universal)
- Identify testing framework in use
- Test coverage: which modules have tests, which don't
- Test quality: do tests actually assert behavior or just run code
- Missing edge case tests (null, empty, boundary values, error paths)
- Tests that are tightly coupled to implementation details

### Documentation
- Public APIs / exported functions without documentation
- Complex algorithms without explanatory comments
- Missing README or outdated README
- Architecture decisions not documented anywhere
- Missing changelog

## Cross-Module Checks (used in Phase 2)

- Different approaches to the same problem across modules
- Inconsistent file/folder organization patterns
- Mixed dependency management approaches
- Duplicated utility functions that should be shared
- Inconsistent logging, error handling, or configuration patterns
- Circular dependencies
