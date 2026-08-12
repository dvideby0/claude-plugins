export function applyCoupon(total: number, percent: number): number {
  return total * (1 - percent / 100);
}

export function validateCoupon(code: string): boolean {
  return code.startsWith("SAVE-");
}
