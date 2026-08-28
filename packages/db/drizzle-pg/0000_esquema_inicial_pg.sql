CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"layer" text NOT NULL,
	"runtime" text NOT NULL,
	"provider_profile_id" text,
	"model" text,
	"reports_to" text,
	"active_prompt_version_id" text,
	"tools_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mcp_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb,
	"autonomy" text DEFAULT 'supervised' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seed_file" text,
	"seed_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"task_id" text,
	"project_id" text,
	"payload" jsonb NOT NULL,
	"action_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"decided_by_person_id" text,
	"decided_at" bigint,
	"note" text,
	"reconciled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"path" text,
	"meta" jsonb,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"run_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"run_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"source_refs" jsonb,
	"tags" jsonb,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"idempotency_key" text,
	"run_id" text,
	"actor" text,
	"meta" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "methodologies" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"body_md" text NOT NULL,
	"changelog" text,
	"seed_file" text,
	"seed_hash" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_launches" (
	"id" text PRIMARY KEY NOT NULL,
	"module_id" text NOT NULL,
	"module_slug" text NOT NULL,
	"module_version" integer NOT NULL,
	"phase" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"blueprint_snapshot" jsonb NOT NULL,
	"blueprint_hash" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"inputs_digest" text NOT NULL,
	"toggles" jsonb NOT NULL,
	"methodology_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"task_count" integer NOT NULL,
	"budget_phase_usd" double precision NOT NULL,
	"budget_per_run_usd" double precision NOT NULL,
	"previous_launch_id" text,
	"idempotency_key" text NOT NULL,
	"actor" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"industry" text,
	"employee_count" integer,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"role" text,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phase_modules" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"phase" text NOT NULL,
	"project_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"methodology_slug" text NOT NULL,
	"methodology_version" integer,
	"blueprint" jsonb NOT NULL,
	"blueprint_hash" text NOT NULL,
	"body_md" text NOT NULL,
	"changelog" text,
	"seed_file" text,
	"seed_hash" text,
	"created_by" text,
	"activated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"owner_person" text,
	"variant" text DEFAULT 'as_is' NOT NULL,
	"steps" jsonb,
	"systems" jsonb,
	"pain_points" jsonb,
	"iso_refs" jsonb,
	"source_doc_ids" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"external_ref" jsonb NOT NULL,
	"status" text DEFAULT 'linked' NOT NULL,
	"knowledge_doc_id" text,
	"last_error" text,
	"last_ingested_at" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"stage" text DEFAULT 'ENTENDER' NOT NULL,
	"gate_state" text DEFAULT 'pending' NOT NULL,
	"workspace_path" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"stable" text NOT NULL,
	"context" text,
	"volatile_tpl" text,
	"changelog" text,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"api_key_env" text,
	"cost_input_per_mtok" double precision,
	"cost_output_per_mtok" double precision,
	"capabilities" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "provider_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" text,
	"root_run_id" text NOT NULL,
	"agent_id" text,
	"task_id" text,
	"project_id" text,
	"trigger" text NOT NULL,
	"runtime" text NOT NULL,
	"provider_profile_id" text,
	"model" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"tokens_cache_read" integer,
	"tokens_cache_write" integer,
	"cost_usd" double precision,
	"error" text,
	"resume_of_run_id" text,
	"replay_of_run_id" text,
	"started_at" bigint,
	"finished_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spans" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"attrs" jsonb,
	"status" text,
	"started_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"payload" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_task_id" text,
	"title" text NOT NULL,
	"description" text,
	"definition_of_done" text,
	"stage" text NOT NULL,
	"status" text DEFAULT 'BACKLOG' NOT NULL,
	"activity_type" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_agent_id" text,
	"assignee_person_id" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"external_effect" boolean DEFAULT false NOT NULL,
	"lease_until" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" bigint,
	"order_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"session_key" text NOT NULL,
	"project_id" text,
	"agent_id" text,
	"title" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_launches" ADD CONSTRAINT "module_launches_module_id_phase_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."phase_modules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_launches" ADD CONSTRAINT "module_launches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_launches" ADD CONSTRAINT "module_launches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_launches" ADD CONSTRAINT "module_launches_methodology_id_methodologies_id_fk" FOREIGN KEY ("methodology_id") REFERENCES "public"."methodologies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_launches" ADD CONSTRAINT "module_launches_previous_launch_id_module_launches_id_fk" FOREIGN KEY ("previous_launch_id") REFERENCES "public"."module_launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_knowledge_doc_id_knowledge_docs_id_fk" FOREIGN KEY ("knowledge_doc_id") REFERENCES "public"."knowledge_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_person_id_people_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_approvals_digest_run" ON "approvals" USING btree ("action_digest","run_id");--> statement-breakpoint
CREATE INDEX "idx_approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_artifacts_task" ON "artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_events_topic_seq" ON "events" USING btree ("topic","seq");--> statement-breakpoint
CREATE INDEX "idx_knowledge_org_kind" ON "knowledge_docs" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_idempotency" ON "messages" USING btree ("thread_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_messages_thread_created" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_methodologies_slug_version" ON "methodologies" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_module_launches_idempotency" ON "module_launches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_module_launches_project_phase" ON "module_launches" USING btree ("project_id","phase");--> statement-breakpoint
CREATE INDEX "idx_module_launches_module" ON "module_launches" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_people_org" ON "people" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_phase_modules_slug_version" ON "phase_modules" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_phase_modules_slug_active" ON "phase_modules" USING btree ("slug") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_phase_modules_phase_status" ON "phase_modules" USING btree ("phase","status");--> statement-breakpoint
CREATE INDEX "idx_processes_org" ON "processes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_project_sources_project" ON "project_sources" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "idx_projects_org" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_versions_agent_version" ON "prompt_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "idx_runs_root" ON "runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "idx_runs_task" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_spans_run" ON "spans" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_task_events_task" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_board" ON "tasks" USING btree ("project_id","status","order_key");--> statement-breakpoint
CREATE INDEX "idx_tasks_lease" ON "tasks" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_threads_session_key" ON "threads" USING btree ("session_key");