import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signToken } from "../utils/jwt.js";

type AuthResult = { result: boolean; message: string; token?: string };

export const signup = async (
  email: string,
  password: string,
): Promise<AuthResult> => {
  const rows = await db.select().from(users).where(eq(users.email, email));
  if (rows.length > 0) {
    return { result: false, message: "User already exists!" };
  }
  const passHash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(users).values({ email, passHash }).returning();
  if (!user) {
    return { result: false, message: "Signup Failed" };
  }
  return { result: true, message: "User created", token: signToken(user.id) };
};

export const login = async (
  email: string,
  password: string,
): Promise<AuthResult> => {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    return { result: false, message: "Invalid credentials" };
  }
  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) {
    return { result: false, message: "Invalid credentials" };
  }
  return { result: true, message: "Logged in", token: signToken(user.id) };
};
