import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";

export const signup = async (
  email: string,
  password: string,
): Promise<{ result: boolean; message: string }> => {
  const rows = await db.select().from(users).where(eq(users.email, email));
  if (rows.length > 0) {
    return { result: false, message: "User already exists!" };
  }
  const passHash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(users).values({ email, passHash }).returning();
  if (user) {
    return { result: true, message: "User created" };
  } else {
    return { result: false, message: "Signup Failed" };
  }
};

export const login = (
  email: string,
  password: string,
): { result: boolean; message: string } => {
  return { result: true, message: "" };
};
