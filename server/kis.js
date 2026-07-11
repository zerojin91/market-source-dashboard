import { inflateRawSync } from "node:zlib";

const KIS_DEFAULT_API_BASE = "https://openapi.koreainvestment.com:9443";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MASTER_CACHE_MS = 6 * 60 * 60 * 1000;
const WATCHLIST_CACHE_MS = 5 * 1000;
const CHART_CACHE_MS = 30 * 60 * 1000;
const KIS_REQUEST_GAP_MS = 1400;
const KIS_CHART_REQUEST_GAP_MS = 450;
const INTRADAY_CHART_START_TIME = "090000";
const INTRADAY_CHART_END_TIME = "200000";
const INTRADAY_CHART_MAX_PAGES = 24;

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
};

const WATCHLIST_TARGETS = [
  { id: "sk", name: "SK", logo: "SK", logoTone: "red" },
  { id: "ecopro", name: "에코프로", logo: "Eco", logoTone: "blue" },
  { id: "tiger-200it-leverage", name: "TIGER 200IT레버리지", logo: "2x", logoTone: "orange" },
  { id: "kodex-semiconductor-leverage", name: "KODEX 반도체레버리지", logo: "2x", logoTone: "indigo" },
  { id: "sk-hynix", name: "SK하이닉스", logo: "SK", logoTone: "red" },
  { id: "samsung-electronics", name: "삼성전자", logo: "SAMSUNG", logoTone: "navy" },
];

let tokenCache = {
  accessToken: null,
  tokenType: "Bearer",
  expiresAt: 0,
  expiresIn: null,
};

let masterCache = {
  expiresAt: 0,
  items: null,
};

let watchlistCache = {
  expiresAt: 0,
  payload: null,
};

let chartCache = new Map();
let lastKisRequestAt = 0;

const INDEX_TARGETS = [
  { id: "kospi", name: "KOSPI", code: "0001" },
  { id: "kosdaq", name: "KOSDAQ", code: "1001" },
  { id: "kospi-200", name: "KOSPI 200", code: "2001" },
];

const STOCK_TARGETS = [
  { id: "samsung-electronics", name: "삼성전자", symbol: "005930" },
  { id: "sk-hynix", name: "SK하이닉스", symbol: "000660" },
  { id: "hyundai-motor", name: "현대차", symbol: "005380" },
  { id: "lg-energy-solution", name: "LG에너지솔루션", symbol: "373220" },
];

function envValue(name) {
  const value = process.env[name];
  if (!value) return "";
  return value.startsWith(`${name}=`) ? value.slice(name.length + 1) : value;
}

function kisConfig() {
  const appKey = envValue("KIS_APP_KEY");
  const appSecret = envValue("KIS_APP_SECRET");
  const apiBase = (envValue("KIS_BASE_URL") || KIS_DEFAULT_API_BASE).replace(/\/+$/, "");

  if (!appKey || !appSecret) {
    const missing = [
      !appKey ? "KIS_APP_KEY" : null,
      !appSecret ? "KIS_APP_SECRET" : null,
    ].filter(Boolean);
    throw new Error(`Missing KIS environment variables: ${missing.join(", ")}`);
  }

  return { apiBase, appKey, appSecret };
}

function kisAccountConfig() {
  const accountNo = envValue("KIS_ACCOUNT_NO");
  const productCode = envValue("KIS_ACCOUNT_PRODUCT_CODE");

  if (!accountNo || !productCode) {
    const missing = [
      !accountNo ? "KIS_ACCOUNT_NO" : null,
      !productCode ? "KIS_ACCOUNT_PRODUCT_CODE" : null,
    ].filter(Boolean);
    throw new Error(`Missing KIS account environment variables: ${missing.join(", ")}`);
  }

  return { accountNo, productCode };
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function kisErrorMessage(status, body) {
  const code = body?.msg_cd || body?.rt_cd || `HTTP ${status}`;
  const message = body?.msg1 || body?.message || body?.raw || "KIS API request failed";
  return `${code}: ${message}`;
}

function isSuccessfulKisBody(body) {
  return !body || body.rt_cd === undefined || body.rt_cd === "0";
}

export async function issueKisToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return {
      accessToken: tokenCache.accessToken,
      tokenType: tokenCache.tokenType,
      expiresIn: tokenCache.expiresIn,
      cache: "hit",
    };
  }

  const { apiBase, appKey, appSecret } = kisConfig();
  const response = await fetch(`${apiBase}/oauth2/tokenP`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "accept": "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      appsecret: appSecret,
    }),
  });
  const payload = await parseResponseBody(response);

  if (!response.ok || !isSuccessfulKisBody(payload)) {
    const error = new Error(kisErrorMessage(response.status, payload));
    error.status = response.status;
    error.details = {
      rtCd: payload?.rt_cd || null,
      msgCd: payload?.msg_cd || null,
      message: payload?.msg1 || payload?.message || null,
    };
    throw error;
  }

  if (!payload?.access_token) {
    throw new Error("KIS token response did not include access_token");
  }

  const expiresIn = Number(payload.expires_in || 0);
  tokenCache = {
    accessToken: payload.access_token,
    tokenType: payload.token_type || "Bearer",
    expiresIn,
    expiresAt: now + Math.max(expiresIn, 1) * 1000,
  };

  return {
    accessToken: tokenCache.accessToken,
    tokenType: tokenCache.tokenType,
    expiresIn: tokenCache.expiresIn,
    cache: "refresh",
  };
}

