import type { Request } from "express";

export type Role = "OWNER" | "CASHIER";

export type AuthUser = {
  id: string;
  username: string;
  name: string;
  role: Role;
};

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
};
