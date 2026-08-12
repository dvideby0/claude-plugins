export function normalizeSearchQuery(value: string): string {
  if (!value) throw new Error("empty query");
  return value.trim();
}

export async function crossQuery(value: string): Promise<string[]> {
  return [value];
}