async function kisRequest(path, { trId, params = {}, paceMs = KIS_REQUEST_GAP_MS } = {}) {
  const { apiBase, appKey, appSecret } = kisConfig();
  const token = await issueKisToken();
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const elapsed = Date.now() - lastKisRequestAt;
  if (elapsed < paceMs) await wait(paceMs - elapsed);
  lastKisRequestAt = Date.now();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "authorization": `${token.tokenType} ${token.accessToken}`,
      "appkey": appKey,
      "appsecret": appSecret,
      "tr_id": trId,
      "custtype": "P",
    },
  });
  const payload = await parseResponseBody(response);

  if (!response.ok || !isSuccessfulKisBody(payload)) {
    const error = new Error(kisErrorMessage(response.status, payload));
    error.status = response.status;
    error.details = {
      rtCd: payload?.rt_cd || null,
      msgCd: payload?.msg_cd || null,
      message: payload?.msg1 || payload?.message || null,
    };
    throw error;
  }

  return payload;
}

function numberLike(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, options = {}) {
  const number = numberLike(value);
  if (number === null) return null;
  return number.toLocaleString("ko-KR", options);
}

function signedNumber(value, options = {}) {
  const number = numberLike(value);
  if (number === null) return null;
  return `${number > 0 ? "+" : ""}${number.toLocaleString("ko-KR", options)}`;
}

