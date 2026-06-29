const POLL_MS = 10000;
const HISTORY_KEY = "qunatlab.quoteHistory.v1";
const HISTORY_DAYS = 7;
const HISTORY_MAX_POINTS_PER_SYMBOL = Math.ceil((HISTORY_DAYS * 24 * 60 * 60 * 1000) / POLL_MS);
const $ = (selector) => document.querySelector(selector);

const state = {
  lastPayload: null,
  nightSocketConnected: false,
  nightSocketHasData: false,
  history: loadHistory(),
  chartRanges: {},
};

function fmtTime(value) {
  if (!value) return "대기 중";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function seoulNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}

function formatClock(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}분 후`;
  return `${hours}시간 ${minutes}분 후`;
}

function nextMarketOpen(now) {
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (now.getDay() === 0) next.setDate(next.getDate() + 1);
  if (now.getDay() === 6) next.setDate(next.getDate() + 2);
  if (now.getDay() >= 1 && now.getDay() <= 5 && now >= next) {
    next.setDate(next.getDate() + 1);
  }
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function marketStatus() {
  const now = seoulNow();
  const day = now.getDay();
  const open = new Date(now);
  const close = new Date(now);
  open.setHours(9, 0, 0, 0);
  close.setHours(15, 30, 0, 0);

  if (day >= 1 && day <= 5 && now >= open && now < close) {
    return {
      label: "국내장진행",
      countdown: `마감 ${formatDuration(close - now)}`,
      isOpen: true,
      now,
    };
  }

  const nextOpen = nextMarketOpen(now);
  return {
    label: "국내장마감",
    countdown: `개장 ${formatDuration(nextOpen - now)}`,
    isOpen: false,
    now,
  };
}

function updateMarketClock() {
  const status = marketStatus();
  $("#localClock").textContent = formatClock(status.now);
  $("#domesticStatus").textContent = status.label;
  $("#marketCountdown").textContent = status.countdown;
  $(".status-dot").className = `status-dot ${status.isOpen ? "active" : ""}`;
}

function directionClass(...values) {
  const joined = values.filter(Boolean).join(" ");
  if (/[▼▽-]/.test(joined)) return "down";
  if (/[▲△+]/.test(joined)) return "up";
  return "";
}

function clean(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function escapeHtml(value) {
  return String(clean(value, ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
  }
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/[^0-9.+-]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function quoteHistoryKey(item) {
  return item.id || item.name?.toLowerCase().replace(/\s+/g, "-");
}

function recordQuoteHistory(item, timestamp = Date.now()) {
  const key = quoteHistoryKey(item);
  const value = numericValue(item.value);
  if (!key || value === null) return;

  const cutoff = timestamp - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const existing = Array.isArray(state.history[key]) ? state.history[key] : [];
  const last = existing.at(-1);

  if (last && timestamp - last.t < POLL_MS * 0.8 && last.v === value) return;

  state.history[key] = [...existing, { t: timestamp, v: value }]
    .filter((point) => point.t >= cutoff && Number.isFinite(point.v))
    .slice(-HISTORY_MAX_POINTS_PER_SYMBOL);
}

function recordPayloadHistory(payload) {
  const timestamp = Date.now();
  const items = payload.kospilab?.items || [];
  for (const item of items) recordQuoteHistory(item, timestamp);
  if (payload.nightFutures?.item?.value) recordQuoteHistory(payload.nightFutures.item, timestamp);
  saveHistory();
}

function mergeHistoryPoints(key, points = []) {
  if (!key || !Array.isArray(points) || !points.length) return;
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const existing = Array.isArray(state.history[key]) ? state.history[key] : [];
  const byTimestamp = new Map();

  for (const point of existing) {
    if (point.t >= cutoff && Number.isFinite(point.v)) byTimestamp.set(point.t, point.v);
  }

  for (const point of points) {
    const t = Number(point.t);
    const v = Number(point.v);
    if (t >= cutoff && Number.isFinite(v)) byTimestamp.set(t, v);
  }

  state.history[key] = [...byTimestamp.entries()]
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) => a.t - b.t)
    .slice(-HISTORY_MAX_POINTS_PER_SYMBOL);
}

function mergeServerHistory(payload) {
  const chartGroups = [
    { items: payload.naverCharts?.items || {}, label: "네이버 1분 차트" },
    { items: payload.yahooCharts?.items || {}, label: "Yahoo 1분 차트" },
  ];

  for (const group of chartGroups) {
    for (const [key, item] of Object.entries(group.items)) {
      mergeHistoryPoints(key, item.points);
      const points = Array.isArray(item.points) ? item.points.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v)) : [];
      if (points.length >= 2) {
        state.chartRanges[key] = {
          start: points[0].t,
          end: points.at(-1).t,
          label: group.label,
        };
      }
    }
  }
}

function numericChange(item) {
  const percent = Number(String(item.percent || "").replace(/[^0-9.+-]/g, ""));
  if (Number.isFinite(percent) && percent !== 0) return percent;
  const change = Number(String(item.change || "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(change) ? change : 0;
}

function todayRange() {
  const now = seoulNow();
  const start = new Date(now);
  const end = new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

function sparkline(item) {
  const key = quoteHistoryKey(item);
  const history = Array.isArray(state.history[key]) ? state.history[key] : [];
  const serverRange = state.chartRanges[key];
  const fallbackRange = todayRange();
  const start = serverRange?.start || fallbackRange.start;
  const end = serverRange?.end || fallbackRange.end;
  const points = history
    .filter((point) => point.t >= start && point.t <= end && Number.isFinite(point.v))
    .sort((a, b) => a.t - b.t);
  const values = points.map((point) => point.v);
  const current = numericValue(item.value);
  const samples = values.length ? values : [current ?? 0];
  const baseline = samples[0] ?? current ?? 0;
  const min = Math.min(...samples, baseline);
  const max = Math.max(...samples, baseline);
  const scaleY = (value) => 8 + (1 - ((value - min) / Math.max(max - min, 1))) * 34;
  const width = 116;
  const baseY = scaleY(samples[0] ?? 0).toFixed(1);
  const baselineY = scaleY(baseline).toFixed(1);
  const path = points.length >= 2
    ? points
      .map((point, index) => {
        const x = ((point.t - start) / Math.max(end - start, 1)) * width;
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${scaleY(point.v).toFixed(1)}`;
      })
      .join(" ")
    : `M0,${baseY} L${width},${baseY}`;
  const areaPath = points.length >= 2
    ? `${path} L${(((points.at(-1).t - start) / Math.max(end - start, 1)) * width).toFixed(1)},50 L${(((points[0].t - start) / Math.max(end - start, 1)) * width).toFixed(1)},50 Z`
    : `M0,${baseY} L${width},${baseY} L${width},50 L0,50 Z`;
  const hourTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const x = ratio * width;
    return `<line class="sparkline-grid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="4" y2="48"></line>`;
  }).join("");
  const rangeLabel = serverRange?.label || "오늘 00~23시";
  const label = points.length >= 2
    ? `${rangeLabel} · ${points.length.toLocaleString("ko-KR")}개 실제 기록`
    : `${rangeLabel} · 실제 데이터 수집 중`;

  return `
    <svg class="sparkline" viewBox="0 0 116 50" role="img" aria-label="${item.name} 오늘 24시간 추세 그래프" preserveAspectRatio="none">
      <title>${label}</title>
      ${hourTicks}
      <line class="sparkline-baseline" x1="0" x2="116" y1="${baselineY}" y2="${baselineY}"></line>
      <path class="sparkline-area" d="${areaPath}"></path>
      <path class="sparkline-line" d="${path}"></path>
    </svg>
    <div class="sparkline-meta">${label}</div>
  `;
}

function formatEsignalTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clean(value, null);

  const adjusted = numeric >= 250000 ? numeric - 240000 : numeric;
  return String(adjusted).padStart(6, "0").match(/.{2}/g).join(":");
}

function detailRows(rows) {
  return `
    <dl class="detail-list">
      ${rows
        .filter((row) => row[1])
        .map(
          ([label, value]) => `
            <div class="detail-row">
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>
          `,
        )
        .join("")}
    </dl>
  `;
}

function fmtNewsTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function newsCard(item, index = 0) {
  const title = escapeHtml(item.title);
  const summary = escapeHtml(item.summary);
  const source = escapeHtml(item.source || "SaveTicker");
  const createdAt = fmtNewsTime(item.createdAt);
  const tags = Array.isArray(item.tags) ? item.tags.slice(0, 2) : [];
  const thumb = item.thumbnail
    ? `<img class="news-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`
    : `<div class="news-thumb placeholder">${source.slice(0, 2)}</div>`;
  const tagHtml = tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");

  return `
    <a class="news-card" href="${escapeHtml(item.url || "https://www.saveticker.com/news")}" target="_blank" rel="noreferrer">
      ${thumb}
      <div class="news-copy">
        <div class="news-meta">
          <strong>${source}</strong>
          ${createdAt ? `<span>${createdAt}</span>` : ""}
        </div>
        <h3>${title}</h3>
        ${summary ? `<p>${summary}</p>` : ""}
        ${tagHtml ? `<div class="news-tags">${tagHtml}</div>` : ""}
      </div>
    </a>
  `;
}

