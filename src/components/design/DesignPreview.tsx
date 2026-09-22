"use client";

import { useState } from "react";
import type { PublicState } from "@/lib/contracts";
import { questions } from "@/content/catalog";
import { AdminPanel } from "../admin/AdminPanel";
import { Entry } from "../player/Entry";
import { GameBoard, Reveal } from "../player/GameBoard";
import { Profile } from "../player/Profile";
import { Brand } from "../ui/Brand";
import type { ApiResult, requestJson, SendAction } from "../useMingleState";
import { createPreviewState, previewPeople, previewViews, type PreviewView } from "./fixtures";
import styles from "./DesignPreview.module.css";

export default function DesignPreview() {
  const [view, setView] = useState<PreviewView>("entry");
  const [state, setState] = useState<PublicState>(() => createPreviewState("entry"));
  const [revision, setRevision] = useState(0);
  const [adminOpen, setAdminOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const navigate = (next: PreviewView) => {
    setView(next); setState(createPreviewState(next)); setRevision((value) => value + 1);
    setAdminOpen(next === "admin"); setNotice("");
  };

  // Profile's default transport remains unchanged in the real event. This route injects memory-only persistence.
  const persistence: typeof requestJson = async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
    if (path === "/api/profile") {
      const id = String(body?.questionId ?? "");
      const option = body?.option;
      if (!questions.some((question) => question.id === id) || (option !== "A" && option !== "B")) throw new Error("합성 프로필 항목을 확인해주세요.");
      const nextRevision = Number(body?.revision ?? 0) + 1;
      setState((current) => ({ ...current, profile: { ...current.profile!, answers: { ...current.profile?.answers, [id]: option }, revisions: { ...current.profile?.revisions, [id]: nextRevision } } }));
      setNotice("합성 답변을 이 화면의 메모리에만 반영했어요. 서버에는 저장하지 않습니다.");
      return { ok: true, revision: nextRevision } as T;
    }
    if (path.startsWith("/api/state?")) return state as T;
    throw new Error("디자인 미리보기에서는 이 요청을 실행하지 않습니다.");
  };

  const send: SendAction = async (path, body) => {
    if (path === "/api/session/claim" || path === "/api/session/operator") {
      const next = createPreviewState("profile");
      const person = previewPeople.find((item) => item.participantId === body?.participantId);
      if (person) next.me = { ...person, isHost: person.participantId === "design-operator-A", profileComplete: false, introsSeen: ["tutorial"] };
      setView("profile"); setState(next); setRevision((value) => value + 1);
      setNotice("합성 참가자 화면으로 이동했어요. 실제 등록이나 코드 인증은 실행하지 않습니다.");
    } else if (path === "/api/game/intro-ack") {
      setState((current) => ({ ...current, game: current.game ? { ...current.game, pendingOverlay: undefined } : undefined }));
    } else if (path === "/api/session/release") {
      navigate("entry");
    } else if (path === "/api/profile/submit") {
      navigate("received"); setNotice("등록 완료 뒤 화면을 보여주는 예시예요. 실제 참가 등록은 하지 않았어요.");
    } else if (path === "/api/game/ensemble-vote") {
      setState((current) => ({ ...current, game: { ...current.game!, ensemble: { ...current.game!.ensemble!, myVote: String(body?.pickId), myRevision: (current.game!.ensemble!.myRevision ?? 0) + 1 } } }));
      setNotice("선택 표시만 변경했어요. 실제 투표나 집계는 실행하지 않습니다.");
    } else if (path === "/api/game/ensemble-end-discussion") {
      navigate("received");
    } else if (path === "/api/admin") {
      const command = String(body?.command ?? "");
      if (command === "pause" || command === "resume") {
        setState((current) => ({ ...current, admin: { ...current.admin!, teams: current.admin!.teams.map((team) => team.key === body?.teamKey ? { ...team, paused: command === "pause" } : team) } }));
      }
      setNotice(`디자인 데모: ${command} 버튼 동작을 확인했어요. 실제 운영 명령은 전송하지 않습니다.`);
    } else {
      setNotice(`디자인 데모: ${path.split("/").at(-1)} 버튼 동작을 확인했어요. 게임 규칙은 계산하지 않습니다.`);
    }
    return { ok: true, correct: false } satisfies ApiResult;
  };

  return <>
    <section className={styles.tools} aria-label="디자인 미리보기 화면 선택">
      <h1>디자인 미리보기</h1><p>합성 데이터로 실제 UI 컴포넌트를 확인합니다. 게임 엔진·API·DB에는 연결하지 않습니다.</p>
      <nav className={styles.views} aria-label="미리보기 화면">{previewViews.map(([key, label]) => <button type="button" key={key} className={styles.viewButton} aria-pressed={view === key} onClick={() => navigate(key)}>{label}</button>)}</nav>
      <div className={styles.secondaryTools}><button className="text-button small" onClick={() => navigate(view)}>현재 화면 초기화</button>{view === "profile" && <button className="text-button small" onClick={() => {
        setState((current) => ({ ...current, profile: { ...current.profile!, answers: Object.fromEntries(questions.map((question, index) => [question.id, index % 2 === 0 ? "A" : "B"])), revisions: Object.fromEntries(questions.map((question) => [question.id, 1])) } }));
        setRevision((value) => value + 1); setNotice("프로필 20개를 합성 답변으로 채웠어요. 서버에 저장하지 않습니다.");
      }}>합성 답변 20개 채우기</button>}</div>
      {notice && <div className={styles.notice} role="status">{notice}</div>}
    </section>
    <main className="app-shell">
      <header className="app-header"><Brand />{state.me ? <div className="identity"><span>{state.team?.key && <b>{state.team.key}</b>}{state.me.displayName}</span>{state.admin && <button className="admin-trigger" onClick={() => setAdminOpen(true)}>관리자</button>}</div> : <span className="header-caption">Whose Data?</span>}</header>
      {state.me && state.event.currentBlock > 0 && <nav className="game-context" aria-label="행사 진행 예시"><span>함께 알아가는 시간</span><ol>{[1, 2, 3].map((block) => <li key={block} aria-current={block === state.event.currentBlock ? "step" : undefined}><span>{block}</span><span>블록</span></li>)}</ol></nav>}
      <div className="page-content">
        {view === "entry" ? <Entry key={revision} state={state} send={send} busy={false} />
          : view === "profile" ? <><p className={styles.profileNote}>선택은 이 미리보기에서만 유지돼요. 실제 프로필은 만들지 않습니다.</p><Profile key={revision} state={state} slug="design-preview-only" send={send} persistence={persistence} /></>
            : view === "reveal" && state.game ? <Reveal game={state.game} />
              : state.game ? <GameBoard key={`${view}:${revision}`} state={state} game={state.game} send={send} busy={false} /> : null}
      </div>
      <footer className="app-footer">서로의 Data가, 새로운 대화가 되도록.</footer>
    </main>
    {adminOpen && state.admin && <AdminPanel state={state} send={send} busy={false} onClose={() => setAdminOpen(false)} />}
    <aside className={styles.watermark}>디자인 미리보기 · 합성 데이터 · DB 미연결</aside>
  </>;
}
