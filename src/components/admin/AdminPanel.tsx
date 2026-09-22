"use client";

import { useState } from "react";
import type { GamePhase, PublicState } from "@/lib/contracts";
import type { SendAction } from "../useMingleState";
import { Modal } from "../ui/Modal";
import { GlobalSettingsForm, TeamSettingsForm } from "./SettingsForms";

const sessionCommands = new Set(["assign-teams", "publish-teams", "start-game1", "publish-next-block", "end-session", "transfer-host", "update-global-settings", "swap-seats", "upsert-participant", "remove-participant", "mark-attendance"]);
const gameCommands = new Set(["transfer-turn-lead", "resend-data", "ensemble-shared", "ensemble-end-discussion"]);
const labels: Record<string, string> = { "assign-teams": "조 편성", "publish-teams": "조 배정 공개", "start-game1": "Game 1 전체 시작", "publish-next-block": "다음 블록 시작", "start-block-game": "착석 완료 · Game 시작", "next-game": "다음 Game", pause: "Game 일시정지", resume: "Game 재개", "force-end-game": "현재 Game 종료", "end-session": "전체 종료", "transfer-host": "호스트 이전", "unlock-participant": "잠금 해제", "transfer-turn-lead": "Turn Lead 변경", "resend-data": "Data 재전송", "ensemble-shared": "공유 단계 넘기기", "ensemble-end-discussion": "토론 마침", "swap-seats": "자리 교환", "mark-attendance": "출석 변경", "upsert-participant": "명단 저장", "remove-participant": "명단에서 제외", "update-team-settings": "조 설정 저장", "update-global-settings": "전체 설정 저장", "apply-preset": "프리셋 적용" };
const confirmationCommands = new Set(["publish-teams", "publish-next-block", "start-game1", "force-end-game", "end-session", "transfer-host", "unlock-participant", "remove-participant"]);
const minutes = (milliseconds: number | null) => milliseconds === null ? "—" : `${Math.floor(milliseconds / 60000)}분 ${Math.floor(milliseconds / 1000) % 60}초`;
const gameStageLabels: Record<GamePhase, string> = { TURN: "단서·추리", ENSEMBLE_SHARE: "Data 공유", ENSEMBLE_VOTE: "개별 투표", ENSEMBLE_DISCUSS: "결과 토론", REVEALED: "정답 공개" };

function ConnectionStatus({ online }: { online: boolean | undefined }) {
  if (online === undefined) return null;
  return <span className={`connection-status ${online ? "online" : "offline"}`}>{online ? "온라인" : "오프라인"}</span>;
}

