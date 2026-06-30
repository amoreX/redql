import { Request, Response } from "express";
import { signup, login } from "../services/auth.services.js";
export const signupController = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const result = await signup(email, password);
    res.status(201).json({ result: result.result, message: result.message });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Server Error" });
  }
};

export const loginController = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const result = await login(email, password);
    res.status(201).json({ result: result.result, message: result.message });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Server Error" });
  }
};
