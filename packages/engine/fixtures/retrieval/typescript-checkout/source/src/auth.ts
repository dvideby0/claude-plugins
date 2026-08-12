export function authenticateSession(token: string): boolean {
  return token.startsWith("session-");
}

export function refreshAuthentication(token: string): string {
  return `${token}-refreshed`;
}
