#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import {
  readCabinetRegistry,
  upsertCabinetRegistryRows,
  writeCabinetRegistry,
} from "../src/cabinet_registry.mjs";
import { parseAccessRightsCabinetText } from "../src/cabinet_list_parser.mjs";
import { parseCabinetName } from "../src/cabinet_parser.mjs";
import { withPage } from "../src/cdp_client.mjs";
import { readCsvRecords } from "../src/csv.mjs";
import { yesterdayLocalDate } from "../src/date_utils.mjs";
import { extractSheetGid, extractSpreadsheetId, readProjectsFromMaster } from "../src/google_project_registry.mjs";
import { GoogleSheetsClient } from "../src/google_sheets.mjs";
import { sendTelegramMessage, summarizeSyncResult } from "../src/telegram_notifier.mjs";
import {
  buildMasterRegistryRows,
  writeMasterRegistry,
} from "../src/master_registry_sheet.mjs";
import { calculateSheetMetrics } from "../src/metrics.mjs";
import {
  expandProjectRecordsForMultiCity,
  splitMultiCityCabinetsStats,
} from "../src/multi_city_projects.mjs";
import {
  aggregateCabinetsByProject,
  decideCabinetStatus,
} from "../src/project_aggregator.mjs";
import {
  noteForSkippedProject,
  notesByProjectKeyFromResults,
} from "../src/sync_notes.mjs";
import { buildMetricUpdatePlan } from "../src/table_mapper.mjs";
import {
  buildAdPlansUrl,
  buildDashboardStatsUrl,
  normalizeDashboardStats,
  normalizeDashboardStatsItems,
  vkDate,
} from "../src/vk_rpa_stats.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const configPath = args.get("--config") || "config/rpa.local.json";
const date = args.get("--date") || yesterdayLocalDate();
const onlyProjectKeys = splitListArg(args.get("--only-project-keys"));
const onlyMetricKeys = splitListArg(args.get("--only-metrics"));
const skipRegistryUpdate = args.has("--skip-registry-update") || args.get("--skip-registry-update") === "true";
const skipMasterRegistryUpdate = args.has("--skip-master-registry-update") || args.get("--skip-master-registry-update") === "true";
const skipNotification = args.has("--skip-notification") || args.get("--skip-notification") === "true";
const DEFAULT_BUSINESS_PROFILE_ID = "30710361";
const VK_API_TIMEOUT_MS = 15_000;

