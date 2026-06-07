import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const BELCHARGE_API = "https://belcharge.by/api";
const TELEGRAM_API = "https://api.telegram.org";
const AVAILABLE_STATUS = "Available";
const STATE_FILE = fileURLToPath(new URL("../data/state.json", import.meta.url));

const config = loadConfig();
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

  mergeEnvDefaults();
  await setupTelegramCommands();
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
        allowed_updates: ["message", "callback_query"]
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
    if (!state.settings.paused) {
      await pollStationsOnce();
    }

    await delay(getPollIntervalMs());
  }
}

async function pollStationsOnce() {
  for (const locationId of getWatchedLocationIds()) {
    try {
      const location = await fetchLocation(locationId);
      await handleLocation(location);
    } catch (error) {
      log(`failed to check ${locationId}: ${error.message}`);
    }
  }

  state.lastRunAt = new Date().toISOString();
  saveState();
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;

  if (!message || !message.chat || !message.text) {
    return;
  }

  subscribeChat(message.chat);

  const text = message.text.trim();
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = normalizeCommand(rawCommand);
  const payload = args.join(" ").trim();

  if (command === "/start" || command === "/menu") {
    await sendMenu(message.chat.id);
    return;
  }

  if (command === "/settings") {
    await sendSettings(message.chat.id);
    return;
  }

  if (command === "/status") {
    await sendStatus(message.chat.id);
    return;
  }

  if (command === "/check") {
    await handleCheckCommand(message.chat.id);
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

  if (command === "/station") {
    await handleStationCommand(message.chat.id, payload);
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

  if (command === "/pause") {
    state.settings.paused = true;
    saveState();
    await sendMessage(message.chat.id, "Checks paused.", mainKeyboard());
    return;
  }

  if (command === "/resume") {
    state.settings.paused = false;
    saveState();
    await sendMessage(message.chat.id, "Checks resumed.", mainKeyboard());
    return;
  }

  await handleMenuText(message.chat.id, text);
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id
  });

  if (!chatId) {
    return;
  }

  if (data === "menu") return sendMenu(chatId);
  if (data === "settings") return sendSettings(chatId);
  if (data === "status") return sendStatus(chatId);
  if (data === "check") return handleCheckCommand(chatId);
  if (data === "list") return handleListCommand(chatId);

  if (data === "pause") {
    state.settings.paused = true;
    saveState();
    return sendMessage(chatId, "Checks paused.", mainKeyboard());
  }

  if (data === "resume") {
    state.settings.paused = false;
    saveState();
    return sendMessage(chatId, "Checks resumed.", mainKeyboard());
  }

  if (data.startsWith("types:")) {
    const raw = data.slice("types:".length);
    state.settings.connectorTypes = raw ? raw.split(",") : [];
    saveState();
    return sendSettings(chatId);
  }

  if (data.startsWith("power:")) {
    state.settings.minPowerKw = Number(data.slice("power:".length));
    saveState();
    return sendSettings(chatId);
  }

  if (data.startsWith("reports:")) {
    state.settings.noAvailabilityReportEveryMinutes = Number(data.slice("reports:".length));
    saveState();
    return sendSettings(chatId);
  }

  if (data.startsWith("interval:")) {
    state.settings.pollIntervalSeconds = Number(data.slice("interval:".length));
    saveState();
    return sendSettings(chatId);
  }

  if (data.startsWith("toggle:")) {
    const [, sessionId, rawIndex] = data.split(":");
    return toggleConnectorSelection(chatId, sessionId, Number(rawIndex));
  }

  if (data.startsWith("watchsel:")) {
    const sessionId = data.slice("watchsel:".length);
    return watchSelectedConnectors(chatId, sessionId);
  }

  return undefined;
}

async function handleMenuText(chatId, text) {
  const normalized = text.toLowerCase();

  if (normalized === "menu") return sendMenu(chatId);
  if (normalized === "settings") return sendSettings(chatId);
  if (normalized === "status") return sendStatus(chatId);
  if (normalized === "check now") return handleCheckCommand(chatId);
  if (normalized === "watch list") return handleListCommand(chatId);

  if (await tryHandleStationInput(chatId, text)) {
    return;
  }

  return sendMessage(chatId, "Unknown command. Send a station id or use /menu.", mainKeyboard());
}

