import { parseCabinetName } from "./cabinet_parser.mjs";

export function decideCabinetStatus({ spend }) {
  return "active";
}

export function aggregateCabinetsByProject(cabinets) {
  const projectsByKey = new Map();
  const zeroSpendCabinets = [];
  const unrecognizedCabinets = [];

  for (const cabinet of cabinets) {
    const stats = cabinet.stats || {};
    const spend = Number(stats.spend) || 0;

    const parsed = cabinet.parsed || parseCabinetName(cabinet.cabinetName);
    if (!parsed) {
      unrecognizedCabinets.push(cabinet);
      continue;
    }

    const current = projectsByKey.get(parsed.projectKey) || {
      projectKey: parsed.projectKey,
      projectName: parsed.projectName,
      city: parsed.city,
      leads: 0,
      spend: 0,
      clicks: 0,
      shows: 0,
      cabinetIds: [],
      cabinetNames: [],
    };

    current.leads += Number(stats.leads) || 0;
    current.spend += spend;
    current.clicks += Number(stats.clicks) || 0;
    current.shows += Number(stats.shows) || 0;
    current.cabinetIds.push(cabinet.cabinetId);
    current.cabinetNames.push(cabinet.cabinetName);
    projectsByKey.set(parsed.projectKey, current);
  }

  return {
    projects: [...projectsByKey.values()],
    zeroSpendCabinets,
    unrecognizedCabinets,
  };
}