function splitListArg(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeConfigValue(value) {
  return String(value ?? "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeProjectKey(value) {
  return normalizeConfigValue(value);
}

function projectNameFromProjectKey(projectKey) {
  return String(projectKey || "").split("|")[0] || "";
}

function normalizedProjectKeyAliases(aliases = {}) {
  return new Map(
    Object.entries(aliases || {})
      .map(([from, to]) => [normalizeProjectKey(from), normalizeProjectKey(to)])
      .filter(([from, to]) => from && to && from !== to),
  );
}

function canonicalizeCabinetProject(cabinet, aliasesByKey, sourcesByProject = {}) {
  const explicitKey = Object.entries(sourcesByProject).find(([, sources]) =>
    sources.some((source) => source.accountLabel === cabinet.accountLabel && String(source.cabinetId) === String(cabinet.cabinetId)),
  )?.[0];
  if (explicitKey) {
    const [projectName, city] = explicitKey.split("|");
    return { ...cabinet, parsed: { projectName, city, projectKey: explicitKey } };
  }
  const parsed = parseCabinetName(cabinet.cabinetName);
  if (!parsed) return { ...cabinet, parsed: null };
  const targetProjectKey = aliasesByKey.get(parsed.projectKey);
  if (!targetProjectKey) return { ...cabinet, parsed };

  const [projectName, city] = targetProjectKey.split("|").map((part) => part.trim());
  if (!projectName || !city) return { ...cabinet, parsed };
  return {
    ...cabinet,
    parsed: { ...parsed, projectName, city, projectKey: targetProjectKey },
  };
}

function canonicalizeProjectRecord(project, aliasesByKey) {
  const targetProjectKey = aliasesByKey.get(project.project_key);
  if (!targetProjectKey) return project;
  const [projectName, city] = targetProjectKey.split("|").map((part) => part.trim());
  if (!projectName || !city) return project;
  return { ...project, city, project_key: targetProjectKey };
}

function shouldKeepAdPlanStats(cabinet, multiCityCabinets = {}) {
  const parsed = cabinet.parsed || parseCabinetName(cabinet.cabinetName);
  if (!parsed) return false;
  if (multiCityCabinets[parsed.projectKey]?.length) return true;

  const projectName = normalizeConfigValue(parsed.projectName);
  const city = normalizeConfigValue(parsed.city);
  return Object.entries(multiCityCabinets).some(([projectKey, cities]) =>
    normalizeConfigValue(projectNameFromProjectKey(projectKey)) === projectName
    && cities.some((item) => normalizeConfigValue(item) === city),
  );
}

function slimCollectedCabinet(cabinet, multiCityCabinets = {}) {
  if (shouldKeepAdPlanStats(cabinet, multiCityCabinets)) return cabinet;
  const { adPlanStats, adPlanIds, ...slim } = cabinet;
  return slim;
}

const SHEET_MONTHS_RU = new Map([
  [1, "января"],
  [2, "февраля"],
  [3, "марта"],
  [4, "апреля"],
  [5, "мая"],
  [6, "июня"],
  [7, "июля"],
  [8, "августа"],
  [9, "сентября"],
  [10, "октября"],
  [11, "ноября"],
  [12, "декабря"],
]);

const SHEET_MONTHS_TITLE_RU = new Map([
  [1, "Январь"],
  [2, "Февраль"],
  [3, "Март"],
  [4, "Апрель"],
  [5, "Май"],
  [6, "Июнь"],
  [7, "Июль"],
  [8, "Август"],
  [9, "Сентябрь"],
  [10, "Октябрь"],
  [11, "Ноябрь"],
  [12, "Декабрь"],
]);

function parseSyncDate(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function previousMonth(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function monthTitlePattern(month) {
  return SHEET_MONTHS_TITLE_RU.get(month).toLowerCase();
}

function sheetsForMonth(metadata, month) {
  const monthName = monthTitlePattern(month);
  return (metadata.sheets || []).filter((sheet) =>
    String(sheet.properties?.title || "").toLowerCase().includes(monthName),
  );
}

function sheetById(metadata, sheetId) {
  if (!sheetId) return null;
  return (metadata.sheets || []).find((sheet) =>
    String(sheet.properties?.sheetId || "") === String(sheetId),
  ) || null;
}

function sheetTitle(sheet) {
  return String(sheet?.properties?.title || "");
}

function isSheetForMonth(sheet, month) {
  return sheetTitle(sheet).toLowerCase().includes(monthTitlePattern(month));
}

function rankMonthSheet(sheet, date) {
  const { year, month } = parseSyncDate(date);
  const title = sheetTitle(sheet).trim().toLowerCase();
  const monthName = monthTitlePattern(month);
  const yearSuffix = String(year).slice(-2);
  if (title.includes(String(year))) return 0;
  if (new RegExp("(^|\\D)" + yearSuffix + "($|\\D)").test(title)) return 1;
  if (title === "вк таргет " + monthName || title === monthName) return 2;
  return 3;
}

function sortMonthSheets(metadata, date) {
  const { month } = parseSyncDate(date);
  return sheetsForMonth(metadata, month)
    .sort((left, right) =>
      rankMonthSheet(left, date) - rankMonthSheet(right, date)
      || sheetTitle(left).length - sheetTitle(right).length,
    );
}

function chooseExistingMonthSheet(metadata, date, preferredSheetId = "") {
  const { month } = parseSyncDate(date);
  const preferred = sheetById(metadata, preferredSheetId);
  if (preferred && isSheetForMonth(preferred, month)) return preferred;
  return sortMonthSheets(metadata, date)[0] || null;
}

function sheetUrl(spreadsheetId, sheetId) {
  return sheetId
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

function titleForCopiedMonth(templateTitle, date) {
  const { year, month } = parseSyncDate(date);
  const targetMonth = SHEET_MONTHS_TITLE_RU.get(month);
  const { month: prev } = previousMonth(year, month);
  const prevTitle = SHEET_MONTHS_TITLE_RU.get(prev);
  const escapedPrevTitle = prevTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replaced = String(templateTitle || "").replace(new RegExp(escapedPrevTitle, "i"), targetMonth);
  if (replaced !== templateTitle) return replaced.trim();
  return `ВК Таргет ${targetMonth} ${String(year).slice(-2)}`;
}

function isDateHeader(value) {
  return /^(\d{1,2})\s+[а-яё]+$/u.test(String(value || "").trim().toLowerCase());
}

function firstDateColumn(header) {
  const dateIndex = header.findIndex((cell) => isDateHeader(cell));
  if (dateIndex !== -1) return dateIndex;
  const monthIndex = header.findIndex((cell) => String(cell || "").trim().toLowerCase() === "месяц");
  return monthIndex === -1 ? 4 : monthIndex + 3;
}

function buildMonthHeader(header, year, month) {
  const totalDays = daysInMonth(year, month);
  const start = firstDateColumn(header);
  const existingDateColumns = header
    .map((cell, index) => (isDateHeader(cell) ? index : -1))
    .filter((index) => index >= 0);
  const dateColumnCount = Math.max(totalDays, existingDateColumns.length || 0);
  const nextHeader = [...header];
  while (nextHeader.length < start + dateColumnCount) nextHeader.push("");
  for (let offset = 0; offset < dateColumnCount; offset += 1) {
    nextHeader[start + offset] = offset < totalDays ? `${offset + 1} ${SHEET_MONTHS_RU.get(month)}` : "";
  }
  return { header: nextHeader, start, dateColumnCount };
}

function hasSection(values, sectionLabel) {
  if (!sectionLabel) return true;
  const expected = String(sectionLabel || "").trim().toLowerCase();
  return values.some((row) => String(row?.[0] || "").trim().toLowerCase() === expected);
}

function uniqueSheetTitle(metadata, title) {
  const existing = new Set((metadata.sheets || []).map((sheet) => sheet.properties?.title));
  if (!existing.has(title)) return title;
  for (let index = 2; index < 50; index += 1) {
    const candidate = `${title} ${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${title} ${Date.now()}`;
}

async function readSheetValues(sheets, spreadsheetId, sheetName) {
  return sheets.readValues(spreadsheetId, `${sheetName}!A1:AZ80`);
}

function columnToA1(index) {
  let column = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function isMonthHeaderRow(row) {
  return row.some((cell) => String(cell || "").trim().toLowerCase() === "месяц")
    || row.some((cell) => isDateHeader(cell));
}

async function prepareMonthSheet(sheets, spreadsheetId, sheetName, date, { clearValues = false } = {}) {
  const { year, month } = parseSyncDate(date);
  const values = await sheets.readValues(spreadsheetId, `${sheetName}!A1:AZ80`);
  const headerRows = values
    .map((row, index) => ({ row: row || [], index }))
    .filter(({ row }) => isMonthHeaderRow(row));
  if (!headerRows.length) headerRows.push({ row: values[0] || [], index: 0 });

  const updates = [];
  const clearColumnIndexes = new Set();
  for (const { row, index: rowIndex } of headerRows) {
    const { header, start, dateColumnCount } = buildMonthHeader(row, year, month);
    updates.push({
      range: `${sheetName}!A${rowIndex + 1}:${columnToA1(Math.max(header.length - 1, 0))}${rowIndex + 1}`,
      values: [header],
    });
    for (let offset = 0; offset < dateColumnCount; offset += 1) {
      clearColumnIndexes.add(start + offset);
    }
  }

  if (clearValues) {
    for (const index of clearColumnIndexes) {
      updates.push({
        range: `${sheetName}!${columnToA1(index)}2:${columnToA1(index)}80`,
        values: Array.from({ length: 79 }, () => [""]),
      });
    }
  }
  await sheets.batchUpdateValues(spreadsheetId, updates);
}

async function ensureMonthlySheet(sheets, spreadsheetId, registry, date, sectionLabel = "") {
  const metadata = await sheets.getSpreadsheet(spreadsheetId);

  if (registry.sheet_name) {
    const configured = (metadata.sheets || []).find((sheet) => sheet.properties?.title === registry.sheet_name);
    if (!configured) throw new Error(`Configured sheet not found: ${registry.sheet_name}`);
    await prepareMonthSheet(sheets, spreadsheetId, registry.sheet_name, date);
    return { sheetName: registry.sheet_name, sheetId: configured.properties.sheetId };
  }

  const monthSheets = sortMonthSheets(metadata, date);
  const orderedMonthSheets = [chooseExistingMonthSheet(metadata, date, registry.google_sheet_gid), ...monthSheets]
    .filter(Boolean)
    .filter((sheet, index, array) => array.findIndex((item) => item.properties.sheetId === sheet.properties.sheetId) === index);

  for (const sheet of orderedMonthSheets) {
    const sheetName = sheet.properties.title;
    await prepareMonthSheet(sheets, spreadsheetId, sheetName, date);
    const values = await readSheetValues(sheets, spreadsheetId, sheetName);
    if (hasSection(values, sectionLabel)) {
      return { sheetName, sheetId: sheet.properties.sheetId };
    }
  }

  if (monthSheets.length) {
    throw new Error(sectionLabel
      ? `Monthly sheet exists, but table section not found: ${sectionLabel}`
      : "Monthly sheet exists, but target table was not found");
  }

  const { year, month } = parseSyncDate(date);
  const previous = previousMonth(year, month);
  const previousSheets = sheetsForMonth(metadata, previous.month);
  const sourceSheet = previousSheets.find((sheet) => /^вк\s+таргет/i.test(sheetTitle(sheet))) || null;

  if (sourceSheet) {
    const sourceValues = await readSheetValues(sheets, spreadsheetId, sourceSheet.properties.title);
    if (hasSection(sourceValues, sectionLabel)) {
      const copied = await sheets.duplicateSheet(
        spreadsheetId,
        sourceSheet.properties.sheetId,
        uniqueSheetTitle(metadata, titleForCopiedMonth(sourceSheet.properties.title, date)),
      );
      await prepareMonthSheet(sheets, spreadsheetId, copied.title, date, { clearValues: true });
      return { sheetName: copied.title, sheetId: copied.sheetId };
    }
  }

  throw new Error("Monthly sheet not found; create the sheet manually before sync");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(client, text, { exact = false } = {}) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const text = ${JSON.stringify(text)};
      const exact = ${JSON.stringify(exact)};
      const candidates = Array.from(document.querySelectorAll('body *'))
        .map((el) => {
          const value = (el.innerText || el.textContent || '').trim();
          const rect = el.getBoundingClientRect();
          return { value, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })
        .filter((item) => item.value && item.width > 5 && item.height > 5)
        .filter((item) => exact ? item.value === text : item.value.includes(text))
        .sort((left, right) => (left.value.length - right.value.length) || (left.width * left.height - right.width * right.height));
      const target = candidates[0];
      if (!target) return null;
      return { x: target.x + Math.min(35, target.width / 2), y: target.y + target.height / 2 };
    })()`,
  });
  const point = result.result.value;
  if (!point) return false;
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  return true;
}

async function clickAccountRowById(client, accountId) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const id = ${JSON.stringify(String(accountId))};
      const target = Array.from(document.querySelectorAll('[role="button"]'))
        .find((el) => (el.innerText || '').includes('ID: ' + id));
      if (!target) return false;
      target.click();
      return true;
    })()`,
  });
  return result.result.value === true;
}

async function openAccountDropdown(client) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const dropdown = document.querySelector('[class*="accountsDropdown"]');
      if (dropdown) return true;
      const target = document.querySelector('[class*="changeAccountButton"]');
      if (!target) return null;
      target.click();
      return true;
    })()`,
  });
  const value = result.result.value;
  if (value === true) return true;
  if (!value) return false;
  await sleep(500);
  return true;
}

async function ensureBusinessProfile(client, businessProfileId) {
  await client.send("Runtime.enable");
  const current = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => localStorage.getItem('user_id'))()`,
  });
  if (String(current.result.value) === String(businessProfileId)) return;
  await openAccountDropdown(client);
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('[class*="accountsDropdown"] input[type="search"], input[placeholder="Поиск"]');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await sleep(700);
  if (!(await clickAccountRowById(client, businessProfileId))) {
    throw new Error(`Business profile not found: ${businessProfileId}`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const active = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        userId: localStorage.getItem('user_id'),
        accountId: localStorage.getItem('accountId'),
        name: document.querySelector('[class*="changeAccountName"]')?.innerText?.trim() || ''
      }))()`,
    });
    if (String(active.result.value.userId) === String(businessProfileId)) return active.result.value;
    await sleep(500);
  }
  throw new Error(`Business profile did not become active: ${businessProfileId}`);
}

async function openAccessRights(client) {
  await client.send("Page.enable");
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await client.send("Page.navigate", { url: "https://ads.vk.ru/hq/settings" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => (document.body.innerText || '').includes('Права доступа'))()`,
    });
    if (ready.result.value) {
      if (await clickByText(client, "Права доступа", { exact: true })) {
        await sleep(1600);
        return;
      }
      if (await clickByText(client, "Права доступа")) {
        await sleep(1600);
        return;
      }
    }
    await sleep(500);
  }
  throw new Error("Access rights tab not found");
}

