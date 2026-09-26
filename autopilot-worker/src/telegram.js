// Telegram notices for simple mode. Optional: without TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID nothing is sent. Never throws (a notice must not break a
// run) and never logs the token.
const API = "https://api.telegram.org";

export function telegramFromEnv(env = process.env, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chat = String(env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chat || !/^-?\d+$|^@\w+$/.test(chat)) return null;
  return async function send(text) {
    try {
      const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.error(`[autopilot] telegram HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      logger.error(`[autopilot] telegram error ${String(e?.name || "")}`);
      return false;
    }
  };
}
