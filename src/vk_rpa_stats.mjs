const HOST = "https://ads.vk.ru";
const AD_PLAN_FIELDS = [
  "id",
  "name",
  "status",
  "delivery",
  "budget_limit",
  "budget_limit_day",
  "created",
  "date_end",
  "date_start",
  "objective",
  "stats_info",
  "campaigns",
];

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeStatsBase(base = {}) {
  return {
    spend: numberValue(base.spent),
    leads: numberValue(base.vk?.result ?? base.goals),
    shows: numberValue(base.shows),
    clicks: numberValue(base.clicks),
  };
}

export function vkDate(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${date}`);
  const [, , month, day] = match;
  return `${day}.${month}.${match[1]}`;
}

export function buildAdPlansUrl({ accountId, sudo }) {
  const url = new URL("/proxy/mt/v2/ad_plans.json", HOST);
  url.searchParams.set("fields", AD_PLAN_FIELDS.join(","));
  // Historical backfills must include campaigns that have ended since the target date.
  url.searchParams.set("sorting", "-id");
  url.searchParams.set("limit", "50");
  url.searchParams.set("offset", "0");
  url.searchParams.set("account", accountId);
  if (sudo) url.searchParams.set("sudo", sudo);
  return url.toString();
}

export function buildDashboardStatsUrl({ accountId, date, adPlanIds, sudo }) {
  const url = new URL("/proxy/mt/v3/statistics/ad_plans/day.json", HOST);
  url.searchParams.set("date_from", vkDate(date));
  url.searchParams.set("date_to", vkDate(date));
  url.searchParams.set("attribution", "conversion");
  url.searchParams.set("id", adPlanIds.join(","));
  url.searchParams.set("metrics", "base");
  url.searchParams.set("limit", String(adPlanIds.length || 1));
  url.searchParams.set("account", accountId);
  if (sudo) url.searchParams.set("sudo", sudo);
  return url.toString();
}

export function normalizeDashboardStats(payload) {
  return normalizeStatsBase(payload?.total?.base);
}

export function normalizeDashboardStatsItems(payload) {
  return (payload?.items || []).map((item) => ({
    id: String(item.id),
    stats: normalizeStatsBase(item?.total?.base),
  }));
}
