"use client";

import { useState } from "react";
import type { PublicState } from "@/lib/contracts";
import { questions } from "@/content/catalog";
import { AdminPanel } from "../admin/AdminPanel";
import { Entry } from "../player/Entry";
import { BlockDoneNotice, GameBoard, Reveal, WaitingRoom } from "../player/GameBoard";
import { Profile } from "../player/Profile";
import { Brand } from "../ui/Brand";
import { StatusPanel } from "../ui/Modal";
import type { ApiResult, requestJson, SendAction } from "../useMingleState";
import { createPreviewState, isAdminPreview, previewGroups, previewGuessCards, previewPeople, previewScenarios, type PreviewView } from "./fixtures";
import styles from "./DesignPreview.module.css";

export default function DesignPreview({ embedded = false }: { embedded?: boolean }) {
  const [view, setView] = useState<PreviewView>("entry");
  const [state, setState] = useState<PublicState>(() => createPreviewState("entry"));
  const [revision, setRevision] = useState(0);
  const [adminOpen, setAdminOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const index = previewScenarios.findIndex((scenario) => scenario.key === view);
  const scenario = previewScenarios[index];
  const Shell = embedded ? "section" : "main";

  const navigate = (next: PreviewView) => {
    setView(next); setState(createPreviewState(next)); setRevision((value) => value + 1);
    setAdminOpen(isAdminPreview(next)); setNotice("");
  };

  // Every transport is injected: the tour never claims a session, polls or saves to the DB.
  const persistence: typeof requestJson = async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
    if (path === "/api/profile") {
      const id = String(body?.questionId ?? "");
      const option = body?.option;
      if (!questions.some((question) => question.id === id) || (option !== "A" && option !== "B")) throw new Error("합성 프로필 항목을 확인해주세요.");
      const nextRevision = Number(body?.revision ?? 0) + 1;
      setState((current) => ({ ...current, profile: { ...current.profile!, answers: { ...current.profile?.answers, [id]: option }, revisions: { ...current.profile?.revisions, [id]: nextRevision } } }));
      setNotice("답변을 이 화면에만 반영했어요. 실제 프로필에는 저장하지 않습니다.");
      return { ok: true, revision: nextRevision } as T;
    }
    if (path.startsWith("/api/state?")) return state as T;
    throw new Error("화면 둘러보기에서는 이 요청을 실행하지 않습니다.");
  };

  const send: SendAction = async (path, body) => {
    if (path === "/api/session/claim" || path === "/api/session/operator") {
      const next = createPreviewState("profile");
      const person = previewPeople.find((item) => item.participantId === body?.participantId);
      if (person) next.me = { ...person, isHost: person.participantId === "design-operator-A", profileComplete: false, introsSeen: ["tutorial"] };
      setView("profile"); setState(next); setRevision((value) => value + 1);
      setNotice("프로필 작성 예시로 이동했어요. 실제 등록이나 코드 인증은 실행하지 않았어요.");
    } else if (path === "/api/game/intro-ack") {
      setState((current) => ({ ...current, game: current.game ? { ...current.game, pendingOverlay: undefined,
        guess: current.game.guess?.enabled && (current.game.guess.noiseCount ?? 0) > 0 &&
          current.game.phase === "TURN" && !current.team?.paused && current.game.turnLead?.participantId === current.me?.participantId
          ? { ...current.game.guess, cards: previewGuessCards(current.game) } : current.game.guess } : undefined }));
    } else if (path === "/api/session/release") navigate("names");
    else if (path === "/api/profile/submit") navigate("waiting");
    else if (path === "/api/game/ensemble-shared") navigate("vote");
    else if (path === "/api/game/ensemble-vote") {
      setState((current) => ({ ...current, game: { ...current.game!, ensemble: { ...current.game!.ensemble!, myVote: String(body?.pickId), myRevision: (current.game!.ensemble!.myRevision ?? 0) + 1 } } }));
      setNotice("선택을 표시했어요. ‘다음 화면’을 누르면 합성 투표 결과를 볼 수 있어요.");
    } else if (path === "/api/game/ensemble-end-discussion") navigate("ground-truth");
    else if (path === "/api/game/more-data") navigate(view === "wrong" ? "turn-lead" : "noise");
    else if (path === "/api/game/guess") {
      navigate("wrong"); setNotice("오답일 때의 동작 예시예요. 실제 정답 판정은 하지 않았어요. 정답 공개는 목록에서 바로 볼 수 있어요.");
    } else if (path === "/api/admin") {
      const command = String(body?.command ?? "");
      if (command === "assign-teams") {
        const prepared = createPreviewState("admin").admin!;
        setState((current) => ({ ...current, admin: { ...current.admin!, nextBlockPlan: prepared.teams.map((team) => ({ teamKey: team.key, members: team.members.map((person) => person.displayName) })) }, allowedActions: [...current.allowedActions, "publish-teams", "swap-seats"] }));
      } else if (command === "publish-teams") {
        const prepared = createPreviewState("admin");
        setState((current) => ({ ...current, team: { ...prepared.team!, phase: "SEATING" }, admin: { ...current.admin!, teams: prepared.admin!.teams.map((team) => ({ ...team, phase: "SEATING", stage: null, gameNo: null, paused: false })) }, allowedActions: [...current.allowedActions, "start-game1"] }));
      } else if (command === "start-game1") navigate("admin");
      else if (command === "force-end-game") navigate("reveal");
      else if (command === "end-session") navigate("ended");
      else if (command === "pause" || command === "resume") {
        setState((current) => ({ ...current, admin: { ...current.admin!, teams: current.admin!.teams.map((team) => team.key === body?.teamKey ? { ...team, paused: command === "pause" } : team) } }));
      }
      setNotice("관리자 화면 체험이에요. 실제 참가자·설정·게임 진행은 변경하지 않았어요.");
    } else setNotice("버튼 동작을 확인했어요. 실제 게임은 변경하지 않았어요.");
    return { ok: true, correct: false } satisfies ApiResult;
  };

  const adminTab = view === "admin-people" ? "people" : view === "admin-settings" ? "settings" : view === "admin-logs" ? "logs" : "progress";
  const entryStep = view === "tutorial" ? "tutorial" : view === "names" || view === "operator" ? "names" : "welcome";
  let content;
  if (!state.me) content = <Entry key={`${view}:${revision}`} state={state} send={send} busy={false} initialStep={entryStep} initialOperatorId={view === "operator" ? "design-operator-A" : undefined} />;
  else if (view === "profile") content = <><p className={styles.profileNote}>이 화면 안에서만 선택을 저장해요. 실제 프로필은 만들지 않습니다.</p><Profile key={revision} state={state} slug="design-preview-only" send={send} persistence={persistence} /></>;
  else if (view === "ended") content = <><StatusPanel title="KANT Mingling 완료"><p>오늘 새롭게 알게 된 사람이나 Data 한 가지를 서로 이야기해보세요.</p></StatusPanel>{state.game && <details className="personal-data"><summary>마지막 Game 다시 보기</summary><Reveal game={state.game} /></details>}</>;
  else if (state.team?.notInCurrentGame || !state.game || state.team?.phase === "SEATING") content = <WaitingRoom state={state} />;
  else content = <>
    <GameBoard key={`${view}:${revision}`} state={state} game={state.game} send={send} busy={false} initialGuessOpen={view === "guess"} initialWrongFeedback={view === "wrong"} />
    {state.team?.phase === "BLOCK_DONE" && <BlockDoneNotice state={state} />}
  </>;

  return <div className={embedded ? styles.embedded : undefined}>
    <section className={styles.tools} aria-label="화면 둘러보기">
      <div className={styles.toolsHeading}><div><h1>모든 화면 둘러보기</h1><p>등록부터 게임·자리 이동·관제까지 원하는 장면으로 바로 이동하세요.</p></div><span className={styles.safeBadge}>합성 데이터 · DB 저장 없음</span></div>
      <div className={styles.stepper}>
        <button type="button" className="button secondary small" disabled={index === 0} onClick={() => navigate(previewScenarios[index - 1].key)}>← 이전 화면</button>
        <label className={styles.screenSelect}><span>{index + 1} / {previewScenarios.length} 화면</span><select aria-label="둘러볼 화면 선택" value={view} onChange={(event) => navigate(event.target.value as PreviewView)}>{previewGroups.map((group) => <optgroup key={group} label={group}>{previewScenarios.filter((item) => item.group === group).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</optgroup>)}</select></label>
        <button type="button" className="button primary small" disabled={index === previewScenarios.length - 1} onClick={() => navigate(previewScenarios[index + 1].key)}>다음 화면 →</button>
      </div>
      <p className={styles.description} role="status">{scenario.description}</p>
      <details className={styles.directory}><summary>전체 {previewScenarios.length}개 화면 목록</summary>{previewGroups.map((group) => <nav key={group} aria-label={group}><h2>{group}</h2><div className={styles.views}>{previewScenarios.filter((item) => item.group === group).map((item) => <button type="button" key={item.key} className={styles.viewButton} aria-pressed={view === item.key} onClick={() => navigate(item.key)}>{item.label}</button>)}</div></nav>)}</details>
      <div className={styles.secondaryTools}><button className="text-button small" onClick={() => navigate(view)}>이 장면 다시 보기</button>{view === "profile" && <button className="text-button small" onClick={() => {
        setState((current) => ({ ...current, profile: { ...current.profile!, answers: Object.fromEntries(questions.map((question, questionIndex) => [question.id, questionIndex % 2 === 0 ? "A" : "B"])), revisions: Object.fromEntries(questions.map((question) => [question.id, 1])) } }));
        setRevision((value) => value + 1); setNotice("프로필 20개를 합성 답변으로 채웠어요. 실제 프로필은 저장하지 않습니다.");
      }}>합성 답변 20개 채우기</button>}</div>
      {notice && <div className={styles.notice} role="status">{notice}</div>}
    </section>
    <Shell className="app-shell" aria-label="선택한 화면 예시">
      <header className="app-header"><Brand />{state.me ? <div className="identity"><span>{state.team?.key && <b>{state.team.key}</b>}{state.me.displayName}</span>{state.admin && <button className="admin-trigger" onClick={() => setAdminOpen(true)}>관리자</button>}</div> : <span className="header-caption">Whose Data?</span>}</header>
      {state.me && state.event.currentBlock > 0 && view !== "ended" && <nav className="game-context" aria-label="행사 진행 예시"><span>함께 알아가는 시간</span><ol>{[1, 2, 3].map((block) => <li key={block} aria-current={block === state.event.currentBlock ? "step" : undefined}><span>{block}</span><span>블록</span></li>)}</ol></nav>}
      <div className="page-content">{content}</div>
      <footer className="app-footer">서로의 Data가, 새로운 대화가 되도록.</footer>
    </Shell>
    {adminOpen && state.admin && <AdminPanel key={`${view}:${revision}`} state={state} send={send} busy={false} onClose={() => setAdminOpen(false)} initialTab={adminTab} commandFeedback="화면 체험 완료 · 실제 DB에 저장하거나 게임을 변경하지 않았어요." />}
    <aside className={styles.watermark}>화면 둘러보기 · 합성 데이터 · 실제 게임은 ‘실제 게임’에서 진행</aside>
  </div>;
}
