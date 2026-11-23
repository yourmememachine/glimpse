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
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      // Keep Telegram's description on the error: callers distinguish a
      // reply-target problem ("message to be replied not found") from
      // rate limits and other failures by it.
      const err = new Error(`telegram_send_failed:${res.status}`);
      err.status = res.status;
      err.description = data?.description ?? null;
      throw err;
    }
    return data?.result ?? data;
  }

  async function getChatMember(chatId, userId) {
    if (!token) throw new Error("telegram_not_configured");
    if (typeof doFetch !== "function") throw new Error("fetch_unavailable");
    const res = await doFetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
      signal: AbortSignal.timeout(10_000),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error(`telegram_get_chat_member_failed:${res.status}`);
      err.status = res.status;
      err.description = data?.description ?? null;
      throw err;
    }
    return data?.result ?? null;
  }

  return { sendMessage, getChatMember };
}
