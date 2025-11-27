// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const OFFLINE_MINUTES = Number(Deno.env.get("NOTIFY_OFFLINE_MINUTES") ?? "60");
const APP_WEB_URL = Deno.env.get("APP_WEB_URL") ?? "https://synastry.app";
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Synastry <notify@synastry.app>";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!RESEND_API_KEY) {
  throw new Error("RESEND_API_KEY env var is required");
}
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const resendEndpoint = "https://api.resend.com/emails";

async function sendEmail(to: string, subject: string, html: string) {
  const response = await fetch(resendEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend error: ${response.status} ${text}`);
  }
}

async function getUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    console.warn("Не удалось получить email пользователя", userId, error);
    return null;
  }
  return data.user?.email ?? null;
}

function formatEmailBody(name: string, unreadCount: number) {
  const safeName = name || "ваша переписка";
  const link = `${APP_WEB_URL.replace(/\/$/, "")}/app`;
  return `<!doctype html>
<html>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#0b1220;color:#111;margin:0;padding:0;">
    <div style="max-width:520px;margin:0 auto;padding:24px 24px 32px;background:#ffffff;border-radius:16px;">
      <h2 style="margin-top:0;color:#111;">У вас новые сообщения</h2>
      <p>Для профиля <strong>${safeName}</strong> появилось <strong>${unreadCount}</strong> непрочитанных сообщений.</p>
      <p>Откройте приложение Synastry и ответьте, пока собеседник онлайн.</p>
      <p style="margin:24px 0;">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600;">Открыть приложение</a>
      </p>
      <p style="font-size:12px;color:#6b7280;">Это письмо отправлено автоматически. Вы можете отключить уведомления в настойках приложения.</p>
    </div>
  </body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const threshold = new Date(Date.now() - OFFLINE_MINUTES * 60 * 1000).toISOString();

  // Step 1: read unread counts (view has no FK, so we join manually)
  const { data: counts, error: countsError } = await supabase
    .from("unread_message_counts")
    .select("recipient_id, unread_count, oldest_unread_at");

  if (countsError) {
    console.error("Не удалось получить данные из unread_message_counts", countsError);
    return new Response(JSON.stringify({ error: countsError.message }), { status: 500 });
  }

  const ids = (counts ?? []).map((row: any) => row.recipient_id).filter(Boolean);
  if (!ids.length) {
    return new Response(JSON.stringify({ processed: 0, sent: [], skipped: [] }), { headers: { "Content-Type": "application/json" } });
  }

  // Step 2: load profiles by ids
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id,last_seen_at,notify_email_messages,unread_notified_at,data")
    .in("id", ids);

  if (profilesError) {
    console.error("Не удалось получить профили", profilesError);
    return new Response(JSON.stringify({ error: profilesError.message }), { status: 500 });
  }

  const profileMap = new Map<string, any>();
  for (const p of profiles ?? []) {
    profileMap.set(p.id, p);
  }

  const candidates = (counts ?? []).filter((row: any) => {
    const profile = profileMap.get(row.recipient_id);
    if (!profile) return false;
    if (!profile.notify_email_messages) return false;

    const lastSeen = profile.last_seen_at ? new Date(profile.last_seen_at).getTime() : 0;
    const thresholdMs = Date.parse(threshold);
    if (profile.last_seen_at && lastSeen > thresholdMs) return false;
    if (profile.unread_notified_at) {
      const notifiedAt = new Date(profile.unread_notified_at).getTime();
      const oldestUnread = new Date(row.oldest_unread_at).getTime();
      if (notifiedAt >= oldestUnread) {
        return false;
      }
    }
    return true;
  });

  const sent: Array<{ id: string; email: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const row of candidates) {
    const profile = row.profiles as any;
    const userId: string = row.recipient_id;
    const email = await getUserEmail(userId);
    if (!email) {
      skipped.push({ id: userId, reason: "no-email" });
      continue;
    }
    try {
      const personName = typeof profile?.data?.personName === "string" ? profile.data.personName : "";
      const subject = `У вас ${row.unread_count} непрочитан${row.unread_count === 1 ? "ное" : "ных"} сообщени${row.unread_count === 1 ? "е" : "й"}`;
      const html = formatEmailBody(personName, row.unread_count as number);
      await sendEmail(email, subject, html);
      sent.push({ id: userId, email });
      await supabase
        .from("profiles")
        .update({ unread_notified_at: new Date().toISOString() })
        .eq("id", userId);
    } catch (mailError) {
      console.error("Не удалось отправить уведомление", userId, mailError);
      skipped.push({ id: userId, reason: "send-error" });
    }
  }

  return new Response(
    JSON.stringify({
      processed: candidates.length,
      sent,
      skipped,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
