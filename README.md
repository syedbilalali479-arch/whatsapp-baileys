# WhatsApp Baileys Bot 🤖

WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys) that logs in with a
**pairing code** (no QR / no camera), chats in **Roman Urdu** via the **Gemini API**, and books
**appointments** into **Google Calendar**.

## Features
- 📲 Pairing-code login (code is printed to the logs — visible in Railway logs)
- 💬 Receives WhatsApp messages and replies with Gemini AI
- 🇵🇰 Roman Urdu conversational personality
- 📅 Appointment booking flow (name → purpose → date/time → confirm)
- 🗓️ Google Calendar event creation via a service account

## Environment variables
| Variable             | Description |
|----------------------|-------------|
| `GEMINI_KEY`         | Gemini API key from https://aistudio.google.com/app/apikey |
| `GOOGLE_CREDENTIALS` | Full service-account JSON (one line) |
| `CALENDAR_ID`        | Target Google Calendar id |
| `PAIRING_NUMBER`     | Your WhatsApp number, digits only + country code (e.g. `923001234567`) |
| `TIMEZONE`           | Optional, default `Asia/Karachi` |

## Local run
```bash
npm install
cp .env.example .env   # then fill in the values
# load env vars however you like, then:
node index.js
```
Watch the logs for the **pairing code**, then on your phone:
**WhatsApp → Linked Devices → Link a Device → Link with phone number instead →** enter the code.

## Google Calendar setup
1. Google Cloud Console → create a **Service Account** → create a **JSON key**.
2. Enable the **Google Calendar API** for the project.
3. Open Google Calendar → your calendar → **Settings → Share with specific people** → add the
   service account email (`...@...iam.gserviceaccount.com`) with **Make changes to events**.
4. Copy the **Calendar ID** into `CALENDAR_ID`.
5. Paste the entire JSON key into `GOOGLE_CREDENTIALS`.

## Deploy on Railway (with persistent session)
1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Add the environment variables above in **Variables**.
4. **Add a Volume** and set the **Mount path** to `/app/auth_info`.
   This is where the WhatsApp session is stored (see `AUTH_DIR` in `index.js`).
5. Railway runs the `worker` process from the `Procfile`.
6. Open the **deploy logs** to read the pairing code and link your phone — **one time only**.

### Why the Volume matters
The session is saved to `/app/auth_info` (`useMultiFileAuthState`), and creds are persisted on
every `creds.update`. With a Volume mounted there:
- ✅ Pair only once
- ✅ Session survives redeploys
- ✅ Session survives restarts/crashes
- ✅ Auto-reconnects without re-pairing

> Local dev: set `AUTH_DIR=auth_info` (a relative path) since `/app` may not be writable on your
> machine. Default is `/app/auth_info` for Railway.
