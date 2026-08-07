export interface Account {
  id: string;
  name: string;
}

export async function loadAccount(id: string): Promise<Account | null> {
  return id === "account-1" ? { id, name: "Ada" } : null;
}