async function handleSearchCommand(chatId, query) {
  if (!query) {
    await sendMessage(chatId, "Usage: /search station text", mainKeyboard());
    return;
  }

  const matches = await searchLocations(query);

  if (matches.length === 0) {
    await sendMessage(chatId, "No stations found.", mainKeyboard());
    return;
  }

  await sendMessage(chatId, matches.map(formatSearchResult).join("\n\n"), mainKeyboard());
}

async function handleWatchCommand(chatId, locationId) {
  if (!locationId) {
    await sendMessage(chatId, "Usage: /watch locationId", mainKeyboard());
    return;
  }

  await handleStationCommand(chatId, locationId);
}

async function handleStationCommand(chatId, locationId) {
  if (!locationId) {
    await sendMessage(chatId, "Usage: /station locationId", mainKeyboard());
    return;
  }

  const location = await fetchLocation(locationId);
  await sendConnectorSelection(chatId, location);
}

async function tryHandleStationInput(chatId, text) {
  if (!/^[a-z0-9-]{12,}$/i.test(text)) {
    return false;
  }

  try {
    await handleStationCommand(chatId, text);
    return true;
  } catch {
    return false;
  }
}

async function handleUnwatchCommand(chatId, locationId) {
  state.watchLocationIds = state.watchLocationIds.filter((id) => id !== locationId);
  state.connectorWatches = state.connectorWatches.filter((watch) => watch.locationId !== locationId && watch.connectorId !== locationId);
  delete state.availability[locationId];
  delete state.availability[`connector:${locationId}`];
  saveState();
  await sendMessage(chatId, `Removed from watch list:\n${locationId}`, mainKeyboard());
}

async function handleListCommand(chatId) {
  if (state.watchLocationIds.length === 0 && state.connectorWatches.length === 0) {
    await sendMessage(chatId, "Watch list is empty. Send a station id, then choose connectors.", mainKeyboard());
    return;
  }

  const connectorLines = state.connectorWatches.map((watch) => {
    const status = state.availability[`connector:${watch.connectorId}`]?.status || "unknown";
    return `${watch.locationName}\n${watch.label}\n${status}\nRemove: /unwatch ${watch.connectorId}`;
  });

  const locationLines = state.watchLocationIds.map((id) => {
    const status = state.availability[id]?.isAvailable ? "available" : "not available";
    const name = state.availability[id]?.name || id;
    const counts = formatCounts(state.availability[id]);
    return `${id}\n${name}\n${status}${counts ? ` (${counts})` : ""}`;
  });

  await sendMessage(chatId, [...connectorLines, ...locationLines].join("\n\n"), mainKeyboard());
}

async function handleCheckCommand(chatId) {
  const locationIds = getWatchedLocationIds();

  if (locationIds.length === 0) {
    await sendMessage(chatId, "Watch list is empty. Send a station id, then choose connectors.", mainKeyboard());
    return;
  }

  const reports = [];

  for (const locationId of locationIds) {
    try {
      const location = await fetchLocation(locationId);
      await handleLocation(location, { forceLog: true, skipNotify: true });
      reports.push(buildLocationReport(location));
    } catch (error) {
      reports.push(`${locationId}\ncheck failed: ${error.message}`);
    }
  }

  state.lastRunAt = new Date().toISOString();
  saveState();
  await sendMessage(chatId, reports.join("\n\n"), mainKeyboard());
}