function signedPercent(value) {
  const number = numberLike(value);
  if (number === null) return null;
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function maskAccountNo(accountNo) {
  if (!accountNo) return null;
  return `${String(accountNo).slice(0, 2)}****${String(accountNo).slice(-2)}`;
}

function normalizeStockPrice(target, output = {}) {
  return {
    id: target.id,
    name: target.name,
    symbol: target.symbol,
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    section: "국내 주식",
    status: output.iscd_stat_cls_code ? `상태 ${output.iscd_stat_cls_code}` : "조회 완료",
    value: formatNumber(output.stck_prpr),
    change: signedNumber(output.prdy_vrss),
    percent: signedPercent(output.prdy_ctrt),
    open: formatNumber(output.stck_oprc),
    high: formatNumber(output.stck_hgpr),
    low: formatNumber(output.stck_lwpr),
    volume: formatNumber(output.acml_vol),
    amount: formatNumber(output.acml_tr_pbmn),
    updatedAt: output.stck_shrn_iscd || target.symbol,
    raw: output,
  };
}

function normalizeWatchlistQuote(target, output = {}) {
  const current = output.stck_prpr || output.inter2_prpr || output.last || output.nav || output.etf_prpr;
  const change = output.prdy_vrss || output.inter2_prdy_vrss || output.bstp_nmix_prdy_vrss || output.nav_prdy_vrss;
  const percent = output.prdy_ctrt || output.bstp_nmix_prdy_ctrt || output.nav_prdy_ctrt;
  const volume = output.acml_vol || output.hts_avls || output.total_vol;

  return {
    value: formatNumber(current),
    change: signedNumber(change),
    percent: signedPercent(percent),
    volume: formatNumber(volume),
    raw: output,
  };
}

function normalizeIndexPrice(target, output = {}) {
  const value = output.bstp_nmix_prpr || output.bstp_nmix || output.stck_prpr;
  const change = output.bstp_nmix_prdy_vrss || output.prdy_vrss;
  const percent = output.prdy_ctrt || output.bstp_nmix_prdy_ctrt;

  return {
    id: target.id,
    name: target.name,
    symbol: target.code,
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    section: "지수",
    status: "조회 완료",
    value: formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    change: signedNumber(change, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    percent: signedPercent(percent),
    open: formatNumber(output.bstp_nmix_oprc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    high: formatNumber(output.bstp_nmix_hgpr, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    low: formatNumber(output.bstp_nmix_lwpr, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    volume: formatNumber(output.acml_vol),
    amount: formatNumber(output.acml_tr_pbmn),
    raw: output,
  };
}

async function getStockPrice(target) {
  const payload = await kisRequest("/uapi/domestic-stock/v1/quotations/inquire-price", {
    trId: "FHKST01010100",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: target.symbol,
    },
  });
  return normalizeStockPrice(target, payload.output);
}

async function getEtfPrice(target) {
  const payload = await kisRequest("/uapi/etfetn/v1/quotations/inquire-price", {
    trId: "FHPST02400000",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: target.symbol,
    },
  });
  return normalizeWatchlistQuote(target, payload.output);
}

function chartDate(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

function koreaClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function minuteChartEndTime() {
  const parts = koreaClockParts();
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const current = hour * 10000 + minute * 100 + second;
  const isWeekday = !["Sat", "Sun"].includes(parts.weekday);
  if (!isWeekday || current > Number(INTRADAY_CHART_END_TIME)) return INTRADAY_CHART_END_TIME;
  if (current < Number(INTRADAY_CHART_START_TIME)) return INTRADAY_CHART_START_TIME;
  return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}${String(second).padStart(2, "0")}`;
}

function oneSecondBeforeTime(time) {
  const text = String(time || "").padStart(6, "0");
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  const second = Number(text.slice(4, 6));
  const total = Math.max(hour * 3600 + minute * 60 + second - 1, 0);
  return [
    String(Math.floor(total / 3600)).padStart(2, "0"),
    String(Math.floor((total % 3600) / 60)).padStart(2, "0"),
    String(total % 60).padStart(2, "0"),
  ].join("");
}

function normalizeDailyChartPoints(output = []) {
  return (Array.isArray(output) ? output : [])
    .map((row) => {
      const date = row.stck_bsop_date || row.bsop_date || row.date;
      const value = numberLike(row.stck_clpr || row.clpr || row.stck_prpr || row.nav);
      if (!date || value === null) return null;
      const year = Number(String(date).slice(0, 4));
      const month = Number(String(date).slice(4, 6)) - 1;
      const day = Number(String(date).slice(6, 8));
      return {
        t: Date.UTC(year, month, day, 6, 30, 0),
        v: value,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

function normalizeMinuteChartPoints(output = []) {
  const seen = new Set();
  return (Array.isArray(output) ? output : [])
    .map((row) => {
      const date = row.stck_bsop_date || row.bsop_date || row.date;
      const time = row.stck_cntg_hour || row.cntg_hour || row.time;
      const value = numberLike(row.stck_prpr || row.stck_clpr || row.clpr || row.nav);
      if (!date || !time || value === null) return null;
      const key = `${date}${time}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const year = Number(String(date).slice(0, 4));
      const month = Number(String(date).slice(4, 6)) - 1;
      const day = Number(String(date).slice(6, 8));
      const hour = Number(String(time).slice(0, 2));
      const minute = Number(String(time).slice(2, 4));
      const second = Number(String(time).slice(4, 6));
      return {
        t: Date.UTC(year, month, day, hour - 9, minute, second),
        v: value,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

function minutePointDateKey(point) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(point.t));
}

function minutePointTimeKey(point) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(point.t)).replace(/:/g, "");
}

async function getDailyChart(target) {
  const cacheKey = `daily:${target.symbol}`;
  const cached = chartCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.points;

  const payload = await kisRequest("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", {
    trId: "FHKST03010100",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: target.symbol,
      FID_INPUT_DATE_1: chartDate(30),
      FID_INPUT_DATE_2: chartDate(0),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "1",
    },
  });

  const points = normalizeDailyChartPoints(payload.output2);
  chartCache.set(cacheKey, {
    expiresAt: now + CHART_CACHE_MS,
    points,
  });
  return points;
}

