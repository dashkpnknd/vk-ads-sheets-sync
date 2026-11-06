function shortDate(date) {
  const match = String(date || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return String(date || "");
  return `${match[2]}.${match[1]}`;
}

function writeFailureText(error) {
  const text = String(error || "");
  const metric = text.match(/Metric rows? not found: (.+)$/);
  if (metric) {
    return `не записалось — в таблице не найдена строка «${metric[1]}»`;
  }

  const date = text.match(/Date column not found: (.+)$/);
  if (date) {
    return `не записалось — в таблице не найдена дата «${date[1]}»`;
  }

  if (/403|permission|access|доступ/i.test(text)) {
    return "не записалось — нет доступа к рабочей таблице";
  }

  if (/429|quota exceeded|rate_limit/i.test(text)) {
    return "не записалось — временный лимит Google API, робот повторит позже";
  }

  return text ? `не записалось — ${text}` : "не записалось — ошибка рабочей таблицы";
}

export function noteForSkippedProject({ reason, error, runDate, targetDate }) {
  const prefix = `${shortDate(runDate)} проверка за ${shortDate(targetDate)}:`;
  const detailsByReason = {
    missing_project_record: "не записалось — проект не найден в общей таблице",
    missing_google_sheet: "не записалось — нет ссылки на рабочую таблицу",
    no_project_activity: "",
    zero_spend: "",
    vk_cabinet_read_failed: "не записалось — робот не смог открыть кабинет VK",
    google_sheet_write_failed: writeFailureText(error),
  };
  const details = Object.hasOwn(detailsByReason, reason)
    ? detailsByReason[reason]
    : `не записалось — ${reason || "неизвестная причина"}`;

  if (!details) return "";
  return `${prefix} ${details}`;
}

export function noteForWrittenProject({ missingMetricLabels = [], runDate, targetDate }) {
  if (!missingMetricLabels.length) return "";
  const labels = missingMetricLabels.map((label) => `«${label}»`).join(", ");
  return `${shortDate(runDate)} проверка за ${shortDate(targetDate)}: частично записано — не найдена строка ${labels}`;
}

export function notesByProjectKeyFromSkipped(skipped, { runDate, targetDate, projects = [] }) {
  const notes = new Map();
  for (const item of skipped) {
    const note = noteForSkippedProject({ ...item, runDate, targetDate });
    if (note.trim()) notes.set(item.projectKey, note);
  }

  for (const project of projects) {
    if (notes.has(project.project_key)) continue;
    const reason = project.google_spreadsheet_id ? "no_project_activity" : "missing_google_sheet";
    const note = noteForSkippedProject({ reason, runDate, targetDate });
    if (note.trim()) notes.set(project.project_key, note);
  }

  return notes;
}

export function notesByProjectKeyFromResults({ writes = [], skipped = [], projects = [], runDate, targetDate }) {
  const notes = notesByProjectKeyFromSkipped(skipped, { projects, runDate, targetDate });
  for (const write of writes) {
    const note = noteForWrittenProject({ ...write, runDate, targetDate });
    if (note.trim()) {
      notes.set(write.projectKey, note);
    } else {
      notes.delete(write.projectKey);
    }
  }
  return notes;
}
