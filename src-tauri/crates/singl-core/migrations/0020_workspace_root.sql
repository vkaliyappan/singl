-- First sqlx-only migration: 0000-0019 are singl-web's Drizzle migrations, copied verbatim.
ALTER TABLE `app_settings` ADD `workspaceRoot` text DEFAULT '' NOT NULL;
