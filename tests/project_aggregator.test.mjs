import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateCabinetsByProject,
  decideCabinetStatus,
} from "../src/project_aggregator.mjs";

test("aggregates every parsed cabinet by project key, including zero spend", () => {
  const result = aggregateCabinetsByProject([
    {
      accountLabel: "vk-1",
      cabinetId: "1",
      cabinetName: "Аймоби | Москва (2)",
      stats: { leads: 3, spend: 600 },
    },
    {
      accountLabel: "vk-1",
      cabinetId: "2",
      cabinetName: "Аймоби | Москва (3)",
      stats: { leads: 4, spend: 800 },
    },
    {
      accountLabel: "vk-1",
      cabinetId: "3",
      cabinetName: "Аймоби | Москва (4)",
      stats: { leads: 0, spend: 0 },
    },
    {
      accountLabel: "vk-1",
      cabinetId: "4",
      cabinetName: "Непонятное название",
      stats: { leads: 1, spend: 200 },
    },
  ]);

  assert.deepEqual(result.projects, [
    {
      projectKey: "аймоби|москва",
      projectName: "Аймоби",
      city: "Москва",
      leads: 7,
      spend: 1400,
      clicks: 0,
      shows: 0,
      cabinetIds: ["1", "2", "3"],
      cabinetNames: ["Аймоби | Москва (2)", "Аймоби | Москва (3)", "Аймоби | Москва (4)"],
    },
  ]);
  assert.deepEqual(result.zeroSpendCabinets, []);
  assert.deepEqual(result.unrecognizedCabinets.map((cabinet) => cabinet.cabinetId), ["4"]);
});

test("aggregates matching projects across different VK accounts", () => {
  const result = aggregateCabinetsByProject([
    {
      accountLabel: "vk-account-1",
      cabinetId: "1",
      cabinetName: "Аймоби | Москва",
      stats: { leads: 2, spend: 300 },
    },
    {
      accountLabel: "vk-account-2",
      cabinetId: "2",
      cabinetName: "Аймоби | Москва (2)",
      stats: { leads: 5, spend: 700 },
    },
  ]);

  assert.deepEqual(result.projects, [
    {
      projectKey: "аймоби|москва",
      projectName: "Аймоби",
      city: "Москва",
      leads: 7,
      spend: 1000,
      clicks: 0,
      shows: 0,
      cabinetIds: ["1", "2"],
      cabinetNames: ["Аймоби | Москва", "Аймоби | Москва (2)"],
    },
  ]);
});

test("marks every scanned cabinet active regardless of spend", () => {
  assert.equal(decideCabinetStatus({ spend: 10, previousStatus: "active" }), "active");
  assert.equal(decideCabinetStatus({ spend: 0, previousStatus: "active" }), "active");
  assert.equal(decideCabinetStatus({ spend: 100, previousStatus: "ignored_zero_spend" }), "active");
});
