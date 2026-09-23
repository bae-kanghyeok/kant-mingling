"use client";

import { useEffect, useState } from "react";
import type { CardQuestion, PublicGame, PublicState } from "@/lib/contracts";
import type { SendAction } from "../useMingleState";
import { SectionTitle, StatusPanel } from "../ui/Modal";
import { GuessModal, RuleOverlay } from "./GameOverlays";
import { Rtan } from "../ui/Brand";

const number = (value: number) => String(value).padStart(2, "0");

function CardContent({ question, text, answerLabel = "선택한 답변" }: { question?: CardQuestion; text: string; answerLabel?: string }) {
  return <div className="card-content">
    {question && <div className="card-question"><p className="card-question-label">질문 · {question.category}</p><p className="card-question-options"><span>{question.options.A}</span><span className="card-question-vs">vs</span><span>{question.options.B}</span></p></div>}
    <p className="card-answer"><span className="card-answer-label">{answerLabel}</span>{text}</p>
  </div>;
}

export function Reveal({ game }: { game: PublicGame }) {
  if (!game.reveal) return null;
  return <section className="reveal">
    <header className="reveal-header"><p className="eyebrow">{game.reveal.endReason === "correct" ? "Data Owner Found!" : "Data Owner 공개"}</p><div className="owner-avatar" aria-hidden="true"><Rtan size={80} /></div><h2>이번 Data Owner는<br /><em>{game.reveal.owner.displayName}</em>님이었습니다!</h2>{game.reveal.endReason !== "correct" && <p className="muted">{game.reveal.endReason === "session_end" ? "행사를 마치며 정답을 공개했어요." : "GM이 이번 판을 마치고 정답을 공개했어요."}</p>}</header>
    <div className="behind-card"><p className="eyebrow">Behind the Data</p><p>{game.reveal.behind.choiceText}</p><h3>{game.reveal.behind.followUp}</h3></div>
    <details className="reveal-data" open><summary>함께 모은 Data · {game.reveal.cards.length}</summary><div className="data-list">{game.reveal.cards.map((card) => <article key={card.cardNo} className={`data-card compact ${card.status === "NOISE" ? "noise-revealed" : ""}`}>
      <div className="card-meta"><span>Data {number(card.cardNo)}</span><span className="badge">{card.status === "GROUND_TRUTH" ? "Ground Truth" : card.status === "NOISE" ? "Noise" : "Real"}</span></div><CardContent question={card.question} text={card.text} answerLabel={card.status === "NOISE" ? "공개됐던 답변 (Noise)" : "선택한 답변"} />{card.ownerActualText && <p className="actual-answer">실제 답 · {card.ownerActualText}</p>}
    </article>)}</div></details>
  </section>;
}

