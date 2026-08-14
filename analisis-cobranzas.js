/* ============================================================
 * Análisis de Cobranzas - Loekemeyer
 * Standalone tool. No backend. SheetJS only.
 * ============================================================ */

(function () {
  "use strict";

  // ====================== CONFIG ======================
  const DTO_BUCKETS_STD = [
    { maxDias: 14, dto: 0.25, label: "Contado (0-14d)" },
    { maxDias: 30, dto: 0.2, label: "15-30d" },
    { maxDias: 45, dto: 0.15, label: "31-45d" },
    { maxDias: 60, dto: 0.1, label: "46-60d" },
    { maxDias: 90, dto: 0.05, label: "61-90d (e-cheq)" },
    { maxDias: Infinity, dto: 0, label: ">90d" },
  ];
  const DTO_BUCKETS_MEGASHOP = [{ maxDias: Infinity, dto: 0.235, label: "Megashop" }];
  const ANOMALY_EPS = 0.005; // 0.5% tolerance for rounding

  // Bank G codes considered as cliente deposit (entrada)
  // D = transferencia bancaria del cliente (acreditación inmediata)
  // 3 / "3" = cheque depositado ("A Depositar") — fecha A es vencimiento, M es aceptación real
  const CLIENTE_G_CODES = new Set(["D", "3", 3]);
  const CHEQUE_G_CODES = new Set(["3", 3]);

  // Sheet name patterns to find current year in Credicoop file
  const CONCILIACION_RX = /CONCILIACION\s*\d{4}/i;

  // ====================== STATE ======================
  const state = {
    deuda: null, // { fileName, clientes: Map<cod, {razon, facturas, suma}> }
    credi: null, // { fileName, deposits: [...] }
    comprobantes: [], // [{name, url, file, type}]
    results: null, // computed array
    filtered: null, // filtered view
  };

  // ====================== HELPERS ======================
  function $(sel) {
    return document.querySelector(sel);
  }
  function $$(sel) {
    return [...document.querySelectorAll(sel)];
  }

  function toast(msg, ms = 3000) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), ms);
  }

  function fmtARS(n) {
    if (n == null || isNaN(n)) return "—";
    return n.toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return "—";
    return n.toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return "—";
    return (n * 100).toFixed(1).replace(".", ",") + "%";
  }
  function fmtDate(d) {
    if (!d || !(d instanceof Date) || isNaN(d)) return "—";
    return d.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }
  function fmtDateShort(d) {
    if (!d || !(d instanceof Date) || isNaN(d)) return "—";
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
  }

  function parseSheetDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") {
      // Excel serial (SheetJS w/ cellDates:false returns numbers)
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + v * 86400000);
      return isNaN(d) ? null : d;
    }
    if (typeof v === "string") {
      // Try ISO first, then dd/mm/yyyy
      const t = v.trim();
      const iso = new Date(t);
      if (!isNaN(iso) && t.match(/\d{4}-\d{2}-\d{2}/)) return iso;
      const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (m) {
        let [_, dd, mm, yy] = m;
        yy = parseInt(yy);
        if (yy < 100) yy += 2000;
        return new Date(yy, parseInt(mm) - 1, parseInt(dd));
      }
    }
    return null;
  }

  /**
   * Parse "Aceptado DD/MM" (cheque acceptance date). Year inferred from
   * reference date (cheque vencimiento): if DD/MM > ref, subtract 1 year.
   */
  function parseAceptado(mStr, refDate) {
    if (!mStr || typeof mStr !== "string" || !refDate) return null;
    const m = mStr.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (!m) return null;
    const dd = parseInt(m[1]);
    const mm = parseInt(m[2]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    let year = refDate.getFullYear();
    let candidate = new Date(year, mm - 1, dd);
    if (candidate > refDate) {
      year -= 1;
      candidate = new Date(year, mm - 1, dd);
    }
    return candidate;
  }

  function isNumericLike(v) {
    if (v == null || v === "") return false;
    if (typeof v === "number") return !isNaN(v);
    if (typeof v === "string") {
      const s = v.replace(/[\.,]/g, "").trim();
      return /^-?\d+$/.test(s);
    }
    return false;
  }

  function toNumber(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      // Remove any non-numeric except sign and decimal
      const s = v.replace(/[^\d.,\-]/g, "").replace(/\./g, "").replace(",", ".");
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  function daysBetween(d1, d2) {
    if (!d1 || !d2) return null;
    return Math.round((d2 - d1) / 86400000);
  }

  // Weighted average date (returns Date)
  function weightedDate(items, dateKey, amountKey) {
    let totalAmt = 0;
    let totalMs = 0;
    for (const it of items) {
      const d = it[dateKey];
      const a = it[amountKey];
      if (!d || !a || a <= 0) continue;
      totalAmt += a;
      totalMs += d.getTime() * a;
    }
    if (totalAmt <= 0) return null;
    return new Date(totalMs / totalAmt);
  }

  function getBucket(dias, mode) {
    const buckets = mode === "megashop" ? DTO_BUCKETS_MEGASHOP : DTO_BUCKETS_STD;
    for (const b of buckets) if (dias <= b.maxDias) return b;
    return buckets[buckets.length - 1];
  }

  // ====================== FILE PARSERS ======================
  async function readBookFromFile(file) {
    const buf = await file.arrayBuffer();
    return XLSX.read(buf, { cellDates: true, type: "array" });
  }

  async function readBookFromUrl(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status + " — " + url);
    const buf = await r.arrayBuffer();
    return XLSX.read(buf, { cellDates: true, type: "array" });
  }

  /**
   * Parse Deuda Clientes XLSX. Format per sheet:
   *  R1-3: header / instructions
   *  Then repeating blocks per cliente:
   *    [client header row]: A=código (numeric, ~4 digits), B=razón social (text), no L
   *    [invoice rows]: A=vto date, B=emisión, C=días, D=Div, E=tipo (FCA/NCA/RC), F=nro, L=pendiente
   *    [totals row]: only L=acumulado
   */
  async function parseDeuda(files) {
    const clientes = new Map();
    let totalSheets = 0;
    let fileNames = [];

    for (const file of files) {
      fileNames.push(file.name);
      const wb = await readBookFromFile(file);
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
        // Use raw values for amounts. Re-read with raw:true for L column
        const rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

        let currentCod = null;
        let currentRazon = null;

        for (let i = 0; i < rowsRaw.length; i++) {
          const r = rowsRaw[i];
          if (!r || r.length === 0) continue;
          const A = r[0],
            B = r[1],
            E = r[4],
            F = r[5],
            L = r[11];

          // Detect client header row: A numeric short (3-5 digits), B text
          if (
            (typeof A === "number" || /^\d{2,5}$/.test(String(A || "").trim())) &&
            typeof B === "string" &&
            B.trim() &&
            !["FCA", "NCA", "RC"].includes(String(E || "").trim())
          ) {
            const cod = String(A).trim().replace(/\.0+$/, "");
            currentCod = cod;
            currentRazon = B.trim();
            if (!clientes.has(cod)) {
              clientes.set(cod, { cod, razon: currentRazon, facturas: [], suma: 0 });
            }
            continue;
          }

          // Invoice row
          const tipo = String(E || "").trim().toUpperCase();
          if (currentCod && ["FCA", "NCA", "RC"].includes(tipo)) {
            const fecha = parseSheetDate(A) || parseSheetDate(r[1]);
            const importe = typeof L === "number" ? L : toNumber(L);
            if (importe === 0) continue;
            const cli = clientes.get(currentCod);
            cli.facturas.push({
              fecha,
              vto: fecha,
              emision: parseSheetDate(r[1]),
              dias: toNumber(r[2]),
              tipo,
              nro: String(F || "").trim(),
              monto: importe,
            });
            cli.suma += importe;
            totalSheets++;
          }
        }
      }
    }

    return { fileNames, clientes, count: totalSheets };
  }

  /**
   * Parse Conciliación Credicoop. Pick all sheets matching /CONCILIACION \d{4}/.
   * Columns:
   *   A=Fecha, B=Operación, C=ENTRADA, D=SALIDA, F=Detalle, G=Código (D/T/S/G/3/...),
   *   H=Nro OP, I=Nro Recibo, J=Cód cliente
   * Filter: G ∈ {D, 3} AND C > 0 AND J numeric AND B != Proyeccion
   */
  async function parseCredicoopFromBook(wb, fileName) {
    const targetSheets = wb.SheetNames.filter((n) => CONCILIACION_RX.test(n));
    const useSheets = targetSheets.length ? targetSheets : wb.SheetNames;

    const deposits = [];

    for (const sheetName of useSheets) {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

      for (let i = 2; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        const A = r[0],
          B = r[1],
          C = r[2],
          F = r[5],
          G = r[6],
          H = r[7],
          I = r[8],
          J = r[9],
          M = r[12]; // "Aceptado DD/MM" para cheques

        // Skip projections
        if (typeof B === "string" && /proyeccion/i.test(B)) continue;
        // Skip rows w/o entrada
        const entrada = typeof C === "number" ? C : toNumber(C);
        if (!entrada || entrada <= 0) continue;

        // Must be cliente deposit (G code)
        const gStr = typeof G === "number" ? String(G) : String(G || "").trim();
        if (!CLIENTE_G_CODES.has(gStr) && !CLIENTE_G_CODES.has(G)) continue;

        // Must have client code in J
        if (!isNumericLike(J)) continue;
        const cod = String(typeof J === "number" ? Math.round(J) : J)
          .trim()
          .replace(/\.0+$/, "");

        const fechaA = parseSheetDate(A);
        if (!fechaA) continue;

        // For cheques (G=3), use M ("Aceptado DD/MM") as real payment date
        // (column A is cheque vencimiento — future). Fallback to A if M unparseable.
        const isCheque = CHEQUE_G_CODES.has(gStr) || CHEQUE_G_CODES.has(G);
        let fecha = fechaA;
        let fechaVto = null;
        if (isCheque) {
          const fechaM = parseAceptado(M, fechaA);
          if (fechaM) {
            fecha = fechaM;
            fechaVto = fechaA;
          }
        }

        deposits.push({
          fecha,
          fechaVto,
          isCheque,
          monto: entrada,
          cod,
          detalle: String(F || "").trim(),
          op: String(typeof H === "number" ? Math.round(H) : H || "").trim(),
          recibo: String(typeof I === "number" ? Math.round(I) : I || "").trim(),
          tipo: B,
          sheet: sheetName,
        });
      }
    }
    return { fileName, deposits };
  }

  async function parseCredicoop(file) {
    const wb = await readBookFromFile(file);
    return parseCredicoopFromBook(wb, file.name);
  }

  async function parseCredicoopFromUrl(url, label) {
    const wb = await readBookFromUrl(url);
    return parseCredicoopFromBook(wb, label || url);
  }

  // ====================== ANALYSIS ======================
  async function analyze() {
    // Auto-fetch credicoop from server if missing
    if (!state.credi) {
      try {
        const res = await parseCredicoopFromUrl("/banco/credicoop.xls", "credicoop.xls (online)");
        state.credi = res;
        $("#statusCredi").textContent = `${res.deposits.length} depósitos · ${res.fileName}`;
        $("#dzCredi").classList.add("loaded");
      } catch (e) {
        toast("No pude bajar la conciliación del server. Cargá manual.");
        return;
      }
    }
    if (!state.deuda) {
      toast("Falta archivo de Deuda Clientes");
      return;
    }
    const desde = $("#fechaDesde").value ? new Date($("#fechaDesde").value + "T00:00:00") : null;
    const hasta = $("#fechaHasta").value ? new Date($("#fechaHasta").value + "T23:59:59") : null;
    const mode = $("#modeDto").value;

    // Group payments by cliente cod
    const pagosPorCod = new Map();
    for (const p of state.credi.deposits) {
      if (desde && p.fecha < desde) continue;
      if (hasta && p.fecha > hasta) continue;
      if (!pagosPorCod.has(p.cod)) pagosPorCod.set(p.cod, []);
      pagosPorCod.get(p.cod).push(p);
    }

    const results = [];
    for (const [cod, pagos] of pagosPorCod.entries()) {
      const cli = state.deuda.clientes.get(cod);
      // Use only positive-pendiente FCA invoices for invoice side
      const facturas = cli ? cli.facturas.filter((f) => f.monto > 0 && f.tipo === "FCA") : [];

      const sumInv = facturas.reduce((a, f) => a + f.monto, 0);
      const sumPay = pagos.reduce((a, p) => a + p.monto, 0);

      const wInvDate = weightedDate(facturas, "fecha", "monto");
      const wPayDate = weightedDate(pagos, "fecha", "monto");
      const dias = wInvDate && wPayDate ? daysBetween(wInvDate, wPayDate) : null;

      // Discount taken = how much the cliente *withheld* relative to the debt covered.
      // descTomado = (sumInv - sumPay) / sumInv  (only meaningful when client paid all invoices)
      let descTomado = null;
      if (sumInv > 0) {
        descTomado = (sumInv - sumPay) / sumInv;
      }

      const bucket = dias != null ? getBucket(dias, mode) : null;
      const descPermitido = bucket ? bucket.dto : null;

      let estado = "ok";
      if (!cli) estado = "sin_deuda";
      else if (descTomado == null) estado = "ok";
      else if (descTomado > (descPermitido || 0) + ANOMALY_EPS) estado = "anomalia";
      else if (descTomado < -ANOMALY_EPS) estado = "sobrepago";

      results.push({
        cod,
        razon: cli ? cli.razon : "(no figura en deuda)",
        facturas,
        pagos,
        sumInv,
        sumPay,
        saldo: sumInv - sumPay,
        wInvDate,
        wPayDate,
        dias,
        descTomado,
        descPermitido,
        bucket: bucket ? bucket.label : "—",
        estado,
      });
    }

    // Sort: anomalias first, then by saldo desc
    results.sort((a, b) => {
      if (a.estado === "anomalia" && b.estado !== "anomalia") return -1;
      if (b.estado === "anomalia" && a.estado !== "anomalia") return 1;
      return b.sumPay - a.sumPay;
    });

    state.results = results;
    state.filtered = results;
    renderAll();
  }

  // ====================== RENDER ======================
  function renderAll() {
    renderKpis();
    renderTable();
    renderAnomalies();
  }

  function renderKpis() {
    const r = state.results || [];
    const totalCobrado = r.reduce((a, x) => a + x.sumPay, 0);
    const totalFact = r.reduce((a, x) => a + x.sumInv, 0);
    const anom = r.filter((x) => x.estado === "anomalia").length;
    const conPagos = r.length;
    const diasArr = r.filter((x) => x.dias != null).map((x) => x.dias);
    // Weighted by sumPay
    let wDias = null;
    let totalW = 0;
    let acc = 0;
    for (const x of r) {
      if (x.dias != null && x.sumPay > 0) {
        acc += x.dias * x.sumPay;
        totalW += x.sumPay;
      }
    }
    if (totalW > 0) wDias = Math.round(acc / totalW);

    const html = `
      <div class="kpi"><div class="kpi-value">${conPagos}</div><div class="kpi-label">Clientes con pagos</div></div>
      <div class="kpi"><div class="kpi-value">${fmtARS(totalCobrado)}</div><div class="kpi-label">Total cobrado</div></div>
      <div class="kpi"><div class="kpi-value">${fmtARS(totalFact)}</div><div class="kpi-label">Total facturas</div></div>
      <div class="kpi"><div class="kpi-value">${wDias != null ? wDias + "d" : "—"}</div><div class="kpi-label">Días promedio (pond.)</div></div>
      <div class="kpi"><div class="kpi-value" style="color:${anom > 0 ? "var(--danger)" : "var(--success)"}">${anom}</div><div class="kpi-label">Anomalías</div></div>
    `;
    $("#kpiRow").innerHTML = html;
    $("#cardResumen").hidden = false;
  }

  function renderTable() {
    const tbody = $("#tbodyResults");
    const list = state.filtered || [];
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text3)">Sin resultados</td></tr>`;
      $("#cardTabla").hidden = false;
      return;
    }
    tbody.innerHTML = list
      .map((r) => {
        const warn = r.estado === "anomalia" ? "warn" : "";
        const badgeClass =
          r.estado === "anomalia"
            ? "badge-warn"
            : r.estado === "sin_deuda"
              ? "badge-info"
              : r.estado === "sobrepago"
                ? "badge-info"
                : "badge-ok";
        const badgeText =
          r.estado === "anomalia"
            ? "⚠ Tomó dto. mayor"
            : r.estado === "sin_deuda"
              ? "ℹ Sin deuda registrada"
              : r.estado === "sobrepago"
                ? "ℹ Sobrepago"
                : "✓ OK";
        return `<tr class="${warn}" data-cod="${r.cod}">
          <td>${r.cod}</td>
          <td>${escapeHtml(r.razon)}</td>
          <td class="num">${fmtARS(r.sumInv)}</td>
          <td class="num">${fmtARS(r.sumPay)}</td>
          <td class="num">${fmtARS(r.saldo)}</td>
          <td class="num">${r.dias != null ? r.dias + "d" : "—"}</td>
          <td class="num">${r.descTomado != null ? fmtPct(r.descTomado) : "—"}</td>
          <td class="num">${r.descPermitido != null ? fmtPct(r.descPermitido) : "—"} <span class="badge badge-neutral">${escapeHtml(r.bucket)}</span></td>
          <td><span class="badge ${badgeClass}">${badgeText}</span></td>
        </tr>`;
      })
      .join("");
    $("#cardTabla").hidden = false;

    // Click → detalle
    tbody.querySelectorAll("tr[data-cod]").forEach((tr) => {
      tr.addEventListener("click", () => showDetalle(tr.dataset.cod));
    });
  }

  function renderAnomalies() {
    const anoms = (state.results || []).filter((x) => x.estado === "anomalia");
    const card = $("#cardAnom");
    if (!anoms.length) {
      card.hidden = true;
      return;
    }
    const list = $("#anomList");
    list.innerHTML = anoms
      .map((r) => {
        const dif = r.descTomado - r.descPermitido;
        const difMonto = dif * r.sumInv;
        return `<div class="anom-item">
          <div>
            <div class="anom-title">${escapeHtml(r.razon)} <small style="color:var(--text3)">(${r.cod})</small></div>
            <div class="anom-detail">
              Pagó a <strong>${r.dias}d</strong> con dto. <strong>${fmtPct(r.descTomado)}</strong> —
              permitido para ${escapeHtml(r.bucket)}: <strong>${fmtPct(r.descPermitido)}</strong> —
              diferencia: <strong>${fmtPct(dif)}</strong> (${fmtARS(difMonto)})
            </div>
          </div>
          <button class="btn-primary" data-email="${r.cod}" type="button">Generar email</button>
        </div>`;
      })
      .join("");
    list.querySelectorAll("button[data-email]").forEach((b) => {
      b.addEventListener("click", () => showEmail(b.dataset.email));
    });
    card.hidden = false;
  }

  function showDetalle(cod) {
    const r = (state.results || []).find((x) => x.cod === cod);
    if (!r) return;
    $("#detalleTitle").textContent = `${r.razon} (${r.cod})`;

    const summary = `
      <div class="detalle-summary">
        <div class="kpi"><div class="kpi-value">${fmtARS(r.sumInv)}</div><div class="kpi-label">Facturas</div></div>
        <div class="kpi"><div class="kpi-value">${fmtARS(r.sumPay)}</div><div class="kpi-label">Pagado</div></div>
        <div class="kpi"><div class="kpi-value">${fmtARS(r.saldo)}</div><div class="kpi-label">Saldo</div></div>
        <div class="kpi"><div class="kpi-value">${r.dias != null ? r.dias + "d" : "—"}</div><div class="kpi-label">Días pond.</div></div>
        <div class="kpi"><div class="kpi-value">${r.descTomado != null ? fmtPct(r.descTomado) : "—"}</div><div class="kpi-label">Dto. tomado</div></div>
        <div class="kpi"><div class="kpi-value">${r.descPermitido != null ? fmtPct(r.descPermitido) : "—"}</div><div class="kpi-label">Dto. permitido</div></div>
      </div>
      <p style="margin-bottom:14px;font-size:12.5px;color:var(--text2)">
        <strong>Fecha factura ponderada:</strong> ${fmtDate(r.wInvDate)} —
        <strong>Fecha pago ponderada:</strong> ${fmtDate(r.wPayDate)}
      </p>
    `;

    const fact = `
      <div class="detalle-section">
        <h4>Facturas pendientes (${r.facturas.length})</h4>
        <table class="detalle-table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Nº</th><th class="num">Monto</th><th class="num">% del total</th></tr></thead>
          <tbody>
            ${r.facturas
              .map(
                (f) => `<tr>
                <td>${fmtDate(f.fecha)}</td>
                <td>${escapeHtml(f.tipo)}</td>
                <td>${escapeHtml(f.nro)}</td>
                <td class="num">${fmtARS(f.monto)}</td>
                <td class="num">${r.sumInv ? fmtPct(f.monto / r.sumInv) : "—"}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    const pag = `
      <div class="detalle-section">
        <h4>Pagos detectados (${r.pagos.length})</h4>
        <table class="detalle-table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>OP / Recibo</th><th>Detalle</th><th class="num">Monto</th></tr></thead>
          <tbody>
            ${r.pagos
              .map(
                (p) => `<tr>
                <td>${fmtDate(p.fecha)}${p.isCheque ? ` <small style="color:var(--text3)">(vto ${fmtDateShort(p.fechaVto)})</small>` : ""}</td>
                <td>${escapeHtml(p.tipo || "")}</td>
                <td>${escapeHtml(p.op || p.recibo)}</td>
                <td>${escapeHtml(p.detalle)}</td>
                <td class="num">${fmtARS(p.monto)}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;

    $("#detalleBody").innerHTML = summary + fact + pag;
    $("#detalleModal").hidden = false;
  }

  function buildEmail(r) {
    const dif = r.descTomado - r.descPermitido;
    const difMonto = dif * r.sumInv;
    return `Buenas tardes Estimado:

Este es un aviso del Depto. de Cobranzas de Loekemeyer Hnos S.R.L..

Detectamos que su pago fue realizado con un descuento de ${fmtPct(r.descTomado)} sobre un total de facturas de ${fmtARS(r.sumInv)}.

Sin embargo, según fecha de acreditación en nuestra cuenta, su pago corresponde a ${r.dias} días desde la fecha promedio ponderada de las facturas (${fmtDate(r.wInvDate)} → ${fmtDate(r.wPayDate)}). Para ese plazo (${r.bucket}) el descuento permitido es de ${fmtPct(r.descPermitido)}.

Diferencia: ${fmtPct(dif)} (${fmtARS(difMonto)}).

Solo por esta oportunidad procesaremos su pago como está, pero le pedimos realice el ajuste por la diferencia indicada en el próximo pago.

En caso de presentar inconvenientes con esta nota, comuníquese con cobranzas@loekemeyer.com.ar.

Desde ya, muchas gracias por su tiempo.

Saluda Atentamente,
Depto. de Cobranzas
Loekemeyer Hnos S.R.L.`;
  }

  function showEmail(cod) {
    const r = (state.results || []).find((x) => x.cod === cod);
    if (!r) return;
    $("#emailText").value = buildEmail(r);
    $("#emailModal").hidden = false;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ====================== EXPORT ======================
  function exportXLSX() {
    if (!state.results || !state.results.length) {
      toast("Nada que exportar — corré el análisis primero");
      return;
    }
    const rows = [
      [
        "Código",
        "Razón social",
        "Facturas",
        "Pagado",
        "Saldo",
        "Días pond.",
        "Fecha fact. pond.",
        "Fecha pago pond.",
        "Dto. tomado",
        "Dto. permitido",
        "Bucket",
        "Estado",
      ],
    ];
    for (const r of state.results) {
      rows.push([
        r.cod,
        r.razon,
        r.sumInv,
        r.sumPay,
        r.saldo,
        r.dias,
        r.wInvDate ? r.wInvDate.toISOString().slice(0, 10) : "",
        r.wPayDate ? r.wPayDate.toISOString().slice(0, 10) : "",
        r.descTomado,
        r.descPermitido,
        r.bucket,
        r.estado,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cobranzas");
    XLSX.writeFile(wb, `analisis-cobranzas-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ====================== COMPROBANTES (auto from server) ======================
  /**
   * Parse filename like "04-05 - CL 4066 - 403297.pdf" or
   * "06-05 - CL 2183 - 2522043 OP.JPG"
   * Extracts: date (dd-mm), client code, amount, optional tag (OP, RT, etc).
   */
  function parseComprobanteName(name, mtimeAnchor) {
    const out = { fecha: null, cod: null, monto: null, tag: null };
    // Date prefix dd-mm or dd/mm
    const dm = name.match(/^(\d{1,2})[\-\/](\d{1,2})\b/);
    if (dm) {
      const dd = parseInt(dm[1]);
      const mm = parseInt(dm[2]);
      // Year inference: pick the candidate closest to file mtime (or today)
      const anchor = mtimeAnchor || new Date();
      const baseY = anchor.getFullYear();
      const candidates = [
        new Date(baseY - 1, mm - 1, dd),
        new Date(baseY, mm - 1, dd),
        new Date(baseY + 1, mm - 1, dd),
      ];
      candidates.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
      out.fecha = candidates[0];
    }
    // Client code: "CL <num>" or "CH <num>"
    const cm = name.match(/\bC[LH]\s+(\d{2,5})\b/i);
    if (cm) out.cod = cm[1];
    // Amount: largest plain number after the code (no decimal in filenames, so look for 4+ digit chunk)
    // Take the last numeric chunk before the extension
    const noExt = name.replace(/\.[^.]+$/, "");
    const nums = noExt.match(/\b\d{3,10}\b/g) || [];
    // Filter out the date numbers (dd, mm) and the code
    if (nums.length) {
      // The amount is typically the largest number
      const candidates = nums.filter(
        (n) => !out.cod || n !== out.cod
      );
      if (candidates.length) {
        const max = candidates.reduce((a, b) => (parseInt(b) > parseInt(a) ? b : a));
        out.monto = parseInt(max);
      }
    }
    // Tag: "OP", "RT", "(G)" etc. between the amount and extension
    const tm = noExt.match(/-\s*\d+\s+([A-Z]{1,4}|\([A-Z]\))\b/i);
    if (tm) out.tag = tm[1];
    return out;
  }

  async function loadComprobantesFromServer() {
    $("#statusComp").textContent = "Buscando...";
    try {
      const r = await fetch("/api/comprobantes-list", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const list = await r.json();
      state.comprobantes = list.map((it) => {
        const mt = it.mtime ? new Date(it.mtime) : null;
        const meta = parseComprobanteName(it.name, mt);
        return {
          name: it.name,
          url: it.url,
          path: it.path,
          folder: it.folder,
          size: it.size,
          mtime: it.mtime ? new Date(it.mtime) : null,
          type: /\.pdf$/i.test(it.name) ? "application/pdf" : "image/*",
          fechaArch: meta.fecha,
          codArch: meta.cod,
          montoArch: meta.monto,
          tagArch: meta.tag,
        };
      });
      $("#dzComp").classList.toggle("loaded", state.comprobantes.length > 0);
      crossReferenceComprobantes();
      // Re-render results if we already analyzed (to attach comprobantes)
      if (state.results) renderTable();
    } catch (err) {
      console.warn("No comprobantes:", err);
      $("#statusComp").textContent = "API no disponible (corré con serve.ps1)";
      state.comprobantes = [];
      renderComprobantes();
    }
  }

  // Get comprobantes that belong to a specific client code
  function comprobantesForCod(cod) {
    return state.comprobantes.filter((c) => c.codArch === cod);
  }

  /**
   * Try to match a comprobante to a Credicoop deposit.
   * Score lower = better match. Requires same código (J).
   * Returns { deposit, score, level: "exact"|"close"|"partial"|null } or null.
   */
  function matchComprobanteToDeposit(comp, deposits) {
    if (comp.montoArch == null) return null;

    const TOL_ABS = 10; // $10 absoluto — sin relative, evita falsos positivos
    const DAY_RANGE_EXACT = 7;
    const DAY_RANGE_CLOSE = 60;

    const tryMatch = (pool) => {
      const matched = [];
      for (const dep of pool) {
        const amtDiff = Math.abs(dep.monto - comp.montoArch);
        if (amtDiff > TOL_ABS) continue;
        let dayDiff = 999;
        if (comp.fechaArch && dep.fecha) {
          dayDiff = Math.abs(dep.fecha - comp.fechaArch) / 86400000;
        }
        if (dayDiff > DAY_RANGE_CLOSE) continue;
        matched.push({ dep, amtDiff, dayDiff });
      }
      return matched;
    };

    // 1) Exact same cod + amount
    let pool = comp.codArch ? deposits.filter((d) => d.cod === comp.codArch) : [];
    let matched = tryMatch(pool);

    let level;
    if (matched.length) {
      matched.sort((a, b) => a.dayDiff - b.dayDiff || a.amtDiff - b.amtDiff);
      const best = matched[0];
      level = best.dayDiff <= DAY_RANGE_EXACT ? "exact" : "close";
      return { deposit: best.dep, score: best.amtDiff + best.dayDiff, level, codMatch: true };
    }

    // 2) Fallback: same amount in any deposit (J vacío en Credicoop o cod distinto)
    matched = tryMatch(deposits);
    if (!matched.length) return null;

    // Prefer: deposits w/o cod (J empty) > others
    matched.sort((a, b) => {
      const aEmpty = !a.dep.cod ? 0 : 1;
      const bEmpty = !b.dep.cod ? 0 : 1;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return a.dayDiff - b.dayDiff || a.amtDiff - b.amtDiff;
    });
    const best = matched[0];
    level = "review"; // amount matches but cliente cod doesn't (or is empty)
    return { deposit: best.dep, score: best.amtDiff + best.dayDiff, level, codMatch: false };
  }

  function crossReferenceComprobantes() {
    if (!state.comprobantes.length) return;
    if (!state.credi) {
      // No deposits loaded yet — clear matches
      for (const c of state.comprobantes) c.match = null;
      return;
    }
    let matched = 0;
    let orphan = 0;
    for (const c of state.comprobantes) {
      c.match = matchComprobanteToDeposit(c, state.credi.deposits);
      if (c.match) matched++;
      else orphan++;
    }
    state.comprobantesMatched = matched;
    state.comprobantesOrphan = orphan;
    $("#statusComp").textContent =
      `${state.comprobantes.length} archivo(s) — ${matched} cruzados, ${orphan} sin cruce`;
    renderComprobantes();
  }

  function matchBadge(m) {
    if (!m)
      return `<span class="match-badge match-orphan" title="Sin cruce — falta cargar en Credicoop o nombre mal armado">✗ sin cruce</span>`;
    const monto = fmtARS(m.deposit.monto);
    const fecha = fmtDateShort(m.deposit.fecha);
    if (m.level === "exact")
      return `<span class="match-badge match-exact" title="Cruce exacto: código + monto + fecha (${fecha})">✓ ${monto}</span>`;
    if (m.level === "close")
      return `<span class="match-badge match-close" title="Mismo código y monto, fecha distinta (${fecha})">≈ ${monto} <small>${fecha}</small></span>`;
    if (m.level === "review")
      return `<span class="match-badge match-review" title="Mismo monto pero cod cliente en Credicoop (J=${m.deposit.cod || "vacío"}) no coincide. Verificar.">? ${monto} <small>verif.</small></span>`;
    return `<span class="match-badge match-partial">? ${monto}</span>`;
  }

  function renderComprobantes() {
    if (!state.comprobantes.length) {
      $("#cardComp").hidden = true;
      return;
    }
    // Build summary header
    const total = state.comprobantes.length;
    const matched = state.comprobantes.filter((c) => c.match).length;
    const orphans = state.comprobantes.filter((c) => !c.match);
    const exact = state.comprobantes.filter((c) => c.match && c.match.level === "exact").length;

    const close = state.comprobantes.filter((c) => c.match && c.match.level === "close").length;
    const review = state.comprobantes.filter((c) => c.match && c.match.level === "review").length;
    let html = `<div class="comp-summary">
      <span><strong>${total}</strong> archivos</span>
      <span class="dot"></span>
      <span style="color:var(--success)"><strong>${exact}</strong> exacto</span>
      <span class="dot"></span>
      <span style="color:var(--warning)"><strong>${close}</strong> aproximado</span>
      <span class="dot"></span>
      <span style="color:#b56500"><strong>${review}</strong> verificar (cod ≠)</span>
      <span class="dot"></span>
      <span style="color:${orphans.length ? "var(--danger)" : "var(--text3)"}"><strong>${orphans.length}</strong> sin cruce</span>
    </div>`;

    // Orphans first if any
    if (orphans.length) {
      html += `<div class="comp-orphans">
        <h4 class="comp-section-title" style="color:var(--danger)">⚠️ Sin cruce (${orphans.length}) — falta cargar en Credicoop o nombre mal armado</h4>
        <div class="comp-gallery">${orphans.map(compCardHtml).join("")}</div>
      </div>`;
    }

    // Group matched by client code
    const matchedItems = state.comprobantes.filter((c) => c.match);
    const byCod = new Map();
    for (const c of matchedItems) {
      const k = c.codArch || "(sin código)";
      if (!byCod.has(k)) byCod.set(k, []);
      byCod.get(k).push(c);
    }
    const codSorted = [...byCod.keys()].sort((a, b) => parseInt(a) - parseInt(b));
    for (const cod of codSorted) {
      const items = byCod.get(cod);
      const cli = state.deuda && state.deuda.clientes.get(cod);
      const razon = cli ? cli.razon : items[0].match.deposit.detalle || "(sin razón social)";
      html += `<div class="comp-group">
        <h4 class="comp-section-title">${cod} — ${escapeHtml(razon)} <small style="font-weight:400;color:var(--text3)">(${items.length})</small></h4>
        <div class="comp-gallery">${items.map(compCardHtml).join("")}</div>
      </div>`;
    }

    $("#compGallery").innerHTML = html;
    $("#cardComp").hidden = false;
    $$("#compGallery img").forEach((img) =>
      img.addEventListener("click", () => window.open(img.src, "_blank"))
    );
  }

  function compCardHtml(c) {
    const isImg = !/\.pdf$/i.test(c.name);
    const badge = matchBadge(c.match);
    let cardClass = "orphan";
    if (c.match) {
      if (c.match.level === "exact") cardClass = "matched-exact";
      else if (c.match.level === "close") cardClass = "matched-close";
      else if (c.match.level === "review") cardClass = "matched-review";
    }
    const inner = isImg
      ? `<img src="${c.url}" alt="${escapeHtml(c.name)}" loading="lazy" />`
      : `<div class="pdf-icon">📄 PDF</div>`;
    return `<div class="comp-thumb ${cardClass}" title="${escapeHtml(c.name)}">
      ${inner}
      <div class="match-row">${badge}</div>
      <div class="name">${escapeHtml(c.name)}</div>
    </div>`;
  }

  // ====================== DROPZONES ======================
  function setupDropzone(dz, input, onFiles) {
    dz.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files.length) onFiles([...input.files]);
      input.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add("drag");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove("drag");
      })
    );
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    });
  }

  // ====================== INIT ======================
  function init() {
    setupDropzone($("#dzDeuda"), $("#fileDeuda"), async (files) => {
      try {
        $("#statusDeuda").textContent = "Procesando...";
        const res = await parseDeuda(files);
        state.deuda = res;
        $("#statusDeuda").textContent = `${res.clientes.size} clientes — ${res.count} facturas`;
        $("#dzDeuda").classList.add("loaded");
      } catch (err) {
        console.error(err);
        toast("Error parseando deuda: " + err.message);
        $("#statusDeuda").textContent = "Error";
      }
    });

    async function applyCrediResult(res) {
      state.credi = res;
      $("#statusCredi").textContent = `${res.deposits.length} depósitos · ${res.fileName}`;
      $("#dzCredi").classList.add("loaded");
      if (res.deposits.length) {
        const maxDate = res.deposits.reduce((m, d) => (d.fecha > m ? d.fecha : m), res.deposits[0].fecha);
        const desde = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
        const hasta = maxDate;
        $("#fechaDesde").value = desde.toISOString().slice(0, 10);
        $("#fechaHasta").value = hasta.toISOString().slice(0, 10);
      }
      // Re-cross-reference if we already have comprobantes
      crossReferenceComprobantes();
    }

    async function loadCredicoopFromServer() {
      $("#statusCredi").textContent = "Bajando del server...";
      try {
        const res = await parseCredicoopFromUrl("/banco/credicoop.xls", "credicoop.xls (online)");
        await applyCrediResult(res);
      } catch (err) {
        console.warn("No credicoop online:", err);
        $("#statusCredi").textContent = "No accesible — droppea archivo manual";
      }
    }

    setupDropzone($("#dzCredi"), $("#fileCredi"), async (files) => {
      try {
        $("#statusCredi").textContent = "Procesando...";
        const res = await parseCredicoop(files[0]);
        await applyCrediResult(res);
      } catch (err) {
        console.error(err);
        toast("Error parseando Credicoop: " + err.message);
        $("#statusCredi").textContent = "Error";
      }
    });

    const btnReloadCredi = $("#btnReloadCredi");
    if (btnReloadCredi) {
      btnReloadCredi.addEventListener("click", (e) => {
        e.stopPropagation();
        loadCredicoopFromServer();
      });
    }
    // Auto-load on init
    loadCredicoopFromServer();

    // Comprobantes: auto-load from server, click-to-reload
    $("#dzComp").addEventListener("click", loadComprobantesFromServer);
    const btnReloadComp = $("#btnReloadComp");
    if (btnReloadComp) {
      btnReloadComp.addEventListener("click", (e) => {
        e.stopPropagation();
        loadComprobantesFromServer();
      });
    }
    loadComprobantesFromServer();

    $("#btnAnalizar").addEventListener("click", analyze);

    $("#btnReset").addEventListener("click", () => {
      state.deuda = null;
      state.credi = null;
      state.results = null;
      state.filtered = null;
      ["statusDeuda", "statusCredi"].forEach((id) => ($("#" + id).textContent = "Sin cargar"));
      ["dzDeuda", "dzCredi"].forEach((id) => $("#" + id).classList.remove("loaded"));
      ["cardResumen", "cardTabla", "cardAnom"].forEach((id) => ($("#" + id).hidden = true));
      toast("Reset OK");
    });

    // Search + filters
    $("#searchInput").addEventListener("input", applyFilters);
    $("#onlyAnom").addEventListener("change", applyFilters);
    $("#btnExport").addEventListener("click", exportXLSX);

    // Modals
    $("#detalleClose").addEventListener("click", () => ($("#detalleModal").hidden = true));
    $("#emailClose").addEventListener("click", () => ($("#emailModal").hidden = true));
    $("#detalleModal").addEventListener("click", (e) => {
      if (e.target.id === "detalleModal") $("#detalleModal").hidden = true;
    });
    $("#emailModal").addEventListener("click", (e) => {
      if (e.target.id === "emailModal") $("#emailModal").hidden = true;
    });
    $("#btnCopyEmail").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#emailText").value);
        toast("Copiado al portapapeles");
      } catch {
        $("#emailText").select();
        document.execCommand("copy");
        toast("Copiado");
      }
    });
  }

  function applyFilters() {
    if (!state.results) return;
    const q = $("#searchInput").value.trim().toLowerCase();
    const onlyAnom = $("#onlyAnom").checked;
    state.filtered = state.results.filter((r) => {
      if (onlyAnom && r.estado !== "anomalia") return false;
      if (q) {
        const blob = (r.cod + " " + r.razon).toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
    renderTable();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
