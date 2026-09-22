import 'server-only';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { TxContext } from '../db/types';
import { reject } from '../http/respond';
import { selectOwner } from '../game/owner';
import { createNoisePlan } from '../game/noise-plan';
import { selectRealCard } from '../game/card-select';
import { selectNoiseCard } from '../game/noise-select';
import { makeRng } from '../game/rng';
import { selectReceiver, type CardDelivery } from '../game/receiver';
import { afterCardPublished, getEnsembleTrigger, tallyEnsembleVotes } from '../game/ensemble';
import { advanceGroundTruth, type GroundTruthState } from '../game/ground-truth';
import { evaluateGuess } from '../game/guess';
import { DEFAULT_TEAM_SETTINGS, parseTeamSettings, type TeamSettings } from '../game/settings';
import { GameRuleError, type DataCard, type GameMember, type GamePhase, type GuessAttempt, type Option } from '../game/types';

interface TeamBlockRow {
  id: string; team_id: string; block_no: number; phase: string; current_game_id: string | null;
  settings_json: unknown; paused_at: Date | null; operator_participant_id: string | null;
}
interface GameRow {
  id: string; event_id: string; team_id: string; team_block_id: string; block_no: number; game_no: number;
  config_snapshot: TeamSettings; owner_participant_id: string; noise_slots: number[]; rng_seed: string;
  phase: GamePhase; turn_lead_participant_id: string | null; guess_locked: boolean; exhausted: boolean;
  ensemble_trigger_no: number | null; ensemble_sharer_id: string | null; ensemble_done: boolean;
  vote_deadline: Date | null; gt_status: GroundTruthState['status']; gt_real_cards_needed: number;
  game_version: number;
}
interface CardRow {
  id: string; card_no: number; question_id: string; displayed_option: Option; true_option: Option; is_noise: boolean;
}
interface MemberRow {
  id: string; role: 'student' | 'operator'; roster_order: number; profile_completed_at: Date | string | null;
  owner_count: number; answers: Record<string, Option>; last_seen_at: Date | string | null;
}
interface DeliveryRow { participant_id: string; card_no: number; reason: 'initial' | 'resend' }
interface AttemptRow { owner_pick: string; noise_picks: number[]; correct: boolean }
interface VoteRow { voter_id: string; pick_id: string }
interface LoadedGame {
  game: GameRow; teamBlock: TeamBlockRow; members: GameMember[]; cardRows: CardRow[]; cards: DataCard[];
  deliveryRows: DeliveryRow[]; groundTruthCardNos: number[]; attempts: AttemptRow[]; votes: VoteRow[];
  viewerGroundTruthSeen: boolean; viewerNoiseSeen: boolean;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) reject(422, 'INVALID_REQUEST');
  return parsed.data;
}

const gameInput = z.object({ gameId: z.string().uuid(), gameVersion: z.number().int().nonnegative() });
const asCard = (row: CardRow): DataCard => ({ cardNo: row.card_no, questionId: row.question_id, displayedOption: row.displayed_option, trueOption: row.true_option, isNoise: row.is_noise });

function mapMember(row: MemberRow): GameMember {
  return { id: row.id, role: row.role, rosterOrder: row.roster_order, answers: row.answers,
    profileComplete: row.profile_completed_at !== null, ownerCount: row.owner_count,
    lastSeenAtMs: row.last_seen_at ? new Date(row.last_seen_at).getTime() : null };
}

