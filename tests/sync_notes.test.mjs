import assert from "node:assert/strict";
import { test } from "node:test";

import {
  noteForSkippedProject,
  noteForWrittenProject,
  notesByProjectKeyFromSkipped,
  notesByProjectKeyFromResults,
} from "../src/sync_notes.mjs";

test("builds a dated note for a missing project spreadsheet link", () => {
  assert.equal(
    noteForSkippedProject({
      reason: "missing_google_sheet",
      runDate: "2026-06-23",
      targetDate: "2026-06-22",
    }),
    "23.06 проверка за 22.06: не записалось — нет ссылки на рабочую таблицу",
  );
});

test("explains missing metric row write failures", () => {
  assert.equal(
    noteForSkippedProject({
      reason: "google_sheet_write_failed",
      error: "Metric row not found: Цена за лид с учетом бонусов",
      runDate: "2026-06-23",
      targetDate: "2026-06-22",
    }),
    "23.06 проверка за 22.06: не записалось — в таблице не найдена строка «Цена за лид с учетом бонусов»",
  );
});

test("explains VK cabinet read failures", () => {
  assert.equal(
    noteForSkippedProject({
      reason: "vk_cabinet_read_failed",
      error: "Cabinet not found in dropdown: 1090548781",
      runDate: "2026-06-24",
      targetDate: "2026-06-23",
    }),
    "24.06 проверка за 23.06: не записалось — робот не смог открыть кабинет VK",
  );
});

test("indexes notes by project key", () => {
  const notes = notesByProjectKeyFromSkipped(
    [
      { projectKey: "аймоби|москва", reason: "zero_spend" },
      { projectKey: "9:41|салават", reason: "missing_google_sheet" },
    ],
    { runDate: "2026-06-23", targetDate: "2026-06-22" },
  );

  assert.equal(notes.has("аймоби|москва"), false);
  assert.equal(
    notes.get("9:41|салават"),
    "23.06 проверка за 22.06: не записалось — нет ссылки на рабочую таблицу",
  );
});

test("fills notes for every known project when there was no write attempt", () => {
  const notes = notesByProjectKeyFromSkipped(
    [
      { projectKey: "аймоби|москва", reason: "zero_spend" },
    ],
    {
      runDate: "2026-06-23",
      targetDate: "2026-06-22",
      projects: [
        { project_key: "аймоби|москва", google_spreadsheet_id: "sheet" },
        { project_key: "9:41|салават", google_spreadsheet_id: "sheet" },
        { project_key: "city gadget|челябинск", google_spreadsheet_id: "" },
      ],
    },
  );

  assert.equal(notes.has("9:41|салават"), false);
  assert.equal(
    notes.get("city gadget|челябинск"),
    "23.06 проверка за 22.06: не записалось — нет ссылки на рабочую таблицу",
  );
});

test("does not write notes for fully successful project writes", () => {
  assert.equal(noteForWrittenProject({
    updatedCells: 5,
    runDate: "2026-06-23",
    targetDate: "2026-06-22",
  }), "");
});

test("writes an error note for partial project writes", () => {
  assert.equal(noteForWrittenProject({
    updatedCells: 4,
    missingMetricLabels: ["Цена за лид"],
    runDate: "2026-06-23",
    targetDate: "2026-06-22",
  }), "23.06 проверка за 22.06: частично записано — не найдена строка «Цена за лид»");
});

test("clears skipped notes when the project write succeeded", () => {
  const notes = notesByProjectKeyFromResults({
    writes: [{ projectKey: "prodevice|ульяновск", updatedCells: 5, missingMetricLabels: [] }],
    skipped: [{ projectKey: "prodevice|ульяновск", reason: "vk_cabinet_read_failed" }],
    runDate: "2026-07-10",
    targetDate: "2026-07-09",
  });

  assert.equal(notes.has("prodevice|ульяновск"), false);
});
