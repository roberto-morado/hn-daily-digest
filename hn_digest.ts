#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
/**
 * Hacker News daily digest.
 *
 * Fetches stories from every feed of the official Hacker News API
 * (https://hacker-news.firebaseio.com/v0/) — top, best, new, ask,
 * show, and jobs — and emails a digest arranged by category.
 * A story appears once, in the first category that claims it.
 * Deno standard behavior only: no dependencies.
 *
 * Settings are entered by the user, never hardcoded. They are read from
 * environment variables or from a local .env file next to this script:
 *
 *   SMTP_HOST   SMTP server, e.g. smtp.gmail.com
 *   SMTP_PORT   465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_USER   SMTP login
 *   SMTP_PASS   SMTP password
 *   MAIL_FROM   From address
 *   MAIL_TO     Recipient of the digest
 *
 * Optional:
 *   DIGEST_COUNT     stories in the Top Stories section (default 15)
 *   DIGEST_MIN_SCORE minimum points for the Top and Best sections
 *                    (default 50; the other sections carry no floor)
 *
 * Run it:
 *   deno run --allow-net --allow-env --allow-read hn_digest.ts
 * Preview without sending:
 *   deno run --allow-net --allow-env --allow-read hn_digest.ts --dry-run
 * Enter your settings (writes .env):
 *   deno run --allow-env --allow-read --allow-write hn_digest.ts --setup
 */

const HN_API = "https://hacker-news.firebaseio.com/v0";
const SCAN = 100; // how many ids to scan in each feed

/** The digest's sections, in order. The first section claims a story. */
const SECTION_DEFS = [
  { name: "Top Stories", feed: "topstories", cap: -1, floored: true },
  { name: "Best Stories", feed: "beststories", cap: 5, floored: true },
  { name: "New Stories", feed: "newstories", cap: 5, floored: false },
  { name: "Ask HN", feed: "askstories", cap: 5, floored: false },
  { name: "Show HN", feed: "showstories", cap: 5, floored: false },
  { name: "Jobs", feed: "jobstories", cap: 5, floored: false },
] as const;

const SETTING_NAMES = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "MAIL_FROM",
  "MAIL_TO",
] as const;

// ---------- settings ----------

type Settings = Record<(typeof SETTING_NAMES)[number], string>;

async function loadSettings(): Promise<Partial<Settings>> {
  const settings: Record<string, string> = {};
  // A local .env file first, then the real environment overrides it.
  try {
    const text = await Deno.readTextFile(new URL(".env", import.meta.url));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      settings[key] = value;
    }
  } catch {
    // No .env file: environment variables only.
  }
  for (const name of SETTING_NAMES) {
    const value = Deno.env.get(name);
    if (value) settings[name] = value;
  }
  return settings as Partial<Settings>;
}

async function runSetup(): Promise<void> {
  console.log("Enter your email settings. They are saved to .env next to");
  console.log("this script and are never sent anywhere else.\n");
  const host = prompt("SMTP host (e.g. smtp.gmail.com):") ?? "";
  const port = prompt("SMTP port [465]:") || "465";
  const user = prompt("SMTP username:") ?? "";
  // promptSecret hides the typed password; it is a runtime global that
  // the type library does not declare, so reach it through globalThis.
  const secret = (globalThis as {
    promptSecret?: (message?: string) => string | null;
  }).promptSecret;
  const pass = secret
    ? secret("SMTP password:") ?? ""
    : prompt("SMTP password:") ?? "";
  const from = prompt("From address:", user) || user;
  const to = prompt("Send the digest to (recipient address):") ?? "";
  const lines = [
    `SMTP_HOST=${host}`,
    `SMTP_PORT=${port}`,
    `SMTP_USER=${user}`,
    `SMTP_PASS=${pass}`,
    `MAIL_FROM=${from}`,
    `MAIL_TO=${to}`,
    "",
  ];
  const path = new URL(".env", import.meta.url);
  await Deno.writeTextFile(path, lines.join("\n"));
  await Deno.chmod(path, 0o600);
  console.log("\nSaved. Run the script again to send your first digest.");
}

// ---------- Hacker News API ----------

