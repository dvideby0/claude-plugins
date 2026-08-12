import { loadCart } from "./cart.js";
import { reserveInventory } from "./inventory.js";
import { recordCheckout } from "./ledger.js";

export type CheckoutStatus = "accepted" | "empty" | "unavailable";

export interface CheckoutResult {
  status: CheckoutStatus;
  reservationId?: string;
}

export async function submitCheckout(
  cartId: string,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  const cart = await loadCart(cartId);
  if (cart.items.length === 0) return { status: "empty" };

  const reservation = await reserveInventory(cart.items);
  if (!reservation.ok) return { status: "unavailable" };

  await recordCheckout({ cartId, idempotencyKey, reservationId: reservation.id });
  return { status: "accepted", reservationId: reservation.id };
}
