# TypeScript / JavaScript Audit Guide

## File-Level Analysis

When analyzing each TS/JS file, check for these language-specific issues:

### Type Safety
- `any` usage — flag every instance, especially in function params and return types
- Missing return types on exported functions
- Type assertions (`as`) that bypass safety — especially `as any`
- Non-null assertions (`!`) without justification
- Missing generic constraints (bare `<T>` where `<T extends Something>` is appropriate)
- `@ts-ignore` / `@ts-expect-error` comments — count them, they indicate type system workarounds
- Loose `tsconfig.json` settings (`strict: false`, `noImplicitAny: false`)

### Async Patterns
- Unhandled promise rejections (missing `.catch()` or try/catch around `await`)
- `async` functions that never `await` (unnecessary async wrapper)
- Sequential `await` in loops where `Promise.all` would work
- Fire-and-forget promises (calling async function without await)
- Missing `AbortController` / timeout on fetch calls
- Callback-style code mixed with async/await in the same module

### React-Specific (if React detected)
- Missing dependency arrays in `useEffect` / `useMemo` / `useCallback`
- Inline object/function creation in JSX props (causes unnecessary re-renders)
- Large components that should be split (> 200 lines of JSX)
- State that should be derived instead of stored
- Missing `key` props or using array index as key on dynamic lists
- Direct DOM manipulation instead of refs
- `useEffect` for things that should be event handlers
- Missing error boundaries
- Prop drilling through 3+ levels (suggests need for context or state management)

### Next.js-Specific (if Next.js detected)
- Client components that could be server components
- Missing `loading.tsx` / `error.tsx` boundary files
- Using `useEffect` for data fetching instead of server components / route handlers
- Large client bundles (check for `"use client"` on files that import heavy deps)
- Missing metadata exports on page files
- API routes without input validation

### Node.js / Server-Side
- Synchronous file system operations (`fs.readFileSync`) in request handlers
- Missing environment variable validation at startup
- Secrets/credentials in source code
- Missing rate limiting on API endpoints
- SQL/NoSQL injection via string concatenation
- Missing input validation/sanitization
- Unbounded queries (missing LIMIT/pagination)
- Memory leaks: event listeners not cleaned up, growing Maps/Sets, unclosed streams

### Module Patterns
- Barrel files (`index.ts`) that re-export everything (tree-shaking killers)
- Circular imports (A imports B imports A)
- Side effects in module scope (code that runs on import)
- Default exports mixed with named exports inconsistently
- Relative import paths going up 3+ levels (`../../../`)

### Performance
- Bundle-heavy imports (`import _ from 'lodash'` vs `import get from 'lodash/get'`)
- Missing dynamic imports for code splitting
- Large constant arrays/objects defined inside components (should be module-level)
- Unnecessary spread operations creating new objects in hot paths
- Regex compilation inside loops

### Testing
- Test files that only test happy paths
- Mocking implementations that are tightly coupled to implementation details
- Missing edge case tests (null, undefined, empty array, boundary values)
- Snapshot tests on large/volatile components (brittle)
- Test descriptions that don't describe behavior (`test('works')`)

## Cross-Module Checks (used in Phase 2)

When comparing across modules:
- Are some modules using `interface` and others `type` for the same patterns?
- Mixed ESM (`import`) and CJS (`require`) across the codebase?
- Inconsistent error class hierarchies
- Multiple HTTP clients (axios in one module, fetch in another)
- Multiple state management approaches without clear reasoning
- Inconsistent naming: `getUserById` vs `fetchUser` vs `loadUserData` for similar operations
- Mixed testing frameworks or assertion styles
