/**
 * Guarding a loopback HTTP server.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not other *pages* on
 * this one: a site whose DNS name resolves to 127.0.0.1 can have the
 * browser issue requests here. Checking Host defeats that rebinding, checking
 * Origin defeats ordinary cross-site fetches, and the bearer token covers
 * every non-browser caller.
 */

import type { IncomingMessage } from "node:http";

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

function allowedAuthorities(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/**
 * Applies to every route, including the UI.
 *
 * This is the check that keeps other pages on this machine out. It cannot
 * depend on the token, because the page that carries the token has to be
 * fetched before any script of ours can run.
 */
export function checkOrigin(req: IncomingMessage, port: number): AuthResult {
  const authorities = allowedAuthorities(port);

  // Host: rejects DNS-rebinding, where the name resolves here but is not ours.
  const host = req.headers.host;
  if (!host || !authorities.includes(host.toLowerCase())) {
    return { ok: false, status: 403, message: "Forbidden: unexpected Host header." };
  }

  // Origin: present only on browser-issued requests; must be this server.
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, message: "Forbidden: malformed Origin header." };
    }
    if (!authorities.includes(originHost)) {
      return { ok: false, status: 403, message: "Forbidden: cross-origin request." };
    }
  }

  return { ok: true };
}

/**
 * Applies to authenticated daemon routes.
 *
 * The UI receives this token embedded in its own HTML; every other caller —
 * the bridge above all — presents it as a bearer header.
 */
export function checkToken(req: IncomingMessage, token: string): AuthResult {
  const header = req.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!presented || !timingSafeEqual(presented, token)) {
    return { ok: false, status: 401, message: "Unauthorized: bad or missing bearer token." };
  }
  return { ok: true };
}

/**
 * Authenticate the one UI response that contains the bearer token.
 *
 * Electron supplies the token on its initial URL because a page cannot set an
 * Authorization header for its own navigation. The UI removes that query
 * parameter from browser history before doing any other work. Bearer auth is
 * also accepted for non-browser clients and tests.
 */
export function checkUiBootstrap(req: IncomingMessage, token: string): AuthResult {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  let query: string | null = null;
  try {
    query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  } catch {
    return { ok: false, status: 400, message: "Bad request: malformed URL." };
  }
  const presented = bearer ?? query;
  if (!presented || !timingSafeEqual(presented, token)) {
    return { ok: false, status: 401, message: "Unauthorized: bad or missing UI token." };
  }
  return { ok: true };
}

/** Constant-time compare, so a wrong token leaks nothing through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
