"use client";

import { useState } from "react";
import type { PublicState } from "@/lib/contracts";
import type { SendAction } from "../useMingleState";

export function GMNextGame({ state, send, busy }: { state: PublicState; send: SendAction; busy: boolean }) {
  const team = state.admin?.teams.find((item) => item.key === state.team?.key);
  const [noiseCap, setNoiseCap] = useState(team?.settings.gm?.noiseCap ?? 1);
  const [groundTruth, setGroundTruth] = useState(team?.settings.gm?.groundTruth ?? false);
  const [error, setError] = useState<string | null>(null);
  if (!team) return null;
  const command = team.phase === "SEATING" ? "start-block-game" : "gm-next-game";
  const start = async () => {
    setError(null);
    try { await send("/api/admin", { command, teamKey: team.key, expectedVersion: team.version, args: { noiseCap, groundTruth } }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "시작하지 못했어요. 조 GM의 프로필과 출석을 확인해주세요."); }
  };
  return <div className="gm-next-game">
    <h3>{team.phase === "SEATING" ? "새 조 준비" : "다음 판 준비"}</h3>
    <div className="field-row"><label>Noise 최대 개수<select value={noiseCap} disabled={busy} onChange={(event) => setNoiseCap(Number(event.target.value))}>
      {[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}개</option>)}
    </select></label><label>확실한 단서 · Ground Truth<select value={groundTruth ? "on" : "off"} disabled={busy} onChange={(event) => setGroundTruth(event.target.value === "on")}><option value="off">사용하지 않음</option><option value="on">1개 확인</option></select></label></div>
    <p className="small muted">Noise는 최대 개수예요. 모두 나오기 전에 맞혀도 끝나요. 지금 설정은 시작할 판에 적용돼요.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    <button className="button primary full" disabled={busy || !state.allowedActions.includes(command) || !!state.event.rotationRequested} onClick={start}>{team.phase === "SEATING" ? "준비 완료 · Game 시작" : "대화를 마치고 다음 Game 시작"}</button>
  </div>;
}

