import { loadAccount } from "./store.js";
//       ^^^^^^^^^^^ reference scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`store.ts`/loadAccount().

export interface Response {
//               ^^^^^^^^ definition scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`main.ts`/Response#
  status: number;
  body: string;
}

export async function handleAccount(id: string): Promise<Response> {
//                    ^^^^^^^^^^^^^ definition scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`main.ts`/handleAccount().
  if (!id) throw new Error("missing account id");
  const account = await loadAccount(id);
//                      ^^^^^^^^^^^ reference scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`store.ts`/loadAccount().
  if (!account) return { status: 404, body: "not found" };
  return { status: 200, body: account.name };
}

void handleAccount("account-1");
//   ^^^^^^^^^^^^^ reference scip-typescript npm sdlc-eval-typescript-entry-effect HEAD src/`main.ts`/handleAccount().
