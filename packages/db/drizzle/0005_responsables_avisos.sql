CREATE TABLE `task_assignees` (
	`task_id` text NOT NULL,
	`person_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`assigned_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`task_id`, `person_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_assignees_task_person` ON `task_assignees` (`task_id`,`person_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_assignees_task_primary` ON `task_assignees` (`task_id`) WHERE is_primary = 1;
--> statement-breakpoint
CREATE INDEX `idx_task_assignees_task` ON `task_assignees` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_assignees_person` ON `task_assignees` (`person_id`);
--> statement-breakpoint
CREATE TABLE `task_notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`delivered_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`dedupe_key` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_notification_log_dedupe` ON `task_notification_log` (`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `idx_task_notification_log_pending` ON `task_notification_log` (`status`,`scheduled_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_notification_log_task` ON `task_notification_log` (`task_id`,`person_id`);
--> statement-breakpoint
INSERT INTO `task_assignees` (`task_id`, `person_id`, `is_primary`, `assigned_by`, `created_at`)
SELECT `id`, `assignee_person_id`, 1, 'system:migration:0005', `created_at`
FROM `tasks`
WHERE `assignee_person_id` IS NOT NULL;