async function getCabinets(client, businessProfileId) {
  await ensureBusinessProfile(client, businessProfileId);
  await openAccessRights(client);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const evaluation = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => document.body.innerText || "")()`,
    });
    const cabinets = parseAccessRightsCabinetText(evaluation.result.value);
    if (cabinets.length > 0) return cabinets;
    await sleep(500);
  }
  throw new Error("VK access-rights page loaded without a cabinet list");
}

async function searchAgencyDashboard(client, query) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const input = Array.from(document.querySelectorAll('input'))
        .find((element) => (element.placeholder || '').includes('Поиск'));
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  });
  return result.result.value === true;
}

async function agencyDashboardCabinetsOnPage(client, query) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const query = ${JSON.stringify(query)}.toLowerCase();
      return Array.from(document.querySelectorAll('a[href*="sudo="]'))
        .map((link) => ({
          cabinetName: (link.innerText || '').trim(),
          agencySudo: new URL(link.href, location.href).searchParams.get('sudo') || '',
        }))
        .filter((cabinet) => cabinet.cabinetName.toLowerCase().includes(query) && cabinet.agencySudo)
        .map((cabinet) => ({ ...cabinet, cabinetId: "agency:" + cabinet.agencySudo }));
    })()`,
  });
  return result.result.value || [];
}

