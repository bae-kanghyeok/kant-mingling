"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const elements = {
    teams: $("teams"), host: $("host-button"), restart: $("restart-button"),
    follow: $("follow-toggle"), followCaption: $("follow-caption"), bots: $("bots-toggle"),
    slug: $("session-slug"), actorTitle: $("actor-title"), actorCaption: $("actor-caption"),
    eventChip: $("event-chip"), link: $("open-link"), frame: $("game-frame"),
    placeholder: $("placeholder"), placeholderTitle: $("placeholder-title"),
    placeholderCopy: $("placeholder-copy"), error: $("error-banner"),
    errorMessage: $("error-message"), retry: $("retry-button"), connection: $("connection-status"),
    restartDialog: $("restart-dialog"), restartCancel: $("restart-cancel"), restartConfirm: $("restart-confirm"),
  };
  const framePattern = /^http:\/\/127\.0\.0\.1:31(?:0[1-9]|1[0-9]|2[01])\/e\/dev-play-[a-z0-9-]+$/;
  const phaseLabels = {
    TURN: "단서 수집", ENSEMBLE_SHARE: "Ensemble · 공유", ENSEMBLE_VOTE: "Ensemble · 투표",
    ENSEMBLE_DISCUSS: "Ensemble · 대화", REVEALED: "정답 공개", REVEAL: "정답 공개",
    SEATING: "착석 대기", BLOCK_DONE: "자리 이동 대기", IN_GAME: "게임 진행",
  };
  let state = null;
  let busy = false;
  let polling = false;
  let timer = null;
  let followTeam = null;
  let currentFrameUrl = null;
  let localError = null;
  let pendingRestart = false;
  let previousSlug = null;
  let mutationVersion = 0;
  let teamsSignature = null;
  let dialogReturnFocus = null;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("리허설 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    return response.json();
  }

  function selectedActor() {
    return state?.actors?.find((actor) => actor.key === state.selectedKey) ?? null;
  }

  function isReady() {
    return Boolean(state?.active && !pendingRestart);
  }

  function setError(message) {
    localError = message;
    renderError();
  }

  function renderError() {
    const message = localError || state?.error;
    elements.error.hidden = !message;
    elements.errorMessage.textContent = message || "";
  }

  function controls() {
    const locked = busy || !isReady();
    elements.host.disabled = locked || !state?.actors?.some((actor) => actor.key === "p19");
    elements.restart.disabled = busy || pendingRestart || !state;
    elements.bots.disabled = locked;
    elements.follow.disabled = locked || !selectedActor()?.teamKey;
    elements.teams.querySelectorAll("button").forEach((button) => {
      button.disabled = locked || button.dataset.available === "false";
    });
    elements.retry.disabled = busy || polling;
  }

  function renderTeam(team, actors, selected) {
    const card = node("section", `team${selected?.teamKey === team.key ? " selected-team" : ""}`);
    card.setAttribute("aria-label", team.key ? `${team.key}조 참가자` : "배정 대기 참가자");
    const top = node("div", "team-top");
    const title = node("h3", "team-title");
    title.append(node("span", "team-letter", team.key || "·"), node("span", "", team.key ? `${team.key}조` : "배정 대기"));
    const status = node("span", "team-status");
    const phase = team.paused ? "일시정지" : phaseLabels[team.phase] || "준비 중";
    status.textContent = team.gameNo ? `Game ${team.gameNo} · ${phase}${team.cardCount ? ` · ${team.cardCount}개` : ""}` : phase;
    top.append(title, status);
    const members = node("div", "members");
    actors.forEach((actor) => {
      const person = node("button", `person${actor.role === "operator" ? " operator" : ""}`);
      person.type = "button";
      person.setAttribute("aria-pressed", String(actor.key === state.selectedKey));
      person.setAttribute("aria-label", `${actor.name}${actor.role === "operator" ? " 운영진" : ""} 화면 보기`);
      person.append(node("span", "", actor.name));
      if (actor.role === "operator") person.append(node("span", "badge", actor.key === "p19" ? "호스트" : "운영진"));
      else if (actor.key === team.leadKey) person.append(node("span", "badge", "●"));
      person.addEventListener("click", () => selectActor(actor.key, true));
      members.append(person);
    });
    card.append(top, members);
    if (team.key) {
      const actions = node("div", "team-actions");
      const lead = node("button", "button", "진행권자 화면");
      lead.type = "button";
      lead.dataset.available = String(Boolean(team.leadKey));
      lead.title = team.leadName ? `${team.leadName} 화면으로 이동` : "현재 진행권자가 없어요";
      lead.addEventListener("click", () => selectActor(team.leadKey, true));
      actions.append(lead);
      if (team.sharerKey && String(team.phase).startsWith("ENSEMBLE")) {
        const sharer = node("button", "button", "공유자 화면");
        sharer.type = "button";
        sharer.title = team.sharerName ? `${team.sharerName} 화면으로 이동` : "공유자 화면으로 이동";
        sharer.addEventListener("click", () => selectActor(team.sharerKey, true));
        actions.append(sharer);
      }
      card.append(actions);
    }
    return card;
  }

  function render() {
    if (!state) {
      controls();
      renderError();
      return;
    }
    const selected = selectedActor();
    elements.slug.textContent = state.slug || "리허설 준비 중";
    elements.bots.checked = Boolean(state.botsEnabled);
    elements.follow.checked = Boolean(followTeam);
    elements.followCaption.textContent = followTeam ? `${followTeam}조의 진행권자가 바뀌면 자동 이동` : "선택한 조의 진행권자 화면으로 이동";
    const nextSignature = JSON.stringify([state.selectedKey, state.teams, state.actors]);
    if (teamsSignature !== nextSignature) {
      const fragment = document.createDocumentFragment();
      for (const key of ["A", "B", "C"]) {
        const team = state.teams?.find((item) => item.key === key) || { key };
        const members = (state.actors || []).filter((actor) => actor.teamKey === key);
        if (members.length || state.teams?.some((item) => item.key === key)) fragment.append(renderTeam(team, members, selected));
      }
      const unassigned = (state.actors || []).filter((actor) => !["A", "B", "C"].includes(actor.teamKey));
      if (unassigned.length) fragment.append(renderTeam({ key: null }, unassigned, selected));
      elements.teams.replaceChildren(fragment);
      teamsSignature = nextSignature;
    }

    const phase = state.eventPhase;
    elements.eventChip.textContent = pendingRestart ? "새 리허설 준비 중" : !state.active ? "준비 중" : phase === "ENDED" ? "행사 종료" : phase === "BREAK" ? "자리 이동" : phase === "SETUP" ? "게임 준비" : `Block ${state.currentBlock || 1} · 진행 중`;
    if (selected) {
      elements.actorTitle.textContent = `${selected.name}${selected.teamKey ? ` · ${selected.teamKey}조` : ""}`;
      elements.actorCaption.textContent = selected.role === "operator" ? "운영진 화면이에요. 앱 안의 사이드 핸들에서 관제를 열 수 있어요." : "이 사람에게 도착한 단서를 확인하고 직접 게임을 진행해 보세요.";
    }
    if (isReady() && selected?.url && framePattern.test(selected.url)) {
      if (currentFrameUrl !== selected.url) {
        elements.placeholder.hidden = false;
        elements.placeholderTitle.textContent = `${selected.name}의 화면을 여는 중`;
        elements.placeholderCopy.textContent = "해당 참가자의 세션으로 연결하고 있어요.";
        currentFrameUrl = selected.url;
        elements.frame.src = selected.url;
      }
      elements.link.href = selected.url;
      elements.link.hidden = false;
    } else {
      elements.link.hidden = true;
      elements.link.removeAttribute("href");
      elements.placeholder.hidden = false;
      elements.placeholderTitle.textContent = pendingRestart ? "새 리허설을 준비하고 있어요" : "리허설을 준비하고 있어요";
      elements.placeholderCopy.textContent = pendingRestart ? "21명 모두 참가한 새 게임을 만들고 있어요. 기존 리허설 기록은 보존돼요." : "참가자와 게임 상태가 준비되면 화면이 열립니다.";
      if (isReady() && selected?.url && !framePattern.test(selected.url)) setError("참가자 화면 주소가 올바르지 않아요. 리허설 서버를 확인해 주세요.");
    }
    renderError();
    controls();
  }

  async function selectActor(key, manual = false) {
    if (!key || busy || !isReady() || !state?.actors?.some((actor) => actor.key === key)) return;
    if (manual) followTeam = null;
    if (state.selectedKey === key) {
      render();
      return;
    }
    busy = true;
    mutationVersion += 1;
    controls();
    try {
      // The server excludes this participant from bots before their frame is shown.
      await api("/lab/select", { key });
      state.selectedKey = key;
      setError(null);
      render();
    } catch (error) {
      setError(error?.name === "TimeoutError" ? "화면 전환 응답이 늦어지고 있어요. 다시 연결해 주세요." : error.message);
    } finally {
      busy = false;
      controls();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(poll, 3000);
  }

  async function poll() {
    clearTimeout(timer);
    if (document.hidden || polling || busy) {
      schedule();
      return;
    }
    polling = true;
    const requestVersion = mutationVersion;
    controls();
    try {
      const next = await api("/lab/state");
      if (requestVersion !== mutationVersion) return;
      // Another controller tab may have restarted the shared local rehearsal.
      if (state?.slug && next.slug && state.slug !== next.slug) followTeam = null;
      if (pendingRestart && next.active && next.slug && next.slug !== previousSlug) {
        pendingRestart = false;
        followTeam = null;
      }
      if (pendingRestart && next.error) pendingRestart = false;
      state = next;
      setError(null);
      render();
      elements.connection.textContent = "3초마다 참가자 상태 확인";
      if (followTeam && !pendingRestart) {
        const team = state.teams?.find((item) => item.key === followTeam);
        if (team?.leadKey && team.leadKey !== state.selectedKey) await selectActor(team.leadKey);
      }
    } catch (error) {
      elements.connection.textContent = "연결 확인 필요";
      setError(error?.name === "TimeoutError" ? "응답이 늦어지고 있어요. 잠시 후 자동으로 다시 연결해요." : error.message);
    } finally {
      polling = false;
      controls();
      schedule();
    }
  }

  elements.host.addEventListener("click", () => selectActor("p19", true));
  elements.follow.addEventListener("change", () => {
    followTeam = elements.follow.checked ? selectedActor()?.teamKey || null : null;
    render();
    const team = state?.teams?.find((item) => item.key === followTeam);
    if (team?.leadKey) void selectActor(team.leadKey);
  });
  elements.bots.addEventListener("change", async () => {
    if (busy || !isReady()) return;
    const enabled = elements.bots.checked;
    busy = true;
    mutationVersion += 1;
    controls();
    try {
      await api("/lab/bots", { enabled });
      state.botsEnabled = enabled;
      setError(null);
    } catch (error) {
      setError(error.message);
    } finally {
      busy = false;
      render();
    }
  });
  function closeRestartDialog() {
    if (elements.restartDialog.hidden) return;
    elements.restartDialog.hidden = true;
    document.querySelector(".shell").inert = false;
    if (dialogReturnFocus instanceof HTMLElement && dialogReturnFocus.isConnected) dialogReturnFocus.focus();
    dialogReturnFocus = null;
  }

  elements.restart.addEventListener("click", () => {
    if (busy || pendingRestart || !state || !elements.restartDialog.hidden) return;
    dialogReturnFocus = document.activeElement;
    document.querySelector(".shell").inert = true;
    elements.restartDialog.hidden = false;
    elements.restartCancel.focus();
  });
  elements.restartCancel.addEventListener("click", closeRestartDialog);
  elements.restartDialog.addEventListener("click", (event) => {
    if (event.target === elements.restartDialog) closeRestartDialog();
  });
  elements.restartDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRestartDialog();
    } else if (event.key === "Tab") {
      if (event.shiftKey && document.activeElement === elements.restartCancel) {
        event.preventDefault();
        elements.restartConfirm.focus();
      } else if (!event.shiftKey && document.activeElement === elements.restartConfirm) {
        event.preventDefault();
        elements.restartCancel.focus();
      }
    }
  });
  elements.restartConfirm.addEventListener("click", async () => {
    if (elements.restartDialog.hidden) return;
    if (busy || pendingRestart || !state) return;
    closeRestartDialog();
    busy = true;
    mutationVersion += 1;
    pendingRestart = true;
    previousSlug = state.slug;
    followTeam = null;
    render();
    try {
      await api("/lab/restart", {});
      setError(null);
    } catch (error) {
      pendingRestart = false;
      setError(error.message);
    } finally {
      busy = false;
      render();
      void poll();
    }
  });
  elements.retry.addEventListener("click", () => void poll());
  elements.frame.addEventListener("load", () => {
    if (isReady() && currentFrameUrl && elements.frame.getAttribute("src") === currentFrameUrl) elements.placeholder.hidden = true;
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) void poll();
  });
  window.addEventListener("focus", () => { if (!document.hidden) void poll(); });
  void poll();
})();