async function lockGame(ctx: TxContext, gameId: string, shared = false): Promise<LoadedGame> {
  type ContextRow = GameRow & {
    block_phase: string; current_game_id: string | null; block_settings: unknown; paused_at: Date | null;
    operator_participant_id: string | null; member_rows: MemberRow[]; card_rows: CardRow[]; delivery_rows: DeliveryRow[];
    ground_truth_card_nos: number[]; attempts: AttemptRow[]; votes: VoteRow[]; viewer_gt_seen: boolean; viewer_noise_seen: boolean;
  };
  // Individual votes/acknowledgements share the event and GAME locks; phase
  // transitions still require exclusive locks. The mode is server selected.
  const row = (await ctx.client.query<ContextRow>(`SELECT g.*,tb.phase AS block_phase,tb.current_game_id,tb.settings_json AS block_settings,
    tb.paused_at,t.operator_participant_id,
    COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roster_order) FROM (
      SELECT p.id,p.role,p.roster_order,p.profile_completed_at,p.owner_count,
        COALESCE((SELECT jsonb_object_agg(a.question_id,a.option) FROM profile_answers a WHERE a.participant_id=p.id AND a.event_id=$2),'{}'::jsonb) AS answers,
        (SELECT max(s.last_seen_at) FROM sessions s WHERE s.participant_id=p.id AND s.event_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3) AS last_seen_at
      FROM game_members gm JOIN participants p ON p.id=gm.participant_id WHERE gm.game_id=g.id AND p.event_id=$2
    ) m),'[]'::jsonb) AS member_rows,
    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_no) FROM data_cards c WHERE c.game_id=g.id),'[]'::jsonb) AS card_rows,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_id',d.participant_id,'card_no',c.card_no,'reason',d.reason)
      ORDER BY c.card_no,d.delivered_at,d.participant_id) FROM card_deliveries d JOIN data_cards c ON c.id=d.card_id WHERE c.game_id=g.id),'[]'::jsonb) AS delivery_rows,
    ARRAY(SELECT c.card_no::integer FROM ground_truths gt JOIN data_cards c ON c.id=gt.card_id WHERE gt.game_id=g.id) AS ground_truth_card_nos,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('owner_pick',a.owner_pick,'noise_picks',a.noise_picks,'correct',a.correct) ORDER BY a.attempt_no)
      FROM guess_attempts a WHERE a.game_id=g.id),'[]'::jsonb) AS attempts,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('voter_id',v.voter_id,'pick_id',v.pick_id)) FROM ensemble_votes v WHERE v.game_id=g.id),'[]'::jsonb) AS votes,
    EXISTS(SELECT 1 FROM game_overlay_seen os WHERE os.game_id=g.id AND os.participant_id=$4 AND os.kind='ground_truth') AS viewer_gt_seen,
    EXISTS(SELECT 1 FROM intro_seen ins WHERE ins.participant_id=$4 AND ins.intro_key='noise') AS viewer_noise_seen
    FROM games g JOIN team_blocks tb ON tb.id=g.team_block_id JOIN teams t ON t.id=g.team_id
    WHERE g.id=$1 AND g.event_id=$2 AND tb.event_id=$2 FOR ${shared ? 'SHARE' : 'UPDATE'} OF tb,g`, [gameId, ctx.event.id, ctx.now, ctx.session.participant_id])).rows[0];
  if (!row) reject(404, 'NOT_FOUND');
  const teamBlock: TeamBlockRow = { id: row.team_block_id, team_id: row.team_id, block_no: row.block_no,
    phase: row.block_phase, current_game_id: row.current_game_id, settings_json: row.block_settings,
    paused_at: row.paused_at, operator_participant_id: row.operator_participant_id };
  return { game: row, teamBlock, members: row.member_rows.map(mapMember), cardRows: row.card_rows, cards: row.card_rows.map(asCard),
    deliveryRows: row.delivery_rows, groundTruthCardNos: row.ground_truth_card_nos, attempts: row.attempts, votes: row.votes,
    viewerGroundTruthSeen: row.viewer_gt_seen, viewerNoiseSeen: row.viewer_noise_seen };
}

function requireCurrent(ctx: TxContext, loaded: LoadedGame): void {
  if (ctx.event.phase === 'ENDED') reject(410, 'ENDED');
  if (ctx.event.phase !== 'BLOCK' || ctx.event.current_block !== loaded.game.block_no || loaded.teamBlock.current_game_id !== loaded.game.id || loaded.teamBlock.phase !== 'IN_GAME') reject(409, 'WRONG_PHASE');
}

function requireMember(ctx: TxContext, loaded: LoadedGame): string {
  const id = ctx.session.participant_id;
  if (!id) reject(401, 'UNAUTHENTICATED');
  if (!loaded.members.some((member) => member.id === id)) reject(403, 'FORBIDDEN');
  return id;
}

function isOperatorForGame(ctx: TxContext, loaded: LoadedGame): boolean {
  return ctx.session.role === 'operator' && (ctx.session.participant_id === ctx.event.host_participant_id || ctx.session.participant_id === loaded.teamBlock.operator_participant_id);
}

