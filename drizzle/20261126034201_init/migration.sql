CREATE TABLE "agent_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"document" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"saved_by_workspace_id" uuid,
	"saved_by_agent_id" uuid,
	"based_on_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"live_revision_id" uuid,
	"auto_promote" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"system_text" text,
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"event" jsonb NOT NULL,
	"text_ends" integer[],
	CONSTRAINT "pk_run_events" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid,
	"workspace_name" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"revision_id" uuid,
	"worker_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"conversation_id" uuid,
	"session_key" text,
	"input" jsonb DEFAULT '[]' NOT NULL,
	"user" text,
	"stream" boolean NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"waiting_since" timestamp with time zone,
	"pending_call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"resume" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	"answer" jsonb,
	CONSTRAINT "ck_runs_status" CHECK ("status" in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"key_hash" text,
	"key_prefix" text,
	"key_set" boolean GENERATED ALWAYS AS (key_hash is not null) STORED NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"host" text,
	"version" text,
	CONSTRAINT "ck_workers_local_keyless" CHECK (("name" = 'local') = ("key_hash" is null)),
	CONSTRAINT "ck_workers_key_prefix" CHECK (("key_hash" is null) = ("key_prefix" is null))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_disabled_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_disabled_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start" text NOT NULL,
	"hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"worker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_revisions_agent_id_number" ON "agent_revisions" ("agent_id","number");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_created_by" ON "agent_revisions" ("created_by");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_saved_by_workspace_id" ON "agent_revisions" ("saved_by_workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_saved_by_agent_id" ON "agent_revisions" ("saved_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_based_on_id" ON "agent_revisions" ("based_on_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_name" ON "agents" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_workspace_id_key" ON "conversations" ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "idx_conversations_expires_at" ON "conversations" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_agent_id" ON "conversations" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_workspace_id_idempotency_key" ON "runs" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_runs_started_at" ON "runs" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_agent_id" ON "runs" ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_runs_revision_id" ON "runs" ("revision_id");--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" ("status");--> statement-breakpoint
CREATE INDEX "idx_runs_worker_id" ON "runs" ("worker_id");--> statement-breakpoint
CREATE INDEX "idx_runs_workspace_id_session_key" ON "runs" ("workspace_id","session_key","started_at") WHERE "session_key" is not null;--> statement-breakpoint
CREATE INDEX "idx_runs_pending_call_ids" ON "runs" USING gin ("pending_call_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_conversation_id_going" ON "runs" ("conversation_id") WHERE "status" in ('running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workers_name" ON "workers" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workers_key_hash" ON "workers" ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_workers_created_by" ON "workers" ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agent_disabled_servers_workspace_agent_id_server_id" ON "workspace_agent_disabled_servers" ("workspace_agent_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_disabled_servers_server_id" ON "workspace_agent_disabled_servers" ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agent_disabled_tools_workspace_agent_id_server_id_tool" ON "workspace_agent_disabled_tools" ("workspace_agent_id","server_id","tool");--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_disabled_tools_server_id" ON "workspace_agent_disabled_tools" ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agents_workspace_id_agent_id" ON "workspace_agents" ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_agents_agent_id" ON "workspace_agents" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_keys_hash" ON "workspace_keys" ("hash");--> statement-breakpoint
CREATE INDEX "idx_workspace_keys_workspace_id" ON "workspace_keys" ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_keys_created_by" ON "workspace_keys" ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspaces_slug" ON "workspaces" ("slug");--> statement-breakpoint
CREATE INDEX "idx_workspaces_worker_id" ON "workspaces" ("worker_id");--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_saved_by_workspace_id_workspaces_id_fkey" FOREIGN KEY ("saved_by_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_saved_by_agent_id_agents_id_fkey" FOREIGN KEY ("saved_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_based_on_id_agent_revisions_id_fkey" FOREIGN KEY ("based_on_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_live_revision_id_agent_revisions_id_fkey" FOREIGN KEY ("live_revision_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_revision_id_agent_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_servers" ADD CONSTRAINT "workspace_agent_disabled_servers_6KuozzaTS7GG_fkey" FOREIGN KEY ("workspace_agent_id") REFERENCES "workspace_agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_tools" ADD CONSTRAINT "workspace_agent_disabled_tools_cdRevjpazWpT_fkey" FOREIGN KEY ("workspace_agent_id") REFERENCES "workspace_agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- The local worker, the host process itself: the one worker with no key. Nobody renames, deletes or keys it.
INSERT INTO "workers" ("name") VALUES ('local');
