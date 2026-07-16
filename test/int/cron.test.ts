// cron 派工（v2.0.0 Phase I）：Telegram 告警游標、rollup 冪等、R2 備份內容與保留、
// 清理保留期、runJob 隔離（失敗寫 errlog＋cron_last_* 有 ok:false）。
// 全部直呼 src/cron.ts 的具名函式（now 可注入 → 日期斷言確定性）。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import {
  tgAlertScan,
  rollupUsageDaily,
  backupToR2,
  purgeOld,
  runCron,
  CRON_ALERTS,
  CRON_DAILY
} from "../../src/cron.js";
import { envWith, seedUser } from "../helpers.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seedErr(src: string, msg: string): Promise<void> {
  await env.DB.prepare("INSERT INTO errlog (ts,src,msg,detail,path) VALUES (?1,?2,?3,'','/x')")
    .bind(new Date().toISOString(), src, msg)
    .run();
}
async function getSetting(k: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?1").bind(k).first<{ v: string }>();
  return r ? String(r.v) : null;
}
async function seedReq(ts: string, user_id: number, svc: string, status: number, tin: number | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO req_log (ts,user_id,svc,channel,model,status,dur_ms,tokens_in,tokens_out) " +
      "VALUES (?1,?2,?3,'ch','m1',?4,100,?5,?5)"
  )
    .bind(ts, user_id, svc, status, tin)
    .run();
}

describe("tgAlertScan", () => {
  it("TG secrets 未設 → 跳過、cursor 不動、不打網路", async () => {
    await seedErr("relay.upstream", "boom");
    const note = await tgAlertScan(env);
    expect(note).toContain("skip");
    expect(await getSetting("tg_cursor")).toBeNull();
  });

  it("有 secrets → 打包送 Telegram、成功才推 cursor；再掃一次＝無新錯誤（不重送）", async () => {
    await seedErr("relay.upstream", "boom-1");
    await seedErr("pg.stream", "boom-2");
    let sent: any = null;
    fetchMock
      .get("https://api.telegram.org")
      .intercept({
        method: "POST",
        path: "/bott123/sendMessage",
        body(b) {
          sent = JSON.parse(String(b));
          return true;
        }
      })
      .reply(200, { ok: true });
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    const note = await tgAlertScan(e2);
    expect(note).toContain("2 筆");
    expect(sent.chat_id).toBe("42");
    expect(sent.text).toContain("[relay.upstream] boom-1");
    expect(sent.text).toContain("[pg.stream] boom-2");
    const cur = parseInt((await getSetting("tg_cursor")) || "0", 10);
    expect(cur).toBeGreaterThan(0);
    // 第二輪：沒有新列 → 不需要任何 fetch（沒註冊 interceptor，打了就會炸）
    expect(await tgAlertScan(e2)).toBe("無新錯誤");
  });

  it("Telegram 回 500 → throw、cursor 不推進（下輪重送）", async () => {
    await seedErr("csp", "x");
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: "/bott123/sendMessage" })
      .reply(500, "nope");
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    await expect(tgAlertScan(e2)).rejects.toThrow(/500/);
    expect(await getSetting("tg_cursor")).toBeNull();
  });
});

describe("rollupUsageDaily", () => {
  it("結算昨日、分組正確、重跑冪等；今日的列不納入", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z"); // 昨日＝2026-01-02
    await seedReq("2026-01-02T05:00:00.000Z", u.id, "relay", 200, 10);
    await seedReq("2026-01-02T06:00:00.000Z", u.id, "relay", 502, 5);
    await seedReq("2026-01-03T01:00:00.000Z", u.id, "relay", 200, 99); // 今日 → 不算
    await rollupUsageDaily(env, now);
    await rollupUsageDaily(env, now); // 冪等
    const rows = (await env.DB.prepare("SELECT * FROM usage_daily").all()).results as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].day).toBe("2026-01-02");
    expect(rows[0].n).toBe(2);
    expect(rows[0].errs).toBe(1);
    expect(rows[0].tokens_in).toBe(15);
    expect(rows[0].dur_ms_sum).toBe(200);
  });
});

