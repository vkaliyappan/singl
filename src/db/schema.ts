import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appSettings = sqliteTable("app_settings", {
  id: int().primaryKey(),
  azurePatToken: text().notNull().default(""),
  updatedAt: int({ mode: "timestamp" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
});

export const repoSettings = sqliteTable("repo_settings", {
  id: int().primaryKey(),
  repoUrl: text().notNull().default(""),
  clonedBranch: text().notNull().default(""),
  repoSlug: text().notNull().default(""),
  updatedAt: int({ mode: "timestamp" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
});

export const environmentSettings = sqliteTable("environment_settings", {
  id: int().primaryKey({ autoIncrement: true }),
  environment: text().notNull().unique(),
  twxBaseUrl: text().notNull().default(""),
  twxAppKey: text().notNull().default(""),
  createdAt: int({ mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: int({ mode: "timestamp" }).$defaultFn(() => new Date()).$onUpdateFn(() => new Date()),
});
