CREATE TABLE "canvas_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"project_id" text,
	"title" text NOT NULL,
	"scene" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"image_artifact_id" text,
	"image_path" text,
	"image_bytes" integer,
	"captured_at" bigint,
	"transcription" text,
	"created_by_person_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "canvas_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "canvas_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "canvas_notes_image_artifact_id_artifacts_id_fk" FOREIGN KEY ("image_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "canvas_notes_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_canvas_notes_project" ON "canvas_notes" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_canvas_notes_org" ON "canvas_notes" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_canvas_notes_updated" ON "canvas_notes" USING btree ("updated_at");