function Ensemble({ state, game, send, busy }: { state: PublicState; game: PublicGame; send: SendAction; busy: boolean }) {
  const ensemble = game.ensemble;
  const deadline = ensemble?.voteDeadline;
  const [remainingSeconds, setRemainingSeconds] = useState(() => deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - Date.parse(state.serverNow)) / 1000)) : 30);
  useEffect(() => {
    if (!deadline || state.team?.paused) return;
    const serverTime = Date.parse(state.serverNow);
    const receivedAt = performance.now();
    const timer = setInterval(() => setRemainingSeconds(Math.max(0, Math.ceil((Date.parse(deadline) - serverTime - (performance.now() - receivedAt)) / 1000))), 250);
    return () => clearInterval(timer);
  }, [deadline, state.serverNow, state.team?.paused]);
  if (!ensemble) return null;
  const gmMode = state.event.gameplayMode === "gm";
  const isSharer = ensemble.sharer.participantId === state.me?.participantId;
  const command = (path: string, extra = {}) => void send(`/api/game/${path}`, { gameId: game.gameId, gameVersion: state.versions.game, ...extra }).catch(() => {});
  if (ensemble.stage === "SHARE") return <section className="panel ensemble-panel"><p className="eyebrow">Ensemble</p><h2>{isSharer ? `Data ${number(ensemble.triggerCardNo)} 내용을 팀에 공유해주세요.` : `${ensemble.sharer.displayName}님이 Data ${number(ensemble.triggerCardNo)}를 공유하고 있어요.`}</h2><p className="muted">{gmMode ? "단서를 함께 읽고 이야기해보세요. GM이 투표를 열어줘요." : isSharer ? "공유했으면 아래 버튼을 눌러주세요." : "곧 Ensemble이 시작됩니다."}</p>{!gmMode && state.allowedActions.includes("ensemble-shared") && <button className="button primary full" disabled={busy || state.team?.paused} onClick={() => command("ensemble-shared")}>{isSharer ? "공유했어요" : "공유 확인 · 투표 시작"}</button>}</section>;
  if (ensemble.stage === "VOTE") {
    const remaining = state.team?.paused && ensemble.voteRemainingMs !== undefined
      ? Math.max(0, Math.ceil(ensemble.voteRemainingMs / 1000))
      : remainingSeconds;
    return <section className="panel ensemble-panel"><div className="inline-between"><p className="eyebrow">Ensemble</p><span className="countdown" aria-label={`투표 남은 시간 ${remaining}초`}>{remaining}<small>초</small></span></div><h2>상의하지 말고 지금 가장 의심되는 Data Owner 한 명을 선택해주세요.</h2><p className="muted">30초 안에 선택해주세요.</p><div className="choice-grid">{game.candidates.map((candidate) => <button key={candidate.participantId} className={`choice-button ${ensemble.myVote === candidate.participantId ? "selected" : ""}`} aria-pressed={ensemble.myVote === candidate.participantId} disabled={busy || state.team?.paused || remaining === 0 || !state.allowedActions.includes("ensemble-vote")} onClick={() => command("ensemble-vote", { pickId: candidate.participantId, revision: ensemble.myRevision ?? 0 })}>{candidate.displayName}</button>)}</div>{ensemble.myVote && <p className="small saved">선택했어요. 마감 전까지 바꿀 수 있어요.</p>}</section>;
  }
  const max = Math.max(1, ...(ensemble.results ?? []).map((result) => result.votes));
  return <section className="panel ensemble-panel"><p className="eyebrow">Ensemble 결과</p><h2>생각이 얼마나 같았을까요?</h2><p className="muted">정답 여부는 아직 공개되지 않습니다. 왜 그렇게 생각했는지 이야기해보세요.</p><div className="vote-results">{ensemble.results?.map((result) => <div className="vote-row" key={result.participantId}><span>{result.displayName}</span><div className="vote-track"><span style={{ width: `${result.votes / max * 100}%` }} /></div><strong>{result.votes}</strong></div>)}</div>{!gmMode && state.allowedActions.includes("ensemble-end-discussion") && <button className="button primary full" disabled={busy || state.team?.paused} onClick={() => command("ensemble-end-discussion")}>토론 마침</button>}</section>;
}

