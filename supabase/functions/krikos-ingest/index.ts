// =============================================================================
// Edge Function: krikos-ingest
// =============================================================================
// Lee la casilla ventas@loekemeyer.com por IMAP, encuentra los mails de
// Krikos360 (Planexware) "Notificación de recepción de Orden de Compra",
// baja el PDF de la OC desde el link firmado del mail y lo deja en la bandeja
// `krikos_oc_inbox` + bucket `krikos-oc`. El panel admin (PDF Krikos →
// "Bandeja Krikos") toma de ahí y usa los parsers de siempre.
//
// La casilla es SmarterMail, IMAP4rev1 en el puerto 143 SIN TLS (el 993 está
// cerrado; verificado el 3/9/2026). Anuncia AUTH=CRAM-MD5, así que la
// contraseña NUNCA viaja en claro: se responde un desafío con HMAC-MD5.
// Se usa BODY.PEEK y EXAMINE (solo lectura): no se marca nada como leído ni
// se mueve ningún mail — Thunderbird sigue viendo la casilla igual. La
// deduplicación es por `doc_id` (id del JWT del link) y por UID IMAP.
//
// Acciones (POST JSON, header `x-krikos-secret: <KRIKOS_INGEST_SECRET>`):
//   { action: "sync", days?: 30, dry_run?: false }
//       → busca mails del remitente desde hace `days` días, procesa los que
//         no estén en la tabla. Devuelve resumen.
//   { action: "test_imap" }
//       → conecta, autentica, EXAMINE INBOX, cuenta mails de Krikos. No escribe.
//   { action: "status" }
//       → conteo por estado de la bandeja.
//
// Secretos: primero variable de entorno (Supabase → Edge Functions → Secrets) y,
// si no está, el Vault de Postgres vía la RPC `krikos_secret` (solo service_role):
//   select vault.create_secret('<valor>', 'KRIKOS_IMAP_PASS');
//   KRIKOS_INGEST_SECRET   obligatorio; el mismo valor va en el header del cron
//   KRIKOS_IMAP_PASS       obligatorio; password de la casilla
//   KRIKOS_IMAP_HOST       default mail.loekemeyer.com
//   KRIKOS_IMAP_PORT       default 143
//   KRIKOS_IMAP_TLS        "true" para TLS implícito (993); default "false"
//   KRIKOS_IMAP_USER       default ventas@loekemeyer.com
//   KRIKOS_SENDER          default noreply@planexware.com
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createHmac } from "node:crypto";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IMAP_HOST = Deno.env.get("KRIKOS_IMAP_HOST") ?? "mail.loekemeyer.com";
const IMAP_PORT = Number(Deno.env.get("KRIKOS_IMAP_PORT") ?? "143");
const IMAP_TLS = (Deno.env.get("KRIKOS_IMAP_TLS") ?? "false") === "true";
const IMAP_USER = Deno.env.get("KRIKOS_IMAP_USER") ?? "ventas@loekemeyer.com";
const SENDER = Deno.env.get("KRIKOS_SENDER") ?? "noreply@planexware.com";
const BUCKET = "krikos-oc";
const LINK_RE = /https:\/\/krikos360\.planexware\.net\/Documentos\/api\/documento\?token=([A-Za-z0-9_\-.]+)/;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Env primero, Vault después. Cacheado por instancia (la función vive poco).
const _secretCache: Record<string, string> = {};
async function getSecret(name: string): Promise<string> {
  const env = Deno.env.get(name);
  if (env) return env;
  if (name in _secretCache) return _secretCache[name];
  try {
    const { data, error } = await sb.rpc("krikos_secret", { p_name: name });
    if (error) console.warn("krikos_secret", name, error.message);
    const v = typeof data === "string" ? data : "";
    _secretCache[name] = v;
    return v;
  } catch (e) {
    console.warn("krikos_secret", name, e);
    return "";
  }
}

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms ${label}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── Cliente IMAP mínimo ───────────────────────────────────────────────────────
interface ImapResp { tag: string; status: string; text: string; lines: string[]; literals: Uint8Array[] }

class Imap {
  private conn: Deno.Conn;
  private buf = new Uint8Array(0);
  private n = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder("latin1"); // las líneas de protocolo son ASCII
  caps = "";
  log: string[] = [];

  private constructor(conn: Deno.Conn) { this.conn = conn; }

