import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = normalize(join(__dirname, ".."));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);

const SOURCES = {
  kospilab: "https://kospilab.com/",
  esignalNight: "https://esignal.co.kr/kospi200-futures-night/",
  naverIndex: "https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ",
  yahooIxic: "https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC",
  yahooGspc: "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/json,text/plain,*/*",
        "user-agent":
          "Mozilla/5.0 (compatible; MarketSourceDashboard/0.1; +https://github.com/)",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(input = "") {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&#8211;", "-")
    .replaceAll("&#8212;", "-")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function htmlToText(html = "") {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function parseNumberLike(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[^\d.+-]/g, "");
  return normalized ? Number(normalized) : null;
}

function isBlankQuote(item) {
  return !item?.value;
}

async function getNaverIndexFallback() {
  const payload = JSON.parse(await fetchText(SOURCES.naverIndex, 5000));
  const byCode = new Map((payload.datas || []).map((item) => [item.itemCode, item]));

  return ["KOSPI", "KOSDAQ"].map((code) => {
    const item = byCode.get(code);
    if (!item) return null;
    const direction = item.compareToPreviousPrice?.name === "FALLING" ? "▼" : "▲";
    return {
      id: code.toLowerCase(),
      name: code,
      source: SOURCES.naverIndex,
      sourceLabel: "네이버 금융",
      section: "지수",
      status: item.marketStatus === "CLOSE" ? "마감" : "장중",
      value: item.closePrice || null,
      change: item.compareToPreviousClosePrice ? `${direction}${item.compareToPreviousClosePrice}` : null,
      percent: item.fluctuationsRatio ? `${item.fluctuationsRatio}%` : null,
      open: item.openPrice || null,
      high: item.highPrice || null,
      low: item.lowPrice || null,
      updatedAt: item.localTradedAt || null,
    };
  }).filter(Boolean);
}

async function getYahooIndexFallback(name, url) {
  const payload = JSON.parse(await fetchText(url, 5000));
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const value = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.previousClose;
  const change = Number.isFinite(value) && Number.isFinite(prev) ? value - prev : null;
  const percent = Number.isFinite(change) && Number.isFinite(prev) && prev !== 0 ? (change / prev) * 100 : null;

  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    source: url,
    sourceLabel: "Yahoo Finance",
    section: "지수",
    status: meta.marketState || "확인",
    value: Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : null,
    change: Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}` : null,
    percent: Number.isFinite(percent) ? `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%` : null,
    updatedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

function pickAround(text, label, chars = 700) {
  const index = text.indexOf(label);
  if (index < 0) return "";
  return text.slice(index, index + chars);
}

function pickIndexChunk(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, "g");
  const matches = [...text.matchAll(pattern)];
  const preferred = matches.find((match) =>
    text.slice(match.index, match.index + 500).includes("전일대비"),
  );
  const match = preferred || matches[0];
  return match ? text.slice(match.index, match.index + 700) : "";
}

function parseIndex(text, name) {
  const chunk = pickIndexChunk(text, name);
  const value =
    chunk.match(/전일대비\s*[▲△▼▽+-]?\s*[\d,.+-]+\s*[+-]?\d+(?:\.\d+)?%\s*([\d,]+\.\d{2})/) ||
    chunk.match(/(?:마감|정규장)[^0-9]{0,120}([\d,]+\.\d{2})/);
  const change = chunk.match(/전일대비\s*([▲△▼▽+-]?\s*[\d,.+-]+)/);
  const percent = chunk.match(/([+-]?\d+(?:\.\d+)?)%/);

  return {
    id: name.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-"),
    name,
    source: SOURCES.kospilab,
    sourceLabel: "KOSPI LAB",
    section: "지수",
    status: chunk.includes("마감") ? "마감" : chunk.includes("정규장") ? "정규장" : "확인 필요",
    value: value?.[1] || null,
    change: change?.[1]?.replace(/\s+/g, "") || null,
    percent: percent?.[1] ? `${percent[1]}%` : null,
    raw: chunk,
  };
}

function parseStock(text, name) {
  const chunk = pickAround(text, `### ${name}`) || pickAround(text, name, 900);
  const krw = chunk.match(/₩\s*([\d,]+)\s*원/);
  const usd = chunk.match(/≈\s*\$([\d,.]+)\s*USD/);
  const diff = chunk.match(/(?:대비|기준)\s*([▲△▼▽+-]?\s*[\d,]+)\s*원/);
  const percent = chunk.match(/([+-]?\d+(?:\.\d+)?)%/);
  const volume = chunk.match(/거래량\s*\(KRX\+NXT\)\s*([\d,]+\s*주)/);
  const amount = chunk.match(/거래대금\s*\(KRX\+NXT\)\s*([^ ]+(?:\s*[^ ]+){0,3}\s*원)/);
  const marketCap = chunk.match(/시가총액\s*([^ ]+(?:\s*[^ ]+){0,3}\s*원)/);

  return {
    id: name === "삼성전자" ? "samsung-electronics" : "sk-hynix",
    name,
    source: SOURCES.kospilab,
    sourceLabel: "KOSPI LAB",
    section: "국내 주식",
    status: chunk.includes("해외 실시간 추정가") ? "해외 실시간 추정가" : "한국 시장 마감",
    value: krw?.[1] ? `₩${krw[1]}` : null,
    usd: usd?.[1] ? `$${usd[1]}` : null,
    change: diff?.[1]?.replace(/\s+/g, "") || null,
    percent: percent?.[1] ? `${percent[1]}%` : null,
    volume: volume?.[1] || null,
    amount: amount?.[1] || null,
    marketCap: marketCap?.[1] || null,
    raw: chunk,
  };
}

async function getKospilab() {
  const html = await fetchText(SOURCES.kospilab);
  const text = htmlToText(html);
  const targets = ["KOSPI", "KOSDAQ", "NASDAQ", "S&P 500"];
  const indices = targets.map((name) => parseIndex(text, name));
  const stocks = ["삼성전자", "SK하이닉스"].map((name) => parseStock(text, name));
  const notes = [];

  try {
    const naver = await getNaverIndexFallback();
    for (const fallback of naver) {
      const index = indices.findIndex((item) => item.name === fallback.name);
      if (index >= 0 && isBlankQuote(indices[index])) {
        indices[index] = fallback;
        notes.push(`${fallback.name}: KOSPI LAB 명시 원천인 네이버 금융 fallback 사용`);
      }
    }
  } catch (error) {
    notes.push(`네이버 금융 fallback 실패: ${error.message}`);
  }

  for (const [name, url] of [
    ["NASDAQ", SOURCES.yahooIxic],
    ["S&P 500", SOURCES.yahooGspc],
  ]) {
    const index = indices.findIndex((item) => item.name === name);
    if (index < 0 || !isBlankQuote(indices[index])) continue;
    try {
      const fallback = await getYahooIndexFallback(name, url);
      if (fallback?.value) {
        indices[index] = fallback;
        notes.push(`${name}: KOSPI LAB 명시 원천인 Yahoo Finance fallback 사용`);
      }
    } catch (error) {
      notes.push(`${name} Yahoo Finance fallback 실패: ${error.message}`);
    }
  }

  return {
    source: SOURCES.kospilab,
    fetchedAt: new Date().toISOString(),
    notes,
    items: [...indices, ...stocks],
  };
}

function latestPointFromCache(cache) {
  if (!cache || typeof cache !== "object") return null;
  const series = Array.isArray(cache.data) ? cache.data : cache?.data?.data;
  const last = Array.isArray(series) ? series.at(-1) : null;
  if (!Array.isArray(last)) return null;
  return { timestamp: last[0], value: last[1] };
}

async function tryFetchJson(url) {
  const text = await fetchText(url, 5000);
  return JSON.parse(text);
}

async function getNightFutures() {
  const result = {
    source: SOURCES.esignalNight,
    sourceLabel: "eSignal",
    fetchedAt: new Date().toISOString(),
    status: "페이지 HTML 확인",
    item: {
      id: "kospi200-night-futures",
      name: "코스피 200 야간 선물",
      section: "야간 선물",
      source: SOURCES.esignalNight,
      sourceLabel: "eSignal",
      value: null,
      change: null,
      percent: null,
      high: null,
      low: null,
      open: null,
      close: null,
      volume: null,
      updatedAt: null,
      bid: null,
      ask: null,
    },
    notes: [],
  };

  try {
    const html = await fetchText(SOURCES.esignalNight);
    const text = htmlToText(html);
    result.pageTitle = text.match(/야간선물/) ? "야간선물" : null;
    result.notes.push("원본 페이지는 socket.io/ngtchart.js로 값을 렌더링합니다.");
  } catch (error) {
    result.notes.push(`페이지 확인 실패: ${error.message}`);
  }

  const cacheCandidates = [
    "https://esignal.co.kr/wp/shared/cache/kospif_ngt.js",
    "https://esignal.co.kr/wp-includes/js/chart/../wp/shared/cache/kospif_ngt.js",
  ];

  for (const url of cacheCandidates) {
    try {
      const cache = await tryFetchJson(url);
      const latest = latestPointFromCache(cache);
      if (latest) {
        result.status = "캐시 JSON 수신";
        result.item.value = String(latest.value);
        result.item.updatedAt = latest.timestamp;
        result.notes.push(`캐시 후보 성공: ${url}`);
        break;
      }
    } catch (error) {
      result.notes.push(`캐시 후보 실패: ${url} (${error.message})`);
    }
  }

  return result;
}

async function getQuotes() {
  const settled = await Promise.allSettled([getKospilab(), getNightFutures()]);
  const [kospilab, nightFutures] = settled.map((entry) =>
    entry.status === "fulfilled" ? entry.value : { error: entry.reason.message },
  );

  return {
    refreshedAt: new Date().toISOString(),
    intervalMs: 10000,
    sources: [
      { label: "KOSPI LAB", url: SOURCES.kospilab },
      { label: "eSignal 코스피 200 야간 선물", url: SOURCES.esignalNight },
      { label: "네이버 금융 지수 fallback", url: SOURCES.naverIndex },
      { label: "Yahoo Finance 지수 fallback", url: "https://finance.yahoo.com/" },
    ],
    kospilab,
    nightFutures,
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(join(publicDir, pathname));

  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(safePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(safePath)] || "application/octet-stream",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/quotes")) {
      json(res, 200, await getQuotes());
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`Market source dashboard: http://localhost:${port}`);
});