async function getIntradayChart(target) {
  const cacheKey = `intraday:${target.symbol}`;
  const cached = chartCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.points;

  const pointsByKey = new Map();
  let tradingDay = null;
  let endTime = minuteChartEndTime();

  for (let page = 0; page < INTRADAY_CHART_MAX_PAGES; page += 1) {
    const payload = await kisRequest("/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice", {
      trId: "FHKST03010200",
      paceMs: KIS_CHART_REQUEST_GAP_MS,
      params: {
        FID_ETC_CLS_CODE: "00",
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: target.symbol,
        FID_INPUT_HOUR_1: endTime,
        FID_PW_DATA_INCU_YN: "N",
      },
    });

    const pagePoints = normalizeMinuteChartPoints(payload.output2);
    if (!pagePoints.length) break;

    const latestPoint = pagePoints.at(-1);
    tradingDay ||= minutePointDateKey(latestPoint);
    const sameDayPoints = pagePoints.filter((point) => minutePointDateKey(point) === tradingDay);
    if (!sameDayPoints.length) break;

    for (const point of sameDayPoints) {
      pointsByKey.set(`${point.t}`, point);
    }

    const earliestTime = minutePointTimeKey(sameDayPoints[0]);
    if (earliestTime <= INTRADAY_CHART_START_TIME) break;

    const nextEndTime = oneSecondBeforeTime(earliestTime);
    if (nextEndTime >= endTime) break;
    endTime = nextEndTime;
  }

  const points = [...pointsByKey.values()].sort((a, b) => a.t - b.t);
  chartCache.set(cacheKey, {
    expiresAt: now + CHART_CACHE_MS,
    points,
  });
  return points;
}

async function getWatchlistChart(target) {
  const points = await getIntradayChart(target);
  if (points.length) return points;
  return getDailyChart(target);
}

function getCachedWatchlistChart(target) {
  return chartCache.get(`intraday:${target.symbol}`)?.points || [];
}

export async function getKisIntradayChart(symbol) {
  const normalizedSymbol = String(symbol || "").trim();
  if (!/^\d{6}$/.test(normalizedSymbol)) {
    const error = new Error("symbol은 6자리 종목코드여야 합니다.");
    error.status = 400;
    throw error;
  }

  const points = await getIntradayChart({ symbol: normalizedSymbol });
  return {
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    symbol: normalizedSymbol,
    chartPoints: points,
    intervalMs: CHART_CACHE_MS,
    refreshedAt: new Date().toISOString(),
  };
}

async function getWatchlistPrice(target) {
  if (target.isEtp) return getEtfPrice(target);
  return normalizeWatchlistQuote(target, (await kisRequest("/uapi/domestic-stock/v1/quotations/inquire-price", {
    trId: "FHKST01010100",
    params: {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: target.symbol,
    },
  })).output);
}

async function getWatchlistMultiPrices(targets) {
  const params = {};
  targets.forEach((target, index) => {
    const number = index + 1;
    params[`FID_COND_MRKT_DIV_CODE_${number}`] = "J";
    params[`FID_INPUT_ISCD_${number}`] = target.symbol;
  });

  const payload = await kisRequest("/uapi/domestic-stock/v1/quotations/intstock-multprice", {
    trId: "FHKST11300006",
    params,
  });

  const output = Array.isArray(payload.output)
    ? payload.output
    : Array.isArray(payload.output1)
      ? payload.output1
      : payload.output
        ? [payload.output]
        : [];

  return targets.map((target, index) => {
    const row = output.find((item) =>
      item.stck_shrn_iscd === target.symbol ||
      item.inter_shrn_iscd === target.symbol ||
      item.mksc_shrn_iscd === target.symbol ||
      item.jong_code === target.symbol ||
      item.pdno === target.symbol,
    ) || output[index] || {};
    return [target.id, normalizeWatchlistQuote(target, row)];
  });
}

async function getIndexPrice(target) {
  const payload = await kisRequest("/uapi/domestic-stock/v1/quotations/inquire-index-price", {
    trId: "FHPUP02100000",
    params: {
      FID_COND_MRKT_DIV_CODE: "U",
      FID_INPUT_ISCD: target.code,
    },
  });
  return normalizeIndexPrice(target, payload.output);
}

function extractFirstZipFile(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("KIS master zip did not start with a local file header");
  }

  const flags = buffer.readUInt16LE(6);
  const method = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const fileNameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const dataStart = 30 + fileNameLength + extraLength;

  if ((flags & 0x08) !== 0) {
    throw new Error("KIS master zip uses a data descriptor that is not supported");
  }

  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`Unsupported KIS master zip compression method: ${method}`);
}

