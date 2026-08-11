import { loadAccount } from "./store.js";

export interface Response {
  status: number;
  body: string;
}

export async function handleAccount(id: string): Promise<Response> {
  if (!id) throw new Error("missing account id");
  const account = await loadAccount(id);
  if (!account) return { status: 404, body: "not found" };
  return { status: 200, body: account.name };
}

void handleAccount("account-1");
