export function extractSpreadsheetId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const urlMatch = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : "";
}

export function extractSheetGid(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const hashMatch = text.match(/[#&?]gid=(\d+)/);
  return hashMatch ? hashMatch[1] : "";
}

export function extractSpreadsheetIds(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const ids = [...text.matchAll(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
  if (ids.length) return ids;
  return text
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => /^[a-zA-Z0-9_-]{20,}$/.test(part));
}

function normalizeProjectKey(value) {
  return String(value || "").trim().toLowerCase().replace(/ё/g, "е");
}

export function projectRecordsFromValues(values) {
  return values.slice(1).flatMap((row) => {
    const projectKey = normalizeProjectKey(row[3]);
    if (!projectKey) return [];
    const spreadsheetUrl = String(row[4] || "").trim();
    return [{
      status: String(row[0] || "").trim(),
      project_name: String(row[1] || "").trim(),
      city: String(row[2] || "").trim(),
      project_key: projectKey,
      google_spreadsheet_url: spreadsheetUrl,
      google_spreadsheet_id: extractSpreadsheetId(spreadsheetUrl),
      google_sheet_gid: extractSheetGid(spreadsheetUrl),
      sheet_name: String(row[5] || "").trim(),
      notes: String(row[7] || "").trim(),
    }];
  });
}

export async function readProjectsFromMaster(sheets, spreadsheetId) {
  const values = await sheets.readValues(spreadsheetId, "Проекты!A1:H1000");
  return projectRecordsFromValues(values).filter((project) => project.status.toLowerCase() !== "отключен");
}
