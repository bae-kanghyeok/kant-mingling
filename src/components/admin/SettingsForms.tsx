"use client";

import { useState } from "react";
import type { GlobalConfig, TeamSettings } from "@/server/game/settings";

type Save = (command: string, args: Record<string, unknown>) => Promise<void | boolean>;

function GamesField({ label, values, onChange, start = 1 }: { label: string; values: number[]; onChange: (values: number[]) => void; start?: number }) {
  return <fieldset className="setting-field"><legend>{label}</legend><div className="game-toggles">{Array.from({ length: 10 - start }, (_, index) => index + start).map((game) => <label key={game} className={values.includes(game) ? "active" : ""}><input type="checkbox" checked={values.includes(game)} onChange={(event) => onChange(event.target.checked ? [...values, game].sort((a, b) => a - b) : values.filter((value) => value !== game))} /><span>{game}</span></label>)}</div></fieldset>;
}

export function TeamSettingsForm({ settings, save, busy }: { settings: TeamSettings; save: Save; busy: boolean }) {
  const [draft, setDraft] = useState(settings);
  const set = <K extends keyof TeamSettings>(key: K, value: TeamSettings[K]) => setDraft((current) => ({ ...current, [key]: value, preset: "custom" }));
  return <form onSubmit={(event) => { event.preventDefault(); void save("update-team-settings", { settings: draft }); }} className="settings-form">
    <p className="notice">변경한 조 설정은 다음 Game부터 적용돼요.</p>
    <fieldset disabled={busy}><legend>난이도 프리셋</legend><div className="action-grid three">{(["easy", "normal", "hard"] as const).map((preset, index) => <button type="button" key={preset} className={`button ${settings.preset === preset ? "primary" : "secondary"}`} onClick={() => void save("apply-preset", { preset })}>{["쉬움", "보통", "어려움"][index]}</button>)}</div></fieldset>
    <GamesField label="Data Split · 사용할 Game" values={draft.dataSplitGames} onChange={(games) => set("dataSplitGames", games)} />
    <GamesField label="Noise · 사용할 Game" values={draft.noiseGames} start={2} onChange={(games) => set("noiseGames", games)} />
    <div className="field-row"><label>첫 Noise 시작<input type="number" min={2} max={3} value={draft.noiseFirstRange[0]} onChange={(event) => set("noiseFirstRange", [Number(event.target.value), draft.noiseFirstRange[1]])} /></label><label>첫 Noise 끝<input type="number" min={2} max={3} value={draft.noiseFirstRange[1]} onChange={(event) => set("noiseFirstRange", [draft.noiseFirstRange[0], Number(event.target.value)])} /></label></div>
    <label className="check-row"><input type="checkbox" checked={draft.noiseAutoAdd} onChange={(event) => set("noiseAutoAdd", event.target.checked)} />긴 Game 자동 Noise 추가</label>
    <label>Noise 상한<input type="number" min={0} max={5} value={draft.noiseCap} onChange={(event) => set("noiseCap", Number(event.target.value))} /></label>
    <GamesField label="Ensemble · 사용할 Game" values={draft.ensembleGames} onChange={(games) => set("ensembleGames", games)} />
    <label className="check-row"><input type="checkbox" checked={draft.ensembleTriggerOverride === null} onChange={(event) => set("ensembleTriggerOverride", event.target.checked ? null : 4)} />Ensemble 시점을 조 인원으로 자동 계산</label>
    {draft.ensembleTriggerOverride !== null && <label>Ensemble이 시작될 Data 번호<input type="number" min={1} max={20} value={draft.ensembleTriggerOverride} onChange={(event) => set("ensembleTriggerOverride", Number(event.target.value))} /></label>}
    <GamesField label="Ground Truth · 사용할 Game" values={draft.groundTruthGames} onChange={(games) => set("groundTruthGames", games)} />
    <label>Game당 Ground Truth 횟수<select value={draft.groundTruthPerGame} onChange={(event) => set("groundTruthPerGame", Number(event.target.value) as 0 | 1)}><option value={0}>사용하지 않음</option><option value={1}>1회</option></select></label>
    <p className="small muted">Ground Truth를 사용할 Game에는 Ensemble도 켜주세요.</p>
    <div className="field-row"><label>Ensemble 뒤 실제 Data 추가 수<input type="number" min={0} max={19} value={draft.gtRealCardsAfterEnsemble} onChange={(event) => set("gtRealCardsAfterEnsemble", Number(event.target.value))} /></label><label>희귀 Data 허용 시작<input type="number" min={3} max={20} value={draft.rareFromRealOrdinal} onChange={(event) => set("rareFromRealOrdinal", Number(event.target.value))} /></label></div>
    <button className="button primary full" disabled={busy}>조 설정 저장</button>
  </form>;
}

export function GlobalSettingsForm({ settings, save, busy, operatorNames }: { settings: GlobalConfig; save: Save; busy: boolean; operatorNames: string[] }) {
  const [draft, setDraft] = useState(settings);
  const set = <K extends keyof GlobalConfig>(key: K, value: GlobalConfig[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save("update-global-settings", { settings: draft }); }}>
    <p className="notice">전체 설정은 다음 블록부터 반영돼요. 인원과 운영진 명단도 함께 맞춰주세요.</p>
    <div className="field-row"><label>수강생 수<input type="number" min={2} value={draft.studentCount} onChange={(event) => set("studentCount", Number(event.target.value))} /></label><label>조 개수<input type="number" min={2} value={draft.teamCount} onChange={(event) => set("teamCount", Number(event.target.value))} /></label></div>
    <label>조별 이동 수강생 수<input type="number" min={0} value={draft.moveCountPerTeam} onChange={(event) => set("moveCountPerTeam", Number(event.target.value))} /></label>
    <fieldset className="setting-field"><legend>블록 목표 시간 · 참고용</legend><div className="field-row three">{draft.blockTargetMinutes.map((minutes, index) => <label key={index}>{index + 1}블록 (분)<input type="number" min={1} value={minutes} onChange={(event) => { const next: [number, number, number] = [...draft.blockTargetMinutes]; next[index] = Number(event.target.value); set("blockTargetMinutes", next); }} /></label>)}</div></fieldset>
    <fieldset className="setting-field"><legend>운영진 배치</legend>{[...new Set([...operatorNames, ...Object.keys(draft.operatorTeamByName)])].map((name) => <label className="assignment-row" key={name}><span>{name}</span><input aria-label={`${name} 조 (비우면 자동)`} placeholder="자동" value={draft.operatorTeamByName[name] ?? ""} maxLength={3} onChange={(event) => { const next = { ...draft.operatorTeamByName }; const value = event.target.value.toUpperCase().trim(); if (value) next[name] = value; else delete next[name]; set("operatorTeamByName", next); }} /></label>)}<p className="small muted">A, B, C처럼 조 이름을 입력하거나 비워두면 자동 배치돼요.</p><button className="text-button" type="button" onClick={() => set("operatorTeamByName", {})}>모두 자동 배치로 변경</button></fieldset>
    <button className="button primary full" disabled={busy}>전체 설정 저장</button>
  </form>;
}