function requireVersion(loaded: LoadedGame, version: number): void {
  if (loaded.game.game_version !== version) reject(409, 'STALE_VERSION');
}

function requireUnpaused(loaded: LoadedGame): void { if (loaded.teamBlock.paused_at) reject(409, 'PAUSED'); }

function requireGroundTruthAcknowledged(loaded: LoadedGame): void {
  if (loaded.game.gt_status === 'announced' && !loaded.viewerGroundTruthSeen) reject(409, 'INTRO_REQUIRED');
}

async function logFallback(ctx: TxContext, code: string): Promise<void> {
  await ctx.client.query('INSERT INTO operation_logs(event_id,actor_participant_id,command) VALUES($1,$2,$3)', [ctx.event.id, ctx.session.participant_id, code]);
}

async function updateGroundTruth(ctx: TxContext, loaded: LoadedGame, event: 'ensemble-finished' | 'real-card'): Promise<void> {
  const { game, cards, members } = loaded;
  const settings = parseTeamSettings(game.config_snapshot);
  const state = advanceGroundTruth({ members, ownerId: game.owner_participant_id, cards,
    attempts: loaded.attempts.map((attempt): GuessAttempt => ({ ownerPick: attempt.owner_pick, noisePicks: attempt.noise_picks, correct: attempt.correct })),
    results: tallyEnsembleVotes(members, loaded.votes.map((vote) => ({ voterId: vote.voter_id, pickId: vote.pick_id }))),
    rng: makeRng(game.rng_seed, `groundTruth:${cards.length}`), gameNo: game.game_no, settings, event,
    state: { status: game.gt_status, needed: game.gt_real_cards_needed, cardNo: loaded.groundTruthCardNos[0] ?? null },
  });
  if (state.status === game.gt_status && state.needed === game.gt_real_cards_needed && state.cardNo === (loaded.groundTruthCardNos[0] ?? null)) return;
  let selectedId: string | null = null;
  if (state.status === 'announced' && game.gt_status !== 'announced') {
    const selected = loaded.cardRows.find((card) => card.card_no === state.cardNo && !card.is_noise);
    if (!selected) reject(409, 'WRONG_PHASE');
    selectedId = selected.id;
    loaded.groundTruthCardNos = [selected.card_no];
  }
  await ctx.client.query(`WITH announced AS (
    INSERT INTO ground_truths(game_id,card_id,announced_at) SELECT $1,$4::uuid,$5::timestamptz WHERE $4::uuid IS NOT NULL ON CONFLICT(game_id) DO NOTHING
    ) UPDATE games SET gt_status=$2,gt_real_cards_needed=$3 WHERE id=$1`, [game.id, state.status, state.needed, selectedId, ctx.now]);
  game.gt_status = state.status;
  game.gt_real_cards_needed = state.needed;
}

