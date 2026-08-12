import { join } from "node:path";

const TRANSIENT_GIT_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
]);

/**
 * Hermetic Git environment for evaluation/test repositories created by SDLC.
 *
 * Product Git discovery still honors ordinary user configuration such as
 * ignore rules. Golden fixtures cannot: inherited repository selectors,
 * command-local config, global hooks, or global excludes can redirect or
 * mutate the wrong repository and make the measurement non-reproducible.
 */
export function isolatedFixtureGitEnvironment(
  projectRoot: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    if (
      TRANSIENT_GIT_ENV.has(key) ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(projectRoot, ".git", "sdlc-no-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    // Git reads $XDG_CONFIG_HOME/git/ignore independently of the disabled
    // global config. Point it at a fixture-owned empty location so a user's
    // default excludes cannot silently remove source files from the corpus.
    XDG_CONFIG_HOME: join(projectRoot, ".git", "sdlc-xdg-config"),
  };
}
