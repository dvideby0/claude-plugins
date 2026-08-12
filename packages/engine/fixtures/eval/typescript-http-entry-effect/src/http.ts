import { crossQuery, normalizeSearchQuery } from "./search.js";

function sendJson(_res: unknown, _status: number, _payload: unknown): void {}

export async function handleApi(path: string, method: string, res: unknown): Promise<boolean> {
  if (path === "/api/search" && method === "GET") {
    let term: string;
    try {
      term = normalizeSearchQuery("database");
    } catch (error) {
      sendJson(res, 400, { error: String(error) });
      return true;
    }
    if (!term) {
      sendJson(res, 400, { error: "invalid query" });
      return true;
    }
    const results = await crossQuery(term);
    sendJson(res, 200, results);
    return true;
  }
  return false;
}
