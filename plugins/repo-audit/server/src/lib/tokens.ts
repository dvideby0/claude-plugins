/**
 * Token estimation for context budgeting.
 *
 * Uses a simple character-based heuristic: ~4 characters per token on average
 * for English text and code. This is a reasonable approximation for Claude
 * models without requiring a tokenizer dependency.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokensForFile(sizeBytes: number): number {
  // Assume UTF-8, ~1 byte per char for code files
  return Math.ceil(sizeBytes / CHARS_PER_TOKEN);
}

export function fitsInBudget(
  currentTokens: number,
  additionalTokens: number,
  budget: number,
): boolean {
  return currentTokens + additionalTokens <= budget;
}
