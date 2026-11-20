-- Claude Code rows held its session's running total cost, not the turn's; clear them
-- so db::open prices them from their tokens (assistant::usage::backfill_costs).
UPDATE `assistant_usage` SET `costUsd` = NULL WHERE `provider` = 'claude';