function renderNewsList(target, items, emptyMessage) {
  if (!target) return;
  if (!Array.isArray(items) || !items.length) {
    target.innerHTML = `<div class="error-box">${emptyMessage}</div>`;
    return;
  }
  target.innerHTML = items.map(newsCard).join("");
}

function renderNews(news) {
  $("#newsUpdated").textContent = fmtNewsTime(news?.fetchedAt) || "대기 중";

  if (news?.error) {
    renderNewsList($("#topNewsList"), [], "SaveTicker 뉴스를 읽지 못했습니다.");
    renderNewsList($("#latestNewsList"), [], "SaveTicker 뉴스를 읽지 못했습니다.");
    return;
  }

  renderNewsList($("#topNewsList"), news?.topStories, "오늘 주요 뉴스가 아직 없습니다.");
  renderNewsList($("#latestNewsList"), news?.items, "뉴스가 아직 없습니다.");
}

function setupNewsTabs() {
  document.querySelectorAll(".news-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const selected = tab.dataset.newsTab;
      document.querySelectorAll(".news-tab").forEach((button) => {
        button.classList.toggle("active", button === tab);
      });
      document.querySelectorAll(".news-list").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.newsPanel === selected);
      });
    });
  });
}

function quoteCard(item, options = {}) {
  const tone = directionClass(item.change, item.percent);
  return `
    <article class="quote-card ${options.feature ? "feature" : ""}">
      <div class="card-head">
        <div>
          <h3>${item.name}</h3>
          <span class="muted">${item.section || ""}</span>
        </div>
        <span class="badge">${item.sourceLabel || "source"}</span>
      </div>
      <div class="value">${clean(item.value)}</div>
      <div class="delta ${tone}">
        <span>${clean(item.change)}</span>
        <span>${clean(item.percent)}</span>
      </div>
      ${sparkline(item)}
      ${detailRows([
        ["상태", item.status],
        ["USD", item.usd],
        ["거래량", item.volume],
        ["거래대금", item.amount],
        ["시가총액", item.marketCap],
        ["출처", item.sourceLabel],
      ])}
    </article>
  `;
}

function nightCard(item, meta = {}) {
  const tone = directionClass(item.change, item.percent);
  return `
    <article class="quote-card feature">
      <div class="card-head">
        <div>
          <h3>${item.name}</h3>
          <span class="muted">${state.nightSocketHasData ? "소켓 실시간 수신 중" : state.nightSocketConnected ? "소켓 연결됨 · 데이터 대기" : meta.status || "10초 폴링"}</span>
        </div>
        <span class="badge">${item.sourceLabel || "eSignal"}</span>
      </div>
      <div class="value">${clean(item.value)}</div>
      <div class="delta ${tone}">
        <span>${clean(item.change)}</span>
        <span>${clean(item.percent)}</span>
      </div>
      ${sparkline(item)}
      ${detailRows([
        ["시가", item.open],
        ["고가", item.high],
        ["저가", item.low],
        ["주간 종가", item.close],
        ["거래량", item.volume],
        ["매수 1호가", item.bid],
        ["매도 1호가", item.ask],
        ["갱신 시간", item.updatedAt],
        ["출처", item.sourceLabel],
      ])}
    </article>
  `;
}

function renderError(target, message) {
  target.innerHTML = `<div class="error-box">${message}</div>`;
}

function renderHeader(payload) {
  const meta = payload.kospilab?.marketMeta || {};
  $("#realtimeStatus").textContent = meta.priceMode || "해외 실시간 추정가";
  $("#fxRate").textContent = meta.fx?.rate || "-";
  $("#fxChange").textContent = meta.fx?.change || "";
  $("#fxChange").className = directionClass(meta.fx?.change);
  updateMarketClock();
}

