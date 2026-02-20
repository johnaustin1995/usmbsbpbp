const form = document.getElementById("date-form");
const dateInput = document.getElementById("date-input");
const gamesRoot = document.getElementById("games");
const meta = document.getElementById("meta");
const count = document.getElementById("count");
const ticker = document.getElementById("ticker");
const template = document.getElementById("game-card-template");
const prevDayBtn = document.getElementById("prev-day");
const nextDayBtn = document.getElementById("next-day");
const todayBtn = document.getElementById("today-btn");
const autoRefreshToggle = document.getElementById("auto-refresh-index");

const AUTO_REFRESH_MS = 60000;
let isLoadingFeed = false;
let autoRefreshTimer = null;
let lastFeed = null;

init();

function init() {
  const urlDate = new URLSearchParams(window.location.search).get("date");
  const initialDate = normalizeDateInput(urlDate) || todayLocal();
  dateInput.value = initialDate;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    loadDate(dateInput.value);
  });

  prevDayBtn.addEventListener("click", () => {
    const next = shiftDate(dateInput.value, -1);
    dateInput.value = next;
    loadDate(next);
  });

  nextDayBtn.addEventListener("click", () => {
    const next = shiftDate(dateInput.value, 1);
    dateInput.value = next;
    loadDate(next);
  });

  todayBtn.addEventListener("click", () => {
    const today = todayLocal();
    dateInput.value = today;
    loadDate(today);
  });

  autoRefreshToggle.addEventListener("change", resetAutoRefresh);

  preloadBranding();
  loadDate(initialDate);
  resetAutoRefresh();
}

function preloadBranding() {
  if (!window.ncaabsbBranding?.load) {
    return;
  }

  window.ncaabsbBranding.load().then(() => {
    if (lastFeed) {
      render(lastFeed);
    }
  });
}

