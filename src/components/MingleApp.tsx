"use client";

import { useState } from "react";
import { AdminPanel } from "./admin/AdminPanel";
import { Entry, Tutorial } from "./player/Entry";
import { BlockDoneNotice, GameBoard, Reveal, WaitingRoom } from "./player/GameBoard";
import { Profile } from "./player/Profile";
import { Modal, StatusPanel } from "./ui/Modal";
import { Brand } from "./ui/Brand";
import { useMingleState } from "./useMingleState";

export default function MingleApp({ slug }: { slug: string }) {
  const { state, error, terminal, disconnected, busy, send, refresh, clearError } = useMingleState(slug);
  const [adminOpen, setAdminOpen] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const ended = state?.event.phase === "ENDED" || terminal === 410;
  const gmMode = state?.event.gameplayMode === "gm";
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
    {!gmMode && state.allowedActions.includes("next-game") && state.team?.phase === "REVEAL" && <button className="button primary full" disabled={busy} onClick={() => control("next-game")}>다음 Game 시작 <span aria-hidden="true">→</span></button>}
    {gmMode && state.admin && state.team?.phase === "REVEAL" && <button className="button primary full" onClick={() => setAdminOpen(true)}>GM 리모컨 · 다음 진행</button>}
  </>;
  else content = <><WaitingRoom state={state} />{state.allowedActions.includes("start-block-game") && <button className="button primary full" disabled={busy} onClick={() => gmMode ? setAdminOpen(true) : control("start-block-game")}>{gmMode ? "GM 리모컨 · 판 준비" : "Game 시작"}</button>}{state.profile?.editable && <button className="text-button" onClick={() => setEditProfile(true)}>내 프로필 수정</button>}{state.lastReveal?.reveal && <details className="personal-data"><summary>지난 Game 다시 보기</summary><Reveal game={state.lastReveal} /></details>}</>;

  return <main className="app-shell">
    <header className="app-header"><Brand />{state?.me ? <div className="identity"><span>{state.team?.key && <b>{state.team.key}</b>}{state.me.displayName}</span>{state.admin && !ended && <button className="admin-trigger" onClick={() => setAdminOpen(true)}>{gmMode ? "GM 리모컨" : "관리자"}</button>}</div> : <span className="header-caption">Whose Data?</span>}</header>
    {state?.me && state.event.currentBlock > 0 && !ended && <nav className="game-context" aria-label="행사 진행"><span>함께 알아가는 시간</span>{gmMode ? <strong>{state.event.currentBlock}번째 자리 · {state.event.rotationRequested ? "조 이동 준비 중" : "우리 조 속도로 진행해요"}</strong> : <ol>{[1, 2, 3].map(block => <li key={block} aria-current={block === state.event.currentBlock ? "step" : undefined}><span>{block}</span><span>블록</span></li>)}</ol>}</nav>}
    {disconnected && !ended && !terminal && <div className="connection-warning" role="status"><span>연결을 다시 확인하고 있어요. 화면은 곧 최신 상태로 맞춰져요.</span><button onClick={() => void refresh().catch(() => {})}>다시 연결</button></div>}
    {error && <div className="error-message app-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="오류 안내 닫기" onClick={clearError}>×</button></div>}
    <div className="page-content">{content}</div>
    <footer className="app-footer">{state?.me && <button className="text-button small" onClick={() => setTutorialOpen(true)}>게임 방법 다시 보기</button>}<p>서로의 Data가, 새로운 대화가 되도록.</p></footer>
    {tutorialOpen && <Modal title="게임 방법 다시 보기" onClose={() => setTutorialOpen(false)}><Tutorial gmMode={gmMode} doneLabel="게임으로 돌아가기" onDone={() => setTutorialOpen(false)} /></Modal>}
    {adminOpen && state?.admin && !ended && <AdminPanel state={state} send={send} busy={busy} onClose={() => setAdminOpen(false)} />}
  </main>;
}
