import type { CartItem } from "./cart.js";

export interface InventoryReservation {
  id: string;
  ok: boolean;
}

export async function reserveInventory(items: CartItem[]): Promise<InventoryReservation> {
  return { id: `reservation-${items.length}`, ok: items.length > 0 };
}