/** The GM sees pacing controls, never the answer or other participants' private cards. */
export function GMRemote({ state, send, busy, onReturnToGame }: { state: PublicState; send: SendAction; busy: boolean; onReturnToGame?: () => void }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const team = state.admin?.teams.find((item) => item.key === state.team?.key);
  if (state.event.gameplayMode !== "gm" || state.me?.role !== "operator" || !team?.canControl || ["SETUP", "ENDED"].includes(state.event.phase)) return null;
  const game = state.game;
  const can = (action: string) => {
    if (!state.allowedActions.includes(action)) return false;
    // A head GM's allowedActions is the union of all controlled teams. The
    // personal remote must also check its own team's stage before enabling.
    if (action === "rotation-ready") return !!state.event.rotationRequested && ["REVEAL", "SEATING"].includes(team.phase);
    if (team.phase !== "IN_GAME" || !game) return false;
    if (action === "pause") return !team.paused;
    if (action === "resume") return team.paused;
    if (team.paused) return false;
    if (action === "ensemble-shared") return game.phase === "ENSEMBLE_SHARE";
    if (action === "ensemble-end-discussion") return game.phase === "ENSEMBLE_DISCUSS";
    if (game.phase !== "TURN") return false;
    if (action === "next-card") return !game.exhausted;
    if (action === "close-guess") return !!game.gm?.guessOpen;
    if (action === "open-guess") return !game.gm?.guessOpen && !game.guess?.locked && game.cards.length >= (game.gameNo === 1 ? 1 : 3);
    return false;
  };
  const run = async (command: string, message: string) => {
    setFeedback(null);
    setError(null);
    try {
      if (command === "next-card") await send("/api/game/next-card", { gameId: game?.gameId, gameVersion: state.versions.game, expectedCardCount: game?.cards.length });
      else if (command === "ensemble-shared" || command === "ensemble-end-discussion") await send(`/api/game/${command}`, { gameId: game?.gameId, gameVersion: state.versions.game });
      else await send("/api/admin", { command, teamKey: team.key,
        expectedVersion: ["open-guess", "close-guess"].includes(command) ? state.versions.game : team.version, args: {} });
      setFeedback(message);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "진행 상태를 다시 확인하고 눌러주세요."); }
  };
  const button = (command: string, label: string, message: string, primary = false) => <button className={`button ${primary ? "primary" : "secondary"}`} disabled={busy || !can(command)} onClick={() => void run(command, message)}>{label}</button>;
  return <section className="gm-remote" aria-label={`${team.key}조 GM 리모컨`}>
    <div className="inline-between"><p className="eyebrow">{team.key}조 · GM 리모컨</p><span className="badge">{team.paused ? "일시정지" : team.rotationReady ? "이동 준비 완료" : game?.gm?.guessOpen && game.phase === "TURN" ? "추리 열림" : "대화 진행"}</span></div>
    {feedback && <p className="small saved" role="status">{feedback}</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {state.event.rotationRequested && <p className="notice">조 이동을 준비하고 있어요. 현재 판과 대화를 마친 뒤 준비 완료를 눌러주세요. 다음 판은 잠시 기다려요.</p>}
    {team.phase === "IN_GAME" && game && <>
      {game.phase === "TURN" && <>
        <h2>지금 추리할까요, 단서를 더 볼까요?</h2>
        <p className="muted">모두의 선택을 묻고, 같은 선택과 다른 선택의 이유를 들어보세요.</p>
        <div className="action-grid">
          {button("next-card", "다음 단서", "새 단서를 전달했어요. 다시 이야기를 나눠보세요.")}
          {game.gm?.guessOpen ? button("close-guess", "추리 닫고 대화하기", "추리를 닫았어요. 대화를 이어가세요.") : button("open-guess", "추리 열기", "현재 추리 담당자가 답을 제출할 수 있어요.", true)}
        </div>
        {game.gm?.guessOpen && <p className="small">{game.turnLead?.displayName}님이 팀의 추리를 제출해요. GM도 정답은 공개 전까지 몰라요.</p>}
        {!game.gm?.guessOpen && game.gameNo > 1 && game.cards.length < 3 && <p className="small muted">단서 3개부터 추리를 열 수 있어요.</p>}
        {game.guess?.locked && <p className="small muted">오답 뒤에는 다음 단서를 받은 후 다시 추리를 열어주세요.</p>}
        {game.exhausted && <p className="small muted">단서 20개를 모두 보았어요. 대화 후 추리를 열어주세요.</p>}
      </>}
      {game.phase === "ENSEMBLE_SHARE" && <><h2>단서를 함께 듣고 각자 생각해봐요.</h2><p className="muted">{game.ensemble?.sharer.displayName}님이 단서를 읽고 이야기를 나눴다면 30초 투표를 열어주세요.</p>{button("ensemble-shared", "공유 마침 · 투표 시작", "30초 투표가 시작됐어요. GM도 자기 표를 선택해주세요.", true)}</>}
      {game.phase === "ENSEMBLE_VOTE" && <><p>지금은 각자 투표하는 시간이에요. GM도 리모컨을 닫고 자기 화면에서 투표해주세요.</p>{onReturnToGame && <button className="button primary full" onClick={onReturnToGame}>내 투표 화면으로</button>}</>}
      {game.phase === "ENSEMBLE_DISCUSS" && <><h2>어떤 단서에서 그렇게 생각했나요?</h2><p className="muted">표가 적게 나온 분도 자신의 선택과 이유를 함께 이야기해주세요.</p>{button("ensemble-end-discussion", "토론 마침 · 대화로 돌아가기", "다시 대화를 이어가세요. 추리는 GM이 열어줘요.", true)}</>}
      <div className="gm-secondary">{team.paused ? button("resume", "진행 재개", "진행을 재개했어요.") : button("pause", "잠시 멈추기", "투표 시계와 게임 진행을 잠시 멈췄어요.")}</div>
    </>}
    {(team.phase === "REVEAL" || team.phase === "SEATING") && !state.event.rotationRequested && <GMNextGame key={`${team.key}:${team.gameNo}:${state.event.currentBlock}`} state={state} send={send} busy={busy} />}
    {state.event.rotationRequested && !team.rotationReady && <div className="gm-secondary">{button("rotation-ready", "대화 마침 · 이동 준비 완료", "우리 조의 준비가 끝났어요. 전체 이동 안내를 기다려주세요.", true)}</div>}
    {team.rotationReady && <p className="small muted">총괄 GM이 새 조를 공개할 때까지 함께 이야기를 나눠주세요.</p>}
  </section>;
}