async function agencyDashboardPageState(client) {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter((button) => String(button.parentElement?.className || '').includes('tablePaginationPages'));
      const pagination = document.querySelector('[class*="tablePagination__"]');
      const total = (document.body.innerText || '').match(/Итого:\\s*(\\d+)\\s+клиент/i);
      return {
        search: Array.from(document.querySelectorAll('input'))
          .find((input) => (input.placeholder || '').includes('Поиск'))?.value || '',
        names: Array.from(document.querySelectorAll('a[href*="sudo="]'))
          .map((link) => (link.innerText || '').trim()).filter(Boolean),
        pages: buttons.map((button) => Number((button.innerText || '').trim()))
          .filter((page) => Number.isInteger(page) && page > 0),
        activePage: buttons.length
          ? Number(buttons.find((button) => button.className.includes('--mode-secondary'))?.innerText || 0)
          : 1,
        nextDisabled: pagination ? pagination.lastElementChild?.disabled === true : true,
        total: total ? Number(total[1]) : null,
      };
    })()`,
  });
  return result.result.value;
}

async function waitForAgencyDashboardPage(client, query, expectedPage) {
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await agencyDashboardPageState(client);
    if (expectedPage === 1 && state.search.toLowerCase() !== query.toLowerCase() && attempt % 3 === 0) {
      await searchAgencyDashboard(client, query);
    }
    const matchesQuery = state.search.toLowerCase() === query.toLowerCase()
      && state.names.every((name) => name.toLowerCase().includes(query.toLowerCase()));
    const ready = matchesQuery && state.total !== null && state.activePage === expectedPage
      && (state.names.length > 0 || state.total === 0);
    const signature = JSON.stringify([state.total, state.pages, state.names, state.nextDisabled]);
    stable = ready && signature === previous ? stable + 1 : 0;
    if (stable >= 2) return state;
    previous = signature;
    await sleep(350);
  }
  throw new Error(`Agency dashboard did not settle on page ${expectedPage} for ${query}`);
}

async function getAgencyCabinets(client, query) {
  await client.send("Page.enable");
  await client.send("Page.navigate", { url: "https://ads.vk.ru/hq/dashboard" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await searchAgencyDashboard(client, query)) break;
    await sleep(500);
  }
  let state = await waitForAgencyDashboardPage(client, query, 1);
  const cabinetsBySudo = new Map();
  for (let page = 1; page <= 100; page += 1) {
    for (const cabinet of await agencyDashboardCabinetsOnPage(client, query)) {
      cabinetsBySudo.set(cabinet.agencySudo, cabinet);
    }
    if (state.nextDisabled) return [...cabinetsBySudo.values()];
    const nextPage = page + 1;
    const clicked = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const numbered = Array.from(document.querySelectorAll('button'))
          .filter((button) => String(button.parentElement?.className || '').includes('tablePaginationPages'))
          .find((button) => (button.innerText || '').trim() === ${JSON.stringify(String(nextPage))});
        const pagination = document.querySelector('[class*="tablePagination__"]');
        const arrow = pagination?.lastElementChild;
        const target = numbered || (!arrow?.disabled ? arrow : null);
        if (!target) return false;
        target.click();
        return true;
      })()`,
    });
    if (!clicked.result.value) {
      state = await waitForAgencyDashboardPage(client, query, page);
      if (state.nextDisabled) return [...cabinetsBySudo.values()];
      throw new Error(`Agency dashboard could not advance from page ${page} for ${query}`);
    }
    state = await waitForAgencyDashboardPage(client, query, nextPage);
  }
  throw new Error(`Agency dashboard exceeded 100 pages for ${query}`);
}

