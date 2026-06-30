import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.js";

// Request with the authenticated user id attached by this middleware.
export interface AuthedRequest extends Request {
  userId?: string;
}

// Gate: needs `Authorization: Bearer <token>`. Verifies it, attaches userId.
export const requireAuth = (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const { userId } = verifyToken(header.slice(7));
    req.userId = userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};