/** Adds exactly one card inside the caller's event/team/GAME transaction locks. */
async function appendCard(ctx: TxContext, loaded: LoadedGame): Promise<void> {
  const { game, members, cards } = loaded;
  if (cards.length >= 20) reject(409, 'EXHAUSTED');
  const settings = parseTeamSettings(game.config_snapshot);
  const cardNo = cards.length + 1;
  const common = { ownerId: game.owner_participant_id, members, cards, rng: makeRng(game.rng_seed, `card:${cardNo}`) };
  const selected = game.noise_slots.includes(cardNo)
    ? selectNoiseCard({ ...common, groundTruthCardNos: loaded.groundTruthCardNos })
    : selectRealCard({ ...common, rareFromRealOrdinal: settings.rareFromRealOrdinal });
  if (selected.kind === 'exhausted') reject(409, 'EXHAUSTED');
  if (selected.fallback) await logFallback(ctx, selected.fallback);
  const deliveryRows = loaded.deliveryRows;
  const deliveries: CardDelivery[] = deliveryRows.map((delivery) => ({ participantId: delivery.participant_id, cardNo: delivery.card_no, reason: delivery.reason }));
  const previousInitial = deliveryRows.find((delivery) => delivery.card_no === cards.length && delivery.reason === 'initial')?.participant_id ?? null;
  const receiver = selectReceiver({ members, deliveries, previousInitialRecipientId: previousInitial,
    previousTurnLeadId: game.turn_lead_participant_id, dataSplit: settings.dataSplitGames.includes(game.game_no),
    nowMs: ctx.now.getTime(), presenceWindowSeconds: ctx.event.config_json.presenceWindowSeconds, rng: makeRng(game.rng_seed, `receiver:${cardNo}`) });
  const card = selected.card;
  const transition = afterCardPublished({ cardNo, triggerNo: game.ensemble_trigger_no, ensembleDone: game.ensemble_done, turnLeadId: receiver.turnLeadId });
  const row = (await ctx.client.query<CardRow>(`WITH card AS (
    INSERT INTO data_cards(game_id,card_no,question_id,displayed_option,true_option,is_noise,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *
    ), deliveries AS (
      INSERT INTO card_deliveries(card_id,participant_id,reason,delivered_at)
      SELECT card.id,p,'initial',$7::timestamptz FROM card CROSS JOIN unnest($8::uuid[]) p
    ), updated AS (
      UPDATE games SET turn_lead_participant_id=$9,guess_locked=false,exhausted=$10,phase=$11,
        ensemble_sharer_id=CASE WHEN $11='ENSEMBLE_SHARE' THEN $9 ELSE ensemble_sharer_id END,
        game_version=game_version+1 WHERE id=$1
    ) SELECT * FROM card`, [game.id, card.cardNo, card.questionId, card.displayedOption, card.trueOption, card.isNoise,
    ctx.now, receiver.recipientIds, receiver.turnLeadId, cardNo === 20, transition.phase])).rows[0];
  loaded.cards.push(card);
  loaded.cardRows.push(row);
  game.turn_lead_participant_id = receiver.turnLeadId;
  game.guess_locked = false;
  game.exhausted = cardNo === 20;
  game.phase = transition.phase;
  game.game_version++;
  if (transition.sharerId) game.ensemble_sharer_id = transition.sharerId;
  if (!card.isNoise && game.gt_status === 'pending') await updateGroundTruth(ctx, loaded, 'real-card');
}