async function selectAgencyCabinet(client, cabinet) {
  await client.send("Page.enable");
  await client.send("Page.navigate", {
    url: "https://ads.vk.ru/hq/overview?sudo=" + encodeURIComponent(cabinet.agencySudo),
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const active = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        userId: localStorage.getItem('user_id'),
        accountId: localStorage.getItem('accountId'),
        sudo: new URL(location.href).searchParams.get('sudo') || '',
        cabinetName: document.querySelector('[class*="changeAccountName"]')?.innerText?.trim() || ''
      }))()`,
    });
    const value = active.result.value;
    if (value?.accountId && value?.userId && value.sudo === cabinet.agencySudo
      && normalizeConfigValue(value.cabinetName) === normalizeConfigValue(cabinet.cabinetName)) return value;
    await sleep(500);
  }
  throw new Error("Agency cabinet did not become active: " + cabinet.cabinetName);
}

async function selectCabinet(client, cabinet) {
  if (cabinet.agencySudo) return selectAgencyCabinet(client, cabinet);
  const cabinetId = cabinet.cabinetId;
  for (let selectAttempt = 0; selectAttempt < 3; selectAttempt += 1) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await sleep(250);
    await openAccountDropdown(client);
    await sleep(700);
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('[class*="accountsDropdown"] input[type="search"], input[placeholder="Поиск"]');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(input, ${JSON.stringify(String(cabinet.cabinetName))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    });
    await sleep(900);
    if (!(await clickAccountRowById(client, cabinetId))) {
      await client.send("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector('[class*="accountsDropdown"] input[type="search"], input[placeholder="Поиск"]');
          if (!input) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(String(cabinetId))});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`,
      });
      await sleep(900);
      if (await clickAccountRowById(client, cabinetId)) {
        // continue to active-state polling below
      } else {
        continue;
      }
    }
    {
      const activeNow = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          userId: localStorage.getItem('user_id'),
          accountId: localStorage.getItem('accountId'),
          sudo: new URL(location.href).searchParams.get('sudo') || '',
          cabinetName: document.querySelector('[class*="changeAccountName"]')?.innerText?.trim() || ''
        }))()`,
      });
      if (String(activeNow.result.value.userId) === String(cabinetId) && activeNow.result.value.accountId
        && normalizeConfigValue(activeNow.result.value.cabinetName) === normalizeConfigValue(cabinet.cabinetName)) {
        return activeNow.result.value;
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const active = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => ({
          userId: localStorage.getItem('user_id'),
          accountId: localStorage.getItem('accountId'),
          sudo: new URL(location.href).searchParams.get('sudo') || '',
          cabinetName: document.querySelector('[class*="changeAccountName"]')?.innerText?.trim() || ''
        }))()`,
      });
      if (String(active.result.value.userId) === String(cabinetId) && active.result.value.accountId
        && normalizeConfigValue(active.result.value.cabinetName) === normalizeConfigValue(cabinet.cabinetName)) {
        return active.result.value;
      }
      await sleep(500);
    }
  }
  throw new Error(`Cabinet did not become active: ${cabinetId}`);
}

async function getStatsForCabinet(client, cabinet, date) {
  await client.send("Page.enable");
  let active = await selectCabinet(client, cabinet);
  const dateParam = vkDate(date);
  const dashboardUrl = new URL("https://ads.vk.ru/hq/dashboard/ad_plans");
  dashboardUrl.search = new URLSearchParams({mode: "ads", attribution: "conversion", date_from: dateParam, date_to: dateParam, sort: "-created"});
  if (active.sudo) dashboardUrl.searchParams.set("sudo", active.sudo);
  await client.send("Page.navigate", {
    url: dashboardUrl.toString(),
  });
  const expected = active;
  let verified = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(500);
    const state = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `({userId:localStorage.getItem('user_id'),accountId:localStorage.getItem('accountId'),sudo:new URL(location.href).searchParams.get('sudo')||'',cabinetName:document.querySelector('[class*="changeAccountName"]')?.innerText?.trim()||''})`,
    });
    active = state.result.value;
    if (active?.accountId && String(active.userId) === String(expected.userId)
      && active.sudo === expected.sudo
      && normalizeConfigValue(active.cabinetName) === normalizeConfigValue(cabinet.cabinetName)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new Error(`Cabinet context changed before stats: ${cabinet.cabinetName}`);
  const accountId = active.accountId;
  const adPlansUrl = buildAdPlansUrl({ accountId, sudo: active.sudo });
  const plans = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ${VK_API_TIMEOUT_MS});
      try {
        const response = await fetch(${JSON.stringify(adPlansUrl)}, {
          credentials: 'include',
          signal: controller.signal,
        });
        return { status: response.status, data: await response.json() };
      } catch (error) {
        return { status: 0, error: error?.name || String(error) };
      } finally {
        clearTimeout(timeout);
      }
    })()`,
  });
  if (plans.result.value.status !== 200) {
    throw new Error(`Ad plans failed for ${cabinet.cabinetName}: ${plans.result.value.status}`);
  }
  const adPlanIds = (plans.result.value.data.items || []).map((item) => String(item.id));
  if (!adPlanIds.length) {
    return { ...cabinet, stats: { spend: 0, leads: 0, shows: 0, clicks: 0 }, accountId, adPlanIds };
  }
  const adPlanNamesById = new Map((plans.result.value.data.items || []).map((item) => [String(item.id), item.name]));
  const statsUrl = buildDashboardStatsUrl({ accountId, date, adPlanIds, sudo: active.sudo });
  const stats = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ${VK_API_TIMEOUT_MS});
      try {
        const response = await fetch(${JSON.stringify(statsUrl)}, {
          credentials: 'include',
          signal: controller.signal,
        });
        return { status: response.status, data: await response.json() };
      } catch (error) {
        return { status: 0, error: error?.name || String(error) };
      } finally {
        clearTimeout(timeout);
      }
    })()`,
  });
  if (stats.result.value.status !== 200) {
    throw new Error(`Stats failed for ${cabinet.cabinetName}: ${stats.result.value.status}`);
  }
  const wrongUser = (stats.result.value.data.items || []).find((item) => item.user_id != null && String(item.user_id) !== String(active.userId));
  if (wrongUser) throw new Error(`Stats belong to another cabinet: expected ${active.userId}, received ${wrongUser.user_id}`);
  return {
    ...cabinet,
    stats: normalizeDashboardStats(stats.result.value.data),
    adPlanStats: normalizeDashboardStatsItems(stats.result.value.data).map((adPlan) => ({
      ...adPlan,
      name: adPlanNamesById.get(adPlan.id) || "",
    })),
    accountId,
    sudo: active.sudo,
    adPlanIds,
  };
}

