import { submitCheckout } from "./checkout.js";

export async function checkoutAcceptsReservedInventory(): Promise<boolean> {
  const result = await submitCheckout("cart-1", "stable-request-key");
  return result.status === "accepted" && Boolean(result.reservationId);
}
