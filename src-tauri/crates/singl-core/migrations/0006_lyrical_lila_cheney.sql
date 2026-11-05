ALTER TABLE `app_settings` ADD `bundleSrcDir` text DEFAULT './WindchillClients/Thingworx' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `bundleDestDir` text DEFAULT './dist/bundles' NOT NULL;
