import "server-only";
import { getPool } from "./pool";
import { CommandRejected, reject } from "../http/respond";
import type { IntroKey, GamePhase, TeamPhase } from "@/lib/contracts";
import type { GlobalConfig, TeamSettings } from "../game/settings";
import type { TeamAssignment, RosterEntry } from "../game/types";

export interface SnapshotPerson {
  id: string; display_name: string; role: "student" | "operator"; roster_order: number; attendance: string; active: boolean;
  profile_completed_at: string | null; profile_locked_at: string | null;
}
export interface SnapshotGame {
  id: string; team_id: string; team_block_id: string; block_no: number; game_no: number; config_snapshot: TeamSettings;
  owner_participant_id: string; rng_seed: string; phase: GamePhase; turn_lead_participant_id: string | null;
  guess_locked: boolean; exhausted: boolean; ensemble_trigger_no: number | null; ensemble_sharer_id: string | null;
  ensemble_done: boolean; vote_deadline: string | null; vote_remaining_ms: number | null; game_version: number; paused_ms_total: number;
  started_at: string; revealed_at: string | null; end_reason: "correct" | "forced" | "session_end" | null;
}
export interface SnapshotBlock {
  id: string; team_id: string; block_no: number; phase: TeamPhase; current_game_id: string | null;
  team_version: number; settings_json: TeamSettings; paused_at: string | null; started_at: string | null;
}
export interface SnapshotCard {
  id: string; game_id: string; card_no: number; question_id: string; displayed_option: "A" | "B"; true_option: "A" | "B"; is_noise: boolean;
}
export interface EventSnapshot {
  now: string;
  event: { id: string; slug: string; title: string; phase: "SETUP" | "BLOCK" | "BREAK" | "ENDED"; current_block: number;
    host_participant_id: string | null; config_json: GlobalConfig; session_version: number; teams_published_at: string | null;
    pending_config_json: GlobalConfig | null; pending_roster_json: RosterEntry[] | null; draft_assignments: TeamAssignment[] | null;
    next_block_plan: { assignments: TeamAssignment[] } | null };
  session: { id: string; participant_id: string | null; last_seen_at: string } | null;
  people: SnapshotPerson[];
  sessions: { participant_id: string | null; last_seen_at: string; expires_at: string; revoked_at: string | null }[];
  profiles: { participant_id: string; question_id: string; option: "A" | "B"; revision: number }[];
  teams: { id: string; team_key: string; operator_participant_id: string | null; settings_json: TeamSettings }[];
  assignments: { block_no: number; participant_id: string; team_id: string; seat_no: number }[];
  blocks: SnapshotBlock[]; games: SnapshotGame[]; cards: SnapshotCard[];
  members: { game_id: string; participant_id: string }[];
  deliveries: { card_id: string; participant_id: string }[];
  votes: { game_id: string; voter_id: string; pick_id: string; revision: number }[];
  groundTruths: { game_id: string; card_id: string }[];
  intros: { participant_id: string; intro_key: IntroKey }[];
  overlays: { game_id: string; participant_id: string; kind: string }[];
  logs: { actor_participant_id: string | null; command: string; target: string | null; created_at: string }[];
}

// One private DB snapshot prevents mixed block assignments / GAME rows during a move.
// Only state-dto.ts may turn this server-only value into a response.
const snapshotSql = `SELECT jsonb_build_object(
  'now',clock_timestamp(),'event',to_jsonb(e),
  'session',(SELECT jsonb_build_object('id',s.id,'participant_id',s.participant_id,'last_seen_at',s.last_seen_at) FROM sessions s
    LEFT JOIN participants p ON p.id=s.participant_id AND p.event_id=s.event_id
    WHERE s.event_id=e.id AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND (s.participant_id IS NULL OR p.active=true)),
  'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name,'role',p.role,
    'roster_order',p.roster_order,'attendance',p.attendance,'active',p.active,'profile_completed_at',p.profile_completed_at,
    'profile_locked_at',p.profile_locked_at) ORDER BY p.roster_order) FROM participants p WHERE p.event_id=e.id),'[]'::jsonb),
  'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_id',s.participant_id,'last_seen_at',s.last_seen_at,
    'expires_at',s.expires_at,'revoked_at',s.revoked_at)) FROM sessions s WHERE s.event_id=e.id),'[]'::jsonb),
  'profiles',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM profile_answers p WHERE p.event_id=e.id),'[]'::jsonb),
  'teams',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.team_key) FROM teams t WHERE t.event_id=e.id),'[]'::jsonb),
  'assignments',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.block_no,a.team_id,a.seat_no) FROM block_assignments a WHERE a.event_id=e.id),'[]'::jsonb),
  'blocks',COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM team_blocks b WHERE b.event_id=e.id),'[]'::jsonb),
  'games',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.game_no) FROM games g WHERE g.event_id=e.id),'[]'::jsonb),
  'cards',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_no) FROM data_cards c JOIN games g ON g.id=c.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'members',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM game_members m JOIN games g ON g.id=m.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'deliveries',COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM card_deliveries d JOIN data_cards c ON c.id=d.card_id JOIN games g ON g.id=c.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'votes',COALESCE((SELECT jsonb_agg(to_jsonb(v)) FROM ensemble_votes v JOIN games g ON g.id=v.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'groundTruths',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM ground_truths t JOIN games g ON g.id=t.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'intros',COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM intro_seen i JOIN participants p ON p.id=i.participant_id WHERE p.event_id=e.id),'[]'::jsonb),
  'overlays',COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM game_overlay_seen o JOIN games g ON g.id=o.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'logs',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM (SELECT actor_participant_id,command,target,created_at FROM operation_logs WHERE event_id=e.id ORDER BY created_at DESC,id DESC LIMIT 30) l),'[]'::jsonb)
) AS snapshot FROM events e WHERE e.slug=$1`;

export async function loadStateSnapshot(slug: string, tokenHash: string): Promise<EventSnapshot> {
  try {
    // All reads are subqueries of this one SELECT, so PostgreSQL uses one MVCC
    // statement snapshot without a BEGIN/COMMIT network round trip. No function
    // in this statement writes data. pool.query discards a failed connection.
    // pg supports per-query query_timeout; its current QueryConfig declaration omits it.
    const query = { text: snapshotSql, values: [slug, tokenHash], query_timeout: 8000 };
    const snapshot = (await getPool().query<{ snapshot: EventSnapshot }>(query)).rows[0]?.snapshot;
    if (!snapshot) reject(404, "NOT_FOUND");
    if (snapshot.event.phase === "ENDED" && !snapshot.session?.participant_id) reject(410, "ENDED");
    if (!snapshot.session) reject(401, "UNAUTHENTICATED");
    // Most polls have no write or extra network round trip. The predicate also
    // prevents two concurrent polls from producing duplicate heartbeat writes.
    if (new Date(snapshot.now).getTime() - new Date(snapshot.session.last_seen_at).getTime() >= 10000) {
      const heartbeat = { text: `UPDATE sessions SET last_seen_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL
        AND expires_at>clock_timestamp() AND last_seen_at<clock_timestamp()-interval '10 seconds'`, values: [snapshot.session.id], query_timeout: 5000 };
      await getPool().query(heartbeat);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof CommandRejected) throw error;
    throw new CommandRejected(503, "DB_UNAVAILABLE");
  }
}
