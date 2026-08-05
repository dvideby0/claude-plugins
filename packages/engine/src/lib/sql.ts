/**
 * Shared SQL helpers.
 */

/**
 * Escape LIKE wildcards in user- or path-derived match text.
 *
 * `_` matches any single character and appears in half of all real
 * filenames — unescaped, a suffix match for `__init__.py` happily resolves
 * to `reinitdb.py`. Use with `LIKE ? ESCAPE '\'`.
 */
export function likeEscape(text: string): string {
  return text.replace(/([%_\\])/g, "\\$1");
}
