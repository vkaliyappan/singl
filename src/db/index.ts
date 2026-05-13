import { drizzle } from "drizzle-orm/libsql";

export const db = drizzle({ connection: process.env.DATABASE_URL! });
