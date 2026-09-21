import "dotenv/config";
import jwt from "jsonwebtoken";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest, AuthUser, Role } from "./types.js";
import { pool } from "./db.js";

const jwtSecret = process.env.JWT_SECRET || "";
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET 必须设置且至少 32 个字符");
}

export function createToken(user: AuthUser, authVersion = 0): string {
  return jwt.sign({ ...user, tokenVersion: authVersion }, jwtSecret, { expiresIn: "12h" });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "请先登录" });
    return;
  }
  try {
    const claims = jwt.verify(token, jwtSecret) as jwt.JwtPayload & {
      id?: string;
      tokenVersion?: number;
    };
    if (typeof claims.id !== "string") throw new Error("invalid token subject");
    if (!Number.isFinite(claims.exp)) throw new Error("token expiry is required");
    const tokenVersion = Number.isInteger(claims.tokenVersion) ? claims.tokenVersion! : 0;
    void pool.query<{
      id: string;
      username: string;
      name: string;
      role: Role;
      active: boolean;
      auth_version: number;
    }>(
      `SELECT id, username, name, role, active, auth_version FROM employees WHERE id = $1`,
      [claims.id]
    ).then((result) => {
      const employee = result.rows[0];
      if (!employee || !employee.active || employee.auth_version !== tokenVersion) {
        res.status(401).json({ error: "账号已停用或登录凭据已更新，请重新登录" });
        return;
      }
      req.user = {
        id: employee.id,
        username: employee.username,
        name: employee.name,
        role: employee.role,
        authVersion: employee.auth_version
      };
      req.tokenExpiresAt = claims.exp! * 1000;
      next();
    }).catch(() => {
      res.status(503).json({ error: "登录状态暂时无法验证，请稍后重试" });
    });
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
