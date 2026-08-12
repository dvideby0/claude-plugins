export function calculateCatalogPrice(base: number, taxRate: number): number {
  return base * (1 + taxRate);
}

export function formatCatalogPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}
