# Infrastructure & Configuration Audit Guide

This covers non-source files that are critical to the project.

## Dockerfile / Container Analysis
- Multi-stage builds missing (final image includes build tools)
- Running as root (missing `USER` directive)
- Missing `.dockerignore` (node_modules, .git, etc. copied into image)
- Using `latest` tag on base images (non-reproducible builds)
- Missing health check (`HEALTHCHECK` directive)
- Secrets baked into image (ARG/ENV with credentials)
- Missing `--no-cache-dir` on pip install (bloated image)
- `apt-get install` without `--no-install-recommends` and cleanup
- Missing `COPY --chown` for file ownership
- `docker-compose.yml` with hardcoded passwords

## CI/CD Pipeline Analysis
- Missing test step before deploy
- Missing caching (dependencies re-downloaded every run)
- Secrets in plaintext in workflow files
- Missing matrix strategy for cross-platform/version testing
- Deploy step without environment protection / approval gate
- Missing artifact upload/download between jobs
- Running on `ubuntu-latest` instead of pinned version (non-reproducible)
- Missing timeout configuration on jobs
- Missing concurrency control (multiple deploys racing)
- Missing rollback mechanism

## Environment & Secrets
- `.env` files committed to version control
- Secrets in source code (API keys, passwords, tokens, connection strings)
- Missing `.env.example` documenting required environment variables
- Missing secret rotation strategy documentation
- Development secrets identical to production (indicates shared credentials)
- Missing environment variable validation at startup

## Database & Migrations
- Missing migration files for schema changes
- Migrations with destructive operations without data preservation
- Missing rollback migrations (irreversible changes)
- Seeds/fixtures with production-like data in version control
- Missing database backup strategy documentation

## Package Management
- Lockfiles missing from version control (`package-lock.json`, `Gemfile.lock`, etc.)
- Lockfiles out of sync with manifest
- Unpinned dependency versions in manifest
- Known vulnerabilities in dependencies (check for audit commands)
- Dev dependencies installed in production
- Multiple package managers in same project (npm + yarn, pip + poetry)

## Configuration Files
- Missing `.editorconfig` for consistent formatting
- Linter configs disabled or overly permissive
- Missing `.gitattributes` for line ending normalization
- `tsconfig.json` / compiler config with overly loose settings
- Missing pre-commit hooks configuration (husky, pre-commit, lefthook)

## Documentation
- Missing or outdated `README.md`
- Missing `CONTRIBUTING.md` for open source projects
- Missing `CHANGELOG.md` or release notes
- Missing architecture decision records (ADRs)
- API documentation missing or out of date
- Missing runbook / operations documentation
- Missing onboarding documentation

## Cross-Module Checks (used in Phase 2)

- CI/CD config doesn't match actual project structure (tests for modules that don't exist, missing modules)
- Docker setup doesn't match dependency files (Dockerfile installs Python but project is Node)
- Environment variables referenced in code but not in `.env.example`
- Config files contradicting each other (prettier vs eslint formatting rules)
- Missing monitoring / observability setup for production services
