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
- Main flow: user sends a station id, bot returns connectors and their statuses, user selects interesting connectors with checkbox buttons, bot watches those exact connectors.
- Events: selected connector changes from not available to `Available`.
- Legacy filters: station ids, connector types, minimum power.
- Notification style: like CheapToursAlertsBot, with useful alerts, no duplicate spam, manual checks, and optional no-availability reports.
- Telegram UX target: separate bot as the main control surface, similar to CheapToursAlertsBot.

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

## Server Service

- Service name: `charger-notification`
- Unit path: `/etc/systemd/system/charger-notification.service`
- Repo copy: `deploy/charger-notification.service`
- Start/restart: `systemctl restart charger-notification`
- Status: `systemctl status charger-notification --no-pager -l`
- Logs: `journalctl -u charger-notification -n 100 --no-pager`
- Current service status on 2026-06-08: active and enabled.

## Notification Rules

- Main alert is sent when a watched station changes from no matching available connectors to at least one matching available connector.
- Preferred alert is sent when a selected connector changes from not available to `Available`.
- If a station is already available on first check, the bot does not alert by default.
- Set `NOTIFY_WHEN_ALREADY_AVAILABLE=true` to alert on first available check.
- Set `NO_AVAILABILITY_REPORT_EVERY_MINUTES` to a positive number to receive periodic "still no chargers" reports.
- Use `/check` to request the current status manually.
- Use `/menu` and `/settings` to work with the bot from Telegram.
- Use `/station stationId` or send a station id as plain text to choose connectors.

## Current Status

- Initial BelCharge station watcher MVP created.
- BelCharge API was manually verified from this environment on 2026-06-08.
- Telegram bot token was verified with `getMe` on 2026-06-08.
- Telegram `getUpdates` returned no chats yet; user must send `/start` to the bot.
- Telegram bot command menu was configured with `setMyCommands` on 2026-06-08.
- Telegram chat id was discovered from `getUpdates`: `38908680`.
- Test Telegram message was sent successfully from the server to chat id `38908680`.
- MVP now supports Telegram commands: `/start`, `/search`, `/watch`, `/unwatch`, `/list`, `/check`.
- Local `.env` was created and is excluded from Git.
- Notification-bot mode was updated to mirror CheapToursAlertsBot behavior: watch criteria, alert on useful transition, manual check, optional no-availability report.
- `src/index.js` and `src/search.js` passed syntax parsing through Node REPL on 2026-06-08.
- Telegram control-surface mode added: `/menu`, `/settings`, `/status`, `/pause`, `/resume`, inline setting buttons, reply keyboard, and callback query handling.
- Connector selection flow added: station id input, connector status display, checkbox selection, and per-connector watch list.
- Systemd service was created and started on the server:
  - Service: `charger-notification`
  - Status: active
  - Enabled on boot: yes
- Runtime verification is pending because this Codex sandbox could not execute `node.exe` and `npm` is not installed in the sandbox path.
- Git initialization, commit, and push are pending because `git`, `gh`, and GitHub Desktop are not available in the sandbox path or standard install paths.
- `winget install Git.Git` downloaded Git 2.54.0 but could not complete because the installer requested administrator approval and the installation was cancelled.
- GitHub SSH remote is known: `git@github.com:infoseoindex/charger-notification.git`.
- Work moved to remote server only after user clarified local machine should not be used for setup.
- Server SSH access verified as `root@2.26.63.165`.
- Server has Git, Node.js, and npm available.
- Server currently cannot access GitHub repo until the deploy key is added to GitHub.
- Server deploy key and SSH alias `github.com-charger-notification` were created.
- Repository was cloned on the server into `/root/charger-notification`.
- Initial MVP was committed on the server and pushed to GitHub:
  - Commit: `f8bde58`
  - Branch: `main`
  - Message: `Initial BelCharge notification bot MVP`

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
