# Phase 1.5: Variant Analysis

After all sub-agents complete, extract high-severity issues and search for
the same patterns across the entire repo. Bugs tend to be copy-pasted or
follow recurring patterns — finding one usually means there are more.

## Step 1: Extract Issue Patterns

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/extract-variants.sh .
```

**If jq is NOT available:** The script exits gracefully. Manually read each
module JSON, extract critical/warning issues, and group by `guide_rule` to
identify patterns.

## Step 2: Search for Variants of Single-Occurrence Critical Issues

Read `sdlc-audit/data/variant-candidates.json`. For each entry in `single_critical`:

1. Read the original issue's description and the affected file
2. Derive a grep-able pattern from the issue. Examples:
   - "SQL string concatenation" -> search for string interpolation in SQL contexts
   - "Unvalidated user input" -> search for request parameters used without validation
   - "Hardcoded credentials" -> search for password/secret/token string literals
   - "Missing error handling" -> search for unchecked promise/error patterns
3. Use Claude Code's Grep tool to search for the pattern across the repo
4. Any new matches are additional findings to add to the analysis

## Step 3: Flag Systemic Patterns

For entries in `systemic_patterns` (same pattern in 3+ modules):
- These represent codebase-wide anti-patterns, not isolated issues
- They should be reported as systemic findings in the AUDIT_REPORT.md
- Include a recommendation for a codebase-wide fix (e.g., "Create a parameterized
  query helper" rather than "Fix this one query")

## Step 4: Write Variant Analysis Output

Write `sdlc-audit/data/variant-analysis.json`:
```json
{
  "systemic_patterns": [
    {
      "pattern": "Unparameterized SQL queries",
      "guide_rule": "SQL/NoSQL injection via string concatenation",
      "occurrences": 7,
      "files": ["src/api/users.ts:45", "src/api/orders.ts:78"],
      "severity": "critical",
      "confidence": "high",
      "recommendation": "Create a parameterized query helper and migrate all raw SQL"
    }
  ],
  "variant_search_results": [
    {
      "original_finding": {"file": "src/api/users.ts", "issue": "SQL injection"},
      "new_matches": [
        {"file": "src/api/admin.ts", "line": 92, "match": "...matched text..."}
      ]
    }
  ]
}
```