  static async connect(host: string, port: number, tls: boolean): Promise<Imap> {
    const conn = await withTimeout(
      tls ? Deno.connectTls({ hostname: host, port }) : Deno.connect({ hostname: host, port }),
      10000, `connect ${host}:${port}`,
    );
    const c = new Imap(conn);
    const greet = await c.readLine();
    c.log.push("S: " + greet);
    if (!/^\* (OK|PREAUTH)/.test(greet)) throw new Error("saludo IMAP inesperado: " + greet);
    return c;
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(65536);
    const n = await withTimeout(this.conn.read(chunk), 30000, "read");
    if (n === null) throw new Error("conexión IMAP cerrada");
    const nb = new Uint8Array(this.buf.length + n);
    nb.set(this.buf); nb.set(chunk.subarray(0, n), this.buf.length);
    this.buf = nb;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = this.dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }

  private async readBytes(len: number): Promise<Uint8Array> {
    while (this.buf.length < len) await this.fill();
    const out = this.buf.slice(0, len);
    this.buf = this.buf.subarray(len);
    return out;
  }

  private async write(s: string): Promise<void> {
    const b = this.enc.encode(s);
    let off = 0;
    while (off < b.length) off += await this.conn.write(b.subarray(off));
  }

  // Manda un comando y lee hasta la respuesta etiquetada. Maneja literales
  // ({N}\r\n + N bytes) y continuaciones ("+ ...") para AUTHENTICATE.
  async cmd(command: string, onContinue?: (challenge: string) => Promise<string>): Promise<ImapResp> {
    const tag = "A" + (++this.n);
    await this.write(`${tag} ${command}\r\n`);
    this.log.push("C: " + tag + " " + (command.startsWith("LOGIN") ? "LOGIN ****" : command));
    const lines: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(tag + " ")) {
        const m = /^\S+ (OK|NO|BAD)\s?(.*)$/.exec(line);
        const status = m ? m[1] : "BAD";
        const text = m ? m[2] : line;
        this.log.push("S: " + line);
        if (status !== "OK") throw new Error(`IMAP ${command.split(" ")[0]} ${status}: ${text}`);
        return { tag, status, text, lines, literals };
      }
      if (line.startsWith("+")) {
        if (!onContinue) throw new Error("continuación inesperada: " + line);
        const reply = await onContinue(line.slice(1).trim());
        await this.write(reply + "\r\n");
        continue;
      }
      lines.push(line);
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) literals.push(await this.readBytes(Number(lit[1])));
    }
  }

  async capability(): Promise<string> {
    const r = await this.cmd("CAPABILITY");
    this.caps = r.lines.find((l) => l.startsWith("* CAPABILITY")) ?? "";
    return this.caps;
  }

  async login(user: string, pass: string): Promise<string> {
    if (!this.caps) await this.capability();
    if (/AUTH=CRAM-MD5/i.test(this.caps)) {
      await this.cmd("AUTHENTICATE CRAM-MD5", async (challengeB64) => {
        const challenge = atob(challengeB64);
        const digest = createHmac("md5", pass).update(challenge).digest("hex");
        return btoa(`${user} ${digest}`);
      });
      return "CRAM-MD5";
    }
    const q = (s: string) => '"' + s.replace(/([\\"])/g, "\\$1") + '"';
    await this.cmd(`LOGIN ${q(user)} ${q(pass)}`);
    return "LOGIN";
  }

  async examine(mailbox = "INBOX"): Promise<{ exists: number; uidvalidity: string }> {
    const r = await this.cmd(`EXAMINE ${mailbox}`);
    let exists = 0, uidvalidity = "";
    for (const l of r.lines) {
      const e = /^\* (\d+) EXISTS/.exec(l); if (e) exists = Number(e[1]);
      const u = /UIDVALIDITY (\d+)/.exec(l); if (u) uidvalidity = u[1];
    }
    return { exists, uidvalidity };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const r = await this.cmd(`UID SEARCH ${criteria}`);
    const l = r.lines.find((x) => x.startsWith("* SEARCH"));
    if (!l) return [];
    return l.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number);
  }

  async uidFetchRaw(uid: number): Promise<{ raw: Uint8Array; internalDate: string }> {
    const r = await this.cmd(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`);
    const head = r.lines.find((l) => /^\* \d+ FETCH/.test(l)) ?? "";
    const d = /INTERNALDATE "([^"]+)"/.exec(head);
    if (!r.literals.length) throw new Error("FETCH sin literal para UID " + uid);
    return { raw: r.literals[0], internalDate: d ? d[1] : "" };
  }

  async logout(): Promise<void> {
    try { await withTimeout(this.cmd("LOGOUT"), 5000, "logout"); } catch { /* ignore */ }
    try { this.conn.close(); } catch { /* ignore */ }
  }
}

// ── MIME / texto ──────────────────────────────────────────────────────────────
function decodeQP(s: string): Uint8Array {
  const out: number[] = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) {
      out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}
function b64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function decodeBody(body: string, cte: string, charset: string): string {
  const cs = /iso-8859|latin1|windows-1252/i.test(charset) ? "windows-1252" : "utf-8";
  const dec = new TextDecoder(cs);
  const e = cte.toLowerCase();
  if (e.includes("base64")) return dec.decode(b64ToBytes(body));
  if (e.includes("quoted-printable")) return dec.decode(decodeQP(body));
  // 7bit/8bit: el raw se decodificó como latin1; re-interpretar como utf-8 si corresponde
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  return dec.decode(bytes);
}
function decodeRfc2047(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs, enc, data) => {
    const bytes = enc.toUpperCase() === "B" ? b64ToBytes(data) : decodeQP(data.replace(/_/g, " "));
    const csn = /iso-8859|latin1|windows-1252/i.test(cs) ? "windows-1252" : "utf-8";
    return new TextDecoder(csn).decode(bytes);
  }).replace(/\?=\s+=\?/g, "?==?");
}
function parseHeaders(block: string): Record<string, string> {
  const h: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}
interface MailText { text: string; html: string; headers: Record<string, string> }
function parseMime(raw: string): MailText {
  const out: MailText = { text: "", html: "", headers: {} };
  const walk = (part: string, depth: number) => {
    if (depth > 6) return;
    const sep = part.search(/\r?\n\r?\n/);
    const headBlock = sep >= 0 ? part.slice(0, sep) : part;
    const body = sep >= 0 ? part.slice(sep).replace(/^\r?\n\r?\n/, "") : "";
    const h = parseHeaders(headBlock);
    if (depth === 0) out.headers = h;
    const ct = (h["content-type"] ?? "text/plain").toLowerCase();
    const cte = h["content-transfer-encoding"] ?? "7bit";
    const cs = /charset="?([^";\s]+)/i.exec(ct)?.[1] ?? "utf-8";
    if (ct.startsWith("multipart/")) {
      const b = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
      if (!b) return;
      const pieces = body.split(new RegExp("\\r?\\n?--" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:--)?\\r?\\n?"));
      for (const p of pieces.slice(1)) if (p.trim()) walk(p, depth + 1);
      return;
    }
    if (ct.startsWith("message/rfc822")) { walk(body, depth + 1); return; }
    if (ct.startsWith("text/html")) out.html += decodeBody(body, cte, cs) + "\n";
    else if (ct.startsWith("text/")) out.text += decodeBody(body, cte, cs) + "\n";
  };
  walk(raw, 0);
  return out;
}
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<\s*\/t[dh][^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&deg;/gi, "°").replace(/&ordm;/gi, "º");
}

// ── Parseo del mail de Krikos ─────────────────────────────────────────────────
interface OcInfo {
  link: string; doc_id: string | null; nro_documento: string | null;
  emisor_raw: string | null; cadena: string | null; gln_emisor: string | null;
  sucursal: string | null; gln_sucursal: string | null; direccion: string | null;
  fecha_emision: string | null; fecha_entrega: string | null; fecha_cancelacion: string | null;
}
function toIso(d: string | null): string | null {
  const m = d && /(\d{2})\/(\d{2})\/(\d{4})/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function docIdFromToken(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4);
    const j = JSON.parse(atob(b64));
    return j && j.id != null ? String(j.id) : null;
  } catch { return null; }
}
function extractOc(mail: MailText): OcInfo | null {
  const html = mail.html;
  const linkM = LINK_RE.exec(html) || LINK_RE.exec(mail.text);
  if (!linkM) return null;
  const link = linkM[0];
  const doc_id = docIdFromToken(linkM[1]);
  const t = (html ? htmlToText(html) : mail.text).replace(/\s+/g, " ");
  const g = (re: RegExp) => { const m = re.exec(t); return m ? m[1].trim() : null; };
  const emisor_raw = g(/Emisor\s+(.+?)\s+Receptor\s/i);
  let cadena: string | null = null, gln_emisor: string | null = null, sucursal: string | null = null,
      gln_sucursal: string | null = null, direccion: string | null = null;
  if (emisor_raw) {
    const m = /^(.*?)\s*\(GLN\s*(\d+)\)\s*(?:Sucursal\s+(.*?)\s*\(GLN\s*(\d+)\))?\s*(?:\((.*)\))?\s*$/i.exec(emisor_raw);
    if (m) { cadena = m[1] || null; gln_emisor = m[2] || null; sucursal = m[3] || null; gln_sucursal = m[4] || null; direccion = m[5] || null; }
    else cadena = emisor_raw;
  }
  return {
    link, doc_id, emisor_raw, cadena, gln_emisor, sucursal, gln_sucursal, direccion,
    nro_documento: g(/N[°º]?\s*de\s*Documento\s+(\S+)/i),
    fecha_emision: toIso(g(/Fecha\s*Emisi[oó]n\s+(\d{2}\/\d{2}\/\d{4})/i)),
    fecha_entrega: g(/Fecha\s*Entrega\s+(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/i),
    fecha_cancelacion: toIso(g(/Fecha\s*Cancelaci[oó]n\s+(\d{2}\/\d{2}\/\d{4})/i)),
  };
}
function imapDate(d: Date): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")}-${M[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
function internalDateToIso(s: string): string | null {
  // "31-Aug-2026 09:11:05 -0300"
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(s.trim());
  if (!m) return null;
  const M: Record<string, string> = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  return `${m[3]}-${M[m[2]] ?? "01"}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}${m[7].slice(0, 3)}:${m[7].slice(3)}`;
}

// ── Acciones ──────────────────────────────────────────────────────────────────
async function openMailbox(): Promise<{ imap: Imap; auth: string; exists: number; uidvalidity: string }> {
  const pass = await getSecret("KRIKOS_IMAP_PASS");
  if (!pass) throw new Error("KRIKOS_IMAP_PASS no configurado (ni env ni Vault)");
  const imap = await Imap.connect(IMAP_HOST, IMAP_PORT, IMAP_TLS);
  await imap.capability();
  const auth = await imap.login(IMAP_USER, pass);
  const { exists, uidvalidity } = await imap.examine("INBOX");
  return { imap, auth, exists, uidvalidity };
}

async function actionTestImap() {
  const started = Date.now();
  const { imap, auth, exists, uidvalidity } = await openMailbox();
  try {
    const since = new Date(Date.now() - 30 * 86400000);
    const uids = await imap.uidSearch(`FROM "${SENDER}" SINCE ${imapDate(since)}`);
    return { ok: true, host: IMAP_HOST, port: IMAP_PORT, tls: IMAP_TLS, auth, caps: imap.caps, inbox_exists: exists, uidvalidity, krikos_ultimos_30d: uids.length, ms: Date.now() - started };
  } finally { await imap.logout(); }
}

async function actionStatus() {
  const { data, error } = await sb.from("krikos_oc_inbox").select("estado");
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.estado] = (counts[r.estado] ?? 0) + 1;
  return { ok: true, counts, total: (data ?? []).length };
}

async function fetchPdf(link: string): Promise<Uint8Array> {
  const r = await withTimeout(fetch(link, { redirect: "follow", headers: { "Accept": "*/*", "User-Agent": "Mozilla/5.0" } }), 40000, "fetch pdf");
  if (!r.ok) throw new Error(`link HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const isPdf = buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  if (!isPdf) throw new Error(`el link no devolvió un PDF (${r.headers.get("content-type")}, ${buf.length} bytes)`);
  return buf;
}

async function actionSync(days: number, dryRun: boolean) {
  const started = Date.now();
  const { imap, auth, uidvalidity } = await openMailbox();
  const summary = { ok: true, auth, days, dry_run: dryRun, encontrados: 0, ya_procesados: 0, nuevos: 0, insertados: 0, errores: 0, detalle: [] as unknown[], ms: 0 };
  try {
    const since = new Date(Date.now() - days * 86400000);
    const uids = await imap.uidSearch(`FROM "${SENDER}" SINCE ${imapDate(since)}`);
    summary.encontrados = uids.length;
    if (!uids.length) return summary;

    const keys = uids.map((u) => `${uidvalidity}:${u}`);
    const { data: known, error: kErr } = await sb.from("krikos_oc_inbox").select("mail_uid").in("mail_uid", keys);
    if (kErr) throw new Error("lectura bandeja: " + kErr.message);
    const knownSet = new Set((known ?? []).map((r) => r.mail_uid));
    const pending = uids.filter((u) => !knownSet.has(`${uidvalidity}:${u}`));
    summary.ya_procesados = uids.length - pending.length;
    summary.nuevos = pending.length;

    for (const uid of pending) {
      const mail_uid = `${uidvalidity}:${uid}`;
      const det: Record<string, unknown> = { uid };
      try {
        const { raw, internalDate } = await imap.uidFetchRaw(uid);
        const rawStr = new TextDecoder("latin1").decode(raw);
        const mail = parseMime(rawStr);
        const subject = decodeRfc2047(mail.headers["subject"] ?? "");
        const oc = extractOc(mail);
        det.subject = subject;
        if (!oc) {
          det.skip = "sin link de Krikos";
          if (!dryRun) {
            await sb.from("krikos_oc_inbox").insert({
              link: "", mail_uid, mail_fecha: internalDateToIso(internalDate), mail_subject: subject,
              estado: "error", error_msg: "mail sin link de documento Krikos",
            });
          }
          summary.errores++;
          continue;
        }
        det.doc_id = oc.doc_id; det.cadena = oc.cadena; det.nro = oc.nro_documento;

        if (oc.doc_id) {
          const { data: dup } = await sb.from("krikos_oc_inbox").select("id, mail_uid").eq("doc_id", oc.doc_id).maybeSingle();
          if (dup) {
            det.skip = "doc_id ya en bandeja (id " + dup.id + ")";
            if (!dryRun && !dup.mail_uid) await sb.from("krikos_oc_inbox").update({ mail_uid }).eq("id", dup.id);
            summary.ya_procesados++;
            continue;
          }
        }
        if (dryRun) { det.dry = true; continue; }

        let storage_path: string | null = null, pdf_bytes: number | null = null;
        let estado = "pendiente", error_msg: string | null = null;
        try {
          const pdf = await fetchPdf(oc.link);
          const year = (oc.fecha_emision ?? new Date().toISOString().slice(0, 10)).slice(0, 4);
          const name = (oc.doc_id ?? `uid${uid}`) + ".pdf";
          storage_path = `${year}/${name}`;
          const up = await sb.storage.from(BUCKET).upload(storage_path, pdf, { contentType: "application/pdf", upsert: true });
          if (up.error) throw new Error("upload: " + up.error.message);
          pdf_bytes = pdf.length;
        } catch (e) {
          estado = "error"; error_msg = e instanceof Error ? e.message : String(e); storage_path = null;
        }
        const row = {
          doc_id: oc.doc_id, nro_documento: oc.nro_documento, emisor_raw: oc.emisor_raw, cadena: oc.cadena,
          gln_emisor: oc.gln_emisor, sucursal: oc.sucursal, gln_sucursal: oc.gln_sucursal, direccion: oc.direccion,
          fecha_emision: oc.fecha_emision, fecha_entrega: oc.fecha_entrega, fecha_cancelacion: oc.fecha_cancelacion,
          link: oc.link, mail_uid, mail_fecha: internalDateToIso(internalDate), mail_subject: subject,
          storage_path, pdf_bytes, estado, error_msg,
        };
        const ins = await sb.from("krikos_oc_inbox").insert(row);
        if (ins.error) throw new Error("insert: " + ins.error.message);
        if (estado === "error") summary.errores++; else summary.insertados++;
        det.estado = estado; if (error_msg) det.error = error_msg;
      } catch (e) {
        det.error = e instanceof Error ? e.message : String(e);
        summary.errores++;
      } finally {
        summary.detalle.push(det);
      }
    }
    return summary;
  } finally {
    summary.ms = Date.now() - started;
    await imap.logout();
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const secret = await getSecret("KRIKOS_INGEST_SECRET");
  if (!secret) return json({ ok: false, error: "KRIKOS_INGEST_SECRET no configurado (ni env ni Vault)" }, 503);
  if ((req.headers.get("x-krikos-secret") ?? "") !== secret) return json({ ok: false, error: "forbidden" }, 403);

  let body: { action?: string; days?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const action = String(body.action ?? "sync");
  try {
    if (action === "status") return json(await actionStatus());
    if (action === "test_imap") return json(await actionTestImap());
    if (action === "sync") {
      const days = Math.min(365, Math.max(1, Number(body.days ?? 30)));
      return json(await actionSync(days, !!body.dry_run));
    }
    return json({ ok: false, error: "action desconocida", valid: ["sync", "test_imap", "status"] }, 400);
  } catch (e) {
    console.error("krikos-ingest error:", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