async function resetVkPage(client) {
  await client.send("Page.enable");
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }).catch(() => {});
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }).catch(() => {});
  await client.send("Page.navigate", { url: "https://ads.vk.ru" });
  await sleep(2500);
}

async function collectCabinetsWithRetries(client, cabinets, accountLabel, date, { maxRounds = 3, multiCityCabinets = {} } = {}) {
  const collected = [];
  const collectedIds = new Set();
  let pending = cabinets.map((cabinet) => ({ ...cabinet, accountLabel }));
  const attemptsByCabinet = new Map();
  const retryRounds = [];

  for (let round = 1; round <= maxRounds && pending.length; round += 1) {
    if (round > 1) {
      await resetVkPage(client);
    }
    const nextPending = [];
    const roundErrors = [];
    for (const [cabinetIndex, cabinet] of pending.entries()) {
      try {
        // VK's account switcher keeps the previous cabinet's filtered list after a
        // statistics visit. Reopen the parent page before switching legacy clients.
        if (accountLabel === "vk-account-3" && cabinetIndex > 0) {
          await resetVkPage(client);
        }
        const item = await getStatsForCabinet(client, cabinet, date);
        if (!collectedIds.has(String(cabinet.cabinetId))) {
          collected.push(slimCollectedCabinet(item, multiCityCabinets));
          collectedIds.add(String(cabinet.cabinetId));
        }
      } catch (error) {
        const previous = attemptsByCabinet.get(cabinet.cabinetId) || [];
        attemptsByCabinet.set(cabinet.cabinetId, [...previous, error.message]);
        nextPending.push(cabinet);
        roundErrors.push({
          cabinetId: cabinet.cabinetId,
          cabinetName: cabinet.cabinetName,
          projectKey: cabinet.parsed.projectKey,
          error: error.message,
        });
      }
    }
    retryRounds.push({
      round,
      attempted: pending.length,
      collected: pending.length - nextPending.length,
      failed: nextPending.length,
    });
    pending = nextPending;
  }

  const errors = pending.map((cabinet) => ({
    cabinetId: cabinet.cabinetId,
    cabinetName: cabinet.cabinetName,
    projectKey: cabinet.parsed.projectKey,
    error: (attemptsByCabinet.get(cabinet.cabinetId) || []).at(-1) || "Cabinet was not collected",
    attempts: attemptsByCabinet.get(cabinet.cabinetId) || [],
  }));

  return { collected, errors, retryRounds };
}

function compactAccountReport(report) {
  return {
    accountLabel: report.accountLabel,
    cabinetsFound: report.cabinetsFound,
    matched: report.matched,
    ignored: report.ignored,
    scanTargets: report.scanTargets,
    collected: report.collected,
    errors: report.errors,
    retryRounds: report.retryRounds,
  };
}

function compactSyncResult(result) {
  return {
    ok: result.ok,
    date: result.date,
    accountReports: (result.accountReports || []).map(compactAccountReport),
    writes: result.writes,
    skipped: result.skipped,
    cabinetsRegistryPath: result.cabinetsRegistryPath,
    cabinetScanFilter: result.cabinetScanFilter,
    cabinetRegistryUpdates: result.cabinetRegistryUpdates,
    masterSpreadsheet: result.masterSpreadsheet,
    masterRegistryError: result.masterRegistryError,
  };
}


