"use client";

import { useState } from "react";
import type { PublicGame, PublicState } from "@/lib/contracts";
import type { SendAction } from "../useMingleState";
import { Modal } from "../ui/Modal";

const dataNumber = (number: number) => String(number).padStart(2, "0");

export function RuleOverlay({ game, groundTruthIntroSeen, send, busy }: { game: PublicGame; groundTruthIntroSeen: boolean; send: SendAction; busy: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const overlay = game.pendingOverlay;
  if (!overlay) return null;
  const acknowledge = () => { setError(null); void send("/api/game/intro-ack", {
    introKey: overlay.kind, gameId: game.gameId, ...(overlay.cardNo ? { cardNo: overlay.cardNo } : {}),
  }).catch((failure) => setError(failure instanceof Error ? failure.message : "잠시 후 다시 시도해주세요.")); };
  const errorNotice = error && <p role="alert" className="error-message">{error}</p>;
  if (overlay.kind === "noise") return <Modal title="잠깐, Noise가 숨어 있습니다">
    <div className="rule-symbol" aria-hidden="true">≠</div><h3>지금까지 본 Data가 전부 진짜는 아닙니다.</h3>
    <p>{game.gm ? "Noise 확인! 어떤 단서가 Noise일까요? 지금까지의 선택과 이유를 함께 이야기해보세요." : `현재 공개된 Data ${overlay.cardCount ?? game.cards.length}개 중 Noise ${overlay.noiseCount ?? 1}개가 숨어 있습니다.`}</p>
    <p className="muted">Data Owner와 함께 어떤 Data가 Noise인지도 찾아보세요.</p>
    {errorNotice}<button className="button primary full" disabled={busy} onClick={acknowledge}>{game.gm ? "확인했어요" : "추리 시작하기"}</button>
  </Modal>;
  if (overlay.kind === "ensemble") return <Modal title="잠깐, Ensemble이 시작됩니다">
    <div className="rule-symbol" aria-hidden="true">⋈</div><h3>이번에는 이야기하기 전에 각자 먼저 생각해볼 시간입니다.</h3>
    <p>상의하지 말고 지금 가장 의심되는 Data Owner 한 명을 선택해주세요.</p>
    <p className="muted">30초 안에 선택해주세요.</p>{errorNotice}<button className="button primary full" disabled={busy} onClick={acknowledge}>확인했어요</button>
  </Modal>;
  const cardNo = dataNumber(overlay.cardNo ?? game.groundTruth?.cardNo ?? 1);
  return <Modal title="한 가지는 확실해졌습니다"><p className="eyebrow">Ground Truth</p><div className="verified-banner">Data {cardNo} / Verified</div>
    {groundTruthIntroSeen ? <h3>이번 Game의 Data {cardNo}이 확인되었습니다.</h3> : <><h3>Data {cardNo}은 실제 Data입니다. Noise가 아닙니다.</h3><p className="muted">그렇다면 Noise는 어디에 있을까요? 지금까지의 추리를 다시 확인해보세요.</p></>}
    {errorNotice}<button className="button primary full" disabled={busy} onClick={acknowledge}>추리 계속하기</button></Modal>;
}

export function GuessModal({ state, game, send, busy, onClose, onWrong }: {
  state: PublicState; game: PublicGame; send: SendAction; busy: boolean; onClose: () => void; onWrong: () => void;
}) {
  const [ownerPick, setOwnerPick] = useState("");
  const [noisePicks, setNoisePicks] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const k = game.guess?.noiseCount ?? 0;
  const reviewCards = new Map(game.guess?.cards?.map((card) => [card.cardNo, card]));
  const noiseChoices = game.cards.map((card) => ({ ...card, ...reviewCards.get(card.cardNo) }));
  const submit = async () => {
    setError(null);
    try {
      const result = await send("/api/game/guess", { gameId: game.gameId, gameVersion: state.versions.game, ownerPick, noisePicks });
      if (!(result.correct ?? result.data?.correct)) onWrong();
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "잠시 후 다시 시도해주세요."); }
  };
  return <Modal title="누가 Data Owner일까요?" onClose={onClose}>
    <p className="muted">팀원들과 상의한 뒤 한 명을 선택해주세요.</p>
    <div className="choice-grid" role="radiogroup" aria-label="Data Owner 선택">{game.candidates.map((candidate) => <button key={candidate.participantId} role="radio" aria-checked={ownerPick === candidate.participantId} className={`choice-button ${ownerPick === candidate.participantId ? "selected" : ""}`} onClick={() => setOwnerPick(candidate.participantId)}>{candidate.displayName}</button>)}</div>
    {game.guess?.noiseCount !== undefined && <section className="noise-picker"><p className="pill">현재 Data {game.cards.length}개 / 이 중 Noise {k}개</p>{k > 0 && <>
      <h3>어떤 Data가 Noise라고 생각하나요?</h3>
      <p className="small muted">지금까지 우리 조에 전달된 질문과 답변을 다시 읽고, Noise로 의심되는 Data를 골라주세요.</p>
      <div className="noise-choice-list" role="group" aria-label="Noise로 의심되는 Data 선택">{noiseChoices.map((card) => <button key={card.cardNo} className={`choice-button noise-choice ${noisePicks.includes(card.cardNo) ? "selected" : ""}`} aria-pressed={noisePicks.includes(card.cardNo)} disabled={!!card.verified || (!noisePicks.includes(card.cardNo) && noisePicks.length >= k)} onClick={() => setNoisePicks((current) => current.includes(card.cardNo) ? current.filter((number) => number !== card.cardNo) : [...current, card.cardNo])}>
        <span className="noise-choice-heading"><strong>Data {dataNumber(card.cardNo)}</strong>{card.verified ? <span className="badge verified">Verified · 선택 불가</span> : <span className="noise-choice-check" aria-hidden="true">{noisePicks.includes(card.cardNo) ? "✓" : "+"}</span>}</span>
        {card.text !== undefined ? <>
          {card.question && <span className="noise-choice-question"><span>{card.question.category}</span><span>{card.question.options.A} <span className="noise-choice-vs">vs</span> {card.question.options.B}</span></span>}
          <span className="noise-choice-answer"><span>선택한 답변</span><strong>{card.text}</strong></span>
        </> : <span className="noise-choice-unreceived"><strong>{card.recipients.map((recipient) => recipient.displayName).join(", ") || "다른 참가자"}님에게 전달된 Data</strong><span>받은 사람에게 내용을 확인한 뒤 선택해주세요.</span></span>}
      </button>)}</div><p className="small muted">{noisePicks.length} / {k}개 선택</p></>}</section>}
    {error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full" disabled={busy || !ownerPick || noisePicks.length !== k} onClick={() => void submit()}>이대로 추리하기</button>
  </Modal>;
}
