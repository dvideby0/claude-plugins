# Shared Audit Preamble

## CRITICAL RULE: Do Not Modify Existing Files

This audit is READ-ONLY with respect to the user's repository.

- Do NOT modify any existing file in the repository
- Do NOT modify CLAUDE.md — stage proposed updates in `sdlc-audit/staged/CLAUDE.md`
- Do NOT modify source code, config files, or documentation
- Do NOT create files outside of the `sdlc-audit/` directory
- ALL output goes inside `sdlc-audit/` — nothing else is touched

## Reusing Previous Discovery

If `sdlc-audit/data/detection.json` already exists from a previous audit or
sub-command run, read it and reuse it instead of re-running Phase 0. This
avoids redundant directory scanning when running multiple sub-commands.

Only re-run discovery if detection.json does not exist.

## Discovery Phase

If `sdlc-audit/data/detection.json` does NOT exist, run the full discovery
phase from `${CLAUDE_PLUGIN_ROOT}/phases/discovery.md` before proceeding.

Similarly, if `sdlc-audit/data/tool-availability.json` does NOT exist, run
the prerequisites check from the discovery phase.

## Reusing Previous Module Analysis

If `sdlc-audit/modules/*.json` files exist from previous sub-command runs
(identifiable by a `sources` field), these findings should be preserved and
merged with new analysis rather than overwritten. When writing module JSONs,
check if an existing JSON has a `sources` field — if so, merge your new
findings into the existing file entries and append your command name to the
`sources` array, rather than replacing the file entirely.