async function readProjectLinkCache(cachePath) {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function normalizedProjectLinkCache(cache) {
  return new Map(
    Object.entries(cache || {}).map(([projectKey, value]) => [normalizeProjectKey(projectKey), value]),
  );
}

function normalizedProjectLinkAliases(aliases = {}) {
  return new Map(
    Object.entries(aliases || {}).map(([projectKey, sourceProjectKey]) => [
      normalizeProjectKey(projectKey),
      normalizeProjectKey(sourceProjectKey),
    ]),
  );
}

function cachedProjectLink(project, cacheByKey, aliasesByKey = new Map()) {
  const projectKey = normalizeProjectKey(project.project_key);
  return cacheByKey.get(projectKey) || cacheByKey.get(aliasesByKey.get(projectKey)) || null;
}

function applyProjectLinkCache(projects, cache, aliases = {}) {
  const cacheByKey = normalizedProjectLinkCache(cache);
  const aliasesByKey = normalizedProjectLinkAliases(aliases);
  return projects.map((project) => {
    if (project.google_spreadsheet_id) return project;
    const cached = cachedProjectLink(project, cacheByKey, aliasesByKey);
    if (!cached?.google_spreadsheet_url) return project;
    return {
      ...project,
      google_spreadsheet_url: cached.google_spreadsheet_url,
      google_spreadsheet_id: extractSpreadsheetId(cached.google_spreadsheet_url),
      google_sheet_gid: extractSheetGid(cached.google_spreadsheet_url),
      sheet_name: project.sheet_name || cached.sheet_name || "",
    };
  });
}

async function writeProjectLinkCache(cachePath, projects, projectUrlsByKey = new Map()) {
  const cache = await readProjectLinkCache(cachePath);
  for (const project of projects) {
    if (project.google_spreadsheet_url && project.google_spreadsheet_id) {
      cache[project.project_key] = {
        google_spreadsheet_url: project.google_spreadsheet_url,
        sheet_name: project.sheet_name || "",
      };
    }
  }
  for (const [projectKey, url] of projectUrlsByKey.entries()) {
    if (!url) continue;
    cache[projectKey] = {
      ...(cache[projectKey] || {}),
      google_spreadsheet_url: url,
    };
  }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

async function main() {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const sheets = new GoogleSheetsClient({ credentialsPath: config.googleCredentialsPath });
  const projectLinkCachePath = config.projectLinkCachePath || "config/project_links.server.json";
  const projectLinkCache = await readProjectLinkCache(projectLinkCachePath);
  const projectKeyAliases = normalizedProjectKeyAliases(config.projectKeyAliases);
  const rawProjects = config.masterSpreadsheetId
    ? await readProjectsFromMaster(sheets, config.masterSpreadsheetId)
    : (await readCsvRecords(config.projectsRegistryPath)).filter((row) => row.status === "active");
  const projects = applyProjectLinkCache(rawProjects, projectLinkCache, config.projectLinkAliases)
    .map((project) => canonicalizeProjectRecord(project, projectKeyAliases));
  const expandedProjects = expandProjectRecordsForMultiCity(projects, config.multiCityCabinets);
  const projectsByKey = new Map(expandedProjects.map((project) => [project.project_key, project]));
  const cabinetsRegistryPath = config.cabinetsRegistryPath || "config/discovered_cabinets.local.csv";
  const existingCabinetRows = await readCabinetRegistry(cabinetsRegistryPath);
  const scannedCabinets = [];
  const discoveredCabinets = [];
  const accountReports = [];

  for (const account of config.accounts) {
    const accountReport = await withPage(account.port, async (client) => {
      const cabinets = account.cabinetDiscovery === "agency_dashboard"
        ? [...new Map((await (async () => {
          const found = [];
          for (const query of account.cabinetQueries || [account.cabinetQuery || "Церебро"]) {
            found.push(...await getAgencyCabinets(client, query));
          }
          return found;
        })()).map((cabinet) => [cabinet.cabinetId, cabinet])).values()]
        : await getCabinets(
          client,
          account.businessProfileId || config.businessProfileId || DEFAULT_BUSINESS_PROFILE_ID,
        );
      if (cabinets.length === 0) {
        throw new Error(`VK returned an empty cabinet list for ${account.accountLabel}`);
      }
      const matched = cabinets
        .map((cabinet) => canonicalizeCabinetProject({ ...cabinet, accountLabel: account.accountLabel }, projectKeyAliases, config.projectCabinetSources))
        .filter((cabinet) => cabinet.parsed)
        .filter((cabinet) => !config.projectCabinetSources?.[cabinet.parsed.projectKey]
          || config.projectCabinetSources[cabinet.parsed.projectKey].some((source) =>
            source.accountLabel === cabinet.accountLabel && String(source.cabinetId) === String(cabinet.cabinetId)));
      discoveredCabinets.push(...matched);
      const scanTargets = onlyProjectKeys.size
        ? matched.filter((cabinet) => onlyProjectKeys.has(cabinet.parsed.projectKey))
        : matched;
      const { collected, errors, retryRounds } = await collectCabinetsWithRetries(
        client,
        scanTargets,
        account.accountLabel,
        date,
        { maxRounds: config.cabinetScanRetryRounds || 3, multiCityCabinets: config.multiCityCabinets },
      );
      scannedCabinets.push(...collected);
      return {
        accountLabel: account.accountLabel,
        cabinetsFound: cabinets.length,
        matched: matched.length,
        ignored: 0,
        scanTargets: scanTargets.length,
        collected: collected.length,
        errors,
        retryRounds,
      };
    });
    accountReports.push(accountReport);
  }

  const aggregationCabinets = splitMultiCityCabinetsStats(scannedCabinets, config.multiCityCabinets);
  const aggregation = aggregateCabinetsByProject(aggregationCabinets);
  const writes = [];
  const skipped = [];
  const projectUrlsByKey = new Map();

  // A pinned project is complete only when every configured source was read.
  // Never replace its previous sheet values with a partial or wrong-account total.
  const collectedSources = new Set(scannedCabinets.map((cabinet) =>
    `${cabinet.accountLabel}\u0000${cabinet.cabinetId}`));
  const incompletePinnedProjects = new Set();
  for (const [projectKey, sources] of Object.entries(config.projectCabinetSources || {})) {
    if (!projectsByKey.has(projectKey) || (onlyProjectKeys.size && !onlyProjectKeys.has(projectKey))) continue;
    const missingSources = sources.filter((source) =>
      !collectedSources.has(`${source.accountLabel}\u0000${source.cabinetId}`));
    if (!missingSources.length) continue;
    incompletePinnedProjects.add(projectKey);
    skipped.push({
      projectKey,
      reason: "pinned_vk_source_missing",
      error: `Не получены данные VK из ${missingSources.map((source) => `${source.accountLabel}:${source.cabinetId}`).join(", ")}`,
    });
  }

  for (const project of aggregation.projects) {
    if (incompletePinnedProjects.has(project.projectKey)) continue;
    const registry = projectsByKey.get(project.projectKey);
    if (!registry) {
      skipped.push({ projectKey: project.projectKey, reason: "missing_project_record" });
      continue;
    }
    if (!registry.google_spreadsheet_id) {
      skipped.push({ projectKey: project.projectKey, reason: "missing_google_sheet" });
      continue;
    }
    try {
      const sectionLabel = config.projectTableSections?.[project.projectKey] || "";
      const targetSheet = await ensureMonthlySheet(
        sheets,
        registry.google_spreadsheet_id,
        registry,
        date,
        sectionLabel,
      );
      const sheetName = targetSheet.sheetName;
      const metrics = {
        ...calculateSheetMetrics({
          leads: project.leads,
          spend: project.spend,
          vatRate: config.defaultVatRate,
          bonusMultiplier: config.defaultBonusMultiplier,
        }),
        clicks: Number(project.clicks) || 0,
        shows: Number(project.shows) || 0,
        cr: (Number(project.clicks) || 0) ? (Number(project.leads) || 0) / Number(project.clicks) : 0,
        ctr: (Number(project.shows) || 0) ? (Number(project.clicks) || 0) / Number(project.shows) : 0,
      };
      if (config.projectCplIncludesVat?.[project.projectKey]) {
        metrics.cpl = metrics.leads > 0 ? Math.round(metrics.spendWithVat / metrics.leads * 100) / 100 : 0;
      }
      const additionalMetricLabels = config.projectAdditionalMetricLabels?.[project.projectKey] || {};
      const values = await sheets.readValues(
        registry.google_spreadsheet_id,
        `${sheetName}!A1:AZ80`,
      );
      const { updates, missingMetricLabels } = buildMetricUpdatePlan({
        sheetName,
        values,
        date,
        metrics,
        sectionLabel,
        additionalMetricLabels,
        metricKeys: onlyMetricKeys.size ? [...onlyMetricKeys] : [...new Set([...(config.defaultMetricKeys || []), ...Object.keys(additionalMetricLabels)])],
      });
      if (missingMetricLabels.length) {
        throw new Error(`Metric rows not found: ${missingMetricLabels.join(", ")}`);
      }
      if (!updates.length) {
        throw new Error("Metric rows not found");
      }
      const result = await sheets.batchUpdateValues(registry.google_spreadsheet_id, updates);
      if ((Number(result.totalUpdatedCells) || 0) < updates.length) {
        throw new Error(`Google updated only ${result.totalUpdatedCells || 0} of ${updates.length} metric cells`);
      }
      projectUrlsByKey.set(project.projectKey, sheetUrl(registry.google_spreadsheet_id, targetSheet.sheetId));
      writes.push({
        projectKey: project.projectKey,
        spreadsheetId: registry.google_spreadsheet_id,
        sheetName,
        metrics,
        missingMetricLabels,
        updatedCells: result.totalUpdatedCells || 0,
      });
    } catch (error) {
      skipped.push({
        projectKey: project.projectKey,
        spreadsheetId: registry.google_spreadsheet_id,
        reason: "google_sheet_write_failed",
        error: error.message,
      });
    }
  }

  const registryUpdates = scannedCabinets.map((cabinet) => {
    const spend = Number(cabinet.stats?.spend) || 0;
    return {
      status: decideCabinetStatus({ spend }),
      account_label: cabinet.accountLabel,
      cabinet_id: cabinet.cabinetId,
      cabinet_name: cabinet.cabinetName,
      project_key: cabinet.parsed?.projectKey || "",
      last_seen_at: date,
      last_positive_spend_at: spend > 0 ? date : "",
      last_spend: String(spend),
      last_leads: String(Number(cabinet.stats?.leads) || 0),
      notes: "",
    };
  });
  const cabinetRegistryRows = upsertCabinetRegistryRows(existingCabinetRows, registryUpdates);
  if (!skipRegistryUpdate) {
    await writeCabinetRegistry(cabinetsRegistryPath, cabinetRegistryRows);
  }
  let masterRegistryError = null;
  if (config.masterSpreadsheetId && !skipMasterRegistryUpdate) {
    try {
    const runDate = new Date().toLocaleDateString("sv-SE");
    const cabinetReadFailures = accountReports.flatMap((report) =>
      report.errors
        .filter((error) => error.projectKey)
        .map((error) => ({
          projectKey: error.projectKey,
          reason: "vk_cabinet_read_failed",
          error: error.error,
        })),
    );
    const projectNotes = notesByProjectKeyFromResults({
      writes,
      skipped: [...skipped, ...cabinetReadFailures],
      projects: expandedProjects,
      runDate,
      targetDate: date,
    });
    const masterRows = buildMasterRegistryRows(
      discoveredCabinets,
      expandedProjects,
      cabinetRegistryRows,
      {
        multiCityCabinets: config.multiCityCabinets,
        notesByProjectKey: projectNotes,
        projectUrlsByKey,
        missingSheetNote: noteForSkippedProject({
          reason: "missing_google_sheet",
          runDate,
          targetDate: date,
        }),
        noActivityNote: noteForSkippedProject({
          reason: "no_project_activity",
          runDate,
          targetDate: date,
        }),
      },
    );
    await writeMasterRegistry({
      sheets,
      spreadsheetId: config.masterSpreadsheetId,
      projectRows: masterRows.projectRows,
      cabinetRows: masterRows.cabinetRows,
    });
    } catch (error) {
      masterRegistryError = error.message;
      console.error(JSON.stringify({ ok: false, stage: "master_registry", error: error.message }, null, 2));
    }
  }

  await writeProjectLinkCache(projectLinkCachePath, expandedProjects, projectUrlsByKey);

  const result = {
    ok: true,
    date,
    accountReports,
    aggregation,
    writes,
    skipped,
    cabinetsRegistryPath,
    cabinetScanFilter: onlyProjectKeys.size ? { projectKeys: [...onlyProjectKeys] } : null,
    cabinetRegistryUpdates: registryUpdates.length,
    skipRegistryUpdate,
    skipMasterRegistryUpdate,
    masterSpreadsheet: config.masterSpreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${config.masterSpreadsheetId}/edit`
      : null,
    masterRegistryError,
  };
  const compactResult = compactSyncResult(result);
  console.log(JSON.stringify(compactResult, null, 2));
  if (!skipNotification) {
    try {
      await sendTelegramMessage(summarizeSyncResult(compactResult));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, telegramError: error.message }, null, 2));
    }
  }
}

main().catch(async (error) => {
  const result = { ok: false, error: error.message, stack: error.stack, date };
  console.error(JSON.stringify(result, null, 2));
  if (!skipNotification) {
    try {
      await sendTelegramMessage(`VK Ads sync: ошибка\nДата статистики: ${date}\n${error.message}`);
    } catch {
      // Keep the original sync failure as the process result.
    }
  }
  process.exit(1);
});
