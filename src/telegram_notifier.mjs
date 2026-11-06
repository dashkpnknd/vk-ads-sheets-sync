import fs from "node:fs";

function parseEnv(text) {
  const env = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function loadTelegramConfig(path = process.env.TELEGRAM_ENV_PATH || "secrets/telegram.env") {
  const fileEnv = fs.existsSync(path) ? parseEnv(fs.readFileSync(path, "utf8")) : {};
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || fileEnv.TELEGRAM_CHAT_ID || "",
    messageThreadId: process.env.TELEGRAM_MESSAGE_THREAD_ID || fileEnv.TELEGRAM_MESSAGE_THREAD_ID || "",
  };
}

export async function sendTelegramMessage(text, config = loadTelegramConfig()) {
  if (!config.token || !config.chatId) return { ok: false, skipped: true };
  const maxLength = 4096;
  const message = String(text || "");
  const safeText = message.length <= maxLength
    ? message
    : `${message.slice(0, maxLength - 24)}\n...сообщение сокращено`;
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: safeText,
      disable_web_page_preview: true,
      ...(config.messageThreadId ? { message_thread_id: Number(config.messageThreadId) } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export function summarizeSyncResult(result) {
  const writes = result.writes?.length || 0;
  const skipped = result.skipped?.length || 0;
  const errors = result.accountReports?.reduce((sum, report) => sum + (report.errors?.length || 0), 0) || 0;
  const cells = result.writes?.reduce((sum, write) => sum + (Number(write.updatedCells) || 0), 0) || 0;
  const lines = [
    `VK Ads sync: ${skipped || errors ? "есть замечания" : "успешно"}`,
    `Дата статистики: ${result.date}`,
    `Записано проектов: ${writes}`,
    `Обновлено ячеек: ${cells}`,
    `Пропущено проектов: ${skipped}`,
    `Ошибок кабинетов VK: ${errors}`,
  ];
  for (const item of (result.skipped || []).slice(0, 8)) {
    lines.push(`- ${item.projectKey}: ${item.error || item.reason}`);
  }
  if (skipped > 8) lines.push(`...и ещё ${skipped - 8}`);
  return lines.join("\n");
}
