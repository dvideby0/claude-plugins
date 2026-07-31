# Security lens

Look for what static tools miss: intent, data flow across trust boundaries,
and gaps between layers. The secret scanner and linters already ran — go
deeper than pattern matching.

## Trace, don't pattern-match

- Follow user input from entry point through every transformation to its sink
  (query, template, filesystem path, shell, HTTP call). Report the gap, not the
  sink.
- Check validation happens server-side and after deserialization, not only at
  the edge.
- Identify type coercion that defeats a check (`"0" == false`, `int()` on
  attacker input, loose comparison on tokens).

## Auth and access

- Trace auth end to end: who sets the session, who verifies it, what happens on
  error. Fail-open paths are critical.
- Token validation must check signature, expiry, issuer and audience — partial
  validation is a finding.
- Look for endpoints that skip the auth middleware, and for authorization
  checks that verify authentication but never ownership (IDOR).
- Password storage must use bcrypt, argon2 or scrypt.

## Injection and deserialization

- SQL/NoSQL built by concatenation or f-string, even when "internal".
- `eval`, `exec`, `pickle.load`, `yaml.load` without `SafeLoader`, dynamic
  `import`, shell invocation with `shell=True` and interpolated arguments.
- Path joins on user input without normalization (traversal).
- Unescaped values reaching HTML/templating (`innerHTML`,
  `dangerouslySetInnerHTML`, `| safe`).

## Code the repository runs on someone else's machine

The deterministic pass already flags install hooks that pipe downloads into a
shell, attacker-controlled interpolation in workflows, `pull_request_target`
checkouts, and agent config that executes commands. Look for what that misses:

- Build or test scripts that fetch unpinned remote content, or resolve a
  dependency from a URL, git ref, or local tarball rather than the registry.
- Workflow steps that run on untrusted input with elevated permissions, or
  that expose secrets to a step which then calls out to the network.
- Agent and editor config (`.claude/`, `.mcp.json`, `.vscode/tasks.json`) that
  grants broad permissions or points at a script whose contents can change.
- Anything that writes outside the repository, or persists across sessions.

## Exposure

- Secrets in defaults, fixtures, comments or error messages.
- Errors returning stack traces, SQL, or internal paths to the caller.
- Logging of credentials, tokens, or full request bodies.
- Permissive CORS, disabled TLS verification, debug mode reachable in
  production config.

Report each finding with the exact path from untrusted input to the unsafe
operation. If you cannot show that path, say so in the description and lower
your confidence.
