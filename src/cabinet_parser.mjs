function normalizeText(value) {
  return String(value ?? "").replace(/ё/g, "е").replace(/Ё/g, "Е").replace(/\s+/g, " ").trim();
}

export function projectKeyFromParts(projectName, city) {
  return `${normalizeText(projectName).toLowerCase()}|${normalizeText(city).toLowerCase()}`;
}

export function parseCabinetName(cabinetName) {
  const normalized = normalizeText(cabinetName);
  if (/\s+нет$/i.test(normalized)) return null;
  // Agency cabinets add a tag and contractor details after the usual project|city pair.
  // Keep the original parser unchanged for standard cabinet names.
  const agencyParts = normalized.split(/\s*\|\s*/);
  const isCerebroAgencyCabinet = agencyParts.length > 2 && /\(\s*церебро\s*\)/iu.test(agencyParts[1] || "");
  const match = isCerebroAgencyCabinet
    ? [null, agencyParts[0], agencyParts[1].replace(/\s*\(\s*церебро\s*\)\s*/giu, " "), null]
    : normalized.match(/^(.+?)\s*\|\s*(.+?)(?:\s*\((\d+(?:\.\d+)*)\))?$/);
  if (!match) return null;

  const [, rawProjectName, rawCity, rawDuplicateNumber] = match;
  const projectName = normalizeText(rawProjectName);
  const city = normalizeText(rawCity);
  if (!projectName || !city) return null;

  return {
    projectName,
    city,
    duplicateNumber: rawDuplicateNumber ? Number(rawDuplicateNumber) : null,
    projectKey: projectKeyFromParts(projectName, city),
  };
}
