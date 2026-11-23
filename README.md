# Glimpse

A Telegram digest and reply app for the Even Realities G2 smart glasses.

Telegram is where a lot of communities actually live — group chats, channels,
and forwarded tips — but keeping up means picking up your phone dozens of
times a day. Glimpse puts the catch-up on your glasses instead: a short
digest of what is unread across your groups, channels, and forwarded items,
each source summarised in lines short enough to read at a glance. Open a
source to read the latest messages, mark it read, and answer without
reaching for your phone — with a quick reply, an AI-drafted reply you can
accept as-is, or a short voice note that is transcribed and sent as text.

**Track: Track 01 · Messaging & News**

## How it works

1. Pair once: message the Glimpse bot `/start` on Telegram, get a 6-digit
   code, and type it into the app's pairing panel in your phone browser
   (the code is not entered on the glasses). The app stores only a
   session token.
2. The bot collects messages from the groups and channels it belongs to,
   plus anything you forward to it. The digest covers exactly the chats
   the bot has been added to — groups it is a member of and channels
   where it is an administrator — plus forwards sent to the bot DM.
   That membership *is* the picker: there is no separate chat list to
   configure, and a chat the bot has not been added to never appears.
3. The glasses show a digest — sources ordered by most recent activity,
   with unread counts and up to three preview lines per source (≤ 52
   characters each).
4. Open a source, read the newest messages, mark it read, and reply from
   the glasses.

## Architecture

```
 Telegram chats            Cloudflare Worker              Even G2 glasses
 ┌──────────────┐  webhook ┌────────────────────┐  HTTPS  ┌──────────────┐
 │ groups       │ ───────► │ Glimpse backend    │ ◄─────► │ Glimpse app  │
 │ channels     │          │ - webhook intake   │  Bearer │ - digest     │
 │ forwards/DMs │ ◄─────── │ - digest / sources │  token  │ - read view  │
 └──────────────┘  bot API │ - reply / read     │         │ - reply,     │
        ▲          send    │ - pairing + auth   │         │   drafts,    │
        │                  │ - D1 (SQLite) store│         │   voice      │
        │                  └─────────┬──────────┘         └──────────────┘
        │                            │ Groq API
        │                            ▼
        │                     drafts (chat model)
        └───────────────────  speech-to-text (Whisper)
```

- **Backend** (`backend/`): one Cloudflare Worker. It receives Telegram
  webhooks, stores messages in D1, and serves the small JSON API the app
  uses (`/v1/digest`, `/v1/source/:id`, `/v1/read`, `/v1/reply`,
  `/v1/draft`, `/v1/stt`, `/v1/pair`). The fixed API contract is in
  `docs-contract.md`.
- **App** (`app/`): the glasses app, built with Vite. It talks only to the
  Worker origin, renders the digest at glasses resolution, and falls back
  to a 576×288 browser preview for development without hardware.
- **AI**: Groq is used server-side only — a chat model drafts replies in
  context, and Whisper transcribes voice notes. If Groq is not configured,
  drafting falls back to a simple deterministic draft and speech-to-text
  reports itself unavailable; nothing else breaks.

## Setup

### 1. Create the Telegram bot

1. In Telegram, open @BotFather and send `/newbot`. Pick a name and a
   username ending in `bot`, and save the bot token it gives you.
2. Send `/setprivacy` for your bot and choose **Disable** if you want the
   bot to see ordinary group messages (not just commands and mentions).
   The bot still only ever receives messages from chats it has been
   added to — see *Safety & privacy* below. Note: Telegram applies the
   privacy-mode change only when the bot joins a group, so after
   disabling privacy mode you must remove the bot from, and re-add it
   to, any group it already belongs to before it will see that group's
   ordinary messages.
3. Add the bot to the groups and channels you want in your digest. For
   a **channel**, the bot must be added as a channel **administrator**
   with the **Post Messages** permission — a channel the bot is merely
   subscribed to sends it nothing, so no channel posts are received
   until it is an admin there.

### 2. Deploy the Worker backend

Prerequisites: Node.js, a Cloudflare account, and Wrangler
(`npm install -g wrangler`, then `wrangler login`).

```bash
cd backend
npm install

# Create the D1 database and apply the schema
wrangler d1 create glimpse
# Put the returned database_id into backend/wrangler.toml, then:
wrangler d1 execute glimpse --remote --file=schema.sql

# Secrets (never commit these)
wrangler secret put TELEGRAM_BOT_TOKEN   # the BotFather token
wrangler secret put WEBHOOK_SECRET       # a long random string you invent —
                                         # use ONLY A–Z, a–z, 0–9, _ and -
                                         # characters (Telegram rejects any
                                         # other characters in secret_token)
wrangler secret put GROQ_API_KEY         # optional; drafts/STT degrade without it

# Deploy the Worker FIRST — the webhook URL must be live before
# Telegram will accept it in the next step.
wrangler deploy

# THEN point Telegram at the deployed Worker (replace the URL and secret)
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Check it is alive: `curl https://<your-worker>.workers.dev/health`
should return `{"ok":true}`.

