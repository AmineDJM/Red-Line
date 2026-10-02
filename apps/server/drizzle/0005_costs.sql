CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"monthly" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_stats" (
	"grain" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"cpu_sim_ms" double precision DEFAULT 0 NOT NULL,
	"cpu_flush_ms" double precision DEFAULT 0 NOT NULL,
	"cpu_other_ms" double precision DEFAULT 0 NOT NULL,
	"cpu_process_ms" double precision DEFAULT 0 NOT NULL,
	"mem_mb_h" double precision DEFAULT 0 NOT NULL,
	"rss_mb_h" double precision DEFAULT 0 NOT NULL,
	"rss_max_mb" double precision DEFAULT 0 NOT NULL,
	"ws_bytes" bigint DEFAULT 0 NOT NULL,
	"ws_msgs" bigint DEFAULT 0 NOT NULL,
	"http_bytes" bigint DEFAULT 0 NOT NULL,
	"play_s" double precision DEFAULT 0 NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"push_sent" integer DEFAULT 0 NOT NULL,
	"stripe_calls" integer DEFAULT 0 NOT NULL,
	"peak_players" integer DEFAULT 0 NOT NULL,
	"peak_games" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_stats_grain_period_start_scope_key_pk" PRIMARY KEY("grain","period_start","scope","key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_entries_day_idx" ON "cost_entries" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_stats_scope_idx" ON "usage_stats" USING btree ("grain","scope","period_start");--> statement-breakpoint
-- Journal du portefeuille en ajout seul, sauf la mise à NULL de game_id quand une partie est supprimée
-- (clé étrangère ON DELETE SET NULL : sans cette exception, supprimer une partie où le joueur avait
-- acheté des accélérations échouait). Montants, motifs, références et soldes restent intouchables.
CREATE OR REPLACE FUNCTION wallet_ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.game_id IS NULL AND OLD.game_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.user_id = OLD.user_id AND NEW.delta = OLD.delta
     AND NEW.reason = OLD.reason AND NEW.ref IS NOT DISTINCT FROM OLD.ref
     AND NEW.balance_after = OLD.balance_after AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wallet_ledger est en ajout seul';
END; $$ LANGUAGE plpgsql;