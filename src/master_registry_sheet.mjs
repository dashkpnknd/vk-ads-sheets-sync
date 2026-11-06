import { parseCabinetName } from "./cabinet_parser.mjs";
import { projectEntriesForCabinet } from "./multi_city_projects.mjs";

export const PROJECT_HEADERS = [
  "Статус",
  "Проект",
  "Город",
  "Ключ проекта",
  "Ссылка на рабочую таблицу",
  "Лист (можно оставить пустым)",
  "Кабинетов",
  "Примечание",
];

export const CABINET_HEADERS = [
  "VK-аккаунт",
  "ID кабинета",
  "Название кабинета",
  "Проект",
  "Город",
  "Ключ проекта",
  "Статус",
  "Последний расход",
  "Лиды",
  "Проверено",
];

function cabinetKey(cabinet) {
  return `${cabinet.accountLabel || cabinet.account_label}|${cabinet.cabinetId || cabinet.cabinet_id}`;
}

export function buildMasterRegistryRows(cabinets, existingProjects = [], statuses = [], options = {}) {
  const existingByKey = new Map(existingProjects.map((project) => [project.project_key, project]));
  const statusByCabinet = new Map(statuses.map((status) => [cabinetKey(status), status]));
  const notesByProjectKey = options.notesByProjectKey || new Map();
  const projectsByKey = new Map(
    existingProjects.map((project) => [
      project.project_key,
      {
        projectName: project.project_name || "",
        city: project.city || "",
        projectKey: project.project_key,
        cabinetCount: 0,
      },
    ]),
  );

  for (const cabinet of cabinets) {
    for (const parsed of projectEntriesForCabinet(cabinet, options.multiCityCabinets)) {
      const current = projectsByKey.get(parsed.projectKey) || {
        projectName: parsed.projectName,
        city: parsed.city,
        projectKey: parsed.projectKey,
        cabinetCount: 0,
      };
      current.projectName ||= parsed.projectName;
      current.city ||= parsed.city;
      current.cabinetCount += 1;
      projectsByKey.set(parsed.projectKey, current);
    }
  }

  const projectRows = [...projectsByKey.values()]
    .sort((left, right) => left.projectKey.localeCompare(right.projectKey, "ru"))
    .map((project, index) => {
      const existing = existingByKey.get(project.projectKey) || {};
      const url = options.projectUrlsByKey?.get(project.projectKey) || existing.google_spreadsheet_url || "";
      const fallbackNote = url ? options.noActivityNote : options.missingSheetNote;
      const note = notesByProjectKey.has(project.projectKey)
        ? notesByProjectKey.get(project.projectKey)
        : (fallbackNote || "");
      return [
        `=IF(E${index + 2}<>"";"готов";"нужна ссылка")`,
        project.projectName,
        project.city,
        project.projectKey,
        url,
        existing.sheet_name || "",
        project.cabinetCount,
        note,
      ];
    });

  const cabinetRows = cabinets
    .map((cabinet) => {
      const parsed = parseCabinetName(cabinet.cabinetName);
      const status = statusByCabinet.get(cabinetKey(cabinet)) || {};
      return [
        cabinet.accountLabel,
        cabinet.cabinetId,
        cabinet.cabinetName,
        parsed?.projectName || "",
        parsed?.city || "",
        parsed?.projectKey || "",
        status.status || "не проверен",
        Number(status.last_spend) || 0,
        Number(status.last_leads) || 0,
        status.last_seen_at || "",
      ];
    })
    .sort((left, right) => `${left[0]}|${left[2]}`.localeCompare(`${right[0]}|${right[2]}`, "ru"));

  return { projectRows, cabinetRows };
}

function layoutRequests(sheetId, columnCount) {
  return [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: columnCount },
      },
    },
  ];
}

export async function ensureMasterRegistrySheets(sheets, spreadsheetId) {
  let metadata = await sheets.getSpreadsheet(spreadsheetId);
  if (!metadata.sheets.some((sheet) => sheet.properties.title === "Проекты")) {
    const first = metadata.sheets[0]?.properties;
    if (first) {
      await sheets.batchUpdateSpreadsheet(spreadsheetId, [{
        updateSheetProperties: {
          properties: { sheetId: first.sheetId, title: "Проекты" },
          fields: "title",
        },
      }]);
    } else {
      await sheets.ensureSheet(spreadsheetId, "Проекты");
    }
  }
  await sheets.ensureSheet(spreadsheetId, "Кабинеты");
  metadata = await sheets.getSpreadsheet(spreadsheetId);
  return new Map(metadata.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
}

export async function writeMasterRegistry({ sheets, spreadsheetId, projectRows, cabinetRows }) {
  const sheetIds = await ensureMasterRegistrySheets(sheets, spreadsheetId);
  await sheets.clearValues(spreadsheetId, ["Проекты!A:H", "Кабинеты!A:J"]);
  await sheets.batchUpdateValues(spreadsheetId, [
    { range: "Проекты!A1", values: [PROJECT_HEADERS, ...projectRows] },
    { range: "Кабинеты!A1", values: [CABINET_HEADERS, ...cabinetRows] },
  ]);
  await sheets.batchUpdateSpreadsheet(spreadsheetId, [
    ...layoutRequests(sheetIds.get("Проекты"), PROJECT_HEADERS.length),
    ...layoutRequests(sheetIds.get("Кабинеты"), CABINET_HEADERS.length),
  ]);
}

export async function writeCabinetRegistrySheet({ sheets, spreadsheetId, cabinetRows }) {
  const sheetIds = await ensureMasterRegistrySheets(sheets, spreadsheetId);
  await sheets.clearValues(spreadsheetId, ["Кабинеты!A:J"]);
  await sheets.batchUpdateValues(spreadsheetId, [
    { range: "Кабинеты!A1", values: [CABINET_HEADERS, ...cabinetRows] },
  ]);
  await sheets.batchUpdateSpreadsheet(
    spreadsheetId,
    layoutRequests(sheetIds.get("Кабинеты"), CABINET_HEADERS.length),
  );
}
