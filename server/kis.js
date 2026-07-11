const KIS_DEFAULT_API_BASE = "https://openapi.koreainvestment.com:9443";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

let tokenCache = {
  accessToken: null,
  tokenType: "Bearer",
  expiresAt: 0,
  expiresIn: null,
};

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

async function kisRequest(path, { trId, params = {} } = {}) {
  const { apiBase, appKey, appSecret } = kisConfig();
  const token = await issueKisToken();
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

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