export function GameBoard({ state, game, send, busy, initialGuessOpen = false, initialWrongFeedback = false }: {
  state: PublicState; game: PublicGame; send: SendAction; busy: boolean;
  initialGuessOpen?: boolean; initialWrongFeedback?: boolean;
}) {
  const [guessOpen, setGuessOpen] = useState(initialGuessOpen);
  const [wrongAt, setWrongAt] = useState<number | null>(initialWrongFeedback ? game.cards.length : null);
  const isLead = game.turnLead?.participantId === state.me?.participantId;
  const gmMode = state.event.gameplayMode === "gm";
  const wrong = wrongAt === game.cards.length || !!game.guess?.locked;
  const latest = game.cards.at(-1);
  const ownCards = game.cards.filter((card) => card.text !== undefined);
  const more = () => void send("/api/game/more-data", { gameId: game.gameId, gameVersion: state.versions.game, expectedCardCount: game.cards.length }).catch(() => {});
  if (game.reveal) return <Reveal game={game} />;
  return <>
    <SectionTitle label={`Whose Data? · ${state.team?.key ?? ""}조`} title={`Game ${game.gameNo}${game.cards.length === 1 ? " 시작" : ""}`} description={gmMode ? "여러분은 어느 쪽인가요? 선택과 이유를 함께 나눠보세요." : "우리 조의 Data Owner를 찾아보세요."} />
    <div className="game-strip"><span>Data <strong>{number(game.cards.length)}</strong></span><span>{gmMode ? "이번 추리 담당" : "이번 Turn Lead"}: <strong>{game.turnLead?.displayName ?? "—"}</strong></span></div>
    {state.team?.paused && <div className="notice" role="status">운영진이 잠시 멈췄어요. 곧 이어서 진행합니다.</div>}
    {latest && <article className={`data-card latest-card ${latest.text === undefined ? "sealed" : ""}`}>
      <div className="card-meta"><span>Data {number(latest.cardNo)}</span>{latest.verified && <span className="badge verified">Verified</span>}<span aria-hidden="true">✳</span></div>
      {latest.text !== undefined ? <><h2>Data {number(latest.cardNo)}이 도착했습니다</h2><CardContent question={latest.question} text={latest.text} /><p className="small">{latest.recipients.length === 1 ? "이 Data는 지금 당신에게만 보입니다. 팀원에게 직접 알려주세요." : "Data를 서로 공유하고 충분히 이야기한 뒤 결정해보세요."}</p></> : <><div className="sealed-mark" aria-hidden="true">↗</div><h2>Data {number(latest.cardNo)}이 {latest.recipients.map((recipient) => recipient.displayName).join(", ")}님에게 전달되었습니다</h2><p>{latest.recipients.map((recipient) => recipient.displayName).join(", ")}님에게 어떤 Data인지 물어보세요.</p></>}
    </article>}
    {game.ensemble && <Ensemble key={`${game.gameId}:${game.ensemble.stage}`} state={state} game={game} send={send} busy={busy} />}
    {gmMode && game.phase === "TURN" && !game.gm?.guessOpen && <div className="notice conversation-notice" role="status"><strong>지금은 함께 이야기하는 시간이에요.</strong><p>어느 쪽을 골랐나요? 같은 선택·다른 선택의 이유를 들어보세요. 준비되면 GM이 다음 단서나 추리를 열어줘요.</p></div>}
    {game.phase === "TURN" && isLead && <section className="turn-actions"><p className="eyebrow">{gmMode ? "이번 추리 담당은 당신입니다." : "이번 Turn Lead는 당신입니다."}</p><p className="muted">{gmMode ? game.gm?.guessOpen ? "GM이 추리를 열었어요. 팀원들과 상의한 답을 제출해주세요." : "팀원들과 이야기하며 추리를 준비해주세요." : "팀원들과 이야기한 뒤 다음 행동을 선택해주세요."}</p>
      {wrong && <div className="notice error-tone"><strong>아직 정답이 아니에요</strong>{!game.exhausted && <p>{gmMode ? "GM이 새로운 단서를 전하면 다시 이야기하고 추리해보세요." : "새로운 Data를 확인한 뒤 다시 추리해보세요."}</p>}</div>}
      {game.exhausted && <p className="notice">모든 Data가 공개되었습니다.</p>}
      <div className="action-grid">{!gmMode && !game.exhausted && <button className="button secondary" disabled={busy || !state.allowedActions.includes("more-data") || state.team?.paused} onClick={more}>{wrong ? "다음 Data 보기" : "Data 하나 더 보기"}</button>}<button className="button primary" disabled={busy || !game.guess?.enabled || !state.allowedActions.includes("guess") || state.team?.paused} onClick={() => setGuessOpen(true)}>{gmMode && !game.gm?.guessOpen ? "GM이 추리를 열어줄 거예요" : "추리하기"}</button></div>
      {!gmMode && !game.guess?.enabled && !game.guess?.locked && game.gameNo > 1 && game.cards.length < 3 && <p className="small muted center">Data가 3개 공개되면 추리할 수 있어요.</p>}
    </section>}
    {ownCards.length > 0 && <details className="personal-data"><summary>내가 받은 Data 다시 보기 <span>{ownCards.length}</span></summary><div className="data-list">{ownCards.map((card) => <article className="data-card compact" key={card.cardNo}><div className="card-meta">Data {number(card.cardNo)}{card.verified && <span className="badge verified">Verified</span>}</div><CardContent question={card.question} text={card.text!} /></article>)}</div></details>}
    {game.cards.length > 1 && <details className="personal-data"><summary>누가 Data를 받았나요?</summary><div className="data-list">{game.cards.map((card) => <p className="small inline-between" key={card.cardNo}><span>Data {number(card.cardNo)}{card.verified ? " · Verified" : ""}</span><span>{card.recipients.map((recipient) => recipient.displayName).join(", ")}</span></p>)}</div></details>}
    {guessOpen && isLead && game.guess?.enabled && game.phase === "TURN" && !game.pendingOverlay && <GuessModal state={state} game={game} send={send} busy={busy} onClose={() => setGuessOpen(false)} onWrong={() => setWrongAt(game.cards.length)} />}
    <RuleOverlay game={game} groundTruthIntroSeen={state.me?.introsSeen.includes("ground_truth") ?? false} send={send} busy={busy} />
  </>;
}

