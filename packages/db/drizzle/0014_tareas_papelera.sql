ALTER TABLE `tasks` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_by` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_deleted_at` ON `tasks` (`deleted_at`);
