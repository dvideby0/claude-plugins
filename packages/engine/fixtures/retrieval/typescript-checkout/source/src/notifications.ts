export async function sendCheckoutEmail(address: string): Promise<string> {
  return `email:${address}`;
}

export async function sendShippingSms(phone: string): Promise<string> {
  return `sms:${phone}`;
}
