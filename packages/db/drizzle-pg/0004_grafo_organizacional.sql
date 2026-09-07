CREATE TABLE "org_units" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_unit_id" text,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "org_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "org_units_parent_unit_id_org_units_id_fk" FOREIGN KEY ("parent_unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_org_units_org" ON "org_units" USING btree ("org_id");
--> statement-breakpoint
CREATE TABLE "org_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"unit_id" text,
	"name" text NOT NULL,
	"purpose" text,
	"reports_to_role_id" text,
	"canvas_x" double precision,
	"canvas_y" double precision,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "org_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "org_roles_unit_id_org_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "org_roles_reports_to_role_id_org_roles_id_fk" FOREIGN KEY ("reports_to_role_id") REFERENCES "public"."org_roles"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_org_roles_org" ON "org_roles" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_org_roles_unit" ON "org_roles" USING btree ("unit_id");
--> statement-breakpoint
CREATE TABLE "role_functions" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "role_functions_role_id_org_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."org_roles"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_role_functions_role" ON "role_functions" USING btree ("role_id");
--> statement-breakpoint
CREATE TABLE "role_people" (
	"role_id" text NOT NULL,
	"person_id" text NOT NULL,
	"dedication_pct" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pk_role_people" PRIMARY KEY ("role_id", "person_id"),
	CONSTRAINT "role_people_role_id_org_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."org_roles"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "role_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "role_processes" (
	"role_id" text NOT NULL,
	"process_id" text NOT NULL,
	"relation" text DEFAULT 'participant' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "pk_role_processes" PRIMARY KEY ("role_id", "process_id"),
	CONSTRAINT "role_processes_role_id_org_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."org_roles"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "role_processes_process_id_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."processes"("id") ON DELETE no action ON UPDATE no action
);
