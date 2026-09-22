import "server-only";
import type { PoolClient } from "pg";
import type { GlobalConfig } from "../game/settings";

export interface EventRow {
  id: string; slug: string; title: string; phase: "SETUP" | "BLOCK" | "BREAK" | "ENDED";
  current_block: number; host_participant_id: string | null; config_json: GlobalConfig;
  content_version: string; session_version: number; teams_published_at: Date | null;
  next_block_plan: unknown; started_at: Date | null; ended_at: Date | null;
  pending_config_json: GlobalConfig | null; pending_roster_json: unknown; draft_assignments: unknown;
}
export interface SessionRow {
  id: string; event_id: string; participant_id: string | null; expires_at: Date; revoked_at: Date | null;
  role: "student" | "operator" | null; display_name: string | null;
}
export interface TxContext {
  client: PoolClient; event: EventRow; session: SessionRow; now: Date;
  /** A shared command must release its locks before reconciling expired votes. */
  deadlineSettlementNeeded?: boolean;
}
