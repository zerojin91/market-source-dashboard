import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = normalize(join(__dirname, ".."));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const NEWS_CACHE_MS = 5 * 60 * 1000;
const YAHOO_CHART_CACHE_MS = 60 * 1000;
const NAVER_CHART_CACHE_MS = 60 * 1000;
let newsCache = {
  expiresAt: 0,
  payload: null,
};
let yahooChartCache = {
  expiresAt: 0,
  payload: null,
};
let naverChartCache = {
  expiresAt: 0,
  payload: null,
};

const SOURCES = {
  kospilab: "https://kospilab.com/",
  esignalNight: "https://esignal.co.kr/kospi200-futures-night/",
  naverIndex: "https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ",
  naverChart: "https://api.stock.naver.com/chart/domestic/index",
  yahooIxic: "https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC",
  yahooGspc: "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC",
  yahooChart: "https://query1.finance.yahoo.com/v8/finance/chart",
  savetickerNews: "https://www.saveticker.com/news",
  savetickerApi: "https://api.saveticker.com/api",
};

const YAHOO_CHART_TARGETS = [
  { id: "nasdaq", name: "NASDAQ", symbol: "^IXIC" },
  { id: "s-p-500", name: "S&P 500", symbol: "^GSPC" },
  { id: "nasdaq-100-futures", name: "NASDAQ 100 Futures", symbol: "NQ=F" },
];

const NAVER_CHART_TARGETS = [
  { id: "kospi", name: "KOSPI", symbol: "KOSPI" },
  { id: "kosdaq", name: "KOSDAQ", symbol: "KOSDAQ" },
];

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
  html = String(html || "");
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

