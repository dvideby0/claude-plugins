# Python Audit Guide

## File-Level Analysis

When analyzing each Python file, check for these language-specific issues:

### Type Safety
- Missing type hints on function signatures (params and return types)
- Use of `Any` where a more specific type is possible
- Missing `Optional[]` annotations (using `None` default without Optional type)
- Inconsistent use of type hints (some functions annotated, others not)
- Missing `py.typed` marker for library packages
- `# type: ignore` comments — count and flag each one
- No `mypy` / `pyright` configuration present

### Python Idioms & Anti-Patterns
- Mutable default arguments (`def foo(items=[])`) — critical bug source
- Bare `except:` or `except Exception:` that swallows errors silently
- Using `type()` for type checking instead of `isinstance()`
- Manual string formatting instead of f-strings (consistency)
- `import *` usage (namespace pollution)
- Nested functions/closures where a class or module function is clearer
- God classes with 10+ methods that do unrelated things
- Overly broad try/except blocks wrapping 20+ lines
- Using `dict` when `dataclass`, `NamedTuple`, or `TypedDict` is appropriate
- Manual `__init__` boilerplate that should be a `@dataclass`

### Async Patterns (if asyncio / FastAPI / aiohttp detected)
- Blocking calls (`time.sleep`, synchronous I/O) inside async functions
- Missing `await` on coroutines (coroutine never awaited warning at runtime)
- `asyncio.run()` called inside an already-running event loop
- Sequential `await` where `asyncio.gather()` would parallelize
- Mixing `threading` and `asyncio` without proper bridges
- Missing timeout on async operations (`asyncio.wait_for`)
- Spawning unbounded tasks without semaphore

### Django-Specific (if Django detected)
- N+1 queries: accessing related objects in loops without `select_related` / `prefetch_related`
- Missing database indexes on filtered/ordered fields
- Raw SQL without parameterization
- Business logic in views instead of model methods or services
- Missing model `__str__` methods
- Querysets evaluated multiple times (not cached)
- Missing `on_delete` specification on ForeignKey
- Settings with `DEBUG = True` in production configs
- Missing CSRF protection
- Hardcoded URLs instead of `reverse()`

### FastAPI-Specific (if FastAPI detected)
- Missing Pydantic model validation on request bodies
- Missing response model declarations
- Synchronous database calls in async endpoints
- Missing dependency injection for shared resources (DB sessions, auth)
- Missing OpenAPI metadata (descriptions, examples)
- Background tasks without error handling
- Missing rate limiting middleware

### Flask-Specific (if Flask detected)
- App factory pattern not used (global app instance)
- Missing request validation
- SQL injection via string formatting with SQLAlchemy `text()`
- Missing CORS configuration
- Session secret key hardcoded or weak

### Data & Scientific (if pandas/numpy/scipy detected)
- Iterating over DataFrames row-by-row instead of vectorized operations
- Chained indexing (`df[col][row]`) instead of `.loc` / `.iloc`
- Missing `.copy()` causing SettingWithCopyWarning
- Loading entire datasets into memory without chunking
- Ignoring dtypes (everything as object/string)

### Testing (pytest assumed unless unittest detected)
- Tests without assertions (just calling code without checking results)
- Missing fixture usage (setup/teardown duplicated across tests)
- Tests that depend on execution order
- Missing parametrize for similar test cases
- No conftest.py for shared fixtures
- Tests hitting real external services without mocking
- Missing edge case coverage (None, empty, boundary values)

### Packaging & Structure
- Missing `__init__.py` where needed (or present where not needed in modern Python)
- Relative imports going up multiple levels
- Circular imports between modules
- Missing `if __name__ == "__main__":` guard on executable modules
- Dependencies not pinned in requirements.txt (no version specifiers)
- Dev dependencies mixed with production dependencies
- Missing `pyproject.toml` (modern Python packaging)

### Performance
- String concatenation in loops (use `join()` or `io.StringIO`)
- Repeated dict/list comprehension rebuilding the same data
- Missing `lru_cache` / `cache` on expensive pure functions
- Global state mutation in module scope
- Creating new loggers per function call instead of module-level
- Large file reads without streaming/chunking

### Security
- `eval()` / `exec()` on user input
- `pickle.load()` on untrusted data
- Hardcoded secrets, API keys, passwords
- `subprocess.shell=True` with user-controlled input
- Missing input sanitization
- YAML `load()` instead of `safe_load()`
- Disabled SSL verification (`verify=False`)

## Cross-Module Checks (used in Phase 2)

When comparing across modules:
- Mixed string formatting styles (f-strings, .format(), % formatting)
- Inconsistent import ordering (stdlib vs third-party vs local)
- Some modules using dataclasses, others using plain dicts for same patterns
- Inconsistent logging (print() vs logging module vs structlog)
- Mixed error handling: some modules raise, others return None, others return Result types
- Different ORM patterns across similar database operations
- Inconsistent naming: `get_user` vs `fetch_user` vs `load_user` vs `find_user`
- Some modules with docstrings, others without
