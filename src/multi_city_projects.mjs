import { parseCabinetName, projectKeyFromParts } from "./cabinet_parser.mjs";
import { extractSpreadsheetId, extractSpreadsheetIds } from "./google_project_registry.mjs";

function normalize(value) {
  return String(value ?? "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cityFromAdPlanName(name) {
  const parts = String(name || "").split("/");
  return parts.length > 1 ? parts.at(-1).trim() : String(name || "").trim();
}

function projectNameFromKey(projectKey) {
  return String(projectKey || "").split("|")[0] || "";
}

function citiesForParsedCabinet(parsed, multiCityCabinets = {}) {
  const exact = multiCityCabinets[parsed.projectKey];
  if (exact?.length) return exact;

  const normalizedProject = normalize(parsed.projectName);
  const normalizedCity = normalize(parsed.city);
  for (const [configuredKey, cities] of Object.entries(multiCityCabinets)) {
    if (normalize(projectNameFromKey(configuredKey)) !== normalizedProject) continue;
    if (cities.some((city) => normalize(city) === normalizedCity)) return cities;
  }

  return null;
}

function levenshtein(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let last = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = old;
    }
  }
  return previous[b.length];
}

export function resolveCampaignCity(adPlanName, cities) {
  const rawCity = cityFromAdPlanName(adPlanName);
  const normalizedRawCity = normalize(rawCity);
  if (!normalizedRawCity) return null;

  const exact = cities.find((city) => normalize(city) === normalizedRawCity);
  if (exact) return exact;

  const prefix = cities.find((city) => {
    const normalizedCity = normalize(city);
    return normalizedCity.startsWith(normalizedRawCity) || normalizedRawCity.startsWith(normalizedCity.slice(0, -1));
  });
  if (prefix) return prefix;

  const scored = cities
    .map((city) => ({ city, distance: levenshtein(rawCity, city) }))
    .sort((left, right) => left.distance - right.distance);
  return scored[0]?.distance <= 2 ? scored[0].city : null;
}

export function splitMultiCityCabinetStats(cabinet, multiCityCabinets = {}) {
  const parsed = cabinet.parsed || parseCabinetName(cabinet.cabinetName);
  if (!parsed) return [cabinet];

  const cities = citiesForParsedCabinet(parsed, multiCityCabinets);
  if (!cities?.length || !cabinet.adPlanStats?.length) return [cabinet];

  const splitCabinets = cabinet.adPlanStats.flatMap((adPlan) => {
    const city = resolveCampaignCity(adPlan.name, cities);
    if (!city) return [];
    return [{
      ...cabinet,
      cabinetId: `${cabinet.cabinetId}:${adPlan.id}`,
      cabinetName: `${parsed.projectName} | ${city}`,
      parentCabinetId: cabinet.cabinetId,
      adPlanId: adPlan.id,
      adPlanName: adPlan.name,
      stats: adPlan.stats,
      parsed: {
        projectName: parsed.projectName,
        city,
        duplicateNumber: null,
        projectKey: projectKeyFromParts(parsed.projectName, city),
      },
    }];
  });

  return splitCabinets.length ? splitCabinets : [cabinet];
}

export function splitMultiCityCabinetsStats(cabinets, multiCityCabinets = {}) {
  return cabinets.flatMap((cabinet) => splitMultiCityCabinetStats(cabinet, multiCityCabinets));
}

export function projectEntriesForCabinet(cabinet, multiCityCabinets = {}) {
  const parsed = cabinet.parsed || parseCabinetName(cabinet.cabinetName);
  if (!parsed) return [];
  const cities = citiesForParsedCabinet(parsed, multiCityCabinets);
  if (!cities?.length) return [parsed];
  return cities.map((city) => ({
    projectName: parsed.projectName,
    city,
    duplicateNumber: null,
    projectKey: projectKeyFromParts(parsed.projectName, city),
  }));
}

export function expandProjectRecordsForMultiCity(projects, multiCityCabinets = {}) {
  const recordsByKey = new Map(projects.map((project) => [project.project_key, project]));

  for (const [multiCityKey, cities] of Object.entries(multiCityCabinets)) {
    const source = recordsByKey.get(multiCityKey)
      || projects.find((project) => {
        if (normalize(project.project_name) !== normalize(projectNameFromKey(multiCityKey))) return false;
        return cities.some((city) => normalize(project.city) === normalize(city));
      });
    if (!source) continue;

    const spreadsheetIds = extractSpreadsheetIds(source.google_spreadsheet_url);
    const spreadsheetUrls = String(source.google_spreadsheet_url || "").trim().split(/\s+/).filter(Boolean);

    cities.forEach((city, index) => {
      const projectKey = projectKeyFromParts(source.project_name, city);
      const existing = recordsByKey.get(projectKey);
      if (existing?.google_spreadsheet_id && extractSpreadsheetIds(existing.google_spreadsheet_url).length <= 1) return;

      const spreadsheetUrl = spreadsheetUrls[index] || "";
      recordsByKey.set(projectKey, {
        ...source,
        city,
        project_key: projectKey,
        google_spreadsheet_url: spreadsheetUrl,
        google_spreadsheet_id: spreadsheetIds[index] || extractSpreadsheetId(spreadsheetUrl),
      });
    });
  }

  return [...recordsByKey.values()];
}