interface Story {
  id: number;
  title: string;
  url: string | null;
  score: number;
  by: string;
  descendants: number;
  job: boolean;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "hn-daily-digest" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

interface Section {
  name: string;
  stories: Story[];
}

async function fetchItem(id: number): Promise<Story | null> {
  let item: unknown;
  try {
    item = await fetchJson(`${HN_API}/item/${id}.json`);
  } catch {
    return null;
  }
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  if (it.deleted || it.dead) return null;
  if (it.type !== "story" && it.type !== "job") return null;
  return {
    id: it.id as number,
    title: String(it.title ?? "(untitled)"),
    url: typeof it.url === "string" ? it.url : null,
    score: typeof it.score === "number" ? it.score : 0,
    by: String(it.by ?? "unknown"),
    descendants: typeof it.descendants === "number" ? it.descendants : 0,
    job: it.type === "job",
  };
}

/**
 * Fetch every feed and arrange the stories by category. A story is
 * claimed by the first section that takes it and never repeats.
 * Top and Best keep the score floor; the rest are ranked by score
 * within their own feed. Jobs keep their feed order (newest first)
 * and carry no score.
 */
async function fetchSections(
  topCount: number,
  minScore: number,
): Promise<Section[]> {
  const claimed = new Set<number>();
  const sections: Section[] = [];
  for (const def of SECTION_DEFS) {
    const cap = def.cap === -1 ? topCount : def.cap;
    const ids = (await fetchJson(`${HN_API}/${def.feed}.json`)) as number[];
    const items = await Promise.all(
      ids.slice(0, SCAN).map((id) => fetchItem(id)),
    );
    let stories = items.filter((s): s is Story => s !== null);
    stories = stories.filter((s) => !claimed.has(s.id));
    if (def.floored) stories = stories.filter((s) => s.score >= minScore);
    if (def.feed !== "jobstories") {
      stories.sort((a, b) => b.score - a.score);
    }
    stories = stories.slice(0, cap);
    for (const s of stories) claimed.add(s.id);
    if (stories.length > 0) sections.push({ name: def.name, stories });
  }
  return sections;
}

// ---------- digest body ----------

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function discussionUrl(story: Story): string {
  return `https://news.ycombinator.com/item?id=${story.id}`;
}

function buildText(sections: Section[], today: string): string {
  const lines = [`Hacker News digest - ${today}`, ""];
  for (const section of sections) {
    const name = section.name.toUpperCase();
    lines.push(name);
    lines.push("-".repeat(name.length));
    lines.push("");
    section.stories.forEach((story, i) => {
      lines.push(`${i + 1}. ${story.title}`);
      lines.push(`   ${story.url ?? discussionUrl(story)}`);
      if (story.job) {
        lines.push(`   by ${story.by}`);
      } else {
        lines.push(
          `   ${story.score} points, ${story.descendants} comments, by ${story.by}`,
        );
        lines.push(`   Discussion: ${discussionUrl(story)}`);
      }
      lines.push("");
    });
  }
  lines.push("Fetched from the Hacker News API.");
  return lines.join("\n");
}

function buildHtml(sections: Section[], today: string): string {
  const parts: string[] = [
    "<!DOCTYPE html>",
    '<html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:16px">',
    `<h1 style="font-size:20px">Hacker News digest - ${today}</h1>`,
  ];
  for (const section of sections) {
    parts.push(
      `<h2 style="font-size:16px;margin-top:24px">${escapeHtml(section.name)}</h2>`,
    );
    parts.push('<ol style="padding-left:20px">');
    for (const story of section.stories) {
      const link = story.url ?? discussionUrl(story);
      const meta = story.job
        ? `by ${escapeHtml(story.by)}`
        : `${story.score} points, ${story.descendants} comments, by ${escapeHtml(story.by)} - ` +
          `<a href="${discussionUrl(story)}" style="color:#555">discussion</a>`;
      parts.push(
        `<li style="margin-bottom:14px">` +
          `<a href="${link}" style="font-size:16px;color:#7a4a12">${escapeHtml(story.title)}</a><br>` +
          `<span style="color:#555;font-size:13px">${meta}</span>` +
          `</li>`,
      );
    }
    parts.push("</ol>");
  }
  parts.push(
    '<p style="color:#777;font-size:12px">Fetched from the Hacker News API.</p>',
    "</body></html>",
  );
  return parts.join("\n");
}

// ---------- sending (minimal SMTP client, no dependencies) ----------

function encodeBase64(text: string): string {
  return btoa(text);
}

class SmtpSession {
  #conn: Deno.Conn;
  #buffer = "";
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();

  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }

  /** Swap the underlying connection (used after a STARTTLS upgrade). */
  upgrade(conn: Deno.Conn): void {
    if (this.#buffer !== "") {
      throw new Error("SMTP reply buffer not empty at TLS upgrade");
    }
    this.#conn = conn;
  }

  /** Read one reply, following multi-line ("250-...") continuations. */
  async readReply(): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        // A reply is finished when the 4th character is a space.
        if (line.length < 4 || line[3] === " ") return line;
        continue;
      }
      const chunk = new Uint8Array(4096);
      const n = await this.#conn.read(chunk);
      if (n === null) throw new Error("SMTP connection closed early");
      this.#buffer += this.#decoder.decode(chunk.subarray(0, n));
    }
  }

  async command(line: string, expect: string): Promise<string> {
    await this.#conn.write(this.#encoder.encode(line + "\r\n"));
    const reply = await this.readReply();
    if (!reply.startsWith(expect)) {
      throw new Error(`SMTP command "${line.split(" ")[0]}" failed: ${reply}`);
    }
    return reply;
  }

  async sendData(payload: string): Promise<void> {
    await this.#conn.write(this.#encoder.encode(payload));
  }

  close(): void {
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }
}

async function sendMail(
  cfg: Settings,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  const port = parseInt(cfg.SMTP_PORT, 10) || 465;
  const boundary = "hn-digest-" +
    Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const message = [
    `From: ${cfg.MAIL_FROM}`,
    `To: ${cfg.MAIL_TO}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "",
    html.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  let conn: Deno.Conn;
  if (port === 465) {
    conn = await Deno.connectTls({ hostname: cfg.SMTP_HOST, port });
  } else {
    conn = await Deno.connect({ hostname: cfg.SMTP_HOST, port });
  }
  const smtp = new SmtpSession(conn);
  try {
    await smtp.readReply(); // greeting
    await smtp.command("EHLO localhost", "250");
    if (port !== 465) {
      await smtp.command("STARTTLS", "220");
      // In this branch the connection is a plain TCP connection.
      const tlsConn = await Deno.startTls(conn as Deno.TcpConn, {
        hostname: cfg.SMTP_HOST,
      });
      smtp.upgrade(tlsConn);
      await smtp.command("EHLO localhost", "250");
    }
    await smtp.command("AUTH LOGIN", "334");
    await smtp.command(encodeBase64(cfg.SMTP_USER), "334");
    await smtp.command(encodeBase64(cfg.SMTP_PASS), "235");
    await smtp.command(`MAIL FROM:<${cfg.MAIL_FROM}>`, "250");
    await smtp.command(`RCPT TO:<${cfg.MAIL_TO}>`, "250");
    await smtp.command("DATA", "354");
    const stuffed = message.replaceAll("\r\n.", "\r\n..");
    await smtp.sendData(stuffed + "\r\n.\r\n");
    const reply = await smtp.readReply();
    if (!reply.startsWith("250")) {
      throw new Error(`SMTP send failed: ${reply}`);
    }
    await smtp.command("QUIT", "221").catch(() => "");
  } finally {
    smtp.close();
  }
}

// ---------- main ----------

async function main(): Promise<number> {
  const args = new Set(Deno.args);
  if (args.has("--setup")) {
    await runSetup();
    return 0;
  }
  const settings = await loadSettings();
  const missing = SETTING_NAMES.filter((name) => !settings[name]);
  if (missing.length > 0) {
    console.error("Missing email settings: " + missing.join(", "));
    console.error(
      "Run with --setup, or set them in the environment or a .env file.",
    );
    return 1;
  }
  const count = parseInt(Deno.env.get("DIGEST_COUNT") ?? "15", 10) || 15;
  const minScore = parseInt(Deno.env.get("DIGEST_MIN_SCORE") ?? "50", 10) ||
    50;
  const today = new Date().toISOString().slice(0, 10);
  const sections = await fetchSections(count, minScore);
  const text = buildText(sections, today);
  if (args.has("--dry-run")) {
    console.log(text);
    return 0;
  }
  await sendMail(settings as Settings, `Hacker News digest - ${today}`, text,
    buildHtml(sections, today));
  const total = sections.reduce((n, s) => n + s.stories.length, 0);
  console.log(`Digest sent to ${settings.MAIL_TO} (${total} stories)`);
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
