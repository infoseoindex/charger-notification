import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const BELCHARGE_API = "https://belcharge.by/api";
const TELEGRAM_API = "https://api.telegram.org";
const AVAILABLE_STATUS = "Available";
const STATE_FILE = fileURLToPath(new URL("../data/state.json", import.meta.url));

const config = loadConfig();
const pollIntervalMs = secondsToMs(config.POLL_INTERVAL_SECONDS, 60);
const connectorTypes = listFromEnv(config.CONNECTOR_TYPES).map((value) => value.toUpperCase());
const minPowerKw = numberFromEnv(config.MIN_POWER_KW, 0);
const notifyWhenAlreadyAvailable = config.NOTIFY_WHEN_ALREADY_AVAILABLE === "true";
const noAvailabilityReportEveryMs = minutesToMs(config.NO_AVAILABILITY_REPORT_EVERY_MINUTES, 0);

const state = loadState();

main().catch((error) => {
  console.error("[charger-notification] fatal error", error);
  process.exitCode = 1;
});

async function main() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    log("TELEGRAM_BOT_TOKEN is empty. Add it to .env first.");
    return;
  }

  mergeEnvWatchList();
  mergeEnvChatId();
  log(`service started. Watching ${state.watchLocationIds.length} station(s).`);

  await Promise.all([
    runTelegramPolling(),
    runStationPolling()
  ]);
}

async function runTelegramPolling() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: state.telegramOffset + 1,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates.result || []) {
        state.telegramOffset = Math.max(state.telegramOffset, update.update_id);
        await handleTelegramUpdate(update);
      }

      saveState();
    } catch (error) {
      log(`telegram polling failed: ${error.message}`);
      await delay(5000);
    }
  }
}

async function runStationPolling() {
  while (true) {
    await pollStationsOnce();
    await delay(pollIntervalMs);
  }
}

async function pollStationsOnce() {
  for (const locationId of state.watchLocationIds) {
    try {
      const location = await fetchLocation(locationId);
      await handleLocation(location);
    } catch (error) {
      log(`failed to check ${locationId}: ${error.message}`);
    }
  }

  saveState();
}

async function handleTelegramUpdate(update) {
  const message = update.message;

  if (!message || !message.chat || !message.text) {
    return;
  }

  state.chatIds[String(message.chat.id)] = {
    id: message.chat.id,
    type: message.chat.type,
    title: message.chat.title || message.chat.username || message.chat.first_name || "Telegram chat"
  };

  const text = message.text.trim();
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = normalizeCommand(rawCommand);
  const payload = args.join(" ").trim();

  if (command === "/start") {
    await sendMessage(message.chat.id, [
      "ChargerNotification is running.",
      "Commands:",
      "/search station text",
      "/watch locationId",
      "/unwatch locationId",
      "/list",
      "/check"
    ].join("\n"));
    return;
  }

  if (command === "/search") {
    await handleSearchCommand(message.chat.id, payload);
    return;
  }

  if (command === "/watch") {
    await handleWatchCommand(message.chat.id, payload);
    return;
  }

  if (command === "/unwatch") {
    await handleUnwatchCommand(message.chat.id, payload);
    return;
  }

  if (command === "/list") {
    await handleListCommand(message.chat.id);
    return;
  }

  if (command === "/check") {
    await handleCheckCommand(message.chat.id);
    return;
  }

  await sendMessage(message.chat.id, "Unknown command. Send /start for help.");
}

async function handleSearchCommand(chatId, query) {
  if (!query) {
    await sendMessage(chatId, "Usage: /search station text");
    return;
  }

  const matches = await searchLocations(query);

  if (matches.length === 0) {
    await sendMessage(chatId, "No stations found.");
    return;
  }

  await sendMessage(chatId, matches.map(formatSearchResult).join("\n\n"));
}

async function handleWatchCommand(chatId, locationId) {
  if (!locationId) {
    await sendMessage(chatId, "Usage: /watch locationId");
    return;
  }

  const location = await fetchLocation(locationId);

  if (!state.watchLocationIds.includes(location.id)) {
    state.watchLocationIds.push(location.id);
  }

  await handleLocation(location, { forceLog: true });
  saveState();
  await sendMessage(chatId, `Watching: ${location.name}`);
}

