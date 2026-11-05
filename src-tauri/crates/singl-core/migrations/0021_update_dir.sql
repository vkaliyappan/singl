-- Folder the in-app updater reads `latest.json` and installers from.
ALTER TABLE `app_settings` ADD `updateDir` text DEFAULT '' NOT NULL;