describe("backupToR2", () => {
  it("全表 JSONL、media 排除 BLOB、保留 14 份", async () => {
    const u = await seedUser({ name: "備份對象" });
    await env.DB.prepare(
      "INSERT INTO articles (category,title,summary,cover,body_md,status,created_at,updated_at) " +
        "VALUES ('news','備份標題','','','內文','published',?1,?1)"
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare("INSERT INTO media (mime,bytes,w,h,data,created_at) VALUES ('image/webp',3,1,1,?1,?2)")
      .bind(new Uint8Array([1, 2, 3]), new Date().toISOString())
      .run();
    // 佈 15 份舊備份 → 今天這份寫完應只剩 14 份
    for (let i = 1; i <= 15; i++) {
      const d = "2020-01-" + String(i).padStart(2, "0");
      await env.BACKUPS!.put("backup/" + d + ".jsonl", "{}");
    }
    const now = new Date("2026-01-03T12:00:00Z");
    const note = await backupToR2(env, now);
    expect(note).toContain("backup/2026-01-03.jsonl");
    const obj = await env.BACKUPS!.get("backup/2026-01-03.jsonl");
    expect(obj).not.toBeNull();
    const lines = (await obj!.text()).trim().split("\n").map((l) => JSON.parse(l));
    const art = lines.find((x) => x.t === "articles");
    expect(art.r.title).toBe("備份標題");
    const usr = lines.find((x) => x.t === "users" && x.r.id === u.id);
    expect(usr.r.name).toBe("備份對象");
    const med = lines.find((x) => x.t === "media");
    expect(med.r.mime).toBe("image/webp");
    expect("data" in med.r).toBe(false); // BLOB 排除
    const listed = await env.BACKUPS!.list({ prefix: "backup/" });
    expect(listed.objects.length).toBe(14);
    expect(listed.objects.some((o) => o.key === "backup/2020-01-01.jsonl")).toBe(false); // 最舊被清
    expect(listed.objects.some((o) => o.key === "backup/2026-01-03.jsonl")).toBe(true);
  });

  it("無 BACKUPS 綁定 → 跳過不炸", async () => {
    const e2 = envWith({ BACKUPS: undefined });
    expect(await backupToR2(e2)).toContain("skip");
  });
});

describe("purgeOld", () => {
  it("req_log 90 天、sessions 過期、pg_messages 360 天；新的留下", async () => {
    const u = await seedUser();
    const now = new Date("2026-01-03T12:00:00Z");
    const old = (d: number): string => new Date(now.getTime() - d * 86400e3).toISOString();
    await seedReq(old(91), u.id, "relay", 200, null);
    await seedReq(old(89), u.id, "relay", 200, null);
    await env.DB.prepare("INSERT INTO sessions (sid,user_id,created_at,expires_at) VALUES ('dead',?1,?2,?3)")
      .bind(u.id, old(30), old(1))
      .run();
    await env.DB.prepare("INSERT INTO sessions (sid,user_id,created_at,expires_at) VALUES ('live',?1,?2,?3)")
      .bind(u.id, old(1), new Date(now.getTime() + 86400e3).toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO pg_conversations (user_id,title,created_at,updated_at) VALUES (?1,'t',?2,?2)"
    )
      .bind(u.id, old(400))
      .run();
    await env.DB.prepare("INSERT INTO pg_messages (conv_id,role,content,created_at) VALUES (1,'user','舊',?1)")
      .bind(old(361))
      .run();
    await env.DB.prepare("INSERT INTO pg_messages (conv_id,role,content,created_at) VALUES (1,'user','新',?1)")
      .bind(old(300))
      .run();
    const note = await purgeOld(env, now);
    expect(note).toContain("req_log −1");
    const reqs = (await env.DB.prepare("SELECT * FROM req_log").all()).results as any[];
    expect(reqs.length).toBe(1);
    const sess = (await env.DB.prepare("SELECT sid FROM sessions").all()).results as any[];
    expect(sess.map((s) => s.sid)).toEqual(["live"]);
    const msgs = (await env.DB.prepare("SELECT content FROM pg_messages").all()).results as any[];
    expect(msgs.map((m) => m.content)).toEqual(["新"]);
  });
});

describe("runCron 派工與隔離", () => {
  it("每日 cron → rollup/backup/purge 各寫 cron_last_*（ok:true）；不跑告警", async () => {
    await runCron(CRON_DAILY, env, new Date("2026-01-03T12:00:00Z"));
    for (const name of ["rollup", "backup", "purge"]) {
      const rec = JSON.parse((await getSetting("cron_last_" + name)) || "{}");
      expect(rec.ok).toBe(true);
    }
    expect(await getSetting("cron_last_alerts")).toBeNull();
  });

  it("告警 cron 失敗 → cron_last_alerts ok:false ＋ errlog 有 cron.alerts（下輪告警撈得到）", async () => {
    await seedErr("relay.upstream", "boom");
    fetchMock
      .get("https://api.telegram.org")
      .intercept({ method: "POST", path: "/bott123/sendMessage" })
      .reply(500, "nope");
    const e2 = envWith({ TG_BOT_TOKEN: "t123", TG_CHAT_ID: "42" });
    await runCron(CRON_ALERTS, e2);
    const rec = JSON.parse((await getSetting("cron_last_alerts")) || "{}");
    expect(rec.ok).toBe(false);
    expect(rec.err).toContain("500");
    const errs = (await env.DB.prepare("SELECT src FROM errlog ORDER BY id").all()).results as any[];
    expect(errs.map((r) => r.src)).toContain("cron.alerts");
  });
});