async function handleUnwatchCommand(chatId, locationId) {
  state.watchLocationIds = state.watchLocationIds.filter((id) => id !== locationId);
  delete state.availability[locationId];
  saveState();
  await sendMessage(chatId, `Removed from watch list: ${locationId}`);
}

async function handleListCommand(chatId) {
  if (state.watchLocationIds.length === 0) {
    await sendMessage(chatId, "Watch list is empty. Use /search and /watch.");
    return;
  }

  await sendMessage(chatId, state.watchLocationIds.map((id) => {
    const status = state.availability[id]?.isAvailable ? "available" : "not available";
    const name = state.availability[id]?.name || id;
    return `${id}\n${name}\n${status}`;
  }).join("\n\n"));
}

async function handleCheckCommand(chatId) {
  if (state.watchLocationIds.length === 0) {
    await sendMessage(chatId, "Watch list is empty. Use /search and /watch.");
    return;
  }

  const reports = [];

  for (const locationId of state.watchLocationIds) {
    try {
      const location = await fetchLocation(locationId);
      await handleLocation(location, { forceLog: true, skipNotify: true });
      reports.push(buildLocationReport(location));
    } catch (error) {
      reports.push(`${locationId}\ncheck failed: ${error.message}`);
    }
  }

  saveState();
  await sendMessage(chatId, reports.join("\n\n"));
}

async function handleLocation(location, options = {}) {
  const report = getLocationConnectorReport(location);
  const matchingConnectors = report.matchingConnectors;
  const availableConnectors = report.availableConnectors;
  const previous = state.availability[location.id];
  const wasAvailable = previous?.isAvailable;
  const isAvailable = availableConnectors.length > 0;

  if (!options.skipNotify && ((wasAvailable === false && isAvailable) || (wasAvailable === undefined && isAvailable && notifyWhenAlreadyAvailable))) {
    await notifyAll(formatAvailableMessage(location, availableConnectors, matchingConnectors.length));
  }

  if (!options.skipNotify && shouldSendNoAvailabilityReport(location.id, isAvailable)) {
    await notifyAll(formatNoAvailabilityMessage(location, matchingConnectors.length));
    state.availability[location.id] = {
      ...(state.availability[location.id] || {}),
      lastNoAvailabilityReportAt: new Date().toISOString()
    };
  }

  if (options.forceLog || wasAvailable !== isAvailable) {
    log(`${location.name}: ${isAvailable ? "available" : "not available"}`);
  }

  state.availability[location.id] = {
    ...(state.availability[location.id] || {}),
    name: location.name,
    isAvailable,
    availableCount: availableConnectors.length,
    matchingCount: matchingConnectors.length,
    updatedAt: new Date().toISOString()
  };
}

