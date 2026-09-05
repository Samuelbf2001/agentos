CREATE TABLE `task_labels` (
	`task_id` text NOT NULL,
	`label` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`task_id`, `label`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_labels_label` ON `task_labels` (`label`);
--> statement-breakpoint
CREATE INDEX `idx_task_labels_task` ON `task_labels` (`task_id`);
