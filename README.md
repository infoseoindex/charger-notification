# ChargerNotification

Telegram/console watcher for BelCharge charging station availability.

Repository name: `charger-notification`

## MVP

The first version monitors selected connectors from [BelCharge](https://belcharge.by/) and sends a notification when one of them becomes available.

It can track:

- one or more selected connectors on a BelCharge station
- connector status: `Available`, `Charging`, `Unavailable`, etc.
- transition from busy/unavailable to available
- manual current status checks
- optional no-availability reports, disabled by default

Telegram is the main MVP notification channel. Console logs are kept for local debugging.

## Requirements

- Node.js 18 or newer

## Setup

```powershell
copy .env.example .env
```

Edit `.env`:

```text
TELEGRAM_BOT_TOKEN=123456:your-token
TELEGRAM_CHAT_ID=123456789
WATCH_LOCATION_IDS=a04846f4-06a0-4651-a58d-669cd9dc72b9
CONNECTOR_TYPES=CCS2,GBT
MIN_POWER_KW=50
NO_AVAILABILITY_REPORT_EVERY_MINUTES=0
```

Find station ids:

```powershell
npm run search -- "TZone"
```

## Run

```powershell
npm start
```

Then open the Telegram bot and send:

```text
/start
/menu
/settings
/status
/search TZone
/station a04846f4-06a0-4651-a58d-669cd9dc72b9
/list
/check
/pause
/resume
```

The bot also remembers chats that send `/start`, so `TELEGRAM_CHAT_ID` is useful but not the only way to register a chat.

Main flow:

1. Send a station id or `/station stationId`.
2. The bot replies with all connectors and their current statuses.
3. Select interesting connectors with checkbox buttons.
4. Press `Start watching selected`.
5. The bot sends a notification when a selected connector becomes available.

Settings available in Telegram:

- connector type presets
- minimum power presets
- polling interval
- no-availability report interval
- pause/resume monitoring

## Scripts

```powershell
npm run check
npm run search -- "Minsk"
```

## Operations

See [OPERATIONS.md](OPERATIONS.md).