export function AdminPanel({ state, send, busy, onClose }: { state: PublicState; send: SendAction; busy: boolean; onClose: () => void }) {
  const [tab, setTab] = useState("progress");
  const [teamKey, setTeamKey] = useState(state.team?.key ?? state.admin?.teams[0]?.key ?? "A");
  const [target, setTarget] = useState("");
  const [cardNo, setCardNo] = useState(1);
  const [swapA, setSwapA] = useState("");
  const [swapB, setSwapB] = useState("");
  const [editId, setEditId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"student" | "operator">("student");
  const [resetAnswers, setResetAnswers] = useState(false);
  const [forceStart, setForceStart] = useState(false);
  const [confirm, setConfirm] = useState<{ command: string; args: Record<string, unknown>; stage: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const admin = state.admin;
  if (!admin) return null;
  const team = admin.teams.find((item) => item.key === teamKey);
  const can = (command: string) => state.allowedActions.includes(command);
  const execute = async (command: string, args: Record<string, unknown> = {}) => {
    setMessage(null);
    const expectedVersion = sessionCommands.has(command) ? state.versions.session : gameCommands.has(command) ? team?.gameVersion : team?.version;
    try {
      if (command === "ensemble-shared" || command === "ensemble-end-discussion") {
        await send(`/api/game/${command}`, { gameId: team?.gameId, gameVersion: team?.gameVersion });
      } else await send("/api/admin", { command, teamKey, expectedVersion, args });
      setMessage(`${labels[command] ?? "변경"} 완료`);
      return true;
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "잠시 후 다시 시도해주세요."); return false; }
  };
  const run = async (command: string, args: Record<string, unknown> = {}) => {
    if (confirmationCommands.has(command)) { setConfirm({ command, args, stage: 1 }); return; }
    return execute(command, args);
  };
  const roster = admin.registration ?? admin.teams.flatMap((item) => item.members.map((member) => ({ ...member, locked: false })));
  const presenceByParticipant = new Map(admin.teams.flatMap((item) => item.members.map((member) => [member.participantId, member.online] as const)));
  const validForTeam = (command: string) => {
    if (sessionCommands.has(command)) return true;
    if (!team?.canControl) return false;
    if (command === "pause") return team.phase === "IN_GAME" && !team.paused;
    if (command === "resume") return team.phase === "IN_GAME" && team.paused;
    if (command === "force-end-game") return team.phase === "IN_GAME";
    if (command === "next-game") return team.phase === "REVEAL";
    if (command === "start-block-game") return team.phase === "SEATING";
    if (command === "ensemble-shared") return team.stage === "ENSEMBLE_SHARE" && !team.paused;
    if (command === "ensemble-end-discussion") return team.stage === "ENSEMBLE_DISCUSS" && !team.paused;
    return true;
  };
  const button = (command: string, args = {}) => can(command) && validForTeam(command) && <button key={command} className={`button ${command.includes("end") ? "danger-outline" : "secondary"}`} disabled={busy} onClick={() => void run(command, args)}>{labels[command] ?? command}</button>;
  return <Modal title="관리자" onClose={onClose} wide className="admin-panel">
    <p className="small muted">관리자 화면에서도 정답 정보는 공개되지 않습니다.</p>
    <nav className="admin-tabs" aria-label="관리자 메뉴">{[["progress", "진행"], ["people", "참가자"], ["settings", "설정"], ["logs", "로그"]].map(([key, label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>{label}</button>)}</nav>
    {message && <p className="notice" role="status">{message}</p>}
    {tab !== "logs" && admin.teams.length > 0 && <label className="team-select">조 선택<select value={teamKey} onChange={(event) => { setTeamKey(event.target.value); setTarget(""); }}>
      {admin.teams.map((item) => <option key={item.key} value={item.key}>{item.key}조 · {item.operatorName}</option>)}
    </select></label>}
    {tab === "progress" && <>
      <div className="admin-team-grid">{admin.teams.map((item) => <button className={`admin-team-card ${item.key === teamKey ? "selected" : ""}`} key={item.key} onClick={() => setTeamKey(item.key)}><div className="inline-between"><strong>{item.key}조</strong><span className="badge">{item.paused ? "일시정지" : item.phase === "BLOCK_DONE" ? "블록 완료" : item.phase === "SEATING" ? "착석 대기" : item.gameNo ? `Game ${item.gameNo}` : "준비"}</span></div><p className="admin-stage">{item.gameNo ? `Game ${item.gameNo} · ` : "현재 단계 · "}{item.stage ? gameStageLabels[item.stage as GamePhase] ?? "진행 상태 확인 중" : item.phase === "SEATING" ? "착석 대기" : "준비"}</p><p>온라인 {item.members.filter((member) => member.online).length} / {item.members.length}명</p><p>Data {item.revealedCount} · {item.turnLeadName ?? "대기 중"}</p><p className={`small ${item.timers.blockElapsedMs !== null && item.timers.blockElapsedMs > item.timers.blockTargetMs * 1.3 ? "overdue" : "muted"}`}>Game {minutes(item.timers.gameElapsedMs)}<br />블록 {minutes(item.timers.blockElapsedMs)} / 목표 {minutes(item.timers.blockTargetMs)}</p></button>)}</div>
      <p className="small muted">참고용 타이머 · 자동 종료 없음</p>
      {team && <section className="admin-presence" aria-label={`${team.key}조 참가자 연결`}><h3>{team.key}조 참가자 연결</h3><p className="small muted">최근 연결 기록 기준이며, 출석·결석 기록과는 별개예요.</p><ul className="admin-presence-list">{team.members.map((person) => <li key={person.participantId}><span>{person.displayName}{person.role === "operator" && <small className="muted"> · 운영진</small>}</span><ConnectionStatus online={person.online} /></li>)}</ul></section>}
      <div className="action-grid">{["pause", "resume", "force-end-game", "next-game", "start-block-game", "ensemble-shared", "ensemble-end-discussion"].map((command) => button(command))}</div>
      {team?.canControl && ["TURN", "ENSEMBLE_SHARE"].includes(team.stage ?? "") && (can("transfer-turn-lead") || can("resend-data")) && <fieldset className="admin-tools"><legend>진행 복구</legend><label>대상 참가자<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">선택해주세요</option>{team.members.map((person) => <option key={person.participantId} value={person.participantId}>{person.displayName}</option>)}</select></label><div className="action-grid">{can("transfer-turn-lead") && <button className="button secondary" disabled={busy || !target} onClick={() => void run("transfer-turn-lead", { participantId: target })}>Turn Lead 변경</button>}{can("resend-data") && <><label>Data 번호<input type="number" min={1} max={team.revealedCount} value={cardNo} onChange={(event) => setCardNo(Number(event.target.value))} /></label><button className="button secondary" disabled={busy || !target || !team.revealedCount} onClick={() => void run("resend-data", { participantId: target, cardNo })}>Data 재전송</button></>}</div></fieldset>}
      {admin.isHost && <section className="host-tools"><h3>전체 진행 · 호스트</h3>{state.event.phase === "BREAK" && !admin.nextBlockPlan && <p className="notice">명단과 전체 설정을 확인한 뒤 저장해주세요. 조 수와 운영진 배정이 맞으면 다음 자리 배정안이 만들어져요.</p>}{admin.nextBlockPlan && <div className="plan-list">{admin.nextBlockPlan.map((item) => <p key={item.teamKey}><strong>{item.teamKey}조</strong> {item.members.join(" · ")}</p>)}</div>}
        {can("swap-seats") && <fieldset className="admin-tools"><legend>배정안 자리 교환</legend><div className="field-row">{[[swapA, setSwapA], [swapB, setSwapB]].map(([value, setter], index) => <select aria-label={`교환할 참가자 ${index + 1}`} key={index} value={value as string} onChange={(event) => (setter as (value: string) => void)(event.target.value)}><option value="">참가자 선택</option>{roster.filter((person) => person.role === "student").map((person) => <option key={person.participantId} value={person.participantId}>{person.displayName}</option>)}</select>)}</div><button className="button secondary" disabled={busy || !swapA || !swapB || swapA === swapB} onClick={() => void run("swap-seats", { a: swapA, b: swapB })}>자리 교환</button></fieldset>}
        {can("start-game1") && <label className="check-row"><input type="checkbox" checked={forceStart} onChange={(event) => setForceStart(event.target.checked)} />미완료 참가자를 확인했고, 현재 인원으로 시작</label>}
        <div className="action-grid">{button("assign-teams")}{button("publish-teams")}{button("start-game1", { force: forceStart })}{button("publish-next-block")}{button("end-session", state.event.currentBlock < 3 ? { emergency: true, confirm: true, confirmEmergency: true } : { confirm: true })}</div>
        {can("transfer-host") && <label>호스트 이전<select value="" onChange={(event) => event.target.value && void run("transfer-host", { participantId: event.target.value })}><option value="">새 호스트 선택</option>{roster.filter((person) => person.role === "operator" && person.participantId !== state.me?.participantId).map((person) => <option key={person.participantId} value={person.participantId}>{person.displayName}</option>)}</select></label>}
      </section>}
    </>}
    {tab === "people" && <>
      <p className="small muted">온라인·오프라인은 최근 연결 기록이며 출석 상태와 달라요. 조에 배정된 참가자의 연결 상태를 표시해요.</p>
      <label className="check-row"><input type="checkbox" checked={resetAnswers} onChange={(event) => setResetAnswers(event.target.checked)} />잠금 해제 시 답변도 초기화 (Game 시작 전만)</label>
      <div className="participant-list">{roster.map((person) => <article key={person.participantId}><div><strong>{person.displayName}</strong>{"pending" in person && person.pending && <span className="badge">다음 블록 반영</span>}{"active" in person && person.active === false && <span className="badge">제외됨</span>}<p className="small muted">{person.role === "operator" ? "운영진" : "수강생"} · {person.profileComplete ? "프로필 완료" : "프로필 작성 전"} · {person.attendance === "present" ? "출석" : person.attendance === "absent" ? "결석" : "미확인"}</p><ConnectionStatus online={presenceByParticipant.get(person.participantId)} /></div><div className="participant-buttons">
        {can("unlock-participant") && (admin.isHost || team?.members.some((member) => member.participantId === person.participantId) || state.event.phase === "SETUP") && <button className="button small secondary" disabled={busy} onClick={() => void run("unlock-participant", { participantId: person.participantId, resetAnswers })}>잠금 해제</button>}
        {can("mark-attendance") && <select aria-label={`${person.displayName} 출석`} value={person.attendance} disabled={busy} onChange={(event) => void run("mark-attendance", { participantId: person.participantId, attendance: event.target.value })}><option value="unknown">미확인</option><option value="present">출석</option><option value="absent">결석</option></select>}
        {can("upsert-participant") && <button className="text-button small" onClick={() => { setEditId(person.participantId); setDisplayName(person.displayName); setRole(person.role); }}>수정</button>}
        {can("remove-participant") && <button className="text-button small" disabled={busy} onClick={() => void run("remove-participant", { participantId: person.participantId })}>제외</button>}
      </div></article>)}</div>
      {can("upsert-participant") && <form className="admin-tools" onSubmit={(event) => { event.preventDefault(); void run("upsert-participant", { ...(editId ? { participantId: editId } : {}), displayName: displayName.trim(), role }).then((success) => { if (success) { setEditId(""); setDisplayName(""); } }); }}><h3>{editId ? "참가자 수정" : "참가자 추가"}</h3><label>이름<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={40} /></label><label>역할<select value={role} onChange={(event) => setRole(event.target.value as "student" | "operator")}><option value="student">수강생</option><option value="operator">운영진</option></select></label><p className="small muted">행사 진행 중 명단 변경은 다음 블록에 반영돼요. 새 운영진 코드는 별도로 발급해주세요.</p><button className="button secondary full" disabled={busy || !displayName.trim()}>명단 저장</button>{editId && <button type="button" className="text-button" onClick={() => { setEditId(""); setDisplayName(""); }}>수정 취소</button>}</form>}
    </>}
    {tab === "settings" && <>{team?.canControl && can("update-team-settings") && <TeamSettingsForm key={`${team.key}:${JSON.stringify(team.settings)}`} settings={team.settings} save={run} busy={busy} />}{admin.isHost && admin.globalSettings && can("update-global-settings") && <details className="global-settings"><summary>전체 설정 · 호스트</summary><GlobalSettingsForm key={JSON.stringify(admin.globalSettings)} settings={admin.globalSettings} save={run} busy={busy} operatorNames={roster.filter((person) => person.role === "operator" && !("active" in person && person.active === false)).map((person) => person.displayName)} /></details>}</>}
    {tab === "logs" && <ol className="operation-log">{admin.recentLogs.map((log, index) => <li key={`${log.at}:${index}`}><time>{new Date(log.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><p><strong>{log.actorName}</strong> · {labels[log.command] ?? "진행 변경"}{log.target && <span className="small muted"> · {log.target}</span>}</p></li>)}{admin.recentLogs.length === 0 && <p className="muted">아직 운영 기록이 없어요.</p>}</ol>}
    {confirm && <Modal title={`${labels[confirm.command] ?? "변경"}을 진행할까요?`} onClose={() => setConfirm(null)}><p>{confirm.command.includes("end") ? "진행 중인 Game은 정답을 공개한 뒤 종료해요." : confirm.command === "unlock-participant" ? "기존 기기의 연결을 해제합니다. 참가자는 본인 이름을 다시 선택할 수 있어요." : "참가자 화면에도 변경 사항이 반영돼요."}</p>{confirm.command === "end-session" && !!confirm.args.emergency && <p className="error-message">전체 비상 종료 확인 {confirm.stage} / 2</p>}<div className="action-grid"><button className="button secondary" onClick={() => setConfirm(null)}>취소</button><button className="button primary" disabled={busy} onClick={() => { if (confirm.command === "end-session" && confirm.args.emergency && confirm.stage === 1) { setConfirm({ ...confirm, stage: 2 }); return; } const { command, args } = confirm; setConfirm(null); void execute(command, args); }}>확인</button></div></Modal>}
  </Modal>;
}
