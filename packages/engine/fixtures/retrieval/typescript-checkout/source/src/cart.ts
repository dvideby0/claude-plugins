export interface CartItem {
  sku: string;
  quantity: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
}

export async function loadCart(cartId: string): Promise<Cart> {
  return { id: cartId, items: [{ sku: "fixture-sku", quantity: 1 }] };
}
