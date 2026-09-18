import "dotenv/config";
import jwt from "jsonwebtoken";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest, AuthUser, Role } from "./types.js";

const jwtSecret = process.env.JWT_SECRET || "";
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET 必须设置且至少 32 个字符");
}

export function createToken(user: AuthUser): string {
  return jwt.sign(user, jwtSecret, { expiresIn: "12h" });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  try {
    req.user = jwt.verify(token, jwtSecret) as unknown as AuthUser;
    next();
  } catch {
    res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "没有执行此操作的权限" });
      return;
    }
    next();
  };
}
