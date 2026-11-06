#!/usr/bin/env node
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadTelegramConfig, sendTelegramMessage } from "../src/telegram_notifier.mjs";

const execFileAsync = promisify(execFile);
const envPath = process.env.TELEGRAM_ENV_PATH || "secrets/telegram.env";
const serviceName = process.env.VK_SYNC_SERVICE || "vk-ads-sync.service";
let offset = 0;

function setEnvValue(text, key, value) {
  return text.match(new RegExp(`^${key}=`, "m"))
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${text.trim()}\n${key}=${value}\n`;
}

function updateTelegramTarget(chatId, messageThreadId = "") {
  if (!chatId || !fs.existsSync(envPath)) return;
  let text = fs.readFileSync(envPath, "utf8");
  text = setEnvValue(text, "TELEGRAM_CHAT_ID", chatId);
  text = setEnvValue(text, "TELEGRAM_MESSAGE_THREAD_ID", messageThreadId || "");
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}

async function telegram(method, payload = {}) {
  const { token } = loadTelegramConfig(envPath);
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`${method} failed: ${response.status} ${JSON.stringify(data)}`);
  return data.result;
}

async function reply(chatId, text, messageThreadId = "") {
  await sendTelegramMessage(text, {
    ...loadTelegramConfig(envPath),
    chatId: String(chatId),
    messageThreadId: messageThreadId ? String(messageThreadId) : loadTelegramConfig(envPath).messageThreadId,
  });
}

async function commandOutput(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 20000, ...options });
  return `${stdout || ""}${stderr || ""}`.trim();
}

async function statusText() {
  const service = await commandOutput("systemctl", ["status", serviceName, "--no-pager", "-l"]).catch((error) => error.stdout || error.message);
  const timer = await commandOutput("systemctl", ["list-timers", "--all", "--no-pager"]).catch(() => "");
  const vkTimer = timer.split("\n").find((line) => line.includes("vk-ads-sync.timer")) || "timer not found";
  const tail = await commandOutput("tail", ["-80", "/opt/vk-ads-sync/logs/sync.log"]).catch(() => "");
  const lastDate = tail.match(/"date": "([^"]+)"/)?.[1] || "не нашёл";
  const writes = tail.match(/"writes": \[/) ? (tail.match(/"updatedCells":/g) || []).length : "не посчитал";
  return [
    "VK Ads sync status",
    vkTimer,
    service.split("\n").slice(0, 8).join("\n"),
    `Последняя дата в логе: ${lastDate}`,
    `Записей в хвосте лога: ${writes}`,
  ].join("\n");
}

async function runSync(chatId, dateArg = "", messageThreadId = "") {
  const active = await commandOutput("systemctl", ["is-active", serviceName]).catch(() => "inactive");
  if (active.trim() === "active") {
    await reply(chatId, "Сбор уже идёт, второй запуск не стартую.", messageThreadId);
    return;
  }
  if (dateArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      await reply(chatId, "Формат даты: /run 2026-07-01", messageThreadId);
      return;
    }
    const unit = `vk-ads-manual-${dateArg.replaceAll("-", "")}`;
    await execFileAsync("systemd-run", [
      `--unit=${unit}`,
      "--working-directory=/opt/vk-ads-sync",
      "--property=Environment=TZ=Europe/Moscow",
      "--property=StandardOutput=append:/opt/vk-ads-sync/logs/sync.log",
      "--property=StandardError=append:/opt/vk-ads-sync/logs/sync-error.log",
      "/usr/bin/node",
      "bin/rpa_sync_projects.mjs",
      "--config",
      "config/rpa.server.json",
      "--date",
      dateArg,
    ]);
    await reply(chatId, `Ручной сбор за ${dateArg} запущен: ${unit}`, messageThreadId);
    return;
  }
  await execFileAsync("systemctl", ["start", serviceName]);
  await reply(chatId, "Сбор запущен.", messageThreadId);
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = String(message.text || "").trim();
  const messageThreadId = "";
  if (!chatId || !text) return;
  if (message.chat?.type === "private") {
    updateTelegramTarget(chatId, "");
  }
  if (text.startsWith("/start")) {
    await reply(chatId, "Готов. Буду писать в этот топик. Команды: /status, /run, /run YYYY-MM-DD", messageThreadId);
  } else if (text.startsWith("/status")) {
    await reply(chatId, await statusText(), messageThreadId);
  } else if (text.startsWith("/run")) {
    const [, dateArg = ""] = text.split(/\s+/, 2);
    await runSync(chatId, dateArg, messageThreadId);
  } else {
    await reply(chatId, "Команды: /status, /run, /run YYYY-MM-DD", messageThreadId);
  }
}

async function poll() {
  for (;;) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleMessage(update.message || {});
      }
    } catch (error) {
      console.error(new Date().toISOString(), error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

await poll();
