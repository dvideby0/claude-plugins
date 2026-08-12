export interface CheckoutRecord {
  cartId: string;
  idempotencyKey: string;
  reservationId: string;
}

export async function recordCheckout(record: CheckoutRecord): Promise<void> {
  void record;
}
