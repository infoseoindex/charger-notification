# ChargerNotification Operations

## Working Style

- Build in small, clear steps.
- Start with a fast MVP, then improve.
- Keep code in GitHub.
- Update this file and handoff notes after meaningful changes.
- Deploy, verify the running service, then commit and push.
- Do not keep important product or technical decisions only in chat.

## Repository

- GitHub repository name: `charger-notification`
- GitHub SSH remote: `git@github.com:infoseoindex/charger-notification.git`
- Server GitHub SSH alias: `git@github.com-charger-notification:infoseoindex/charger-notification.git`
- App display name: `ChargerNotification`
- Local project folder: `charger-notification`

## Server

- Host: `2.26.63.165`
- SSH user: `root`
- Hostname: `1777289.xorek.cloud`
- Project target directory: `/root/charger-notification`
- Runtime available on server: Git 2.43.0, Node.js 20.20.2, npm 10.8.2.
- GitHub deploy key file on server: `/root/.ssh/charger_notification_github`
- GitHub deploy key public value:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICfeQoAwB4CMn6qaDNFn9Pfyc7PFvbBrt77FNfz042eq charger-notification@1777289.xorek.cloud
```

## MVP Scope

First MVP:

- Runtime: Node.js without external dependencies.
- Data source: BelCharge public web API.
- Notifications: Telegram if configured, otherwise console logs.
- Events: selected charging station gets an available connector.
- Filters: station ids, connector types, minimum power.
- Notification style: like CheapToursAlertsBot, with useful alerts, no duplicate spam, manual checks, and optional no-availability reports.

BelCharge endpoints discovered from the public website:

- `POST https://belcharge.by/api/map/locations`
- `GET https://belcharge.by/api/map/locations/{locationId}`

## Runbook

1. Copy `.env.example` to `.env`.
2. Fill `TELEGRAM_BOT_TOKEN`.
3. Run `npm start`.
4. Open the Telegram bot and send `/start`.
5. Search a station id with `/search station text` or `npm run search -- "station text"`.
6. Add a station with `/watch locationId`.
7. Wait until a watched station changes from unavailable/busy to available.

## Notification Rules

- Main alert is sent when a watched station changes from no matching available connectors to at least one matching available connector.
- If a station is already available on first check, the bot does not alert by default.
- Set `NOTIFY_WHEN_ALREADY_AVAILABLE=true` to alert on first available check.
- Set `NO_AVAILABILITY_REPORT_EVERY_MINUTES` to a positive number to receive periodic "still no chargers" reports.
- Use `/check` to request the current status manually.

## Current Status

- Initial BelCharge station watcher MVP created.
- BelCharge API was manually verified from this environment on 2026-06-08.
- Telegram bot token was verified with `getMe` on 2026-06-08.
- Telegram `getUpdates` returned no chats yet; user must send `/start` to the bot.
- Telegram bot command menu was configured with `setMyCommands` on 2026-06-08.
- MVP now supports Telegram commands: `/start`, `/search`, `/watch`, `/unwatch`, `/list`, `/check`.
- Local `.env` was created and is excluded from Git.
- Notification-bot mode was updated to mirror CheapToursAlertsBot behavior: watch criteria, alert on useful transition, manual check, optional no-availability report.
- `src/index.js` and `src/search.js` passed syntax parsing through Node REPL on 2026-06-08.
- Runtime verification is pending because this Codex sandbox could not execute `node.exe` and `npm` is not installed in the sandbox path.
- Git initialization, commit, and push are pending because `git`, `gh`, and GitHub Desktop are not available in the sandbox path or standard install paths.
- `winget install Git.Git` downloaded Git 2.54.0 but could not complete because the installer requested administrator approval and the installation was cancelled.
- GitHub SSH remote is known: `git@github.com:infoseoindex/charger-notification.git`.
- Work moved to remote server only after user clarified local machine should not be used for setup.
- Server SSH access verified as `root@2.26.63.165`.
- Server has Git, Node.js, and npm available.
- Server currently cannot access GitHub repo until the deploy key is added to GitHub.
- Server deploy key and SSH alias `github.com-charger-notification` were created.

## Next Steps

Immediate checklist:

1. Create a new Telegram bot through BotFather.
2. Save the bot token in local `.env` as `TELEGRAM_BOT_TOKEN`.
3. Run `npm start`.
4. Open the Telegram bot and send `/start`.
5. Search BelCharge station ids with `/search station text`.
6. Add stations with `/watch locationId`.
7. Verify that BelCharge station polling works.
8. Initialize Git repository.
9. Create GitHub repository `charger-notification`.
10. Commit and push the MVP.

Later improvements:

- Add Telegram commands for adding/removing watched stations.
- Add persistence for watched stations and last states.
- Add Windows autostart or service installation.
- Add deploy target for always-on monitoring.

## Handoff

- Important decisions are stored here and in `README.md`.
- MVP intentionally avoids dependencies so setup is fast and robust.