/** Caller authorizes the admin operation; outer runCommand owns the transaction. */
export async function createGame(ctx: TxContext, { teamBlockId, gameNo }: { teamBlockId: string; gameNo: number }): Promise<string> {
  const block = (await ctx.client.query<TeamBlockRow & { previous_owner_ids: string[] }>(`SELECT tb.*,t.operator_participant_id,
    ARRAY(SELECT g.owner_participant_id FROM games g WHERE g.team_id=tb.team_id AND g.block_no=tb.block_no AND g.event_id=$2) AS previous_owner_ids
    FROM team_blocks tb JOIN teams t ON t.id=tb.team_id
    WHERE tb.id=$1 AND tb.event_id=$2 FOR UPDATE OF tb`, [teamBlockId, ctx.event.id])).rows[0];
  if (!block) reject(404, 'NOT_FOUND');
  if (!Number.isInteger(gameNo) || gameNo < 1 || gameNo > 9 || Math.ceil(gameNo / 3) !== block.block_no) reject(422, 'INVALID_REQUEST');
  if (block.paused_at) reject(409, 'PAUSED');
  if (block.current_game_id) {
    const current = (await ctx.client.query<{ game_no: number; phase: string }>('SELECT game_no,phase FROM games WHERE id=$1 FOR UPDATE', [block.current_game_id])).rows[0];
    if (!current || current.phase !== 'REVEALED' || current.game_no % 3 === 0 || gameNo !== current.game_no + 1) reject(409, 'WRONG_PHASE');
  } else if (gameNo !== (block.block_no - 1) * 3 + 1) reject(409, 'WRONG_PHASE');
  const rows = (await ctx.client.query<MemberRow>(`SELECT p.id,p.role,p.roster_order,p.profile_completed_at,p.owner_count,
    COALESCE((SELECT jsonb_object_agg(a.question_id,a.option) FROM profile_answers a WHERE a.participant_id=p.id AND a.event_id=$2),'{}'::jsonb) answers,
    (SELECT max(s.last_seen_at) FROM sessions s WHERE s.participant_id=p.id AND s.event_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$4) last_seen_at
    FROM block_assignments a JOIN participants p ON p.id=a.participant_id
    WHERE a.team_id=$1 AND a.event_id=$2 AND a.block_no=$3 AND p.event_id=$2
      AND p.active=true AND p.attendance <> 'absent' AND p.profile_completed_at IS NOT NULL
    ORDER BY p.roster_order FOR UPDATE OF p`, [block.team_id, ctx.event.id, block.block_no, ctx.now])).rows;
  if (rows.length < 2) reject(409, 'INSUFFICIENT_MEMBERS');
  const members = rows.map(mapMember);
  const settings = parseTeamSettings(Object.keys((block.settings_json ?? {}) as object).length ? block.settings_json : DEFAULT_TEAM_SETTINGS);
  const seed = randomBytes(16).toString('hex');
  let owner;
  try { owner = selectOwner({ members, previousOwnerIdsInBlock: block.previous_owner_ids, rng: makeRng(seed, 'owner') }); }
  catch (error) { if (error instanceof GameRuleError) reject(409, error.code === 'NOT_ENOUGH_COMPLETED_MEMBERS' ? 'INSUFFICIENT_MEMBERS' : error.code); throw error; }
  if (owner.fallback) await logFallback(ctx, 'owner_fallback');
  const slots = createNoisePlan({ gameNo, settings, rng: makeRng(seed, 'noisePlan') });
  const trigger = getEnsembleTrigger({ gameNo, memberCount: members.length, settings });
  const game = (await ctx.client.query<GameRow>(`WITH created AS (
    INSERT INTO games(event_id,team_id,team_block_id,block_no,game_no,config_snapshot,
    owner_participant_id,noise_slots,rng_seed,phase,ensemble_trigger_no,started_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'TURN',$10,$11) RETURNING *
    ), members_added AS (
      INSERT INTO game_members(game_id,participant_id) SELECT created.id,p FROM created CROSS JOIN unnest($12::uuid[]) p
    ), profiles_locked AS (
      UPDATE participants SET profile_locked_at=COALESCE(profile_locked_at,$11::timestamptz),
        owner_count=owner_count+CASE WHEN id=$7::uuid THEN 1 ELSE 0 END WHERE id=ANY($12::uuid[]) AND event_id=$1
    ), block_updated AS (
      UPDATE team_blocks SET current_game_id=created.id,phase='IN_GAME',team_version=team_version+1,
        started_at=COALESCE(team_blocks.started_at,$11::timestamptz),done_at=NULL FROM created WHERE team_blocks.id=$3
    ) SELECT * FROM created`,
  [ctx.event.id, block.team_id, block.id, block.block_no, gameNo, JSON.stringify(settings), owner.ownerId, slots, seed, trigger, ctx.now, members.map((member) => member.id)])).rows[0];
  await appendCard(ctx, { game, teamBlock: block, members, cards: [], cardRows: [], deliveryRows: [],
    groundTruthCardNos: [], attempts: [], votes: [], viewerGroundTruthSeen: false, viewerNoiseSeen: false });
  return game.id;
}

/** Do not return the loaded private GAME. Final public data is built by the DTO. */
export async function forceReveal(ctx: TxContext, gameId: string, reason: 'correct' | 'forced' | 'session_end'): Promise<void> {
  const loaded = await lockGame(ctx, gameId);
  await revealLoadedGame(ctx, loaded, reason);
}

async function revealLoadedGame(ctx: TxContext, loaded: LoadedGame, reason: 'correct' | 'forced' | 'session_end'): Promise<void> {
  if (loaded.game.phase === 'REVEALED') return;
  const gameId = loaded.game.id;
  const pauseMs = loaded.teamBlock.paused_at ? Math.max(0, ctx.now.getTime() - loaded.teamBlock.paused_at.getTime()) : 0;
  await ctx.client.query(`WITH revealed AS (UPDATE games SET phase='REVEALED',revealed_at=$2,end_reason=$3,guess_locked=false,
    gt_status=CASE WHEN gt_status='pending' THEN 'skipped' ELSE gt_status END,
    vote_deadline=NULL,vote_remaining_ms=NULL,paused_ms_total=paused_ms_total+$4,game_version=game_version+1 WHERE id=$1)
    UPDATE team_blocks SET phase=$6,team_version=team_version+1,paused_at=NULL,
    done_at=CASE WHEN $6='BLOCK_DONE' THEN $2::timestamptz ELSE NULL END WHERE id=$5 AND current_game_id=$1`,
  [gameId, ctx.now, reason, pauseMs, loaded.teamBlock.id, loaded.game.game_no % 3 === 0 ? 'BLOCK_DONE' : 'REVEAL']);
}

