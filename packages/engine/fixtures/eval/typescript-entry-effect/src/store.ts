export interface Account {
//               ^^^^^^^ definition scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`store.ts`/Account#
  id: string;
  name: string;
}

export async function loadAccount(id: string): Promise<Account | null> {
//                    ^^^^^^^^^^^ definition scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`store.ts`/loadAccount().
  return id === "account-1" ? { id, name: "Ada" } : null;
}