export function WaitingRoom({ state }: { state: PublicState }) {
  if (state.team?.notInCurrentGame) return <StatusPanel title="다음 Game부터 함께해요."><p className="muted">지금 진행 중인 대화를 함께 들어주세요.</p></StatusPanel>;
  const singleTeam = state.event.teamCount === 1;
  return <><SectionTitle label="Your team" title={state.nextBlock ? singleTeam ? "같은 조에서 다음 대화를 시작해요." : "새로운 사람들과 만나볼 시간입니다. 새 조를 확인해주세요." : "오늘의 Mingle 조"} description="함께 추리할 사람들을 확인해보세요." />
    <div className="team-ticket"><div className="team-letter">{state.nextBlock?.teamKey ?? state.team?.key ?? "?"}<span>Team</span></div><div><h2>{state.nextBlock ? `${state.nextBlock.seatNo}번 자리` : "함께할 사람들"}</h2><p>{state.nextBlock?.members.join(" · ") ?? state.team?.members.map((person) => person.displayName).join(" · ") ?? "조를 준비하고 있어요."}</p></div></div>
    <p className="notice">{state.team?.phase === "SEATING" ? singleTeam ? "자리 이동 없이 함께 준비해주세요. 호스트가 Game을 시작해요." : "새 자리에 앉으면 운영진이 Game을 시작해요." : "잠시 후 Game이 시작됩니다."}</p>
  </>;
}

export function BlockDoneNotice({ state }: { state: PublicState }) {
  const singleTeam = state.event.teamCount === 1;
  if (state.event.gameplayMode === "gm") return <div className="notice center" role="status"><strong>{state.team?.waitingForOthers ? "다른 조가 대화를 마치기를 기다리고 있어요." : singleTeam ? "다음 자리 회차를 준비하고 있어요." : "다음 조 안내를 기다려주세요."}</strong><p className="small muted">{singleTeam ? "같은 자리에 머물며 이야기를 이어가세요. GM이 다음 시작을 안내해요." : "총괄 GM이 새 조를 공개하면 이동할 자리를 안내할게요. 그동안 이야기를 이어가세요."}</p></div>;
  const waitingForOthers = state.team?.waitingForOthers;
  const finalBlockComplete = state.event.currentBlock === 3 && state.event.phase === "BLOCK" && !waitingForOthers;
  const title = waitingForOthers
    ? "다른 조의 Game이 끝나기를 기다리고 있어요."
    : finalBlockComplete
      ? singleTeam ? "모든 Game이 끝났어요. 마지막 대화를 나눠보세요." : "모든 조의 Game이 끝났어요. 마지막 대화를 나눠보세요."
      : singleTeam ? "이번 블록을 마쳤어요. 같은 조에서 다음 블록을 기다려주세요." : "새로운 사람들과 만나볼 시간입니다. 다음 조 안내를 기다려주세요.";
  const description = waitingForOthers
    ? "함께 발견한 Data로 이야기를 이어가세요."
    : finalBlockComplete
      ? "호스트가 전체 행사를 종료할 때까지 함께 발견한 Data로 이야기를 이어가세요."
      : singleTeam ? "자리를 옮기지 않아도 돼요. 호스트가 다음 블록을 시작할 때까지 이야기를 이어가세요." : "호스트가 새 조를 공개하면 이동할 자리를 안내할게요. 그동안 이야기를 이어가세요.";
  return <div className="notice center" role="status"><strong>{title}</strong><p className="small muted">{description}</p></div>;
}
