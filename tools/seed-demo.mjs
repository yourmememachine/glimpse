#!/usr/bin/env node
// Glimpse — demo data seeder.
//
// Replays realistic demo traffic through the backend webhook, exactly as
// Telegram would deliver it, so a freshly deployed Worker has something
// to show in the glasses digest.
//
// Usage:
//   node tools/seed-demo.mjs --base <worker-url> --secret <webhook-secret>
//   node tools/seed-demo.mjs --dry-run
//
// What it sends:
//   1. A /start DM from the demo account — on a live bot this makes the bot
//      DM a 6-digit pairing code to that account. The code cannot be read
//      back by this script (it only exists in that Telegram DM), so when
//      running live: open the bot DM on the demo account, read the code,
//      and enter it in the Glimpse app to pair.
//   2. A demo group, "Solana Builders Chat", with messages including a
//      question addressed to the user.
//   3. A demo channel, "Crypto Signals Daily", with 3 posts.
//   4. Two forwards into the demo account's DM (the forwarded-items inbox).
//
// --dry-run validates every payload shape locally and prints a summary
// without any network calls.

const DEMO_USER = { id: 910001, firstName: 'Demo' };
const GROUP = { id: -100910002, title: 'Solana Builders Chat' };
const CHANNEL = { id: -100910003, title: 'Crypto Signals Daily' };

const nowSec = Math.floor(Date.now() / 1000);

function buildUpdates() {
  const updates = [];
  let updateId = 500000;
  let ts = nowSec - 3600;
  const next = () => ({ update_id: ++updateId, date: (ts += 137) });

  // 1. /start DM from the demo account (triggers the pairing code DM).
  updates.push({
    ...next(),
    message: {
      message_id: 1,
      date: ts,
      chat: { id: DEMO_USER.id, type: 'private' },
      from: { id: DEMO_USER.id, first_name: DEMO_USER.firstName, is_bot: false },
      text: '/start',
    },
  });

  // 2. Demo group conversation; the last message asks the user a question.
  const groupMessages = [
    { from: { id: 920101, first_name: 'Maya' }, text: 'Morning everyone, the weekly builder notes are up — main thread has the summary.' },
    { from: { id: 920102, first_name: 'Leo' }, text: 'Nice. I pushed the fee estimator fix, needs one more review before it goes out.' },
    { from: { id: 920103, first_name: 'Priya' }, text: 'Workshop slides from yesterday are in the shared folder if anyone missed them.' },
    { from: { id: 920101, first_name: 'Maya' }, text: 'Quick one for you: are we still on for the demo rehearsal at 4pm today?' },
  ];
  groupMessages.forEach((m, i) => {
    updates.push({
      ...next(),
      message: {
        message_id: 101 + i,
        date: ts,
        chat: { id: GROUP.id, type: 'supergroup', title: GROUP.title },
        from: { ...m.from, is_bot: false },
        text: m.text,
      },
    });
  });

  // 3. Demo channel posts.
  const channelPosts = [
    'Market open: majors are holding yesterday\u2019s range, funding rates are neutral across the board.',
    'Explainer thread: how priority fees actually work, and when paying more does not help your transaction land.',
    'Community spotlight: three small teams shipped mainnet updates this week — links and changelogs inside.',
  ];
  channelPosts.forEach((text, i) => {
    updates.push({
      ...next(),
      channel_post: {
        message_id: 201 + i,
        date: ts,
        chat: { id: CHANNEL.id, type: 'channel', title: CHANNEL.title },
        text,
      },
    });
  });

  // 4. Two forwards into the demo DM (forwarded-items inbox).
  const forwards = [
    { from: { id: 920104, first_name: 'Nina' }, text: 'Forwarded: the grant programme application window closes this Friday at noon.' },
    { from: { id: 920105, first_name: 'Omar' }, text: 'Forwarded: meetup venue confirmed for next month, same place as last time, doors at six.' },
  ];
  forwards.forEach((f, i) => {
    updates.push({
      ...next(),
      message: {
        message_id: 301 + i,
        date: ts,
        chat: { id: DEMO_USER.id, type: 'private' },
        from: { id: DEMO_USER.id, first_name: DEMO_USER.firstName, is_bot: false },
        forward_from: { id: f.from.id, first_name: f.from.first_name },
        forward_date: ts - 600,
        text: f.text,
      },
    });
  });

  return updates;
}

function validate(updates) {
  const problems = [];
  updates.forEach((u, i) => {
    if (!Number.isInteger(u.update_id)) problems.push(`update ${i}: missing integer update_id`);
    const msg = u.message || u.channel_post;
    if (!msg) { problems.push(`update ${i}: neither message nor channel_post`); return; }
    if (!Number.isInteger(msg.message_id)) problems.push(`update ${i}: missing integer message_id`);
    if (!msg.chat || !Number.isInteger(msg.chat.id) || !msg.chat.type) problems.push(`update ${i}: bad chat`);
    if (typeof msg.text !== 'string' || msg.text.length === 0) problems.push(`update ${i}: empty text`);
    if (!Number.isInteger(msg.date)) problems.push(`update ${i}: missing integer date`);
  });
  return problems;
}

function parseArgs(argv) {
  const args = { dryRun: false, base: null, secret: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--secret') args.secret = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node tools/seed-demo.mjs --base <worker-url> --secret <webhook-secret> [--dry-run]');
  process.exit(0);
}

const updates = buildUpdates();
const problems = validate(updates);
if (problems.length > 0) {
  console.error('Payload validation failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Payloads valid: ${updates.length} updates (1 /start DM, 4 group messages, 3 channel posts, 2 forwards).`);

if (args.dryRun) {
  console.log('Dry run — no network calls made.');
  process.exit(0);
}

if (!args.base || !args.secret) {
  console.error('Both --base <worker-url> and --secret <webhook-secret> are required (or pass --dry-run).');
  process.exit(2);
}

const endpoint = `${args.base.replace(/\/$/, '')}/telegram/webhook`;
for (const update of updates) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': args.secret,
    },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    console.error(`Webhook rejected update ${update.update_id}: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
}
console.log(`Sent ${updates.length} updates to ${endpoint}.`);
console.log('Next step: open the Glimpse bot DM on the demo Telegram account, read the 6-digit pairing code it sent in reply to /start, and enter that code in the app to pair.');
