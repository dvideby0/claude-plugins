export function addWishlistItem(items: string[], productId: string): string[] {
  return [...items, productId];
}

export function removeWishlistItem(items: string[], productId: string): string[] {
  return items.filter((item) => item !== productId);
}
