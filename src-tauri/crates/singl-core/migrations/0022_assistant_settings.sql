-- App-wide assistant: API keys, MCP server port/token, project MCP servers, defaults (JSON).
ALTER TABLE `app_settings` ADD `assistantSettings` text DEFAULT '{}' NOT NULL;
