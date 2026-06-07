# ChargerNotification

Telegram/console watcher for BelCharge charging station availability.

Repository name: `charger-notification`

## MVP

The first version monitors selected stations from [BelCharge](https://belcharge.by/) and sends a notification when a connector becomes available.

It can track:

- one or more BelCharge locations
- only selected connector types, for example `CCS2` or `GBT`
- minimum connector power
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
/search TZone
/watch a04846f4-06a0-4651-a58d-669cd9dc72b9
/list
/check
```

The bot also remembers chats that send `/start`, so `TELEGRAM_CHAT_ID` is useful but not the only way to register a chat.

## Scripts

```powershell
npm run check
npm run search -- "Minsk"
```

## Operations

See [OPERATIONS.md](OPERATIONS.md).
