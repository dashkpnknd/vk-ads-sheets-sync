import fs from "node:fs/promises";
import path from "node:path";

import { readCsvRecords, writeCsvRecords } from "./csv.mjs";

export const CABINET_REGISTRY_HEADERS = [
  "status",
  "account_label",
  "cabinet_id",
  "cabinet_name",
  "project_key",
  "last_seen_at",
  "last_positive_spend_at",
  "last_spend",
  "last_leads",
  "notes",
];

export function cabinetRegistryKey({ account_label, accountLabel, cabinet_id, cabinetId }) {
  return `${account_label || accountLabel}|${cabinet_id || cabinetId}`;
}

export async function readCabinetRegistry(registryPath) {
  try {
    return await readCsvRecords(registryPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function upsertCabinetRegistryRows(existingRows, updates) {
  const rowsByKey = new Map(existingRows.map((row) => [cabinetRegistryKey(row), row]));
  for (const update of updates) {
    const previous = rowsByKey.get(cabinetRegistryKey(update)) || {};
    rowsByKey.set(cabinetRegistryKey(update), {
      ...previous,
      ...update,
    });
  }
  return [...rowsByKey.values()]
    .map((row) => {
      const { notes, ...cleanRow } = row;
      return cleanRow;
    })
    .sort((left, right) =>
      cabinetRegistryKey(left).localeCompare(cabinetRegistryKey(right)),
    );
}

export async function writeCabinetRegistry(registryPath, rows) {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await writeCsvRecords(registryPath, CABINET_REGISTRY_HEADERS, rows);
}
