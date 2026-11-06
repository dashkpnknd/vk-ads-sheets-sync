const DEFAULT_HOST = "https://ads.vk.com";

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function collectMetricRows(payload) {
  if (Array.isArray(payload?.items)) {
    return payload.items.flatMap((item) => {
      if (Array.isArray(item.rows)) return item.rows;
      if (Array.isArray(item.metrics)) return item.metrics;
      return [item];
    });
  }
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload)) return payload;
  return [];
}

export function buildStatisticsUrl({
  host = DEFAULT_HOST,
  level = "ad_groups",
  period = "day",
  dateFrom,
  dateTo,
  metrics,
  ids = [],
}) {
  const url = new URL(`/api/v2/statistics/${level}/${period}.json`, host);
  url.searchParams.set("date_from", dateFrom);
  url.searchParams.set("date_to", dateTo);
  url.searchParams.set("metrics", metrics.join(","));
  if (ids.length) {
    url.searchParams.set("id__in", ids.join(","));
  }
  return url.toString();
}

export async function requestAccessToken({
  host = DEFAULT_HOST,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${host}/api/v2/oauth2/token.json`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`VK token request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  if (!data.access_token) {
    throw new Error(`VK token response has no access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export function normalizeStatisticsResponse(
  payload,
  { spendMetric = "spent", leadsMetric = "goals" } = {},
) {
  const rows = collectMetricRows(payload);
  return rows.reduce(
    (total, row) => {
      const metrics = row.metrics || row;
      total.spend += numberValue(metrics[spendMetric]);
      total.leads += numberValue(metrics[leadsMetric]);
      return total;
    },
    { spend: 0, leads: 0 },
  );
}

export async function fetchVkAdsStats({
  credentials,
  date,
  level = "ad_groups",
  period = "day",
  metrics = ["spent", "goals"],
  spendMetric = "spent",
  leadsMetric = "goals",
  ids = [],
  fetchImpl = fetch,
}) {
  const host = credentials.host || DEFAULT_HOST;
  const token = await requestAccessToken({
    host,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    fetchImpl,
  });
  const url = buildStatisticsUrl({
    host,
    level,
    period,
    dateFrom: date,
    dateTo: date,
    metrics,
    ids,
  });
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`VK statistics request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return normalizeStatisticsResponse(data, { spendMetric, leadsMetric });
}

export async function fetchAgencyClients({
  credentials,
  limit,
  offset,
  query,
  fetchImpl = fetch,
}) {
  const host = credentials.host || DEFAULT_HOST;
  const token = await requestAccessToken({
    host,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    fetchImpl,
  });
  const url = new URL("/api/v2/agency/clients.json", host);
  if (limit != null) url.searchParams.set("limit", String(limit));
  if (offset != null) url.searchParams.set("offset", String(offset));
  if (query) url.searchParams.set("_q", query);

  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`VK agency clients request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const items = data.items || data.results || [];
  return items.map((item) => {
    const user = item.user || item._user || item;
    return {
      id: user.id,
      username: user.username,
      clientName: user.additional_info?.client_name || user.client_name || user.username,
      accessType: item.access_type,
      relationStatus: item.status,
      userStatus: user.status,
    };
  });
}
