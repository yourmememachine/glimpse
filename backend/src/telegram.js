// Minimal Telegram Bot API client.

export function createTelegram({ token, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function sendMessage(chatId, text, opts = {}) {
    if (!token) throw new Error("telegram_not_configured");
    if (typeof doFetch !== "function") throw new Error("fetch_unavailable");
    const body = { chat_id: chatId, text };
    if (opts && opts.replyToMessageId != null) {
      body.reply_to_message_id = opts.replyToMessageId;
    }
    const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`telegram_send_failed:${res.status}`);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && data.ok === false) throw new Error("telegram_send_failed");
    return data?.result ?? data;
  }

  return { sendMessage };
}
