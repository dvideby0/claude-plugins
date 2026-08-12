export function buildRevenueReport(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function renderRevenueReport(total: number): string {
  return `revenue:${total}`;
}
