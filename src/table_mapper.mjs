const MONTHS_RU = new Map([
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

const METRIC_LABELS = {
  leads: "Кол-во лидов",
  cpl: "Цена за лид",
  cplWithBonus: "Цена за лид с учетом бонусов",
  spend: "Расходы",
  spendWithVat: "Расходы + НДС",
};

const METRIC_ALIASES = {
  cplWithBonus: ["Цена за лид с учетом бонусов", "Цена за лид / с учетом бонусов"],
  spend: ["Расходы", "Рекл. бюджет"],
  spendWithVat: ["Расходы + НДС", "Рекл. бюджет с НДС"],
};

function normalizeLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function targetDateHeader(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date: ${date}`);
  }
  const [, , month, day] = match;
  return `${Number(day)} ${MONTHS_RU.get(Number(month))}`;
}

export function columnToA1(index) {
  let column = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

export function findDateColumn(values, date) {
  const expected = normalizeLabel(targetDateHeader(date));
  const header = values[0] || [];
  const index = header.findIndex((cell) => normalizeLabel(cell) === expected);
  if (index === -1) {
    throw new Error(`Date column not found: ${targetDateHeader(date)}`);
  }
  return index;
}

export function findMetricRow(values, label) {
  const expected = normalizeLabel(label);
  const index = values.findIndex((row) => normalizeLabel(row[0]) === expected);
  if (index === -1) {
    throw new Error(`Metric row not found: ${label}`);
  }
  return index;
}

function findMetricRowIndex(values, label, preferredColumns = [0]) {
  const expected = normalizeLabel(label);
  for (const column of preferredColumns) {
    if (column < 0) continue;
    const index = values.findIndex((row) => normalizeLabel(row[column]) === expected);
    if (index !== -1) return index;
  }
  return values.findIndex((row) => row.some((cell) => normalizeLabel(cell) === expected));
}

export function buildMetricUpdates({ sheetName, values, date, metrics }) {
  const column = findDateColumn(values, date);
  return Object.entries(METRIC_LABELS).map(([metricKey, label]) => {
    const labels = METRIC_ALIASES[metricKey] || [label];
    const row = labels
      .map((candidate) => values.findIndex((item) => normalizeLabel(item[0]) === normalizeLabel(candidate)))
      .find((index) => index !== -1);
    if (row === undefined) throw new Error(`Metric row not found: ${label}`);
    return {
      range: `${sheetName}!${columnToA1(column)}${row + 1}`,
      values: [[metrics[metricKey]]],
    };
  });
}

export function buildMetricUpdatePlan({ sheetName, values, date, metrics, sectionLabel = "", additionalMetricLabels = {}, metricKeys = [] }) {
  let rowOffset = 0;
  let sectionValues = values;
  if (sectionLabel) {
    rowOffset = values.findIndex((row) => normalizeLabel(row[0]) === normalizeLabel(sectionLabel));
    if (rowOffset === -1) {
      throw new Error(`Table section not found: ${sectionLabel}`);
    }
    sectionValues = values.slice(rowOffset);
  }

  const column = findDateColumn(sectionValues, date);
  const updates = [];
  const missingMetricLabels = [];

  const metricLabels = { ...METRIC_LABELS, ...additionalMetricLabels };
  const selectedMetricKeys = new Set(metricKeys);
  for (const [metricKey, label] of Object.entries(metricLabels)) {
    if (selectedMetricKeys.size && !selectedMetricKeys.has(metricKey)) continue;
    const labels = METRIC_ALIASES[metricKey] || [label];
    const row = labels
      .map((candidate) => findMetricRowIndex(sectionValues, candidate, [column - 1, 0]))
      .find((index) => index !== -1) ?? -1;
    if (row === -1) {
      missingMetricLabels.push(label);
      continue;
    }
    updates.push({
      range: `${sheetName}!${columnToA1(column)}${rowOffset + row + 1}`,
      values: [[metrics[metricKey]]],
    });
  }

  return { updates, missingMetricLabels };
}
