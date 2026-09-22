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
    <p>현재 공개된 Data {overlay.cardCount ?? game.cards.length}개 중 Noise {overlay.noiseCount ?? 1}개가 숨어 있습니다.</p>
    <p className="muted">Data Owner와 함께 어떤 Data가 Noise인지도 찾아보세요.</p>
    {errorNotice}<button className="button primary full" disabled={busy} onClick={acknowledge}>추리 시작하기</button>
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
      <h3>어떤 Data가 Noise라고 생각하나요?</h3><div className="choice-grid">{game.cards.map((card) => <button key={card.cardNo} className={`choice-button ${noisePicks.includes(card.cardNo) ? "selected" : ""}`} aria-pressed={noisePicks.includes(card.cardNo)} disabled={!!card.verified || (!noisePicks.includes(card.cardNo) && noisePicks.length >= k)} onClick={() => setNoisePicks((current) => current.includes(card.cardNo) ? current.filter((number) => number !== card.cardNo) : [...current, card.cardNo])}>Data {dataNumber(card.cardNo)}{card.verified && <small>Verified</small>}</button>)}</div><p className="small muted">{noisePicks.length} / {k}개 선택</p></>}</section>}
    {error && <p className="error-message" role="alert">{error}</p>}<button className="button primary full" disabled={busy || !ownerPick || noisePicks.length !== k} onClick={() => void submit()}>이대로 추리하기</button>
  </Modal>;
}