async function acknowledgeIntro(ctx: TxContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = parse(z.object({ introKey: z.enum(['tutorial', 'noise', 'ensemble', 'ground_truth']), gameId: z.string().uuid().optional() }), args);
  if (!ctx.session.participant_id) reject(401, 'UNAUTHENTICATED');
  if (ctx.event.phase === 'ENDED') reject(410, 'ENDED');
  if (input.introKey !== 'tutorial') {
    if (!input.gameId) reject(422, 'INVALID_REQUEST');
    const loaded = await lockGame(ctx, input.gameId, true);
    requireMember(ctx, loaded);
    const game = loaded.game;
    if (input.introKey === 'noise' && (loaded.cards.length < 3 || !loaded.cards.some((card) => card.isNoise))) reject(409, 'WRONG_PHASE');
    if (input.introKey === 'ensemble' && !game.ensemble_done && !game.phase.startsWith('ENSEMBLE_')) reject(409, 'WRONG_PHASE');
    if (input.introKey === 'ground_truth' && game.gt_status !== 'announced') reject(409, 'WRONG_PHASE');
    await ctx.client.query(`WITH overlay AS (
      INSERT INTO game_overlay_seen(game_id,participant_id,kind,seen_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING
      ) INSERT INTO intro_seen(participant_id,intro_key,seen_at) VALUES($2,$3,$4) ON CONFLICT DO NOTHING`, [game.id, ctx.session.participant_id, input.introKey, ctx.now]);
    return {};
  }
  await ctx.client.query('INSERT INTO intro_seen(participant_id,intro_key,seen_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [ctx.session.participant_id, input.introKey, ctx.now]);
  return {};
}

/** Tx-level entry point. The route runs settleBlocks(ctx) in this transaction. */
export async function executeGameCommand(ctx: TxContext, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try { return await dispatchGameCommand(ctx, command, args); }
  catch (error) {
    if (error instanceof GameRuleError) {
      const stateConflict = ['PAUSED', 'WRONG_PHASE', 'GUESS_LOCKED', 'NOT_ENOUGH_DATA', 'INTRO_REQUIRED'].includes(error.code);
      reject(stateConflict ? 409 : 422, error.code);
    }
    if (error instanceof z.ZodError) reject(422, 'INVALID_REQUEST');
    throw error;
  }
}

async function dispatchGameCommand(ctx: TxContext, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (command === 'intro-ack') return acknowledgeIntro(ctx, args);
  const vote = command === 'ensemble-vote';
  const input = vote ? parse(z.object({ gameId: z.string().uuid(), pickId: z.string().uuid(), revision: z.number().int().nonnegative() }), args) : parse(gameInput, args);
  const loaded = await lockGame(ctx, input.gameId, vote);
  requireCurrent(ctx, loaded);
  requireUnpaused(loaded);
  if ('gameVersion' in input) requireVersion(loaded, input.gameVersion);
  const { game, cards, members } = loaded;
  const participantId = ctx.session.participant_id;
  if (!participantId) reject(401, 'UNAUTHENTICATED');
  const canDelegate = isOperatorForGame(ctx, loaded);
  if (command === 'more-data' || command === 'guess') {
    requireMember(ctx, loaded);
    if (game.turn_lead_participant_id !== participantId) reject(409, 'NOT_TURN_LEAD');
    if (game.phase !== 'TURN') reject(409, 'WRONG_PHASE');
    requireGroundTruthAcknowledged(loaded);
  }
  if (command === 'more-data') {
    const extra = parse(z.object({ expectedCardCount: z.number().int().min(1).max(20) }), args);
    if (extra.expectedCardCount !== cards.length) reject(409, 'STALE_VERSION');
    await appendCard(ctx, loaded);
    return {};
  }
  if (command === 'guess') {
    const extra = parse(z.object({ ownerPick: z.string().uuid(), noisePicks: z.array(z.number().int().min(1).max(20)).max(5) }), args);
    const result = evaluateGuess({ gameNo: game.game_no, settings: parseTeamSettings(game.config_snapshot), phase: game.phase,
      paused: false, guessLocked: game.guess_locked, cards, memberIds: members.map((member) => member.id), ownerId: game.owner_participant_id,
      ...extra, groundTruthCardNos: loaded.groundTruthCardNos, noiseIntroSeen: loaded.viewerNoiseSeen });
    await ctx.client.query(`INSERT INTO guess_attempts(game_id,attempt_no,submitted_by,owner_pick,noise_picks,revealed_count,correct,created_at)
      SELECT $1,COALESCE(max(attempt_no),0)+1,$2,$3,$4,$5,$6,$7 FROM guess_attempts WHERE game_id=$1`,
    [game.id, participantId, extra.ownerPick, extra.noisePicks, cards.length, result.correct, ctx.now]);
    if (result.correct) await revealLoadedGame(ctx, loaded, 'correct');
    else await ctx.client.query('UPDATE games SET guess_locked=$2,game_version=game_version+1 WHERE id=$1', [game.id, result.guessLocked]);
    return { correct: result.correct };
  }
  if (command === 'ensemble-shared') {
    if (!canDelegate && participantId !== game.ensemble_sharer_id) reject(403, 'FORBIDDEN');
    if (game.phase !== 'ENSEMBLE_SHARE') reject(409, 'WRONG_PHASE');
    await ctx.client.query(`UPDATE games SET phase='ENSEMBLE_VOTE',vote_deadline=$2,vote_remaining_ms=NULL,game_version=game_version+1 WHERE id=$1`, [game.id, new Date(ctx.now.getTime() + 30_000)]);
    return {};
  }
  if (command === 'ensemble-vote') {
    requireMember(ctx, loaded);
    const extra = parse(z.object({ pickId: z.string().uuid(), revision: z.number().int().nonnegative() }), args);
    // Serialize this voter's first INSERT as well as revisions of an existing
    // vote. Other voters can proceed without holding the event exclusively.
    // The pick_id FK takes KEY SHARE on the selected person. NO KEY UPDATE
    // serializes one voter without deadlocking reciprocal A -> B ballots.
    await ctx.client.query('SELECT id FROM participants WHERE id=$1 AND event_id=$2 FOR NO KEY UPDATE', [participantId, ctx.event.id]);
    ctx.now = (await ctx.client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
    if (game.phase !== 'ENSEMBLE_VOTE' || !game.vote_deadline || ctx.now >= game.vote_deadline) {
      if(game.phase === 'ENSEMBLE_VOTE' && game.vote_deadline && ctx.now >= game.vote_deadline) ctx.deadlineSettlementNeeded = true;
      reject(409, 'WRONG_PHASE');
    }
    if (!members.some((member) => member.id === extra.pickId)) reject(422, 'INVALID_REQUEST');
    const previous = (await ctx.client.query<{ pick_id: string; revision: number }>('SELECT pick_id,revision FROM ensemble_votes WHERE game_id=$1 AND voter_id=$2 FOR UPDATE', [game.id, participantId])).rows[0];
    if (previous?.revision === extra.revision + 1 && previous.pick_id === extra.pickId) return { revision: previous.revision };
    if ((previous?.revision ?? 0) !== extra.revision) reject(409, 'STALE_REVISION');
    const revision = extra.revision + 1;
    await ctx.client.query(`INSERT INTO ensemble_votes(game_id,voter_id,pick_id,revision,updated_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(game_id,voter_id) DO UPDATE SET pick_id=EXCLUDED.pick_id,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at`,
    [game.id, participantId, extra.pickId, revision, ctx.now]);
    return { revision };
  }
  if (command === 'ensemble-end-discussion') {
    if (!canDelegate && participantId !== game.ensemble_sharer_id) reject(403, 'FORBIDDEN');
    if (game.phase !== 'ENSEMBLE_DISCUSS') reject(409, 'WRONG_PHASE');
    await ctx.client.query(`UPDATE games SET phase='TURN',ensemble_done=true,turn_lead_participant_id=ensemble_sharer_id,game_version=game_version+1 WHERE id=$1`, [game.id]);
    game.phase = 'TURN';
    game.ensemble_done = true;
    game.turn_lead_participant_id = game.ensemble_sharer_id;
    await updateGroundTruth(ctx, loaded, 'ensemble-finished');
    return {};
  }
  reject(422, 'INVALID_REQUEST');
}