function parseFixedWidth(text, widths, columns) {
  const values = {};
  let offset = 0;
  columns.forEach((column, index) => {
    const width = widths[index];
    values[column] = text.slice(offset, offset + width).trim();
    offset += width;
  });
  return values;
}

const KOSPI_WIDTHS = [
  2, 1, 4, 4, 4,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 9, 5, 5, 1,
  1, 1, 2, 1, 1,
  1, 2, 2, 2, 3,
  1, 3, 12, 12, 8,
  15, 21, 2, 7, 1,
  1, 1, 1, 1, 9,
  9, 9, 5, 9, 8,
  9, 3, 1, 1, 1,
];
const KOSPI_COLUMNS = ["그룹코드", "시가총액규모", "지수업종대분류", "지수업종중분류", "지수업종소분류", "제조업", "저유동성", "지배구조지수종목", "KOSPI200섹터업종", "KOSPI100", "KOSPI50", "KRX", "ETP", "ELW발행", "KRX100", "KRX자동차", "KRX반도체", "KRX바이오", "KRX은행", "SPAC", "KRX에너지화학", "KRX철강", "단기과열", "KRX미디어통신", "KRX건설", "Non1", "KRX증권", "KRX선박", "KRX섹터_보험", "KRX섹터_운송", "SRI", "기준가", "매매수량단위", "시간외수량단위", "거래정지", "정리매매", "관리종목", "시장경고", "경고예고", "불성실공시", "우회상장", "락구분", "액면변경", "증자구분", "증거금비율", "신용가능", "신용기간", "전일거래량", "액면가", "상장일자", "상장주수", "자본금", "결산월", "공모가", "우선주", "공매도과열", "이상급등", "KRX300", "KOSPI", "매출액", "영업이익", "경상이익", "당기순이익", "ROE", "기준년월", "시가총액", "그룹사코드", "회사신용한도초과", "담보대출가능", "대주가능"];

const KOSDAQ_WIDTHS = [
  2, 1,
  4, 4, 4, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 9,
  5, 5, 1, 1, 1,
  2, 1, 1, 1, 2,
  2, 2, 3, 1, 3,
  12, 12, 8, 15, 21,
  2, 7, 1, 1, 1,
  1, 9, 9, 9, 5,
  9, 8, 9, 3, 1,
  1, 1,
];
const KOSDAQ_COLUMNS = ["증권그룹구분코드", "시가총액규모", "지수업종대분류", "지수업종중분류", "지수업종소분류", "벤처기업", "저유동성", "KRX", "ETP", "KRX100", "KRX자동차", "KRX반도체", "KRX바이오", "KRX은행", "SPAC", "KRX에너지화학", "KRX철강", "단기과열", "KRX미디어통신", "KRX건설", "투자주의환기", "KRX증권", "KRX선박", "KRX섹터_보험", "KRX섹터_운송", "KOSDAQ150", "기준가", "매매수량단위", "시간외수량단위", "거래정지", "정리매매", "관리종목", "시장경고", "경고예고", "불성실공시", "우회상장", "락구분", "액면변경", "증자구분", "증거금비율", "신용가능", "신용기간", "전일거래량", "액면가", "상장일자", "상장주수", "자본금", "결산월", "공모가", "우선주", "공매도과열", "이상급등", "KRX300", "매출액", "영업이익", "경상이익", "당기순이익", "ROE", "기준년월", "시가총액", "그룹사코드", "회사신용한도초과", "담보대출가능", "대주가능"];