function parseKospilabMeta(text) {
  const fx = text.match(/USD\/KRW\s*₩\s*([\d,]+)\s*([+-]?\d+(?:\.\d+)?)/);

  return {
    priceMode: text.includes("해외 실시간 추정가") ? "해외 실시간 추정가" : null,
    domesticStatus: text.includes("국내장마감") ? "국내장마감" : text.includes("국내장") ? "국내장" : null,
    fx: fx
      ? {
          pair: "USD/KRW",
          rate: `₩${fx[1]}`,
          change: fx[2],
        }
      : null,
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

  for (const item of indices) {
    if (item.name === "KOSPI" || item.name === "KOSDAQ") {
      item.sourceLabel = "네이버 금융";
    }
  }

  return {
    source: SOURCES.kospilab,
    fetchedAt: new Date().toISOString(),
    marketMeta: parseKospilabMeta(text),
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

function yahooChartUrl(symbol) {
  const params = new URLSearchParams({
    range: "1d",
    interval: "1m",
    includePrePost: "true",
  });
  return `${SOURCES.yahooChart}/${encodeURIComponent(symbol)}?${params}`;
}

function normalizeYahooChart(payload, target) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps
    .map((timestamp, index) => ({
      t: timestamp * 1000,
      v: closes[index],
    }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));

  return {
    id: target.id,
    name: target.name,
    symbol: target.symbol,
    source: `https://finance.yahoo.com/quote/${encodeURIComponent(target.symbol)}/`,
    fetchedAt: new Date().toISOString(),
    previousClose: result?.meta?.chartPreviousClose || result?.meta?.previousClose || null,
    points,
  };
}

async function getYahooCharts() {
  const settled = await Promise.allSettled(
    YAHOO_CHART_TARGETS.map(async (target) => {
      const payload = await tryFetchJson(yahooChartUrl(target.symbol));
      return normalizeYahooChart(payload, target);
    }),
  );

  const items = {};
  const notes = [];
  settled.forEach((entry, index) => {
    const target = YAHOO_CHART_TARGETS[index];
    if (entry.status === "fulfilled") {
      items[target.id] = entry.value;
      return;
    }
    notes.push(`${target.symbol}: Yahoo chart fetch failed (${entry.reason.message})`);
  });

  return {
    source: "https://finance.yahoo.com/",
    sourceLabel: "Yahoo Finance",
    fetchedAt: new Date().toISOString(),
    interval: "1m",
    range: "1d",
    items,
    notes,
  };
}

async function getCachedYahooCharts() {
  const now = Date.now();
  if (yahooChartCache.payload && yahooChartCache.expiresAt > now) {
    return {
      ...yahooChartCache.payload,
      cache: {
        status: "hit",
        ttlMs: yahooChartCache.expiresAt - now,
      },
    };
  }

  try {
    const payload = await getYahooCharts();
    yahooChartCache = {
      expiresAt: now + YAHOO_CHART_CACHE_MS,
      payload,
    };
    return {
      ...payload,
      cache: {
        status: "refresh",
        ttlMs: YAHOO_CHART_CACHE_MS,
      },
    };
  } catch (error) {
    if (yahooChartCache.payload) {
      return {
        ...yahooChartCache.payload,
        error: error.message,
        cache: {
          status: "stale",
          ttlMs: 0,
        },
      };
    }
    throw error;
  }
}

function chartDateTime(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function naverChartUrl(symbol) {
  const params = new URLSearchParams({
    startDateTime: chartDateTime(7),
    endDateTime: chartDateTime(0),
  });
  return `${SOURCES.naverChart}/${symbol}/minute?${params}`;
}

function timestampFromNaverLocalDateTime(value) {
  const text = String(value || "");
  if (text.length < 14) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6)) - 1;
  const day = Number(text.slice(6, 8));
  const hour = Number(text.slice(8, 10));
  const minute = Number(text.slice(10, 12));
  const second = Number(text.slice(12, 14));
  return Date.UTC(year, month, day, hour - 9, minute, second);
}

function normalizeNaverChart(payload, target) {
  const rows = Array.isArray(payload) ? payload : [];
  const latestDate = rows.at(-1)?.localDateTime?.slice(0, 8);
  const points = rows
    .filter((row) => !latestDate || row.localDateTime?.startsWith(latestDate))
    .map((row) => ({
      t: timestampFromNaverLocalDateTime(row.localDateTime),
      v: row.currentPrice,
    }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));

  return {
    id: target.id,
    name: target.name,
    symbol: target.symbol,
    source: `https://finance.naver.com/sise/sise_index.naver?code=${target.symbol}`,
    fetchedAt: new Date().toISOString(),
    points,
  };
}

async function getNaverCharts() {
  const settled = await Promise.allSettled(
    NAVER_CHART_TARGETS.map(async (target) => {
      const payload = await tryFetchJson(naverChartUrl(target.symbol));
      return normalizeNaverChart(payload, target);
    }),
  );

  const items = {};
  const notes = [];
  settled.forEach((entry, index) => {
    const target = NAVER_CHART_TARGETS[index];
    if (entry.status === "fulfilled") {
      items[target.id] = entry.value;
      return;
    }
    notes.push(`${target.symbol}: Naver chart fetch failed (${entry.reason.message})`);
  });

  return {
    source: "https://finance.naver.com/",
    sourceLabel: "네이버 금융",
    fetchedAt: new Date().toISOString(),
    interval: "1m",
    range: "recent",
    items,
    notes,
  };
}

async function getCachedNaverCharts() {
  const now = Date.now();
  if (naverChartCache.payload && naverChartCache.expiresAt > now) {
    return {
      ...naverChartCache.payload,
      cache: {
        status: "hit",
        ttlMs: naverChartCache.expiresAt - now,
      },
    };
  }

  try {
    const payload = await getNaverCharts();
    naverChartCache = {
      expiresAt: now + NAVER_CHART_CACHE_MS,
      payload,
    };
    return {
      ...payload,
      cache: {
        status: "refresh",
        ttlMs: NAVER_CHART_CACHE_MS,
      },
    };
  } catch (error) {
    if (naverChartCache.payload) {
      return {
        ...naverChartCache.payload,
        error: error.message,
        cache: {
          status: "stale",
          ttlMs: 0,
        },
      };
    }
    throw error;
  }
}

function pickTranslation(item, key) {
  return item?.translations?.translated?.ko_KR?.[key] || item?.translations?.translated?.ko?.[key] || item?.[key] || "";
}

function valueToText(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    for (const key of ["text", "title", "summary", "description", "content", "body", "ko_KR", "ko"]) {
      const text = valueToText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function normalizeThumbnail(thumbnail) {
  if (!thumbnail) return null;
  if (/^https?:\/\//i.test(thumbnail)) return thumbnail;
  return `https://api.saveticker.com${thumbnail.startsWith("/") ? "" : "/"}${thumbnail}`;
}

function normalizeNewsItem(item) {
  const title = htmlToText(valueToText(pickTranslation(item, "title")));
  const summary = htmlToText(
    valueToText(
      pickTranslation(item, "summary") ||
        pickTranslation(item, "content") ||
        item?.content ||
        "",
    ),
  ).slice(0, 160);

  return {
    id: String(item?.id || ""),
    title,
    summary,
    source: item?.source || "SaveTicker",
    author: item?.author_name || null,
    createdAt: item?.created_at || null,
    viewCount: item?.view_count ?? null,
    tags: Array.isArray(item?.tag_names) ? item.tag_names.slice(0, 3) : [],
    thumbnail: normalizeThumbnail(item?.thumbnail),
    isTopStory: Boolean(item?.is_top_story),
    url: item?.id ? `https://www.saveticker.com/news/detail/${item.id}` : SOURCES.savetickerNews,
  };
}

function newsListFromPayload(payload) {
  return (payload?.news_list || payload?.data || payload?.items || [])
    .map(normalizeNewsItem)
    .filter((item) => item.title);
}

async function getSavetickerNews() {
  const [topPayload, listPayload] = await Promise.all([
    tryFetchJson(`${SOURCES.savetickerApi}/news/top-stories`),
    tryFetchJson(`${SOURCES.savetickerApi}/news/list?page=1&page_size=8&sort=created_at_desc`),
  ]);

  return {
    source: SOURCES.savetickerNews,
    sourceLabel: "SaveTicker",
    fetchedAt: new Date().toISOString(),
    topStories: newsListFromPayload(topPayload).slice(0, 3),
    items: newsListFromPayload(listPayload).slice(0, 6),
  };
}

async function getCachedSavetickerNews() {
  const now = Date.now();
  if (newsCache.payload && newsCache.expiresAt > now) {
    return {
      ...newsCache.payload,
      cache: {
        status: "hit",
        ttlMs: newsCache.expiresAt - now,
      },
    };
  }

  try {
    const payload = await getSavetickerNews();
    newsCache = {
      expiresAt: now + NEWS_CACHE_MS,
      payload,
    };
    return {
      ...payload,
      cache: {
        status: "refresh",
        ttlMs: NEWS_CACHE_MS,
      },
    };
  } catch (error) {
    if (newsCache.payload) {
      return {
        ...newsCache.payload,
        error: error.message,
        cache: {
          status: "stale",
          ttlMs: 0,
        },
      };
    }
    throw error;
  }
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

export async function getQuotes() {
  const settled = await Promise.allSettled([
    getKospilab(),
    getNightFutures(),
    getCachedSavetickerNews(),
    getCachedYahooCharts(),
    getCachedNaverCharts(),
  ]);
  const [kospilab, nightFutures, news, yahooCharts, naverCharts] = settled.map((entry) =>
    entry.status === "fulfilled" ? entry.value : { error: entry.reason.message },
  );

  return {
    refreshedAt: new Date().toISOString(),
    intervalMs: 10000,
    sources: [
      { label: "KOSPI LAB", url: SOURCES.kospilab },
      { label: "eSignal 코스피 200 야간 선물", url: SOURCES.esignalNight },
      { label: "네이버 금융 지수 fallback", url: SOURCES.naverIndex },
      { label: "네이버 금융 1분 차트", url: "https://finance.naver.com/" },
      { label: "Yahoo Finance 지수 fallback", url: "https://finance.yahoo.com/" },
      { label: "Yahoo Finance 1분 차트", url: "https://finance.yahoo.com/" },
      { label: "SaveTicker 뉴스", url: SOURCES.savetickerNews },
    ],
    kospilab,
    nightFutures,
    news,
    yahooCharts,
    naverCharts,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}