async function loadDate(yyyyMmDd, options = {}) {
  const { silent = false, updateUrl = true } = options;
  if (isLoadingFeed) {
    return;
  }

  isLoadingFeed = true;
  if (!silent) {
    setLoading(true);
  }
  if (updateUrl) {
    syncUrl(yyyyMmDd);
  }

  try {
    const params = new URLSearchParams({
      date: yyyyMmDd,
      view: "frontend",
      includeLive: "active",
      _: String(Date.now()),
    });

    const response = await fetch(`/api/scores?${params.toString()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    const data = await response.json();
    lastFeed = data;
    render(data);
  } catch (error) {
    renderError(error instanceof Error ? error.message : "Failed to load games");
  } finally {
    isLoadingFeed = false;
    if (!silent) {
      setLoading(false);
    }
  }
}

function render(feed) {
  const totalGames = Number(feed.totalGames || 0);
  const cards = Array.isArray(feed.cards) ? feed.cards : [];
  const tickerItems = Array.isArray(feed.ticker) ? feed.ticker : [];

  meta.textContent = formatMeta(feed.date, feed.updatedAt);
  count.textContent = `${totalGames} game${totalGames === 1 ? "" : "s"}`;

  ticker.innerHTML = "";
  if (tickerItems.length === 0) {
    const empty = document.createElement("span");
    empty.className = "ticker-item";
    empty.textContent = "No games on this date.";
    ticker.appendChild(empty);
  } else {
    tickerItems.forEach((item) => {
      const node = document.createElement("span");
      node.className = "ticker-item";
      node.textContent = item.text;
      ticker.appendChild(node);
    });
  }

  gamesRoot.innerHTML = "";
  if (cards.length === 0) {
    renderStateMessage("No games found for the selected date.");
    return;
  }

  cards.forEach((card) => gamesRoot.appendChild(renderCard(card, feed.date)));
}

function renderCard(card, feedDate) {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector(".game-card");
  const teamsWrap = fragment.querySelector(".teams");
  const cardHead = fragment.querySelector(".card-head");
  const cardFoot = fragment.querySelector(".card-foot");

  const phaseChip = fragment.querySelector(".phase-chip");
  phaseChip.textContent = card.phase;
  phaseChip.classList.add(`phase-${card.phase}`);

  const status = fragment.querySelector(".status");
  status.textContent = card.status || "Scheduled";

  const awayRow = fragment.querySelector(".team-row.away");
  const homeRow = fragment.querySelector(".team-row.home");
  const awayBranding = resolveTeamBranding(card.teams[0]);
  const homeBranding = resolveTeamBranding(card.teams[1]);

  fillTeamRow(awayRow, card.teams[0], awayBranding);
  fillTeamRow(homeRow, card.teams[1], homeBranding);
  renderLiveSnapshot(
    fragment,
    article,
    teamsWrap,
    cardHead,
    cardFoot,
    card,
    awayBranding,
    homeBranding
  );
  applyCardBranding(article, awayBranding, homeBranding);

  const time = fragment.querySelector(".time");
  const location = fragment.querySelector(".location");
  const liveLink = fragment.querySelector(".live-link");
  let playViewerHref = null;

  time.textContent = formatDisplayTime(card);
  location.textContent = card.location || "Location TBD";

  if (Number.isFinite(card.statbroadcastId)) {
    const dateQuery = normalizeDateInput(feedDate) || "";
    const params = new URLSearchParams({
      id: String(card.statbroadcastId),
    });
    if (dateQuery) {
      params.set("date", dateQuery);
    }

    liveLink.href = `/game.html?${params.toString()}`;
    liveLink.textContent = "Game Dashboard";
    liveLink.removeAttribute("target");
    liveLink.removeAttribute("rel");
    playViewerHref = `/play-by-play.html?${params.toString()}`;
  } else if (card.liveStatsUrl) {
    liveLink.href = card.liveStatsUrl;
    liveLink.textContent = "External Live Stats";
  } else {
    liveLink.remove();
  }

  if (playViewerHref && cardFoot) {
    const viewerLink = document.createElement("a");
    viewerLink.className = "live-link";
    viewerLink.href = playViewerHref;
    viewerLink.textContent = "Play Viewer";
    cardFoot.appendChild(viewerLink);
  }

  if (card.liveError) {
    article.title = `Live error: ${card.liveError}`;
  }

  const snapshot = fragment.querySelector(".live-snapshot");
  if (card.phase === "live" && Number.isFinite(card.statbroadcastId) && snapshot && liveLink?.href) {
    snapshot.classList.add("live-clickable");
    snapshot.addEventListener("click", () => {
      window.location.href = liveLink.href;
    });
    snapshot.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        window.location.href = liveLink.href;
      }
    });
    snapshot.tabIndex = 0;
  }

  return fragment;
}

function renderLiveSnapshot(
  fragment,
  article,
  teamsWrap,
  cardHead,
  cardFoot,
  card,
  awayBranding,
  homeBranding
) {
  const snapshot = fragment.querySelector(".live-snapshot");
  if (!snapshot) {
    return;
  }

  const situation = card.liveSituation;
  const shouldShow = card.phase === "live";
  snapshot.hidden = !shouldShow;
  teamsWrap.hidden = Boolean(shouldShow);
  cardHead.hidden = Boolean(shouldShow);
  cardFoot.hidden = Boolean(shouldShow);
  article.classList.toggle("live-focus", Boolean(shouldShow));
  article.classList.toggle("live-exact", Boolean(shouldShow));

  if (!shouldShow) {
    return;
  }

  setBaseState(snapshot.querySelector(".base-first"), Boolean(situation?.bases?.first));
  setBaseState(snapshot.querySelector(".base-second"), Boolean(situation?.bases?.second));
  setBaseState(snapshot.querySelector(".base-third"), Boolean(situation?.bases?.third));

  const countNode = snapshot.querySelector(".live-count");
  const outsDots = snapshot.querySelector(".live-outs-dots");
  countNode.textContent = formatLiveCount(situation?.count);
  applyOutDots(outsDots, situation?.outs);

  const awayRow = snapshot.querySelector(".live-score-row.away");
  const homeRow = snapshot.querySelector(".live-score-row.home");
  fillLiveScoreRow(awayRow, card.teams[0], awayBranding);
  fillLiveScoreRow(homeRow, card.teams[1], homeBranding);

  const batterLine = snapshot.querySelector(".live-batter-line");
  const pitcherLine = snapshot.querySelector(".live-pitcher-line");
  const inning = snapshot.querySelector(".live-inning");

  const batterLast = toLastNameUpper(situation?.batter?.name) || "BATTER";
  const batterSummary = normalizeAbSummary(situation?.batter?.summary);
  batterLine.textContent = `${batterLast} (${batterSummary})`;

  const pitcherLast = toLastNameUpper(situation?.pitcher?.name) || "PITCHER";
  const pitchCount = Number.isFinite(situation?.pitcher?.pitchCount)
    ? `P:${situation.pitcher.pitchCount}`
    : "P:--";
  pitcherLine.textContent = `${pitcherLast} ${pitchCount}`;
  inning.textContent = formatInningLabel(situation, card.status);
}

function setBaseState(node, active) {
  if (!node) {
    return;
  }

  node.classList.toggle("active", active);
}

function applyOutDots(container, outs) {
  if (!container) {
    return;
  }

  const totalOuts = Number.isFinite(outs) ? Math.max(0, Math.min(3, outs)) : 0;
  container.querySelectorAll(".out-dot").forEach((dot, index) => {
    dot.classList.toggle("active", index < totalOuts);
  });
}

function fillLiveScoreRow(row, team, branding) {
  if (!row || !team) {
    return;
  }

  const nameNode = row.querySelector(".live-score-code");
  const scoreNode = row.querySelector(".live-score-value");
  const logoNode = row.querySelector(".live-score-watermark");
  const chooseLogo = window.ncaabsbBranding?.chooseLogo;
  const primary = getTeamPrimaryColor(branding);
  const logoSrc = chooseLogo ? chooseLogo(branding) : null;

  const fallbackColor = "#24335f";
  nameNode.textContent = formatFullSchoolName(team);
  scoreNode.textContent = Number.isFinite(team.score) ? String(team.score) : "-";

  if (logoSrc) {
    logoNode.src = logoSrc;
    logoNode.alt = `${team.name} logo`;
    logoNode.hidden = false;
  } else {
    logoNode.removeAttribute("src");
    logoNode.hidden = true;
  }

  row.style.setProperty("--live-team", primary || fallbackColor);
  row.classList.add("team-branded");
}

function formatLiveCount(count) {
  const balls = Number.isFinite(count?.balls) ? count.balls : null;
  const strikes = Number.isFinite(count?.strikes) ? count.strikes : null;
  if (balls === null && strikes === null) {
    return "--";
  }

  return `${balls ?? "-"}-${strikes ?? "-"}`;
}

function formatInningLabel(situation, status) {
  if (Number.isFinite(situation?.inning)) {
    const arrow = situation?.half === "bottom" ? "▼" : "▲";
    return `${arrow} ${situation.inning}`;
  }

  const statusText = String(status || "");
  const match = statusText.match(/\b(top|bot|bottom)\s*(\d+)/i);
  if (match) {
    const arrow = /^top/i.test(match[1]) ? "▲" : "▼";
    return `${arrow} ${match[2]}`;
  }

  if (/final/i.test(statusText)) {
    return "FINAL";
  }

  return statusText ? statusText.toUpperCase() : "LIVE";
}

function toLastNameUpper(name) {
  const clean = String(name || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) {
    return null;
  }

  if (clean.includes(",")) {
    return (clean.split(",")[0].trim() || clean).toUpperCase();
  }

  const parts = clean.split(/\s+/);
  return (parts[parts.length - 1] || clean).toUpperCase();
}

function normalizeAbSummary(value) {
  const clean = String(value || "")
    .replace(/\s+/g, "")
    .trim();

  if (/^\d+-\d+$/u.test(clean)) {
    return clean;
  }

  return "X-X";
}

function formatFullSchoolName(team) {
  const name = String(team?.name || team?.shortName || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^#\d+\s+/u, "")
    .trim();

  if (!name) {
    return "TEAM";
  }

  return name;
}

function fillTeamRow(row, team, branding) {
  const teamNameWrap = row.querySelector(".team-name-wrap");
  const rank = row.querySelector(".team-rank");
  const name = row.querySelector(".team-name");
  const score = row.querySelector(".team-score");
  let logo = row.querySelector(".team-logo");

  if (!logo) {
    logo = document.createElement("img");
    logo.className = "team-logo";
    logo.loading = "lazy";
    logo.decoding = "async";
    logo.referrerPolicy = "no-referrer";
    teamNameWrap.insertBefore(logo, rank);
  }

  rank.textContent = team.rank ? `#${team.rank}` : "";
  name.textContent = team.name;
  score.textContent = Number.isFinite(team.score) ? String(team.score) : "-";
  applyTeamBranding(row, team, branding, logo);

  if (team.isWinner) {
    row.classList.add("winner");
  } else {
    row.classList.remove("winner");
  }
}

function renderError(message) {
  meta.textContent = `Error loading games: ${message}`;
  count.textContent = "0 games";
  ticker.innerHTML = "";
  gamesRoot.innerHTML = "";
  renderStateMessage(`Could not load games. ${message}`);
}

function renderStateMessage(message) {
  const box = document.createElement("div");
  box.className = "state-message";
  box.textContent = message;
  gamesRoot.appendChild(box);
}

function setLoading(isLoading) {
  form.querySelectorAll("button, input").forEach((el) => {
    el.disabled = isLoading;
  });
  if (isLoading) {
    count.textContent = "Loading...";
  }
}

function formatMeta(dateString, updatedAt) {
  const niceDate = formatDateLabel(dateString);
  if (updatedAt) {
    return `${niceDate} • Updated ${updatedAt}`;
  }

  return niceDate;
}

function formatDateLabel(dateString) {
  if (!dateString || !/^\d{8}$/.test(dateString)) {
    return "Selected Date";
  }

  const year = Number(dateString.slice(0, 4));
  const month = Number(dateString.slice(4, 6)) - 1;
  const day = Number(dateString.slice(6, 8));
  const date = new Date(Date.UTC(year, month, day));

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatDisplayTime(card) {
  if (card.phase !== "upcoming") {
    return card.status || "Live";
  }

  if (!card.startTimeIso) {
    return card.status || "Scheduled";
  }

  const date = new Date(card.startTimeIso);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function syncUrl(dateValue) {
  const url = new URL(window.location.href);
  url.searchParams.set("date", dateValue);
  window.history.replaceState({}, "", url);
}

function normalizeDateInput(value) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  return null;
}

function shiftDate(currentDate, days) {
  const [year, month, day] = currentDate.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return formatDateInput(date);
}

function todayLocal() {
  return formatDateInput(new Date());
}

function formatDateInput(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resetAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  if (!autoRefreshToggle.checked) {
    return;
  }

  autoRefreshTimer = setInterval(() => {
    if (document.hidden) {
      return;
    }

    loadDate(dateInput.value, {
      silent: true,
      updateUrl: false,
    });
  }, AUTO_REFRESH_MS);
}

function resolveTeamBranding(team) {
  if (!window.ncaabsbBranding?.lookup) {
    return null;
  }

  const candidates = [];
  if (typeof team === "string") {
    candidates.push(team, stripTeamDecorators(team));
  } else if (team && typeof team === "object") {
    candidates.push(
      team.name,
      team.shortName,
      stripTeamDecorators(team.name),
      stripTeamDecorators(team.shortName)
    );
  }

  for (const candidate of candidates) {
    const found = window.ncaabsbBranding.lookup(candidate);
    if (found) {
      return found;
    }
  }

  return null;
}

function stripTeamDecorators(name) {
  return String(name || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^#\d+\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getTeamPrimaryColor(branding) {
  const safeColor = window.ncaabsbBranding?.safeColor;
  if (!safeColor) {
    return null;
  }

  return (
    safeColor(branding?.colors?.primary) ||
    safeColor(branding?.colors?.espnPrimary) ||
    null
  );
}

function applyTeamBranding(row, team, branding, logoEl) {
  const safeColor = window.ncaabsbBranding?.safeColor;
  const chooseLogo = window.ncaabsbBranding?.chooseLogo;
  const primary = safeColor ? safeColor(branding?.colors?.primary) : null;
  const secondary = safeColor ? safeColor(branding?.colors?.secondary) : null;
  const logoSrc = chooseLogo ? chooseLogo(branding) : null;

  if (logoSrc) {
    logoEl.src = logoSrc;
    logoEl.alt = `${team.name} logo`;
    logoEl.hidden = false;
  } else {
    logoEl.removeAttribute("src");
    logoEl.hidden = true;
  }

  if (primary) {
    row.style.setProperty("--team-color", primary);
    row.classList.add("team-branded");
  } else {
    row.style.removeProperty("--team-color");
    row.classList.remove("team-branded");
  }

  if (secondary) {
    row.style.setProperty("--team-color-soft", toRgba(secondary, 0.12));
  } else if (primary) {
    row.style.setProperty("--team-color-soft", toRgba(primary, 0.12));
  } else {
    row.style.removeProperty("--team-color-soft");
  }
}

function applyCardBranding(cardEl, awayBranding, homeBranding) {
  const safeColor = window.ncaabsbBranding?.safeColor;
  const away = safeColor ? safeColor(awayBranding?.colors?.primary) : null;
  const home = safeColor ? safeColor(homeBranding?.colors?.primary) : null;

  if (!away && !home) {
    cardEl.classList.remove("card-branded");
    cardEl.style.removeProperty("--away-accent-soft");
    cardEl.style.removeProperty("--home-accent-soft");
    return;
  }

  cardEl.classList.add("card-branded");
  cardEl.style.setProperty("--away-accent-soft", away ? toRgba(away, 0.18) : "transparent");
  cardEl.style.setProperty("--home-accent-soft", home ? toRgba(home, 0.16) : "transparent");
}

function toRgba(hex, alpha) {
  const clean = String(hex || "").replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(clean)) {
    return "transparent";
  }

  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
