import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMetricUpdatePlan,
  buildMetricUpdates,
  columnToA1,
  findDateColumn,
  findMetricRow,
} from "../src/table_mapper.mjs";

const sheetValues = [
  ["", "1 июня", "2 июня", "3 июня"],
  ["Кол-во лидов", "1", "7", "3"],
  ["Цена за лид", "893,38 ₽", "173,85 ₽", "421,17 ₽"],
  ["Цена за лид\nс учетом бонусов", "446,69 ₽", "86,92 ₽", "210,59 ₽"],
  ["Конверсия", "0,00%", "0,00%", "0,00%"],
  ["Кол-во продаж"],
  ["Выручка"],
  ["Средний чек"],
  ["Расходы", "732,28 ₽", "997,48 ₽", "1 035,67 ₽"],
  ["Расходы + НДС", "893,38 ₽", "1 216,93 ₽", "1 263,52 ₽"],
];

test("finds a date column in Russian day-month headers", () => {
  assert.equal(findDateColumn(sheetValues, "2026-06-02"), 2);
});

test("finds metric rows despite line breaks and extra spaces", () => {
  assert.equal(findMetricRow(sheetValues, "Цена за лид с учетом бонусов"), 3);
  assert.equal(findMetricRow(sheetValues, "Расходы + НДС"), 9);
});

test("converts zero-based column index to A1 column", () => {
  assert.equal(columnToA1(0), "A");
  assert.equal(columnToA1(25), "Z");
  assert.equal(columnToA1(26), "AA");
});

test("builds sparse Google Sheets updates for the target day", () => {
  const updates = buildMetricUpdates({
    sheetName: "Лист1",
    values: sheetValues,
    date: "2026-06-02",
    metrics: {
      leads: 4,
      cpl: 200,
      cplWithBonus: 100,
      spend: 800,
      spendWithVat: 976,
    },
  });

  assert.deepEqual(updates, [
    { range: "Лист1!C2", values: [[4]] },
    { range: "Лист1!C3", values: [[200]] },
    { range: "Лист1!C4", values: [[100]] },
    { range: "Лист1!C9", values: [[800]] },
    { range: "Лист1!C10", values: [[976]] },
  ]);
});

test("builds updates from the metric labels directly before the date columns", () => {
  const values = [
    ["", "Месяц", "", "", "1 июня", "2 июня"],
    ["Кол-во лидов", "70", "", "Кол-во лидов", "", ""],
    ["Цена за лид", "104,46 ₽", "", "Цена за лид", "", ""],
    ["Конверсия", "0,00%", "", "Конверсия"],
    ["Кол-во продаж", "0", "", "Кол-во продаж"],
    ["Выручка", "0,00 ₽", "", "Выручка"],
    ["Средний чек", "", "", "Средний чек"],
    ["Расходы", "11 986,99 ₽", "", "Расходы", "", ""],
    ["Расходы + НДС", "14 624,13 ₽", "", "Расходы + НДС", "", ""],
  ];

  const plan = buildMetricUpdatePlan({
    sheetName: "ВК Таргет Июнь",
    values,
    date: "2026-06-02",
    metrics: {
      leads: 4,
      cpl: 200,
      cplWithBonus: 100,
      spend: 800,
      spendWithVat: 976,
    },
  });

  assert.deepEqual(plan.updates, [
    { range: "ВК Таргет Июнь!F2", values: [[4]] },
    { range: "ВК Таргет Июнь!F3", values: [[200]] },
    { range: "ВК Таргет Июнь!F8", values: [[800]] },
    { range: "ВК Таргет Июнь!F9", values: [[976]] },
  ]);
  assert.deepEqual(plan.missingMetricLabels, ["Цена за лид с учетом бонусов"]);
});

test("targets the city-specific table block when one sheet contains multiple cities", () => {
  const values = [
    ["Донецк", "Месяц", "", "", "1 июня", "2 июня"],
    ["Кол-во лидов", "", "", "Кол-во лидов"],
    ["Цена за лид", "", "", "Цена за лид"],
    ["Цена за лид с учетом бонусов", "", "", "Цена за лид с учетом бонусов"],
    ["Расходы", "", "", "Расходы"],
    ["Расходы + НДС", "", "", "Расходы + НДС"],
    [],
    ["Москва", "Месяц", "", "", "1 июня", "2 июня"],
    ["Кол-во лидов", "", "", "Кол-во лидов"],
    ["Цена за лид", "", "", "Цена за лид"],
    ["Цена за лид с учетом бонусов", "", "", "Цена за лид с учетом бонусов"],
    ["Расходы", "", "", "Расходы"],
    ["Расходы + НДС", "", "", "Расходы + НДС"],
  ];

  const plan = buildMetricUpdatePlan({
    sheetName: "ВК Таргет Июнь",
    values,
    date: "2026-06-02",
    sectionLabel: "Москва",
    metrics: {
      leads: 49,
      cpl: 186.98,
      cplWithBonus: 93.49,
      spend: 7509.97,
      spendWithVat: 9162.16,
    },
  });

  assert.deepEqual(plan.updates, [
    { range: "ВК Таргет Июнь!F9", values: [[49]] },
    { range: "ВК Таргет Июнь!F10", values: [[186.98]] },
    { range: "ВК Таргет Июнь!F11", values: [[93.49]] },
    { range: "ВК Таргет Июнь!F12", values: [[7509.97]] },
    { range: "ВК Таргет Июнь!F13", values: [[9162.16]] },
  ]);
  assert.deepEqual(plan.missingMetricLabels, []);
});


test("adds configured project-specific metrics", () => {
  const values = [
    ["", "Месяц", "", "", "1 августа"],
    ["Кол-во лидов", "", "", "Кол-во лидов"],
    ["Цена за лид", "", "", "Цена за лид"],
    ["Цена за лид с учетом бонусов", "", "", "Цена за лид с учетом бонусов"],
    ["Клики", "", "", "Клики"],
    ["Просмотры", "", "", "Просмотры"],
    ["Расходы", "", "", "Расходы"],
    ["Расходы + НДС", "", "", "Расходы + НДС"],
  ];
  const plan = buildMetricUpdatePlan({
    sheetName: "ВК Таргет Август", values, date: "2026-08-01",
    metrics: { leads: 2, cpl: 100, cplWithBonus: 50, spend: 200, spendWithVat: 244, clicks: 12, shows: 345 },
    additionalMetricLabels: { clicks: "Клики", shows: "Просмотры" },
  });
  assert.deepEqual(plan.missingMetricLabels, []);
  assert.deepEqual(plan.updates.slice(-2), [
    { range: "ВК Таргет Август!E5", values: [[12]] },
    { range: "ВК Таргет Август!E6", values: [[345]] },
  ]);
});
