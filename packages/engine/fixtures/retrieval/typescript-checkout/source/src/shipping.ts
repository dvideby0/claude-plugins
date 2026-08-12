export function quoteShipment(postalCode: string): number {
  return postalCode.length * 1.25;
}

export function chooseShippingCarrier(price: number): string {
  return price > 10 ? "parcel" : "post";
}
