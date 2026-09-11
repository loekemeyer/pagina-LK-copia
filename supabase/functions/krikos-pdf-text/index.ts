// =============================================================================
// Edge Function: krikos-pdf-text
// =============================================================================
// Devuelve el TEXTO de una OC ya guardada en el bucket `krikos-oc`, extraído
// con la MISMA lógica que usa el navegador en `admin-supercot.js`
// (`extractPdfText`): pdf.js + agrupado de items por coordenada Y con
// tolerancia de 1 px y ordenado por X. Sirve para verificar, fuera del
// navegador, que los parsers de cada cadena leen bien una OC.
//
// Sólo LEE. No toca la bandeja ni el bucket.
//
//   POST { action: "text", ids: [9, 10] }   header `x-krikos-secret: <KRIKOS_INGEST_SECRET>`
//     → [{ id, cadena, storage_path, paginas, chars, text }]
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "krikos-oc";
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function getSecret(name: string): Promise<string> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data } = await sb.rpc("krikos_secret", { p_name: name });
  return typeof data === "string" ? data : "";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Calcado de extractPdfText() de admin-supercot.js
async function extractPdfText(buf: Uint8Array) {
  const pdf = await getDocumentProxy(buf);
  const allLines: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows: Record<string, { x: number; str: string }[]> = {};
    for (const it of content.items as any[]) {
      const y = Math.round(it.transform[5]);
      let key: string | null = null;
      for (const k of Object.keys(rows)) {
        if (key == null && Math.abs(Number(k) - y) <= 1) key = k;
      }
      if (key == null) { rows[String(y)] = []; key = String(y); }
      rows[key].push({ x: it.transform[4], str: it.str });
    }
    const keys = Object.keys(rows).map(Number).sort((a, b) => b - a);
    for (const k of keys) {
      const line = rows[String(k)]
        .sort((a, b) => a.x - b.x)
        .map((r) => r.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) allLines.push(line);
    }
  }
  return { text: allLines.join("\n"), paginas: pdf.numPages };
}

Deno.serve(async (req) => {
  try {
    const secret = await getSecret("KRIKOS_INGEST_SECRET");
    if (!secret) return json({ ok: false, error: "sin KRIKOS_INGEST_SECRET" }, 503);
    if (req.headers.get("x-krikos-secret") !== secret) return json({ ok: false, error: "no autorizado" }, 401);

    const body = await req.json().catch(() => ({}));
    const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    if (!ids.length) return json({ ok: false, error: "faltan ids" }, 400);

    const { data: filas, error } = await sb
      .from("krikos_oc_inbox")
      .select("id, cadena, storage_path")
      .in("id", ids);
    if (error) return json({ ok: false, error: error.message }, 500);

    const out: unknown[] = [];
    for (const f of filas ?? []) {
      if (!f.storage_path) { out.push({ id: f.id, error: "sin storage_path" }); continue; }
      const dl = await sb.storage.from(BUCKET).download(f.storage_path);
      if (dl.error) { out.push({ id: f.id, error: dl.error.message }); continue; }
      const buf = new Uint8Array(await dl.data.arrayBuffer());
      try {
        const { text, paginas } = await extractPdfText(buf);
        out.push({ id: f.id, cadena: f.cadena, storage_path: f.storage_path, paginas, chars: text.length, text });
      } catch (e) {
        out.push({ id: f.id, error: String(e) });
      }
    }
    return json({ ok: true, docs: out });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