### 3. Build the glasses app

```bash
cd app
npm install
npm run dev        # browser preview / simulator: 576x288, keyboard = gestures
```

Before packaging, set the Worker origin in `app/app.json` (the origin
whitelist) and in the app's API base URL so both match your deployed
Worker exactly — the app can only call the whitelisted origin. Then build
and package with the Even Hub tooling as usual, producing the `.ehpk`
submission artifact.

### 4. Pairing walkthrough

1. On Telegram, open your bot and send `/start`. The bot replies with a
   6-digit pairing code (valid for 10 minutes, single use).
2. Open Glimpse and type the code into the app's pairing panel in your
   phone browser — the code is entered on the phone, not on the glasses.
3. The app exchanges the code for a session token and shows your digest.
   Only the hash of the token is stored on the server.

## What existed before November 23, 2026

Honest declaration for the hackathon build window: before November 23,
2026 there were project accounts (DoraHacks, GitHub, Groq, Cloudflare)
and a written plan — planning notes were prepared with AI tool
assistance — but no app code. All code in this repository was written
during the November 23–29, 2026 build window.

## Safety & privacy

- **Bot-only identity.** Replies are posted by the bot, as the bot —
  never as you, and never from your personal Telegram account. There is
  no way for Glimpse to send a message that appears to come from you.
- **The bot only sees chats it is added to.** Telegram decides what the
  bot receives; the backend cannot widen that. Remove the bot from a
  chat and it stops receiving that chat immediately.
- **No user credentials are stored.** There is no Telegram login, no
  password, and no user API keys anywhere in the system. Pairing uses a
  short-lived 6-digit code; the server stores only a hash of the app's
  session token. Bot and AI keys live only as Worker secrets.
- **No funds, read + reply only.** Glimpse cannot move money, join or
  leave chats, delete messages, or change any chat settings. Its whole
  surface is: read a digest, read messages, mark read, and send a reply
  you composed or approved on the glasses.
- **What leaves your machine.** When you ask for a drafted reply, the
  message text and recent context from that chat are sent to Groq so
  its model can draft the reply; when you dictate a voice note, the
  voice audio is sent to Groq for transcription. Nothing else is sent
  to third parties.
- **Retention.** Messages the bot receives are stored in the backend
  database (D1) so the digest can show them. When the bot is removed
  from a chat, that chat's stored history is deleted. The operator can
  wipe everything at once by deleting the D1 database.

## Known limits

- **Simulator microphone.** The official simulator may deliver no
  microphone audio, so voice input cannot be fully exercised there. On
  real G2 hardware the SDK audio path is used: the SDK delivers
  processed PCM frames, which Glimpse wraps as 16 kHz mono WAV for
  transcription (the browser fallback resamples its capture to 16 kHz
  explicitly). Everywhere, voice has a
  fallback: quick replies and AI drafts cover the same reply flow
  without a microphone.
- **Edits and deletions stay as received.** If a message is edited or
  deleted in Telegram after the bot received it, the digest still shows
  the text as it first arrived; Glimpse does not track later edits.
- **One operator per chat.** A chat's messages are attached to the
  account whose bot membership surfaced them; this is a personal digest,
  not a shared team inbox.
- **Telegram privacy mode.** With privacy mode on, the bot only sees
  commands, mentions, and replies to it in groups — the digest reflects
  exactly what Telegram sends, nothing more.
- Digest preview lines are capped at 52 characters and three per source
  by design; the full text is one tap away in the source view.

## Demo data

With a deployed Worker and its webhook secret, seed a realistic demo —
a demo group ("Solana Builders Chat") with a question addressed to you,
a demo channel ("Crypto Signals Daily") with three posts, and two
forwards:

```bash
node tools/seed-demo.mjs --base https://<your-worker>.workers.dev --secret <WEBHOOK_SECRET>
node tools/seed-demo.mjs --dry-run   # validate payloads only, no network
```

The script posts webhook updates exactly as Telegram would. The pairing
code itself is read from the real bot DM on the demo account (the script
triggers it with `/start`; a script cannot read your Telegram DMs).

## Tests

```bash
npm test   # from the repo root
```

This runs the end-to-end integration tests in `tests/` (full pairing →
digest → read → reply → draft → speech-to-text story against an
in-memory backend with fake Telegram and AI clients) plus any unit tests
under `backend/test/` and `app/test/`.

## License

MIT — see `LICENSE`.
