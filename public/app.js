const POLL_MS = 10000;
const $ = (selector) => document.querySelector(selector);

const state = {
  lastPayload: null,
  nightSocketConnected: false,
  nightSocketHasData: false,
};

function fmtTime(value) {
  if (!value) return "대기 중";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
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

function render(payload) {
  state.lastPayload = payload;
  $("#lastUpdated").textContent = fmtTime(payload.refreshedAt);
  $("#liveDot").className = "live-dot active";

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

  if (payload.nightFutures?.item) {
    $("#nightGrid").innerHTML = nightCard(payload.nightFutures.item, payload.nightFutures);
  } else {
    renderError($("#nightGrid"), "eSignal 야간선물 데이터를 읽지 못했습니다.");
  }
}

async function loadQuotes() {
  try {
    const response = await fetch(`/api/quotes?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    render(await response.json());
  } catch (error) {
    $("#liveDot").className = "live-dot error";
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

  const close = Number(data.close1);
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
    updatedAt: data.time_format || new Date().toLocaleTimeString("ko-KR"),
  };

  state.nightSocketConnected = true;
  state.nightSocketHasData = true;
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

    socket.on("kospif_ngt", patchNightFromSocket);
    socket.on("disconnect", () => {
      state.nightSocketConnected = false;
      state.nightSocketHasData = false;
    });
  } catch {
    state.nightSocketConnected = false;
  }
}

loadQuotes();
setInterval(loadQuotes, POLL_MS);
connectNightSocket();
