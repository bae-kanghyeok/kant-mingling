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
  gm_guess_open?: boolean;
  ensemble_done: boolean; vote_deadline: string | null; vote_remaining_ms: number | null; game_version: number; paused_ms_total: number;
  started_at: string; revealed_at: string | null; end_reason: "correct" | "forced" | "session_end" | null;
}
export interface SnapshotBlock {
  id: string; team_id: string; block_no: number; phase: TeamPhase; current_game_id: string | null;
  team_version: number; settings_json: TeamSettings; paused_at: string | null; started_at: string | null;
  rotation_ready?: boolean;
}
export interface SnapshotCard {
  id: string; game_id: string; card_no: number; question_id: string; displayed_option: "A" | "B"; true_option: "A" | "B"; is_noise: boolean;
}
export interface EventSnapshot {
  now: string;
  event: { id: string; slug: string; title: string; phase: "SETUP" | "BLOCK" | "BREAK" | "ENDED"; current_block: number;
    host_participant_id: string | null; config_json: GlobalConfig; session_version: number; teams_published_at: string | null;
    pending_config_json: GlobalConfig | null; pending_roster_json: RosterEntry[] | null; draft_assignments: TeamAssignment[] | null;
    next_block_plan: { assignments: TeamAssignment[] } | null; rotation_requested?: boolean };
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
  guesses?: { game_id: string; owner_pick: string; noise_picks: number[]; attempt_no: number; revealed_count: number; correct: boolean }[];
  groundTruths: { game_id: string; card_id: string }[];
  intros: { participant_id: string; intro_key: IntroKey }[];
  overlays: { game_id: string; participant_id: string; kind: string }[];
  logs: { actor_participant_id: string | null; command: string; target: string | null; created_at: string }[];
}

