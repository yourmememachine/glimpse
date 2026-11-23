# Glimpse — DoraHacks submission (draft)

**Title:** Glimpse — Telegram digest & reply for Even Realities G2

**Track:** Track 01 · Messaging & News

**Demo video:** https://youtu.be/ftnYzlltlsA

**Repository:** https://github.com/yourmememachine/glimpse

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

**Telegram integration.** The bot receives updates over a webhook: it
ingests group messages from groups it is a member of, channel posts
from channels where it is an administrator with Post Messages
permission, and anything forwarded to the bot's DM, which becomes the
forwarded-items inbox. Replies sent from the glasses are threaded to
the message they answer using `reply_to_message_id`. Pairing happens
through the bot's `/start` DM: the bot replies with a 6-digit code,
which the user types into the app's pairing panel in the phone browser.
Telegram's privacy mode is handled in setup — disabling it lets the bot
see ordinary group messages, and the setup notes cover removing and
re-adding the bot to groups it already belongs to so the change takes
effect.

**Safety.** Glimpse has a bot-only identity: replies are posted by the
bot, as the bot, never as the user. When a reply is drafted, the message
text and recent context are sent to Groq, and voice audio is sent to
Groq for transcription; nothing else is sent to third parties. Messages
are stored in the backend database, and when the bot is removed from a
chat that chat's stored history is deleted; the operator can wipe
everything by deleting the database. Glimpse handles no funds and
stores no user credentials — there is no Telegram login and no user API
keys anywhere in the system.

**Built:** November 23–29, 2026 build window. Backend (Cloudflare
Worker + D1), glasses app, integration tests, and demo-data tooling are
all in the repository.

For what existed before November 23, 2026, see the declaration in the
README ("What existed before November 23, 2026").
