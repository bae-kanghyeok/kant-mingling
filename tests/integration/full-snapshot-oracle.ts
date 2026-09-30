// Test oracle only: the pre-2026-09-29 whole-event snapshot statement, kept verbatim so
// t37 can prove the viewer-scoped statement in src/server/db/snapshot.ts yields the same DTO.
// 2026-09-30 added 'guesses' (every guess attempt of the event) for the GM ruled-out list.
export const fullSnapshotSql = `SELECT jsonb_build_object(
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
  'guesses',COALESCE((SELECT jsonb_agg(jsonb_build_object('game_id',a.game_id,'owner_pick',a.owner_pick,'attempt_no',a.attempt_no,
    'revealed_count',a.revealed_count,'correct',a.correct) ORDER BY a.game_id,a.attempt_no)
    FROM guess_attempts a JOIN games g ON g.id=a.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'groundTruths',COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM ground_truths t JOIN games g ON g.id=t.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'intros',COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM intro_seen i JOIN participants p ON p.id=i.participant_id WHERE p.event_id=e.id),'[]'::jsonb),
  'overlays',COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM game_overlay_seen o JOIN games g ON g.id=o.game_id WHERE g.event_id=e.id),'[]'::jsonb),
  'logs',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM (SELECT actor_participant_id,command,target,created_at FROM operation_logs
    WHERE event_id=e.id AND command NOT IN ('COMMON_CARD_FALLBACK','RARE_CARD_FALLBACK','owner_fallback')
    ORDER BY created_at DESC,id DESC LIMIT 30) l),'[]'::jsonb)
) AS snapshot FROM events e WHERE e.slug=$1`;