// One private DB snapshot prevents mixed block assignments / GAME rows during a move.
// Only state-dto.ts may turn this server-only value into a response.
// Every poll runs this statement, and Neon bills DB→app bytes, so it returns only the rows
// buildPublicState() reads for this viewer, in the same shape as a full event snapshot:
// - games: current games, every unrevealed game (needsSync) and, when the DTO shows a
//   last reveal, the viewer's latest revealed game;
// - child rows (cards, members, ...): those games for operators (admin counts), otherwise
//   only games the viewer plays in;
// - profiles: the viewer's own answers plus, for a revealed game they played, every member's
//   answers to that game's card questions (all Behind the Data selection compares);
// - sessions: one active row per participant, which is all online()/locked() test;
// - guesses: wrong guesses in games the viewer plays in (GM mode shows who was ruled out).
// tests/integration/t37-viewer-snapshot.test.ts proves the DTO equals the full snapshot's.
export const snapshotSql = `WITH t AS (SELECT clock_timestamp() AS now),
e AS (SELECT * FROM events WHERE slug=$1),
viewer AS (SELECT s.id,s.participant_id,s.last_seen_at FROM e JOIN sessions s ON s.event_id=e.id CROSS JOIN t
  LEFT JOIN participants p ON p.id=s.participant_id AND p.event_id=s.event_id
  WHERE s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>t.now AND (s.participant_id IS NULL OR p.active=true)),
me AS (SELECT p.id,p.role FROM viewer v JOIN e ON true JOIN participants p ON p.id=v.participant_id AND p.event_id=e.id WHERE p.active),
op AS (SELECT EXISTS(SELECT 1 FROM me WHERE role='operator') AS yes),
my_block AS (SELECT b.phase FROM me JOIN e ON true
  JOIN block_assignments a ON a.event_id=e.id AND a.block_no=GREATEST(1,e.current_block) AND a.participant_id=me.id
  JOIN team_blocks b ON b.event_id=e.id AND b.team_id=a.team_id AND b.block_no=e.current_block),
cur AS (SELECT g.id FROM e JOIN team_blocks b ON b.event_id=e.id AND b.block_no=e.current_block
  JOIN games g ON g.id=b.current_game_id AND g.event_id=e.id),
-- Same winner as the DTO's stable millisecond sort over games ordered by game_no.
last AS (SELECT g.id FROM e JOIN games g ON g.event_id=e.id JOIN game_members m ON m.game_id=g.id JOIN me ON me.id=m.participant_id
  WHERE g.phase='REVEALED' AND (e.phase IN ('BREAK','ENDED') OR EXISTS(SELECT 1 FROM my_block WHERE phase IN ('SEATING','BLOCK_DONE')))
  ORDER BY date_trunc('milliseconds',g.revealed_at) DESC NULLS LAST,g.game_no,g.id LIMIT 1),
inc AS (SELECT id FROM cur UNION SELECT g.id FROM e JOIN games g ON g.event_id=e.id WHERE g.phase<>'REVEALED' UNION SELECT id FROM last),
mine AS (SELECT i.id FROM inc i JOIN game_members m ON m.game_id=i.id JOIN me ON me.id=m.participant_id),
child AS (SELECT id FROM inc WHERE (SELECT yes FROM op) UNION SELECT id FROM mine),
rev AS (SELECT g.id FROM mine JOIN games g ON g.id=mine.id WHERE g.phase='REVEALED')
SELECT jsonb_build_object(
  'now',t.now,
  'event',to_jsonb(e) || CASE WHEN (SELECT yes FROM op) THEN '{}'::jsonb
    ELSE '{"pending_config_json":null,"pending_roster_json":null,"draft_assignments":null,"next_block_plan":null}'::jsonb END,
  'session',(SELECT jsonb_build_object('id',v.id,'participant_id',v.participant_id,'last_seen_at',v.last_seen_at) FROM viewer v),
  'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name,'role',p.role,
    'roster_order',p.roster_order,'attendance',p.attendance,'active',p.active,'profile_completed_at',p.profile_completed_at,
    'profile_locked_at',p.profile_locked_at) ORDER BY p.roster_order) FROM participants p
    WHERE p.event_id=e.id AND EXISTS(SELECT 1 FROM viewer)),'[]'::jsonb),
  'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_id',x.participant_id,'last_seen_at',x.last_seen_at,
    'expires_at',x.expires_at,'revoked_at',NULL)) FROM (SELECT s.participant_id,max(s.last_seen_at) AS last_seen_at,max(s.expires_at) AS expires_at
      FROM sessions s WHERE s.event_id=e.id AND s.participant_id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at>t.now
      AND EXISTS(SELECT 1 FROM viewer) GROUP BY s.participant_id) x),'[]'::jsonb),
  'profiles',COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_id',a.participant_id,'question_id',a.question_id,
    'option',a.option,'revision',a.revision)) FROM profile_answers a WHERE a.event_id=e.id AND (a.participant_id IN (SELECT id FROM me)
    OR EXISTS(SELECT 1 FROM rev JOIN game_members m ON m.game_id=rev.id JOIN data_cards c ON c.game_id=rev.id
      WHERE m.participant_id=a.participant_id AND c.question_id=a.question_id))),'[]'::jsonb),
  'teams',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.team_key) FROM teams r
    WHERE r.event_id=e.id AND EXISTS(SELECT 1 FROM viewer)),'[]'::jsonb),
  'assignments',COALESCE((SELECT jsonb_agg(jsonb_build_object('block_no',a.block_no,'participant_id',a.participant_id,
    'team_id',a.team_id,'seat_no',a.seat_no) ORDER BY a.block_no,a.team_id,a.seat_no) FROM block_assignments a
    WHERE a.event_id=e.id AND a.block_no=GREATEST(1,e.current_block) AND EXISTS(SELECT 1 FROM viewer)),'[]'::jsonb),
  'blocks',COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM team_blocks b WHERE b.event_id=e.id AND EXISTS(SELECT 1 FROM viewer)
    AND (b.block_no=e.current_block OR b.id IN (SELECT g.team_block_id FROM games g WHERE g.id IN (SELECT id FROM inc)))),'[]'::jsonb),
  'games',COALESCE((SELECT jsonb_agg(to_jsonb(g)-'noise_slots' ORDER BY g.game_no) FROM games g
    WHERE g.id IN (SELECT id FROM inc) AND EXISTS(SELECT 1 FROM viewer)),'[]'::jsonb),
  'cards',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'game_id',c.game_id,'card_no',c.card_no,'question_id',c.question_id,
    'displayed_option',c.displayed_option,'true_option',c.true_option,'is_noise',c.is_noise) ORDER BY c.card_no)
    FROM data_cards c WHERE c.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',m.game_id,'participant_id',m.participant_id))
    FROM game_members m WHERE m.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'deliveries',COALESCE((SELECT jsonb_agg(jsonb_build_object('card_id',d.card_id,'participant_id',d.participant_id))
    FROM card_deliveries d JOIN data_cards c ON c.id=d.card_id WHERE c.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'votes',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',v.game_id,'voter_id',v.voter_id,'pick_id',v.pick_id,'revision',v.revision))
    FROM ensemble_votes v WHERE v.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'guesses',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',a.game_id,'owner_pick',a.owner_pick,'noise_picks',a.noise_picks,'attempt_no',a.attempt_no,
    'revealed_count',a.revealed_count,'correct',a.correct) ORDER BY a.game_id,a.attempt_no)
    FROM guess_attempts a WHERE a.game_id IN (SELECT id FROM mine) AND NOT a.correct),'[]'::jsonb),
  'groundTruths',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',r.game_id,'card_id',r.card_id))
    FROM ground_truths r WHERE r.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'intros',COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_id',i.participant_id,'intro_key',i.intro_key))
    FROM intro_seen i WHERE i.participant_id IN (SELECT id FROM me)),'[]'::jsonb),
  'overlays',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',o.game_id,'participant_id',o.participant_id,'kind',o.kind))
    FROM game_overlay_seen o WHERE o.participant_id IN (SELECT id FROM me) AND o.game_id IN (SELECT id FROM child)),'[]'::jsonb),
  'logs',CASE WHEN (SELECT yes FROM op) THEN COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM (SELECT actor_participant_id,command,target,created_at
    FROM operation_logs WHERE event_id=e.id AND command NOT IN ('COMMON_CARD_FALLBACK','RARE_CARD_FALLBACK','owner_fallback')
    ORDER BY created_at DESC,id DESC LIMIT 30) l),'[]'::jsonb) ELSE '[]'::jsonb END
) AS snapshot FROM e CROSS JOIN t`;

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
