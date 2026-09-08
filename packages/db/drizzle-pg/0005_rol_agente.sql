ALTER TABLE "org_roles" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
