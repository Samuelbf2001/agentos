CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`layer` text NOT NULL,
	`runtime` text NOT NULL,
	`provider_profile_id` text,
	`model` text,
	`active_prompt_version_id` text,
	`tools_allowlist` text DEFAULT '[]' NOT NULL,
	`mcp_allowlist` text DEFAULT '[]' NOT NULL,
	`limits` text,
	`autonomy` text DEFAULT 'supervised' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`seed_file` text,
	`seed_hash` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`slug`);--> statement-breakpoint
CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`task_id` text,
	`project_id` text,
	`payload` text NOT NULL,
	`action_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`decided_by_person_id` text,
	`decided_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_approvals_digest_run` ON `approvals` (`action_digest`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_status` ON `approvals` (`status`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`path` text,
	`meta` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_task` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`before` text,
	`after` text,
	`reason` text,
	`run_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`run_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_topic_seq` ON `events` (`topic`,`seq`);--> statement-breakpoint
CREATE TABLE `knowledge_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`project_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`source_refs` text,
	`tags` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_org_kind` ON `knowledge_docs` (`org_id`,`kind`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`idempotency_key` text,
	`run_id` text,
	`actor` text,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_idempotency` ON `messages` (`thread_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread_created` ON `messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `methodologies` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`version` integer NOT NULL,
	`body_md` text NOT NULL,
	`changelog` text,
	`seed_file` text,
	`seed_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_methodologies_slug_version` ON `methodologies` (`slug`,`version`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`industry` text,
	`employee_count` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`full_name` text NOT NULL,
	`email` text,
	`role` text,
	`is_internal` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_people_org` ON `people` (`org_id`);--> statement-breakpoint
CREATE TABLE `processes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`owner_person` text,
	`variant` text DEFAULT 'as_is' NOT NULL,
	`steps` text,
	`systems` text,
	`pain_points` text,
	`iso_refs` text,
	`source_doc_ids` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_processes_org` ON `processes` (`org_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`stage` text DEFAULT 'ENTENDER' NOT NULL,
	`gate_state` text DEFAULT 'pending' NOT NULL,
	`workspace_path` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_projects_org` ON `projects` (`org_id`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`stable` text NOT NULL,
	`context` text,
	`volatile_tpl` text,
	`changelog` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_prompt_versions_agent_version` ON `prompt_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE TABLE `provider_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`api_key_env` text,
	`cost_input_per_mtok` real,
	`cost_output_per_mtok` real,
	`capabilities` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_profiles_slug_unique` ON `provider_profiles` (`slug`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_run_id` text,
	`root_run_id` text NOT NULL,
	`agent_id` text,
	`task_id` text,
	`project_id` text,
	`trigger` text NOT NULL,
	`runtime` text NOT NULL,
	`provider_profile_id` text,
	`model` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`tokens_cache_read` integer,
	`tokens_cache_write` integer,
	`cost_usd` real,
	`error` text,
	`resume_of_run_id` text,
	`replay_of_run_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_runs_root` ON `runs` (`root_run_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_task` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `spans` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`attrs` text,
	`status` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_spans_run` ON `spans` (`run_id`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`actor` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_events_task` ON `task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_task_id` text,
	`title` text NOT NULL,
	`description` text,
	`definition_of_done` text,
	`stage` text NOT NULL,
	`status` text DEFAULT 'BACKLOG' NOT NULL,
	`activity_type` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_agent_id` text,
	`assignee_person_id` text,
	`requires_approval` integer DEFAULT false NOT NULL,
	`external_effect` integer DEFAULT false NOT NULL,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`blocked_reason` text,
	`order_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_board` ON `tasks` (`project_id`,`status`,`order_key`);--> statement-breakpoint
CREATE INDEX `idx_tasks_lease` ON `tasks` (`status`,`lease_until`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`session_key` text NOT NULL,
	`project_id` text,
	`agent_id` text,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_threads_session_key` ON `threads` (`session_key`);