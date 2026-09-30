CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"release_id" integer,
	"system_id" text NOT NULL,
	"revision" integer NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"message" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT 'new_games' NOT NULL,
	"player_message" text,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_id" uuid,
	"message" text DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_orders" (
	"game_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"player_slot" integer NOT NULL,
	"game_time_ms" double precision NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_orders_game_id_seq_pk" PRIMARY KEY("game_id","seq")
);
--> statement-breakpoint
CREATE TABLE "game_players" (
	"game_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"user_id" uuid,
	"nation_id" text NOT NULL,
	"ai_level" text,
	"is_ai_replacement" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone,
	CONSTRAINT "game_players_game_id_slot_pk" PRIMARY KEY("game_id","slot")
);
--> statement-breakpoint
CREATE TABLE "game_snapshots" (
	"game_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"game_time_ms" double precision NOT NULL,
	"last_order_seq" integer NOT NULL,
	"catalog_release_id" integer,
	"codec" text DEFAULT 'gzip' NOT NULL,
	"state_hash" text,
	"state" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_snapshots_game_id_seq_pk" PRIMARY KEY("game_id","seq")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scenario_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"pause_reason" text,
	"mode" text DEFAULT 'solo' NOT NULL,
	"speed" double precision DEFAULT 1 NOT NULL,
	"speeds" jsonb NOT NULL,
	"seed" bigint NOT NULL,
	"catalog_release_id" integer,
	"balance" jsonb NOT NULL,
	"setup" jsonb NOT NULL,
	"anchor_game_ms" double precision DEFAULT 0 NOT NULL,
	"anchor_real_at" timestamp with time zone DEFAULT now() NOT NULL,
	"game_time_ms" double precision DEFAULT 0 NOT NULL,
	"last_order_seq" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "games_status_check" CHECK ("games"."status" in ('lobby','running','paused','ended'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"password_hash" text,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'player' NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"premium_balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('player','moderator','balance','superadmin'))
);
--> statement-breakpoint
CREATE TABLE "weapon_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'repo' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_changes" ADD CONSTRAINT "catalog_changes_release_id_catalog_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."catalog_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_changes" ADD CONSTRAINT "catalog_changes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_releases" ADD CONSTRAINT "catalog_releases_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_orders" ADD CONSTRAINT "game_orders_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_snapshots" ADD CONSTRAINT "game_snapshots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_catalog_release_id_catalog_releases_id_fk" FOREIGN KEY ("catalog_release_id") REFERENCES "public"."catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "catalog_changes_system_idx" ON "catalog_changes" USING btree ("system_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_players_nation_key" ON "game_players" USING btree ("game_id","nation_id");--> statement-breakpoint
CREATE INDEX "game_players_user_idx" ON "game_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "games_status_idx" ON "games" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));