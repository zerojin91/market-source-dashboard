const TOSS_DEFAULT_API_BASE = "https://openapi.tossinvest.com";
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

let tokenCache = {
  accessToken: null,
  tokenType: null,
  expiresAt: 0,
  expiresIn: null,
};

function tossConfig() {
  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  const apiBase = (process.env.TOSS_API_BASE || TOSS_DEFAULT_API_BASE).replace(/\/+$/, "");

  if (!clientId || !clientSecret) {
    const missing = [
      !clientId ? "TOSS_CLIENT_ID" : null,
      !clientSecret ? "TOSS_CLIENT_SECRET" : null,
    ].filter(Boolean);
    throw new Error(`Missing Toss environment variables: ${missing.join(", ")}`);
  }

  return { apiBase, clientId, clientSecret };
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

function tossErrorMessage(status, body) {
  const code = body?.error?.code || body?.error || `HTTP ${status}`;
  const message = body?.error?.message || body?.error_description || body?.message || "Toss API request failed";
  return `${code}: ${message}`;
}

export async function issueTossToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return {
      accessToken: tokenCache.accessToken,
      tokenType: tokenCache.tokenType,
      expiresIn: tokenCache.expiresIn,
      cache: "hit",
    };
  }

  const { apiBase, clientId, clientSecret } = tossConfig();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(`${apiBase}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body,
  });
  const payload = await parseResponseBody(response);

  if (!response.ok) {
    const error = new Error(tossErrorMessage(response.status, payload));
    error.status = response.status;
    error.details = {
      code: payload?.error?.code || payload?.error || null,
      message: payload?.error?.message || payload?.error_description || payload?.message || null,
    };
    throw error;
  }

  if (!payload?.access_token) {
    throw new Error("Toss token response did not include access_token");
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

export async function checkTossToken() {
  const token = await issueTossToken({ forceRefresh: true });
  return {
    ok: true,
    tokenType: token.tokenType,
    expiresIn: token.expiresIn,
    cache: token.cache,
    checkedAt: new Date().toISOString(),
  };
}
