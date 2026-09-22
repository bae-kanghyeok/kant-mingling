"use client";

import { useState } from "react";
import type { PublicState } from "@/lib/contracts";
import { AdminPanel } from "./admin/AdminPanel";
import { Entry } from "./player/Entry";
import { GameBoard, Reveal, WaitingRoom } from "./player/GameBoard";
import { Profile } from "./player/Profile";
import { StatusPanel } from "./ui/Modal";
import { useMingleState } from "./useMingleState";

function BlockDoneNotice({ state }: { state: PublicState }) {
  const waitingForOthers = state.team?.waitingForOthers;
  const finalBlockComplete = state.event.currentBlock === 3 && state.event.phase === "BLOCK" && !waitingForOthers;
  const title = waitingForOthers
    ? "다른 조의 Game이 끝나기를 기다리고 있어요."
    : finalBlockComplete
      ? "모든 조의 Game이 끝났어요. 마지막 대화를 나눠보세요."
      : "새로운 사람들과 만나볼 시간입니다. 다음 조 안내를 기다려주세요.";
  const description = waitingForOthers
    ? "함께 발견한 Data로 이야기를 이어가세요."
    : finalBlockComplete
      ? "호스트가 전체 행사를 종료할 때까지 함께 발견한 Data로 이야기를 이어가세요."
      : "호스트가 새 조를 공개하면 이동할 자리를 안내할게요. 그동안 이야기를 이어가세요.";
  return <div className="notice center" role="status"><strong>{title}</strong><p className="small muted">{description}</p></div>;
}

export default function MingleApp({ slug }: { slug: string }) {
  const { state, error, terminal, disconnected, busy, send, refresh, clearError } = useMingleState(slug);
  const [adminOpen, setAdminOpen] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const ended = state?.event.phase === "ENDED" || terminal === 410;
  const control = (command: string) => state && void send("/api/admin", { command, teamKey: state.team?.key, expectedVersion: state.versions.team, args: {} }).catch(() => {});
  let content;
  if (ended) content = <><StatusPanel title="KANT Mingling 완료"><p>오늘 새롭게 알게 된 사람이나 Data 한 가지를 서로 이야기해보세요.</p></StatusPanel>{(state?.game?.reveal || state?.lastReveal?.reveal) && <details className="personal-data"><summary>마지막 Game 다시 보기</summary><Reveal game={(state.game?.reveal ? state.game : state.lastReveal)!} /></details>}</>;
  else if (terminal === 404) content = <StatusPanel title="행사 링크를 확인해주세요"><p className="muted">진행자가 안내한 QR로 다시 접속해주세요.</p></StatusPanel>;
  else if (!state) content = <StatusPanel title="Mingling에 연결하고 있어요"><div className="loading-dots" aria-hidden="true"><i /><i /><i /></div><p className="muted">잠시만 기다려주세요.</p></StatusPanel>;
  else if (!state.me) content = <Entry state={state} send={send} busy={busy} />;
  else if (!state.me.profileComplete || (editProfile && state.profile?.editable)) content = <Profile key={state.me.participantId} state={state} slug={slug} send={send} onDone={() => setEditProfile(false)} />;
  else if (state.team?.notInCurrentGame) content = <WaitingRoom state={state} />;
  else if (state.game && state.team?.phase !== "SEATING") content = <>
    <GameBoard key={state.game.gameId} state={state} game={state.game} send={send} busy={busy} />
    {state.team?.phase === "BLOCK_DONE" && <BlockDoneNotice state={state} />}
    {state.allowedActions.includes("next-game") && state.team?.phase === "REVEAL" && <button className="button primary full" disabled={busy} onClick={() => control("next-game")}>다음 Game 시작 <span aria-hidden="true">→</span></button>}
  </>;
  else content = <><WaitingRoom state={state} />{state.allowedActions.includes("start-block-game") && <button className="button primary full" disabled={busy} onClick={() => control("start-block-game")}>Game 시작</button>}{state.profile?.editable && <button className="text-button" onClick={() => setEditProfile(true)}>내 프로필 수정</button>}{state.lastReveal?.reveal && <details className="personal-data"><summary>지난 Game 다시 보기</summary><Reveal game={state.lastReveal} /></details>}</>;

  return <main className="app-shell">
    <header className="app-header"><div className="brand">KANT<span>Mingling</span><i aria-hidden="true">✳</i></div>{state?.me ? <div className="identity"><span>{state.team?.key && <b>{state.team.key}</b>}{state.me.displayName}</span>{state.admin && !ended && <button className="admin-trigger" onClick={() => setAdminOpen(true)}>관리자</button>}</div> : <span className="header-caption">Whose Data?</span>}</header>
    {disconnected && !ended && !terminal && <div className="connection-warning" role="status"><span>연결을 다시 확인하고 있어요. 화면은 곧 최신 상태로 맞춰져요.</span><button onClick={() => void refresh().catch(() => {})}>다시 연결</button></div>}
    {error && <div className="error-message app-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="오류 안내 닫기" onClick={clearError}>×</button></div>}
    <div className="page-content">{content}</div>
    <footer className="app-footer">서로의 Data가, 새로운 대화가 되도록.</footer>
    {adminOpen && state?.admin && !ended && <AdminPanel state={state} send={send} busy={busy} onClose={() => setAdminOpen(false)} />}
  </main>;
}