function render(payload) {
  state.lastPayload = payload;
  $("#lastUpdated").textContent = fmtTime(payload.refreshedAt);
  const liveDot = $("#liveDot");
  if (liveDot) liveDot.className = "live-dot active";
  renderHeader(payload);
  renderNews(payload.news);
  mergeServerHistory(payload);
  recordPayloadHistory(payload);

  const items = payload.kospilab?.items || [];
  const indices = items.filter((item) => item.section === "지수");
  const stocks = items.filter((item) => item.section === "국내 주식");

  if (indices.length) {
    $("#indicesGrid").innerHTML = indices.map((item) => quoteCard(item)).join("");
  } else {
    renderError($("#indicesGrid"), "KOSPI LAB 지수 데이터를 읽지 못했습니다.");
  }

  if (stocks.length) {
    $("#stocksGrid").innerHTML = stocks.map((item) => quoteCard(item)).join("");
  } else {
    renderError($("#stocksGrid"), "KOSPI LAB 주식 데이터를 읽지 못했습니다.");
  }

  if (!state.nightSocketHasData && payload.nightFutures?.item) {
    $("#nightGrid").innerHTML = nightCard(payload.nightFutures.item, payload.nightFutures);
  } else if (!state.nightSocketHasData) {
    renderError($("#nightGrid"), "eSignal 야간선물 데이터를 읽지 못했습니다.");
  }
}

async function loadQuotes() {
  try {
    const response = await fetch(`/api/quotes?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    render(await response.json());
  } catch (error) {
    const liveDot = $("#liveDot");
    if (liveDot) liveDot.className = "live-dot error";
    $("#lastUpdated").textContent = "오류";
    renderError($("#nightGrid"), `데이터 갱신 실패: ${error.message}`);
  }
}

function patchNightFromSocket(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }

  const close = Number(data.value_day ?? data.close1);
  const value = Number(data.value);
  const diff = Number(data.value_diff);
  const percent = Number.isFinite(value) && Number.isFinite(close) && close !== 0
    ? `${(((value - close) / close) * 100).toFixed(2)}%`
    : null;

  const item = {
    id: "kospi200-night-futures",
    name: "코스피 200 야간 선물",
    section: "야간 선물",
    source: "https://esignal.co.kr/kospi200-futures-night/",
    sourceLabel: "eSignal",
    value: Number.isFinite(value) ? value.toFixed(2) : null,
    change: Number.isFinite(diff) ? `${diff > 0 ? "+" : ""}${diff.toFixed(2)}` : null,
    percent,
    open: data.opening ? Number(data.opening).toFixed(2) : null,
    high: data.high ? Number(data.high).toFixed(2) : null,
    low: data.low ? Number(data.low).toFixed(2) : null,
    close: Number.isFinite(close) ? close.toFixed(2) : null,
    volume: data.volume ? Number(data.volume).toLocaleString("ko-KR") : null,
    bid: data.bid1_price ? `${Number(data.bid1_price).toFixed(2)} (${clean(data.bid1_vol)})` : null,
    ask: data.ask1_price ? `${Number(data.ask1_price).toFixed(2)} (${clean(data.ask1_vol)})` : null,
    updatedAt: formatEsignalTime(data.ttime ?? data.time_format),
  };

  state.nightSocketConnected = true;
  state.nightSocketHasData = true;
  recordQuoteHistory(item);
  saveHistory();
  $("#nightGrid").innerHTML = nightCard(item, { status: "소켓 실시간 수신" });
}

function connectNightSocket() {
  const ioClient = window.io;
  if (!ioClient) return;

  try {
    const socket = ioClient("https://esignal.co.kr", {
      path: "/proxy/8888/socket.io",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 3000,
    });

    socket.on("connect", () => {
      state.nightSocketConnected = true;
    });

    socket.on("populate", patchNightFromSocket);
    socket.on("disconnect", () => {
      state.nightSocketConnected = false;
      state.nightSocketHasData = false;
    });
  } catch {
    state.nightSocketConnected = false;
  }
}

setupNewsTabs();
loadQuotes();
setInterval(loadQuotes, POLL_MS);
updateMarketClock();
setInterval(updateMarketClock, 1000);
connectNightSocket();
