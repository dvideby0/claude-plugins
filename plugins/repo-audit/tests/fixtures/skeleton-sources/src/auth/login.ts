import { Request, Response } from "express";
import { verifyToken } from "../utils/jwt";

export async function handleLogin(req: Request, res: Response) {
  const { username, password } = req.body;
  return res.json({ token: "abc" });
}

export const MAX_RETRIES = 3;

export class AuthService {
  private tokens: Map<string, string>;

  constructor() {
    this.tokens = new Map();
  }

  async validate(token: string): Promise<boolean> {
    return this.tokens.has(token);
  }
}

export interface LoginPayload {
  username: string;
  password: string;
}

export type AuthResult = "success" | "failure";

function hashPassword(pw: string): string {
  return pw;
}