async function handleLocation(location, options = {}) {
  const connectorWatches = state.connectorWatches.filter((watch) => watch.locationId === location.id);

  if (connectorWatches.length > 0) {
    await handleWatchedConnectors(location, connectorWatches, options);
    return;
  }

  const report = getLocationConnectorReport(location);
  const matchingConnectors = report.matchingConnectors;
  const availableConnectors = report.availableConnectors;
  const previous = state.availability[location.id];
  const wasAvailable = previous?.isAvailable;
  const isAvailable = availableConnectors.length > 0;

  if (!options.skipNotify && ((wasAvailable === false && isAvailable) || (wasAvailable === undefined && isAvailable && state.settings.notifyWhenAlreadyAvailable))) {
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

async function sendConnectorSelection(chatId, location) {
  const connectors = flattenConnectors(location);

  if (connectors.length === 0) {
    await sendMessage(chatId, `No connectors found for:\n${location.name}`, mainKeyboard());
    return;
  }

  const sessionId = String(state.nextSessionId++);
  state.selectionSessions[sessionId] = {
    chatId: String(chatId),
    locationId: location.id,
    locationName: location.name,
    provider: location.provider,
    latitude: location.latitude,
    longitude: location.longitude,
    selected: [],
    connectors
  };
  saveState();

  await sendMessage(chatId, formatConnectorSelection(state.selectionSessions[sessionId]), connectorSelectionKeyboard(sessionId));
}

async function toggleConnectorSelection(chatId, sessionId, index) {
  const session = state.selectionSessions[sessionId];

  if (!session || String(chatId) !== String(session.chatId)) {
    await sendMessage(chatId, "Selection session expired. Send station id again.", mainKeyboard());
    return;
  }

  if (!Number.isInteger(index) || !session.connectors[index]) {
    await sendMessage(chatId, "Connector not found. Send station id again.", mainKeyboard());
    return;
  }

  if (session.selected.includes(index)) {
    session.selected = session.selected.filter((value) => value !== index);
  } else {
    session.selected.push(index);
  }

  saveState();
  await sendMessage(chatId, formatConnectorSelection(session), connectorSelectionKeyboard(sessionId));
}

async function watchSelectedConnectors(chatId, sessionId) {
  const session = state.selectionSessions[sessionId];

  if (!session || String(chatId) !== String(session.chatId)) {
    await sendMessage(chatId, "Selection session expired. Send station id again.", mainKeyboard());
    return;
  }

  if (session.selected.length === 0) {
    await sendMessage(chatId, "Choose at least one connector first.", connectorSelectionKeyboard(sessionId));
    return;
  }

  for (const index of session.selected) {
    const connector = session.connectors[index];
    const existingIndex = state.connectorWatches.findIndex((watch) => watch.connectorId === connector.connectorId);
    const watch = {
      locationId: session.locationId,
      locationName: session.locationName,
      provider: session.provider,
      latitude: session.latitude,
      longitude: session.longitude,
      stationId: connector.stationId,
      connectorId: connector.connectorId,
      label: connector.label,
      type: connector.type,
      power: connector.power
    };

    if (existingIndex === -1) {
      state.connectorWatches.push(watch);
    } else {
      state.connectorWatches[existingIndex] = watch;
    }

    state.availability[`connector:${connector.connectorId}`] = {
      status: connector.status,
      isAvailable: connector.status === AVAILABLE_STATUS,
      updatedAt: new Date().toISOString()
    };
  }

  delete state.selectionSessions[sessionId];
  saveState();
  await sendMessage(chatId, `Watching ${session.selected.length} connector(s):\n${session.locationName}`, mainKeyboard());
}

async function handleWatchedConnectors(location, watches, options = {}) {
  const connectors = flattenConnectors(location);
  const connectorById = new Map(connectors.map((connector) => [connector.connectorId, connector]));

  for (const watch of watches) {
    const connector = connectorById.get(watch.connectorId);
    const key = `connector:${watch.connectorId}`;
    const previous = state.availability[key];
    const status = connector?.status || "Missing";
    const isAvailable = status === AVAILABLE_STATUS;
    const wasAvailable = previous?.isAvailable;

    if (!options.skipNotify && wasAvailable === false && isAvailable) {
      await notifyAll(formatConnectorAvailableMessage(location, watch, connector));
    }

    state.availability[key] = {
      status,
      isAvailable,
      updatedAt: new Date().toISOString()
    };

    if (options.forceLog || wasAvailable !== isAvailable) {
      log(`${watch.label}: ${status}`);
    }
  }
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
  const connectorTypes = state.settings.connectorTypes.map((value) => value.toUpperCase());
  const minPowerKw = state.settings.minPowerKw;

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
  const connectorWatches = state.connectorWatches.filter((watch) => watch.locationId === location.id);

  if (connectorWatches.length > 0) {
    const connectors = flattenConnectors(location);
    const connectorById = new Map(connectors.map((connector) => [connector.connectorId, connector]));
    return [
      `${location.name}`,
      ...connectorWatches.map((watch) => {
        const connector = connectorById.get(watch.connectorId);
        return `${watch.label}: ${connector?.status || "Missing"}`;
      })
    ].join("\n");
  }

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

function formatConnectorAvailableMessage(location, watch, connector) {
  const mapsUrl = `https://yandex.ru/maps/?rtext=~${location.latitude},${location.longitude}`;

  return [
    "Selected connector is free.",
    `${location.name}`,
    `${watch.label}`,
    `${connector?.type || watch.type} ${connector?.power || watch.power} kW`,
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

function formatStatus() {
  return [
    "ChargerNotification status",
    `State: ${state.settings.paused ? "paused" : "running"}`,
    `Watched stations: ${state.watchLocationIds.length}`,
    `Poll interval: ${state.settings.pollIntervalSeconds}s`,
    `Connector types: ${state.settings.connectorTypes.length ? state.settings.connectorTypes.join(", ") : "any"}`,
    `Min power: ${state.settings.minPowerKw} kW`,
    `No-availability reports: ${state.settings.noAvailabilityReportEveryMinutes > 0 ? `${state.settings.noAvailabilityReportEveryMinutes} min` : "off"}`,
    `Last run: ${state.lastRunAt || "never"}`
  ].join("\n");
}

function formatSettings() {
  return [
    "Settings",
    `Connector types: ${state.settings.connectorTypes.length ? state.settings.connectorTypes.join(", ") : "any"}`,
    `Min power: ${state.settings.minPowerKw} kW`,
    `Poll interval: ${state.settings.pollIntervalSeconds}s`,
    `No-availability reports: ${state.settings.noAvailabilityReportEveryMinutes > 0 ? `${state.settings.noAvailabilityReportEveryMinutes} min` : "off"}`,
    `Initial available alert: ${state.settings.notifyWhenAlreadyAvailable ? "on" : "off"}`,
    `Paused: ${state.settings.paused ? "yes" : "no"}`
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
  const intervalMs = state.settings.noAvailabilityReportEveryMinutes * 60 * 1000;

  if (isAvailable || intervalMs <= 0) {
    return false;
  }

  const previousReportAt = state.availability[locationId]?.lastNoAvailabilityReportAt;

  if (!previousReportAt) {
    return true;
  }

  return Date.now() - new Date(previousReportAt).getTime() >= intervalMs;
}

async function sendMenu(chatId) {
  await sendMessage(chatId, [
    "ChargerNotification ready.",
    "Send a BelCharge station id, choose connectors with checkboxes, then start watching selected connectors.",
    "Use /search station text if you need to find a station id."
  ].join("\n"), mainKeyboard());
}

async function sendSettings(chatId) {
  await sendMessage(chatId, formatSettings(), settingsKeyboard());
}

async function sendStatus(chatId) {
  await sendMessage(chatId, formatStatus(), mainKeyboard());
}

async function notifyAll(message) {
  const chatIds = Object.keys(state.chatIds);

  if (chatIds.length === 0) {
    log(message.replace(/\n/g, " | "));
    return;
  }

  await Promise.all(chatIds.map((chatId) => sendMessage(chatId, message, mainKeyboard())));
}

async function sendMessage(chatId, text, replyMarkup) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function setupTelegramCommands() {
  await telegram("setMyCommands", {
    commands: [
      { command: "menu", description: "Main menu" },
      { command: "settings", description: "Settings" },
      { command: "status", description: "Status" },
      { command: "check", description: "Check now" },
      { command: "station", description: "Show station connectors" },
      { command: "search", description: "Search stations" },
      { command: "watch", description: "Watch station by id" },
      { command: "unwatch", description: "Remove station" },
      { command: "list", description: "Watch list" },
      { command: "pause", description: "Pause checks" },
      { command: "resume", description: "Resume checks" }
    ]
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

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: "Check now" }, { text: "Settings" }],
      [{ text: "Status" }, { text: "Watch list" }]
    ],
    resize_keyboard: true
  };
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Any plug", callback_data: "types:" },
        { text: "CCS2", callback_data: "types:CCS2" },
        { text: "GBT", callback_data: "types:GBT" }
      ],
      [
        { text: "CCS2+GBT", callback_data: "types:CCS2,GBT" },
        { text: "Type2", callback_data: "types:TYPE2" }
      ],
      [
        { text: "0 kW", callback_data: "power:0" },
        { text: "22 kW", callback_data: "power:22" },
        { text: "50 kW", callback_data: "power:50" },
        { text: "100 kW", callback_data: "power:100" }
      ],
      [
        { text: "Check 30s", callback_data: "interval:30" },
        { text: "Check 60s", callback_data: "interval:60" },
        { text: "Check 120s", callback_data: "interval:120" }
      ],
      [
        { text: "Reports off", callback_data: "reports:0" },
        { text: "Reports 30m", callback_data: "reports:30" },
        { text: "Reports 60m", callback_data: "reports:60" }
      ],
      [
        { text: state.settings.paused ? "Resume" : "Pause", callback_data: state.settings.paused ? "resume" : "pause" },
        { text: "Status", callback_data: "status" },
        { text: "Menu", callback_data: "menu" }
      ]
    ]
  };
}

function connectorSelectionKeyboard(sessionId) {
  const session = state.selectionSessions[sessionId];

  if (!session) {
    return mainKeyboard();
  }

  const rows = session.connectors.map((connector, index) => {
    const selected = session.selected.includes(index);
    return [{
      text: `${selected ? "[x]" : "[ ]"} ${connector.type} ${connector.power} kW ${connector.status}`,
      callback_data: `toggle:${sessionId}:${index}`
    }];
  });

  rows.push([
    { text: "Start watching selected", callback_data: `watchsel:${sessionId}` },
    { text: "Menu", callback_data: "menu" }
  ]);

  return {
    inline_keyboard: rows
  };
}

function formatConnectorSelection(session) {
  return [
    "Choose connectors to watch.",
    `${session.locationName}`,
    "",
    ...session.connectors.map((connector, index) => {
      const selected = session.selected.includes(index) ? "[x]" : "[ ]";
      return `${selected} ${index + 1}. ${connector.label}: ${connector.status}`;
    })
  ].join("\n");
}

function flattenConnectors(location) {
  return (location.stations || []).flatMap((station, stationIndex) => {
    return (station.connectors || []).map((connector, connectorIndex) => ({
      stationId: station.id,
      connectorId: connector.id,
      type: connector.type,
      power: connector.power,
      rate: connector.rate,
      status: connector.status,
      booking: connector.booking,
      label: `Station ${stationIndex + 1}, connector ${connectorIndex + 1}: ${connector.type} ${connector.power} kW`
    }));
  });
}

function loadState() {
  const base = {
    telegramOffset: 0,
    chatIds: {},
    watchLocationIds: [],
    connectorWatches: [],
    selectionSessions: {},
    nextSessionId: 1,
    availability: {},
    lastRunAt: undefined,
    settings: defaultSettings()
  };

  if (!existsSync(STATE_FILE)) {
    return base;
  }

  const loaded = JSON.parse(readFileSync(STATE_FILE, "utf8"));

  return {
    ...base,
    ...loaded,
    connectorWatches: loaded.connectorWatches || [],
    selectionSessions: loaded.selectionSessions || {},
    nextSessionId: loaded.nextSessionId || 1,
    settings: {
      ...base.settings,
      ...(loaded.settings || {})
    }
  };
}

function saveState() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function defaultSettings() {
  return {
    connectorTypes: listFromEnv(config.CONNECTOR_TYPES),
    minPowerKw: numberFromEnv(config.MIN_POWER_KW, 0),
    notifyWhenAlreadyAvailable: config.NOTIFY_WHEN_ALREADY_AVAILABLE === "true",
    noAvailabilityReportEveryMinutes: numberFromEnv(config.NO_AVAILABILITY_REPORT_EVERY_MINUTES, 0),
    pollIntervalSeconds: numberFromEnv(config.POLL_INTERVAL_SECONDS, 60),
    paused: false
  };
}

function mergeEnvDefaults() {
  for (const id of listFromEnv(config.WATCH_LOCATION_IDS)) {
    if (!state.watchLocationIds.includes(id)) {
      state.watchLocationIds.push(id);
    }
  }

  if (config.TELEGRAM_CHAT_ID) {
    state.chatIds[String(config.TELEGRAM_CHAT_ID)] = {
      id: config.TELEGRAM_CHAT_ID,
      type: "configured",
      title: "Configured Telegram chat"
    };
  }

  saveState();
}

function getWatchedLocationIds() {
  return [...new Set([
    ...state.watchLocationIds,
    ...state.connectorWatches.map((watch) => watch.locationId)
  ])];
}

function subscribeChat(chat) {
  state.chatIds[String(chat.id)] = {
    id: chat.id,
    type: chat.type,
    title: chat.title || chat.username || chat.first_name || "Telegram chat"
  };
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

function getPollIntervalMs() {
  return Math.max(15, numberFromEnv(state.settings.pollIntervalSeconds, 60)) * 1000;
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

function formatCounts(value) {
  if (!value || value.matchingCount === undefined || value.availableCount === undefined) {
    return "";
  }

  return `${value.availableCount}/${value.matchingCount}`;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