async function searchLocations(query) {
  const response = await fetch(`${BELCHARGE_API}/map/locations`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: "{}"
  });

  if (!response.ok) {
    throw new Error(`BelCharge search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const normalizedQuery = query.toLowerCase();

  return (data.value || [])
    .filter((location) => matchesQuery(location, normalizedQuery))
    .slice(0, 10);
}

async function fetchLocation(locationId) {
  const response = await fetch(`${BELCHARGE_API}/map/locations/${locationId}`);

  if (!response.ok) {
    throw new Error(`BelCharge location request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function getMatchingConnectors(location) {
  return (location.stations || [])
    .flatMap((station) => station.connectors || [])
    .filter((connector) => {
      const typeMatches = connectorTypes.length === 0 || connectorTypes.includes(String(connector.type).toUpperCase());
      const powerMatches = Number(connector.power || 0) >= minPowerKw;
      return typeMatches && powerMatches;
    });
}

function getLocationConnectorReport(location) {
  const matchingConnectors = getMatchingConnectors(location);
  const availableConnectors = matchingConnectors.filter((connector) => connector.status === AVAILABLE_STATUS);

  return {
    matchingConnectors,
    availableConnectors,
    busyConnectors: matchingConnectors.filter((connector) => connector.status !== AVAILABLE_STATUS)
  };
}

function buildLocationReport(location) {
  const report = getLocationConnectorReport(location);
  const mapsUrl = `https://yandex.ru/maps/?rtext=~${location.latitude},${location.longitude}`;
  const status = report.availableConnectors.length > 0 ? "available" : "not available";
  const connectorSummary = report.availableConnectors.length > 0
    ? summarizeConnectors(report.availableConnectors)
    : summarizeConnectorStatuses(report.busyConnectors);

  return [
    `${location.name}`,
    `${location.provider || "Unknown provider"}: ${status} ${report.availableConnectors.length}/${report.matchingConnectors.length}`,
    connectorSummary,
    mapsUrl
  ].filter(Boolean).join("\n");
}

function formatSearchResult(location) {
  const availability = location.availableConnectorsExist ? "available" : "busy";
  return [
    `${location.id}`,
    `${availability} | ${location.provider} | ${location.name}`,
    `${location.address || location.description || ""}`,
    `connectors=${location.connectorsCount}, power=${location.minPower}-${location.maxPower} kW`,
    `Add: /watch ${location.id}`
  ].join("\n");
}

function formatAvailableMessage(location, availableConnectors, totalMatchingConnectors) {
  const connectorSummary = summarizeConnectors(availableConnectors);
  const mapsUrl = `https://yandex.ru/maps/?rtext=~${location.latitude},${location.longitude}`;

  return [
    "Free charger found. You can go now.",
    `${location.name}`,
    `${location.provider || "Unknown provider"}: available ${availableConnectors.length}/${totalMatchingConnectors}`,
    connectorSummary,
    mapsUrl
  ].filter(Boolean).join("\n");
}

function formatNoAvailabilityMessage(location, totalMatchingConnectors) {
  return [
    "Still no free chargers.",
    `${location.name}`,
    `${location.provider || "Unknown provider"}: available 0/${totalMatchingConnectors}`
  ].join("\n");
}

function summarizeConnectors(connectors) {
  return connectors
    .slice(0, 6)
    .map((connector) => `${connector.type} ${connector.power} kW, ${connector.rate ?? "?"} BYN/kWh`)
    .join("\n");
}

function summarizeConnectorStatuses(connectors) {
  if (connectors.length === 0) {
    return "No connectors match current filters.";
  }

  return connectors
    .slice(0, 6)
    .map((connector) => `${connector.type} ${connector.power} kW: ${connector.status}`)
    .join("\n");
}

function shouldSendNoAvailabilityReport(locationId, isAvailable) {
  if (isAvailable || noAvailabilityReportEveryMs <= 0) {
    return false;
  }

  const previousReportAt = state.availability[locationId]?.lastNoAvailabilityReportAt;

  if (!previousReportAt) {
    return true;
  }

  return Date.now() - new Date(previousReportAt).getTime() >= noAvailabilityReportEveryMs;
}

async function notifyAll(message) {
  const chatIds = Object.keys(state.chatIds);

  if (chatIds.length === 0) {
    log(message.replace(/\n/g, " | "));
    return;
  }

  await Promise.all(chatIds.map((chatId) => sendMessage(chatId, message)));
}

async function sendMessage(chatId, text) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram ${method} failed`);
  }

  return data;
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {
      telegramOffset: 0,
      chatIds: {},
      watchLocationIds: [],
      availability: {}
    };
  }

  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function mergeEnvWatchList() {
  const envIds = listFromEnv(config.WATCH_LOCATION_IDS);

  for (const id of envIds) {
    if (!state.watchLocationIds.includes(id)) {
      state.watchLocationIds.push(id);
    }
  }

  saveState();
}

function mergeEnvChatId() {
  if (!config.TELEGRAM_CHAT_ID) {
    return;
  }

  state.chatIds[String(config.TELEGRAM_CHAT_ID)] = {
    id: config.TELEGRAM_CHAT_ID,
    type: "configured",
    title: "Configured Telegram chat"
  };

  saveState();
}

function loadConfig() {
  const envPath = new URL("../.env", import.meta.url);
  const env = { ...process.env };

  if (!existsSync(envPath)) {
    return env;
  }

  const content = readFileSync(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function listFromEnv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function secondsToMs(value, fallbackSeconds) {
  return numberFromEnv(value, fallbackSeconds) * 1000;
}

function minutesToMs(value, fallbackMinutes) {
  return numberFromEnv(value, fallbackMinutes) * 60 * 1000;
}

function normalizeCommand(command) {
  return String(command || "").split("@")[0];
}

function matchesQuery(location, normalizedQuery) {
  return [
    location.name,
    location.address,
    location.description,
    location.provider
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
