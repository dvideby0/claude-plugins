import { submitCheckout, type CheckoutResult } from "./checkout.js";

export async function postCheckout(cartId: string, key: string): Promise<CheckoutResult> {
  return submitCheckout(cartId, key);
}
