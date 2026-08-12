export function recommendProducts(history: string[]): string[] {
  return history.map((item) => `related:${item}`);
}

export function rankRecommendations(products: string[]): string[] {
  return [...products].sort();
}
