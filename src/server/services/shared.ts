import "server-only";
import type { TxContext } from "../db/tx";
import { reject } from "../http/respond";
import type { TeamSettings } from "../game/settings";
export interface TeamRow { id: string; event_id: string; team_key: string; operator_participant_id: string|null; settings_json: TeamSettings }
export interface TeamBlockRow { id: string; event_id: string; team_id: string; block_no: number; phase: string;
  current_game_id: string|null; team_version: number; settings_json: TeamSettings; paused_at: Date|null; started_at: Date|null; done_at: Date|null; rotation_ready?: boolean }
export function requireHost(ctx: TxContext) {
  if (ctx.session.role !== "operator" || ctx.event.host_participant_id !== ctx.session.participant_id) reject(403, "FORBIDDEN");
}
export function checkVersion(actual: number, supplied: unknown) {
  if (!Number.isInteger(supplied) || actual !== supplied) reject(409, "STALE_VERSION");
}
export async function controlledTeam(ctx: TxContext, key: string) {
  const team = (await ctx.client.query<TeamRow>("SELECT * FROM teams WHERE event_id=$1 AND team_key=$2",[ctx.event.id,key])).rows[0];
  if (!team) reject(404,"NOT_FOUND");
  if (ctx.session.role !== "operator" || (ctx.session.participant_id !== ctx.event.host_participant_id && ctx.session.participant_id !== team.operator_participant_id)) reject(403,"FORBIDDEN");
  return team;
}
export async function currentTeamBlock(ctx: TxContext, teamId: string) {
  const block = (await ctx.client.query<TeamBlockRow>("SELECT * FROM team_blocks WHERE event_id=$1 AND team_id=$2 AND block_no=$3 FOR UPDATE",[ctx.event.id,teamId,ctx.event.current_block])).rows[0];
  if (!block) reject(409,"WRONG_PHASE");
  return block;
}
export async function operationLog(ctx: TxContext, command: string, target: string|null = null) {
  await ctx.client.query("INSERT INTO operation_logs(event_id,actor_participant_id,command,target) VALUES($1,$2,$3,$4)",[ctx.event.id,ctx.session.participant_id,command,target]);
}
