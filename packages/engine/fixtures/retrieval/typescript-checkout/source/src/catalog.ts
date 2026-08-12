export function searchCatalog(term: string): string[] {
  return term ? [`product:${term}`] : [];
}

export function normalizeCatalogQuery(term: string): string {
  return term.trim().toLowerCase();
}
