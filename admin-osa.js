/* ============================================================
   Admin · OSA — cargar Entregas (Loeke→OSA) y Ventas (OSA→clientes)
   Reusa la capa de datos del Formato OSA (window.Store): mismos parsers y
   misma escritura a Supabase (osa_entregas / osa_ventas). El admin sigue
   siendo un admin de Loekemeyer normal; solo escribe en las tablas osa_*.
   ============================================================ */
(function () {
  "use strict";

  var S = window.Store;
  var toast = window.toast || function (m) { console.log(m); };
  var showLoader = window.showLoader || function () {};
  var hideLoader = window.hideLoader || function () {};
  var _ready = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtInt(n) { return String(Math.round(n || 0)); }
  function fmtFecha(iso) {
    if (!iso) return "";
    var p = String(iso).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
  }

  // Carga el catálogo OSA en memoria (como admin: lectura). Una sola vez.
  function ensureReady() {
    if (!S || !S.init) return Promise.reject(new Error("Capa de datos OSA no disponible"));
    if (!_ready) {
      if (S.setSaveErrorHandler) {
        S.setSaveErrorHandler(function (e) {
          toast("No se pudo guardar en Supabase: " + ((e && e.message) || e), "error");
        });
      }
      _ready = S.init();
    }
    return _ready;
  }

  function headHTML(titulo, desc) {
    return (
      '<div style="padding:24px 28px;">' +
      '<h1 style="font-size:22px;margin:0 0 4px;">' + esc(titulo) + "</h1>" +
      '<p style="color:#6b7280;margin:0 0 18px;font-size:14px;max-width:680px;">' + desc + "</p>"
    );
  }

  /* ---------------- ENTREGAS (Excel de facturación Loeke→OSA) ---------------- */
  function buildEntregas() {
    var el = document.getElementById("osa-entregas");
    if (!el || el.dataset.built) return;
    el.dataset.built = "1";
    el.innerHTML =
      headHTML(
        "OSA · Entregas",
        "Cargá el <strong>Excel de facturación de Loekemeyer a OSA</strong>. Cada fila es una entrega que <strong>entra</strong> al stock de OSA (tabla <code>osa_entregas</code>). Detecto solo si viene en cajas o en unidades."
      ) +
      '<div class="card" style="padding:18px;max-width:820px;">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<input type="file" id="osaEntFile" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />' +
      '<button class="btn-primary" id="osaEntAnalizar">Analizar</button>' +
      "</div>" +
      '<div id="osaEntResult" style="margin-top:16px;"></div>' +
      "</div></div>";
    document.getElementById("osaEntAnalizar").addEventListener("click", analizarEntregas);
  }

  function analizarEntregas() {
    var f = document.getElementById("osaEntFile").files[0];
    var box = document.getElementById("osaEntResult");
    if (!f) { toast("Elegí el archivo Excel", "warn"); return; }
    box.innerHTML = "Leyendo…";
    showLoader("Leyendo Excel…");
    ensureReady()
      .then(function () { return f.arrayBuffer(); })
      .then(function (buf) {
        var wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
        var r = S.parseEntregas(rows);
        hideLoader();
        if (!r.filas.length) { box.innerHTML = '<span style="color:#b00020">No reconocí filas de entrega en el Excel.</span>'; return; }
        previewEntregas(r, box);
      })
      .catch(function (e) { hideLoader(); box.innerHTML = '<span style="color:#b00020">Error: ' + esc(e.message || e) + "</span>"; });
  }

  function previewEntregas(r, box) {
    var enCajas = r.formato === "cajas";
    var filas = r.filas.map(function (f) {
      var ok = !!f.articuloId;
      return (
        '<tr style="' + (ok ? "" : "opacity:.5;") + '"><td style="padding:6px">' + esc(f.codigo) + "</td>" +
        '<td style="padding:6px">' + (ok ? esc(f.nombre) : esc(f.descripcion || "—") + " · sin catálogo") + "</td>" +
        '<td style="padding:6px">' + esc(fmtFecha(f.fecha)) + "</td>" +
        '<td style="padding:6px;text-align:right">' + fmtInt(f.unidades) + "</td>" +
        '<td style="padding:6px;text-align:right">' + fmtInt(f.cajas) + "</td></tr>"
      );
    }).join("");
    box.innerHTML =
      '<div style="margin-bottom:10px;font-size:14px;">Detectado: <strong>' + (enCajas ? "CAJAS" : "UNIDADES") + "</strong> · " +
      r.matchCount + " de " + r.filas.length + " reconocidos" +
      (r.noEncontrados.length ? ' · <span style="color:#b00020">' + r.noEncontrados.length + " sin coincidencia</span>" : "") +
      "<br>A registrar (entra al stock): <strong>" + fmtInt(r.totalUnidades) + "</strong> u · <strong>" + fmtInt(r.totalCajas) + "</strong> cajas</div>" +
      '<div style="max-height:320px;overflow:auto;border:1px solid #eee;border-radius:8px;"><table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:#f6f7fb"><th style="text-align:left;padding:6px">Código</th><th style="text-align:left;padding:6px">Artículo</th><th style="text-align:left;padding:6px">Fecha</th><th style="text-align:right;padding:6px">Unid.</th><th style="text-align:right;padding:6px">Cajas</th></tr></thead>' +
      "<tbody>" + filas + "</tbody></table></div>" +
      '<button class="btn-primary" id="osaEntConfirm" style="margin-top:14px;">Confirmar entregas</button>';
    document.getElementById("osaEntConfirm").addEventListener("click", function () {
      if (enCajas && r.uxcDerivado) S.actualizarUxcDesde(r.uxcDerivado);
      var batch = r.filas
        .filter(function (f) { return f.articuloId && f.unidades > 0; })
        .map(function (f) {
          return { articuloId: f.articuloId, tipo: "entrega", cantidad: f.unidades, fecha: f.fecha || S.hoyISO(), nota: "Entrega Loeke (admin)", formato: r.formato };
        });
      if (!batch.length) { toast("No hay entregas para registrar", "warn"); return; }
      S.addMovimientosBatch(batch);
      toast("Registradas " + batch.length + " entregas en OSA", "success");
      box.innerHTML = '<span style="color:#0a7d3b;font-weight:600">✓ ' + batch.length + " entregas cargadas (" + fmtInt(r.totalUnidades) + " u / " + fmtInt(r.totalCajas) + " cajas).</span>";
      document.getElementById("osaEntFile").value = "";
    });
  }

  /* ---------------- VENTAS (informe OSA→clientes, PDF/texto) ---------------- */
  function buildVentas() {
    var el = document.getElementById("osa-ventas");
    if (!el || el.dataset.built) return;
    el.dataset.built = "1";
    el.innerHTML =
      headHTML(
        "OSA · Ventas",
        "Cargá el <strong>informe de ventas de OSA a sus clientes</strong> (PDF con texto seleccionable, o pegá el texto). <strong>Sale</strong> del stock de OSA (tabla <code>osa_ventas</code>). Se cruza por código (L031 = 031, L529 = 529E…)."
      ) +
      '<div class="card" style="padding:18px;max-width:820px;">' +
      '<input type="file" id="osaVenFile" accept="application/pdf" />' +
      '<textarea id="osaVenText" placeholder="O pegá el texto del informe…&#10;Desde 5/06/26 hasta 30/06/26&#10;:L031  FILTRO P/CAFE  12" style="width:100%;min-height:90px;margin-top:10px;font-family:monospace;font-size:12px;box-sizing:border-box;"></textarea>' +
      '<button class="btn-primary" id="osaVenAnalizar" style="margin-top:10px;">Analizar</button>' +
      '<div id="osaVenResult" style="margin-top:16px;"></div>' +
      "</div></div>";
    document.getElementById("osaVenAnalizar").addEventListener("click", analizarVentas);
  }

  function pdfATexto(file) {
    var PDFJS = window.pdfjsLib;
    if (PDFJS && PDFJS.GlobalWorkerOptions && !PDFJS.GlobalWorkerOptions.workerSrc) {
      PDFJS.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    return file.arrayBuffer()
      .then(function (buf) { return PDFJS.getDocument({ data: buf }).promise; })
      .then(function (pdf) {
        var pages = [];
        for (var i = 1; i <= pdf.numPages; i++) pages.push(i);
        return pages.reduce(function (acc, n) {
          return acc.then(function (txt) {
            return pdf.getPage(n).then(function (p) { return p.getTextContent(); }).then(function (tc) {
              var rows = {};
              tc.items.forEach(function (it) { var y = Math.round(it.transform[5]); (rows[y] = rows[y] || []).push(it); });
              var lns = Object.keys(rows).sort(function (a, b) { return b - a; }).map(function (y) {
                return rows[y].sort(function (a, b) { return a.transform[4] - b.transform[4]; }).map(function (it) { return it.str; }).join(" ");
              });
              return txt + lns.join("\n") + "\n";
            });
          });
        }, Promise.resolve(""));
      });
  }

  function analizarVentas() {
    var f = document.getElementById("osaVenFile").files[0];
    var pegado = document.getElementById("osaVenText").value;
    var box = document.getElementById("osaVenResult");
    box.innerHTML = "Procesando…";
    showLoader("Procesando informe…");
    ensureReady()
      .then(function () {
        if (f && /pdf/i.test((f.type || "") + " " + f.name)) return pdfATexto(f);
        if (pegado.trim()) return pegado;
        throw new Error("Subí el PDF (con texto) o pegá el texto del informe");
      })
      .then(function (text) {
        var r = S.parseReporteVentas(text);
        hideLoader();
        if (!r.filas.length) { box.innerHTML = '<span style="color:#b00020">No reconocí filas en el informe. Revisá el texto.</span>'; return; }
        previewVentas(r, box);
      })
      .catch(function (e) { hideLoader(); box.innerHTML = '<span style="color:#b00020">Error: ' + esc(e.message || e) + "</span>"; });
  }

  function previewVentas(r, box) {
    var hoy = S.hoyISO();
    var fechaRep = r.periodo.hasta || hoy;
    var qDef = S.quincenaDe(fechaRep) || S.quincenaDe(hoy);
    var quincenas = S.listaQuincenas(r.periodo.desde || fechaRep, hoy > fechaRep ? hoy : fechaRep);
    if (!quincenas.some(function (q) { return q.key === qDef.key; })) quincenas.push(qDef);
    quincenas.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    var optsQ = quincenas.map(function (q) {
      return '<option value="' + q.key + '"' + (q.key === qDef.key ? " selected" : "") + ">" + esc(q.label) + (S.quincenaCargada(q.key) ? " — ya cargada" : "") + "</option>";
    }).join("");
    var detalle = r.filas.map(function (f) {
      var art = f.articuloId ? S.getArticulo(f.articuloId) : null;
      var uxc = art ? S.uxcDe(art) : 1;
      return { f: f, art: art, cajas: Math.round((f.ventas || 0) / uxc) };
    });
    var filas = detalle.map(function (d) {
      var ok = !!d.art;
      return (
        '<tr style="' + (ok ? "" : "opacity:.5;") + '"><td style="padding:6px">' + esc(d.f.codigoReporte) + "</td>" +
        '<td style="padding:6px">' + (ok ? esc(d.art.nombre) : esc(d.f.desc || "—") + " · sin catálogo") + "</td>" +
        '<td style="padding:6px;text-align:right">' + fmtInt(d.f.ventas) + "</td>" +
        '<td style="padding:6px;text-align:right">' + (ok ? fmtInt(d.cajas) : "—") + "</td></tr>"
      );
    }).join("");
    var periodoTxt = r.periodo.desde ? fmtFecha(r.periodo.desde) + " a " + fmtFecha(r.periodo.hasta) : fmtFecha(fechaRep);
    box.innerHTML =
      '<div style="margin-bottom:10px;font-size:14px;">Informe <strong>' + esc(periodoTxt) + "</strong> · " +
      r.matchCount + " de " + r.filas.length + " reconocidos" +
      (r.noEncontrados.length ? ' · <span style="color:#b00020">' + r.noEncontrados.length + " sin coincidencia</span>" : "") +
      "<br>A descontar del stock: <strong>" + fmtInt(r.totalParseado) + "</strong> unidades</div>" +
      '<label style="font-size:14px;">Imputar a la quincena: <select id="osaVenQuincena" style="padding:6px;">' + optsQ + "</select></label>" +
      '<div style="max-height:320px;overflow:auto;border:1px solid #eee;border-radius:8px;margin-top:10px;"><table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead><tr style="background:#f6f7fb"><th style="text-align:left;padding:6px">Código</th><th style="text-align:left;padding:6px">Artículo</th><th style="text-align:right;padding:6px">Ventas (u)</th><th style="text-align:right;padding:6px">Cajas</th></tr></thead>' +
      "<tbody>" + filas + "</tbody></table></div>" +
      '<button class="btn-primary" id="osaVenConfirm" style="margin-top:14px;">Confirmar ventas</button>';
    document.getElementById("osaVenConfirm").addEventListener("click", function () {
      var qk = document.getElementById("osaVenQuincena").value;
      var qObj = S.quincenaDe(qk.slice(0, 8) + (qk.slice(-1) === "1" ? "01" : "16"));
      var fech = qObj ? qObj.hasta : fechaRep;
      var nota = "Ventas OSA " + periodoTxt;
      var batch = detalle
        .filter(function (d) { return d.art && d.f.ventas > 0; })
        .map(function (d) { return { articuloId: d.art.id, tipo: "venta", cantidad: d.f.ventas, fecha: fech, nota: nota, quincena: qk }; });
      if (!batch.length) { toast("No hay ventas para importar", "warn"); return; }
      S.addMovimientosBatch(batch);
      toast("Importadas " + batch.length + " ventas de OSA", "success");
      box.innerHTML = '<span style="color:#0a7d3b;font-weight:600">✓ ' + batch.length + " ventas cargadas (" + fmtInt(r.totalParseado) + " u).</span>";
      document.getElementById("osaVenFile").value = "";
      document.getElementById("osaVenText").value = "";
    });
  }

  /* ---------------- Nav: construir la página al abrirla ---------------- */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest('.nav-item[data-page]');
    if (!btn) return;
    if (btn.dataset.page === "osa-entregas") buildEntregas();
    else if (btn.dataset.page === "osa-ventas") buildVentas();
  });
})();
