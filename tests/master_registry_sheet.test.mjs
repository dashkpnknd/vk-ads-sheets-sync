import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMasterRegistryRows, writeMasterRegistry } from "../src/master_registry_sheet.mjs";

test("adds newly discovered projects and preserves existing spreadsheet links", () => {
  const result = buildMasterRegistryRows(
    [
      { accountLabel: "vk-account-1", cabinetId: "1", cabinetName: "Аймоби | Москва (2)" },
      { accountLabel: "vk-account-1", cabinetId: "2", cabinetName: "Новый проект | Казань" },
    ],
    [
      {
        project_key: "аймоби|москва",
        google_spreadsheet_url: "https://docs.google.com/spreadsheets/d/test_sheet_id_1234567890/edit",
        sheet_name: "",
      },
    ],
    [],
  );

  assert.equal(result.projectRows.length, 2);
  const aimobi = result.projectRows.find((row) => row[3] === "аймоби|москва");
  const newProject = result.projectRows.find((row) => row[3] === "новый проект|казань");
  assert.equal(aimobi[4], "https://docs.google.com/spreadsheets/d/test_sheet_id_1234567890/edit");
  assert.equal(newProject[4], "");
  assert.match(newProject[0], /^=IF\(E\d+/);
});

test("writes master registry without overriding manual header colors", async () => {
  const formatRequests = [];
  const sheets = {
    async getSpreadsheet() {
      return {
        sheets: [
          { properties: { title: "Проекты", sheetId: 1 } },
          { properties: { title: "Кабинеты", sheetId: 2 } },
        ],
      };
    },
    async ensureSheet() {},
    async clearValues() {},
    async batchUpdateValues() {},
    async batchUpdateSpreadsheet(_spreadsheetId, requests) {
      formatRequests.push(...requests);
    },
  };

  await writeMasterRegistry({
    sheets,
    spreadsheetId: "spreadsheet",
    projectRows: [],
    cabinetRows: [],
  });

  assert.equal(formatRequests.some((request) => request.repeatCell), false);
});

test("fills project notes for generated rows without explicit run notes", () => {
  const result = buildMasterRegistryRows(
    [
      { accountLabel: "vk-account-1", cabinetId: "1", cabinetName: "Новый проект | Казань" },
      { accountLabel: "vk-account-1", cabinetId: "2", cabinetName: "Аймоби | Москва" },
    ],
    [
      {
        project_key: "аймоби|москва",
        google_spreadsheet_url: "https://docs.google.com/spreadsheets/d/test_sheet_id_1234567890/edit",
        sheet_name: "",
      },
    ],
    [],
    {
      missingSheetNote: "нет ссылки",
      noActivityNote: "нет расхода",
    },
  );

  const newProject = result.projectRows.find((row) => row[3] === "новый проект|казань");
  const aimobi = result.projectRows.find((row) => row[3] === "аймоби|москва");
  assert.equal(newProject[7], "нет ссылки");
  assert.equal(aimobi[7], "нет расхода");
});

test("does not preserve old success notes when current run has no error", () => {
  const result = buildMasterRegistryRows(
    [
      { accountLabel: "vk-account-1", cabinetId: "1", cabinetName: "Аймоби | Москва" },
    ],
    [
      {
        project_key: "аймоби|москва",
        google_spreadsheet_url: "https://docs.google.com/spreadsheets/d/test_sheet_id_1234567890/edit",
        sheet_name: "",
        notes: "23.06 проверка за 22.06: записано, ячеек обновлено 5",
      },
    ],
    [],
    {
      noActivityNote: "",
    },
  );

  assert.equal(result.projectRows[0][7], "");
});

test("keeps existing project rows when no cabinet is discovered in the current run", () => {
  const result = buildMasterRegistryRows(
    [
      { accountLabel: "vk-account-1", cabinetId: "1", cabinetName: "Аймоби | Москва" },
    ],
    [
      {
        status: "готов",
        project_name: "Аймоби",
        city: "Москва",
        project_key: "аймоби|москва",
        google_spreadsheet_url: "https://docs.google.com/spreadsheets/d/aimobi_sheet_id_1234567890/edit",
        sheet_name: "ВК Таргет Июнь",
      },
      {
        status: "готов",
        project_name: "Старый проект",
        city: "Казань",
        project_key: "старый проект|казань",
        google_spreadsheet_url: "https://docs.google.com/spreadsheets/d/old_sheet_id_1234567890/edit",
        sheet_name: "",
      },
    ],
    [],
  );

  const preserved = result.projectRows.find((row) => row[3] === "старый проект|казань");
  assert.ok(preserved);
  assert.equal(preserved[1], "Старый проект");
  assert.equal(preserved[2], "Казань");
  assert.equal(preserved[4], "https://docs.google.com/spreadsheets/d/old_sheet_id_1234567890/edit");
  assert.equal(preserved[6], 0);
});
