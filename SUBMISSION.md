# Glimpse — DoraHacks submission (draft)

**Title:** Glimpse — Telegram digest & reply for Even Realities G2

**Track:** Track 01 · Messaging & News

**Demo video:** VIDEO_URL_TO_ADD

**Repository:** REPO_URL_TO_ADD

## Short description

**Problem.** Telegram group chats, channels, and forwarded messages are
where many communities share their most time-sensitive updates, but
keeping up means constantly picking up your phone. On smart glasses,
that catch-up should take seconds, not a phone unlock.

**Who it is for.** People who live in Telegram — community members,
builders, and moderators — who own Even Realities G2 glasses and want
to stay current and reply without breaking focus.

**How it works.** A Telegram bot (added only to the chats you choose)
forwards activity to a small Cloudflare Worker backend, which stores it
in D1 and serves a glasses-sized digest: each source shows its unread
count and up to three preview lines of at most 52 characters. Pairing is
a 6-digit code the bot DMs you after `/start`. From the glasses you can
open a source, read the newest messages, mark it read, and reply with a
quick reply, an AI-drafted reply (Groq), or a voice note transcribed to
text (Groq Whisper). Replies are always posted by the bot, as the bot —
never as the user — and the app holds no Telegram credentials, only a
session token whose hash is stored server-side. If the AI provider is
unavailable, drafting falls back to a simple built-in draft and the rest
of the app keeps working.

**Built:** November 23–29, 2026 build window. Backend (Cloudflare
Worker + D1), glasses app, integration tests, and demo-data tooling are
all in the repository.
