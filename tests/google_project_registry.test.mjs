import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractSheetGid,
  extractSpreadsheetId,
  projectRecordsFromValues,
} from "../src/google_project_registry.mjs";

test("extracts a spreadsheet id from a Google Sheets URL", () => {
  assert.equal(
    extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1zAOqwI7N1arjeLt-LbFS-casQtHuBEoJBYX3yMCP0to/edit"),
    "1zAOqwI7N1arjeLt-LbFS-casQtHuBEoJBYX3yMCP0to",
  );
});

test("extracts a sheet gid from a Google Sheets URL", () => {
  assert.equal(
    extractSheetGid("https://docs.google.com/spreadsheets/d/abc/edit?gid=123456#gid=123456"),
    "123456",
  );
});

test("reads project records from the master sheet layout", () => {
  const records = projectRecordsFromValues([
    ["Статус", "Проект", "Город", "Ключ проекта", "Ссылка", "Лист", "Кабинетов", "Примечание"],
    ["готов", "Аймоби", "Москва", "аймоби|москва", "https://docs.google.com/spreadsheets/d/abc_def-12345678901234567890/edit?gid=987654#gid=987654", "", 6, ""],
  ]);
  assert.equal(records[0].project_key, "аймоби|москва");
  assert.equal(records[0].google_spreadsheet_id, "abc_def-12345678901234567890");
  assert.equal(records[0].google_sheet_gid, "987654");
  assert.equal(records[0].sheet_name, "");
});
