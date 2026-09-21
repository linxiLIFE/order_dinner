import type { Request } from "express";

export type Role = "OWNER" | "CASHIER";

export type AuthUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
  authVersion?: number;
};

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
  tokenExpiresAt?: number;
};