async function downloadMaster(market) {
  const response = await fetch(MASTER_URLS[market], {
    headers: {
      "user-agent": "MarketSourceDashboard/0.1",
    },
  });
  if (!response.ok) throw new Error(`${market} master download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const mst = extractFirstZipFile(buffer);
  return new TextDecoder("euc-kr").decode(mst);
}

function parseMasterText(market, text) {
  const isKospi = market === "KOSPI";
  const widths = isKospi ? KOSPI_WIDTHS : KOSDAQ_WIDTHS;
  const columns = isKospi ? KOSPI_COLUMNS : KOSDAQ_COLUMNS;
  const tailLength = widths.reduce((total, width) => total + width, 0);

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const head = line.slice(0, line.length - tailLength);
      const fields = parseFixedWidth(line.slice(-tailLength), widths, columns);
      return {
        market,
        symbol: head.slice(0, 9).trim(),
        standardCode: head.slice(9, 21).trim(),
        name: head.slice(21).trim(),
        basePrice: formatNumber(fields["기준가"]),
        previousVolume: numberLike(fields["전일거래량"]),
        previousVolumeLabel: formatNumber(fields["전일거래량"]),
        listedAt: fields["상장일자"] || null,
        marketCap: formatNumber(fields["시가총액"]),
        roe: fields["ROE"] || null,
        isEtp: fields["ETP"] === "Y",
        status: {
          halted: fields["거래정지"] === "Y",
          watch: fields["관리종목"] === "Y",
          warning: fields["시장경고"] || null,
        },
        rawMaster: fields,
      };
    });
}

async function getStockMaster() {
  const now = Date.now();
  if (masterCache.items && masterCache.expiresAt > now) return masterCache.items;

  const markets = await Promise.all(
    Object.keys(MASTER_URLS).map(async (market) => parseMasterText(market, await downloadMaster(market))),
  );
  const items = markets.flat();
  masterCache = {
    expiresAt: now + MASTER_CACHE_MS,
    items,
  };
  return items;
}

function findMasterItem(masterItems, name) {
  return masterItems.find((item) => item.name === name) || masterItems.find((item) => item.name.includes(name));
}

function formatVolumeCompare(currentVolume, previousVolume) {
  const current = numberLike(currentVolume);
  const previous = numberLike(previousVolume);
  if (current === null || previous === null || previous <= 0) return null;
  return `${((current / previous) * 100).toFixed(2)}%`;
}

function watchlistTargetFromMaster(target, masterItem) {
  if (!masterItem) return null;
  return {
    ...target,
    ...masterItem,
    id: target.id,
    name: masterItem.name,
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
  };
}

function normalizeWatchlistRow(target, quote, chartPoints = []) {
  return {
    id: target.id,
    name: target.name,
    symbol: target.symbol,
    standardCode: target.standardCode,
    market: target.market,
    category: "domestic",
    logo: target.logo,
    logoTone: target.logoTone,
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    value: quote.value,
    percent: quote.percent,
    change: quote.change,
    volume: quote.volume,
    volumeCompare: formatVolumeCompare(quote.volume, target.previousVolume),
    basePrice: target.basePrice,
    previousVolume: target.previousVolumeLabel,
    marketCap: target.marketCap,
    listedAt: target.listedAt,
    isEtp: target.isEtp,
    chartPoints,
    status: "KIS 시세 조회 완료",
    raw: {
      quote: quote.raw,
      master: target.rawMaster,
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleItems(targets, fetcher) {
  const items = [];
  const errors = [];

  for (const target of targets) {
    try {
      items.push(await fetcher(target));
    } catch (error) {
      errors.push({
        id: target.id,
        name: target.name,
        message: error.message,
        details: error.details || null,
      });
    }
    await wait(180);
  }

  return { items, errors };
}

export async function checkKisToken() {
  const token = await issueKisToken();
  return {
    ok: true,
    tokenType: token.tokenType,
    expiresIn: token.expiresIn,
    cache: token.cache,
    checkedAt: new Date().toISOString(),
  };
}

export async function getKisDashboard() {
  const [indices, stocks] = await Promise.all([
    settleItems(INDEX_TARGETS, getIndexPrice),
    settleItems(STOCK_TARGETS, getStockPrice),
  ]);

  return {
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    refreshedAt: new Date().toISOString(),
    intervalMs: 10000,
    indices: indices.items,
    stocks: stocks.items,
    errors: [...indices.errors, ...stocks.errors],
  };
}

export async function getKisWatchlist() {
  const now = Date.now();
  if (watchlistCache.payload && watchlistCache.expiresAt > now) {
    return {
      ...watchlistCache.payload,
      cache: {
        status: "hit",
        ttlMs: watchlistCache.expiresAt - now,
      },
    };
  }

  const masterItems = await getStockMaster();
  const targets = WATCHLIST_TARGETS.map((target) => watchlistTargetFromMaster(target, findMasterItem(masterItems, target.name)));
  const rows = [];
  const errors = [];
  const validTargets = targets.filter(Boolean);
  const quoteById = new Map();
  const chartById = new Map();

  for (const target of WATCHLIST_TARGETS) {
    if (!validTargets.find((item) => item.id === target.id)) {
      errors.push({
        id: target.id,
        name: target.name,
        step: "master",
        message: "stocks_info master에서 종목을 찾지 못했습니다.",
      });
    }
  }

  try {
    const quotes = await getWatchlistMultiPrices(validTargets);
    for (const [id, quote] of quotes) quoteById.set(id, quote);
  } catch (error) {
    errors.push({
      step: "quote",
      message: error.message,
      details: error.details || null,
    });
  }

  for (const target of validTargets) {
    chartById.set(target.id, getCachedWatchlistChart(target));
  }

  for (const target of validTargets) {
    if (!target) {
      errors.push({
        name: target?.name || "unknown",
        message: "stocks_info master에서 종목을 찾지 못했습니다.",
      });
      continue;
    }

    const quote = quoteById.get(target.id);
    const chartPoints = chartById.get(target.id) || [];
    try {
      if (!quote) throw new Error("KIS 멀티 시세 응답에 종목 값이 없습니다.");
      rows.push(normalizeWatchlistRow(target, quote, chartPoints));
    } catch (error) {
      errors.push({
        id: target.id,
        name: target.name,
        symbol: target.symbol,
        step: "quote",
        message: error.message,
        details: error.details || null,
      });
      rows.push({
        id: target.id,
        name: target.name,
        symbol: target.symbol,
        standardCode: target.standardCode,
        market: target.market,
        category: "domestic",
        logo: target.logo,
        logoTone: target.logoTone,
        source: "KIS Developers",
        sourceLabel: "한국투자증권",
        value: null,
        percent: null,
        change: null,
        volume: null,
        volumeCompare: null,
        basePrice: target.basePrice,
        previousVolume: target.previousVolumeLabel,
        marketCap: target.marketCap,
        listedAt: target.listedAt,
        isEtp: target.isEtp,
        chartPoints: [],
        status: `KIS 시세 조회 실패: ${error.message}`,
      });
    }
  }

  const payload = {
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    masterSource: "https://github.com/koreainvestment/open-trading-api/tree/main/stocks_info",
    refreshedAt: new Date().toISOString(),
    intervalMs: WATCHLIST_CACHE_MS,
    rows,
    errors,
  };

  watchlistCache = {
    expiresAt: now + WATCHLIST_CACHE_MS,
    payload,
  };

  return {
    ...payload,
    cache: {
      status: "refresh",
      ttlMs: WATCHLIST_CACHE_MS,
    },
  };
}

function normalizeBalanceItem(item = {}) {
  return {
    symbol: item.pdno || null,
    name: item.prdt_name || null,
    quantity: formatNumber(item.hldg_qty),
    sellableQuantity: formatNumber(item.ord_psbl_qty),
    averagePrice: formatNumber(item.pchs_avg_pric),
    currentPrice: formatNumber(item.prpr),
    purchaseAmount: formatNumber(item.pchs_amt),
    evaluationAmount: formatNumber(item.evlu_amt),
    profitLoss: signedNumber(item.evlu_pfls_amt),
    profitLossRate: signedPercent(item.evlu_pfls_rt),
    raw: item,
  };
}

function normalizeBalanceSummary(summary = {}) {
  return {
    purchaseAmount: formatNumber(summary.pchs_amt_smtl_amt),
    evaluationAmount: formatNumber(summary.tot_evlu_amt),
    profitLoss: signedNumber(summary.evlu_pfls_smtl_amt),
    profitLossRate: signedPercent(summary.asst_icdc_erng_rt),
    cash: formatNumber(summary.dnca_tot_amt),
    totalAmount: formatNumber(summary.tot_evlu_amt),
    raw: summary,
  };
}

export async function getKisBalance() {
  const { accountNo, productCode } = kisAccountConfig();
  const payload = await kisRequest("/uapi/domestic-stock/v1/trading/inquire-balance", {
    trId: "TTTC8434R",
    params: {
      CANO: accountNo,
      ACNT_PRDT_CD: productCode,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "01",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    },
  });

  return {
    ok: true,
    source: "KIS Developers",
    sourceLabel: "한국투자증권",
    account: {
      accountNo: maskAccountNo(accountNo),
      productCode,
    },
    refreshedAt: new Date().toISOString(),
    holdings: (Array.isArray(payload.output1) ? payload.output1 : []).map(normalizeBalanceItem),
    summary: normalizeBalanceSummary(Array.isArray(payload.output2) ? payload.output2[0] : payload.output2),
  };
}
