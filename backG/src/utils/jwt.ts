import jwt from "jsonwebtoken";

export type TokenPayload = { userId: string };

// sign a 7-day JWT carrying the user id
export function signToken(userId: string): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: 60 * 60 * 24 * 7,
  });
}

// verify + decode a token; throws if invalid/expired
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}
