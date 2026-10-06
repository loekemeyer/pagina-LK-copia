// oc-pdf.js — el cliente carga su pedido subiendo la ORDEN DE COMPRA en PDF.
//
// Pedido del 06/10/2026: Torres y Liva (cod 288) armaba el carrito a mano
// copiando su OC. Ahora sube el PDF desde el carrito ("Cargar orden de compra"),
// la página lo lee, arma el carrito y CONTROLA QUE EL TOTAL DE LA OC COINCIDA
// con el de nuestro programa.
//
// ⚠ QUÉ SE COMPARA. La OC de Torres y Liva viene en UNIDADES y a NUESTRO PRECIO
//   DE LISTA por unidad, sin IVA (verificado con la OC 9575: los 26 renglones con
//   PU = products.list_price exacto). O sea que el total de la OC se compara con
//   el carrito A PRECIO DE LISTA, no con el "Pedido · Total" de arriba, que ya
//   lleva el dto. de volumen, el 2% web y el del medio de pago. Comparar contra
//   ese número daría "no coincide" siempre.
//
// ⚠ EL CÓDIGO DE LA OC NO SIEMPRE ES EL NUESTRO. En la 9575: "66" es nuestro 066,
//   "395D" es el 395, y "525" (inactivo, $0) es el 525E que dice la descripción.
//   Por eso se prueban varios candidatos y GANA EL QUE TIENE EL MISMO PRECIO que
//   la OC: el precio confirma el código. Si ninguno coincide en precio, se usa el
//   código exacto y el renglón queda marcado.
//
// ⚠ Unidades → cajas con el uxb de products. Si no da caja cerrada se redondea y
//   se marca: la diferencia aparece sola en el control de total.
//
// Para sumar otro cliente con OC en PDF: agregar un formato a FORMATOS con su
// cod/CUIT, una regex que lo reconozca y su parser (devuelve el mismo objeto).
// Lo sostiene tests/oc-pdf-tyl.cjs.
(function () {
  "use strict";

  var PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var SOURCE = "oc_pdf";

  var FORMATOS = [
    {
      id: "tyl",
      nombre: "Torres y Liva",
      cods: ["288"],
      cuits: ["33534724239"],
      detecta: /TORRES\s+Y\s+LIVA/i,
      parse: parseTyl,
    },
  ];

  // ── Números: "13.656.600,00" (AR), "1987200.00", "1,987,200.00" ─────────────
  function numAR(s) {
    var t = String(s == null ? "" : s).replace(/[$\s]/g, "");
    if (!t) return NaN;
    var ult = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
    if (ult >= 0 && t.length - ult - 1 === 2) {
      var ent = t.slice(0, ult).replace(/[.,]/g, "");
      return Number(ent + "." + t.slice(ult + 1));
    }
    return Number(t.replace(/[.,]/g, ""));
  }

  // ── Parser Torres y Liva ("PEDIDO DE COMPRA", proveedor 267) ────────────────
  // Renglón: Id Producto · Cód.Fábrica · Descripción · PU Costo S/Iva · [Packs] ·
  // Unidades · Total. El PU y el Total llevan 2 decimales: eso ancla la
  // descripción, que puede traer números sueltos ("Nº10", "30 CMS", "X1 579").
  var RE_TYL_ITEM =
    /^(\d+)\s+([0-9A-Z]+)\s+(.+?)\s+(\d[\d.,]*[.,]\d{2})\s+(?:(\d+)\s+)?(\d+)\s+(\d[\d.,]*[.,]\d{2})$/i;
  var RE_PARECE_ITEM = /^\d+\s+\S+\s+.*\d[.,]\d{2}$/;

  function parseTyl(lines) {
    var oc = { formato: "tyl", nro: "", emision: "", entrega: "", lineas: [], noLeidas: [], totalGeneral: NaN };
    lines.forEach(function (raw) {
      var l = String(raw || "").replace(/\s+/g, " ").trim();
      if (!l) return;
      var m;
      if ((m = l.match(/Pedido\s+Nro:?\s*(\d+)/i))) oc.nro = m[1];
      if ((m = l.match(/Fecha\s+de\s+Emisi[oó]n:?\s*(\d{2}\/\d{2}\/\d{4})/i))) oc.emision = m[1];
      if ((m = l.match(/Pedido\s+para\s+el\s+D[ií]a:?\s*(\d{2}\/\d{2}\/\d{4})/i))) oc.entrega = m[1];
      if ((m = l.match(/TOTAL\s+GENERAL[^$\d]*\$?\s*([\d.,]+)/i))) {
        oc.totalGeneral = numAR(m[1]);
        return;
      }
      if ((m = l.match(RE_TYL_ITEM))) {
        oc.lineas.push({
          idProd: m[1],
          codOc: m[2].toUpperCase(),
          desc: m[3].trim(),
          pu: numAR(m[4]),
          packs: m[5] ? Number(m[5]) : null,
          unidades: Number(m[6]),
          total: numAR(m[7]),
        });
      } else if (RE_PARECE_ITEM.test(l)) {
        oc.noLeidas.push(l);
      }
    });
    return oc;
  }

  // ── Código de la OC → producto nuestro ──────────────────────────────────────
  function sinCeros(c) {
    return String(c || "").toUpperCase().replace(/^0+(?=\d)/, "");
  }
  function resolverCodigo(linea, prods) {
    var lista = prods || [];
    var cands = [];
    function sumar(p, via) {
      if (p && !cands.some(function (c) { return c.p === p; })) cands.push({ p: p, via: via });
    }
    function porCod(cod, via) {
      var cu = String(cod || "").toUpperCase();
      lista.forEach(function (p) { if (String(p.cod || "").toUpperCase() === cu) sumar(p, via); });
      lista.forEach(function (p) { if (sinCeros(p.cod) === sinCeros(cu)) sumar(p, via); });
    }
    var codOc = String(linea.codOc || "").toUpperCase();
    porCod(codOc, "codigo");
    // Códigos escritos en la descripción, del último al primero ("…LOEKEMEYER 525E").
    var toks = String(linea.desc || "").toUpperCase().match(/\b\d{2,4}[A-Z]{0,2}\b/g) || [];
    toks.reverse().forEach(function (t) { porCod(t, "descripcion"); });
    // Sin la letra final: 395D → 395.
    var base = codOc.replace(/[A-Z]+$/, "");
    if (base && base !== codOc) porCod(base, "codigo_base");

    if (!cands.length) return null;
    var mismoPrecio = cands.find(function (c) {
      return Math.abs(Number(c.p.list_price || 0) - Number(linea.pu || 0)) < 0.005;
    });
    var elegido = mismoPrecio || cands[0];
    return { prod: elegido.p, via: elegido.via, precioOk: !!mismoPrecio };
  }

  // ── Armado: renglones con cajas, chequeos y totales ─────────────────────────
  function armar(oc, prods) {
    var filas = oc.lineas.map(function (l, i) {
      var f = { orden: i, l: l, prod: null, cajas: 0, uxb: 0, puNuestro: null, totalNuestro: 0, problemas: [] };
      if (Math.abs(l.pu * l.unidades - l.total) >= 1) f.problemas.push("PU × unidades no da el total del renglón");
      var r = resolverCodigo(l, prods);
      if (!r) {
        f.problemas.push("código no encontrado en nuestro catálogo");
        return f;
      }
      var p = r.prod;
      f.prod = p;
      f.uxb = Number(p.uxb || 0);
      f.puNuestro = Number(p.list_price || 0);
      if (String(p.cod || "").toUpperCase() !== String(l.codOc || "").toUpperCase()) f.nota = "es nuestro " + p.cod;
      var badge = String(p.badge_status || "").trim().toUpperCase();
      if (badge === "SIN STOCK" || badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE") {
        f.problemas.push(badge.replace("PROXIMAMENTE", "PRÓXIMAMENTE") + ": no se carga");
        f.prod = null;
        return f;
      }
      if (!(f.uxb > 0)) {
        f.problemas.push("sin unidades por caja");
        f.prod = null;
        return f;
      }
      var exacto = l.unidades / f.uxb;
      f.cajas = Math.max(1, Math.round(exacto));
      if (Math.abs(exacto - f.cajas) > 1e-9) {
        f.problemas.push(l.unidades + " u. no es caja cerrada (" + f.uxb + " u/caja): se cargan " + f.cajas + " cajas");
      }
      if (!r.precioOk) f.problemas.push("precio distinto al nuestro");
      f.totalNuestro = f.cajas * f.uxb * f.puNuestro;
      return f;
    });
    var sumaRenglones = filas.reduce(function (a, f) { return a + (f.l.total || 0); }, 0);
    var totalNuestro = filas.reduce(function (a, f) { return a + (f.prod ? f.totalNuestro : 0); }, 0);
    var totalOc = isFinite(oc.totalGeneral) ? oc.totalGeneral : sumaRenglones;
    return {
      oc: oc,
      filas: filas,
      sumaRenglones: sumaRenglones,
      totalOc: totalOc,
      totalNuestro: totalNuestro,
      diferencia: totalNuestro - totalOc,
      coincide: Math.abs(totalNuestro - totalOc) < 1 && Math.abs(sumaRenglones - totalOc) < 1 && !oc.noLeidas.length,
    };
  }

  function formatoPorTexto(texto) {
    return FORMATOS.find(function (f) { return f.detecta.test(texto); }) || null;
  }

  var api = { numAR: numAR, parseTyl: parseTyl, resolverCodigo: resolverCodigo, armar: armar, formatoPorTexto: formatoPorTexto, FORMATOS: FORMATOS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window === "undefined") return;
  window.OcPdf = api;

  // ════════════════════════════════════════════════════════════════════════════
  // UI (mayorista.html)
  // ════════════════════════════════════════════════════════════════════════════
  function $id(id) { return document.getElementById(id); }
  function plata(n) {
    return "$ " + Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function formatoDelCliente() {
    var cp = window.customerProfile || (typeof customerProfile !== "undefined" ? customerProfile : null);
    if (!cp) return null;
    var cod = String(cp.cod_cliente || "").trim();
    var cuit = String(cp.cuit || "").replace(/\D/g, "");
    return FORMATOS.find(function (f) { return f.cods.indexOf(cod) >= 0 || f.cuits.indexOf(cuit) >= 0; }) || null;
  }

  function ocPdfSyncBtn() {
    var btn = $id("ocPdfBtn");
    if (!btn) return;
    var f = formatoDelCliente();
    btn.hidden = !f;
  }

  function cargarPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (ok, mal) {
      var s = document.createElement("script");
      s.src = PDFJS_URL;
      s.onload = function () {
        if (!window.pdfjsLib) return mal(new Error("pdf.js no cargó"));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        ok(window.pdfjsLib);
      };
      s.onerror = function () { mal(new Error("No se pudo cargar el lector de PDF. Revisá la conexión.")); };
      document.head.appendChild(s);
    });
  }

  // Mismo agrupado por renglón que admin-supercot.js (extractPdfText).
  async function lineasDelPdf(file) {
    var lib = await cargarPdfJs();
    var pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    var out = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var content = await (await pdf.getPage(p)).getTextContent();
      var rows = {};
      content.items.forEach(function (it) {
        var y = Math.round(it.transform[5]);
        var key = Object.keys(rows).find(function (k) { return Math.abs(Number(k) - y) <= 1; });
        if (key == null) { rows[y] = []; key = y; }
        rows[key].push({ x: it.transform[4], s: it.str });
      });
      Object.keys(rows).map(Number).sort(function (a, b) { return b - a; }).forEach(function (k) {
        var l = rows[k].sort(function (a, b) { return a.x - b.x; })
          .map(function (r) { return r.s; }).join(" ").replace(/\s+/g, " ").trim();
        if (l) out.push(l);
      });
    }
    return out;
  }

  function ocPdfAbrir() {
    if (typeof editingOrderId !== "undefined" && editingOrderId) {
      alert("Estás editando un pedido. Terminá o cancelá la edición antes de cargar una orden de compra.");
      return;
    }
    var inp = $id("ocPdfInput");
    if (inp) { inp.value = ""; inp.click(); }
  }

  async function ocPdfArchivo(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var btn = $id("ocPdfBtn");
    var txtBtn = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Leyendo la orden…"; }
    try {
      var fCli = formatoDelCliente();
      var lineas = await lineasDelPdf(file);
      var fmt = formatoPorTexto(lineas.join("\n"));
      if (!fmt) throw new Error("No reconocemos el formato de esta orden de compra.");
      if (fCli && fmt.id !== fCli.id) throw new Error("Esta orden de compra es de " + fmt.nombre + ", no de tu cuenta.");
      var oc = fmt.parse(lineas);
      if (!oc.lineas.length) throw new Error("No encontramos artículos en la orden de compra.");

      var prods = [].concat(typeof products !== "undefined" ? products : [], typeof lokeProducts !== "undefined" ? lokeProducts : []);
      var res = armar(oc, prods);
      var cargar = res.filas.filter(function (f) { return f.prod && f.cajas > 0; });
      if (!cargar.length) throw new Error("Ninguno de los artículos de la orden se puede pedir hoy.");

      if (cart.length && !confirm("Tu carrito ya tiene " + cart.length + " artículo(s). ¿Reemplazarlo por la orden de compra Nº " + (oc.nro || "") + "?")) return;

      cart.splice(0, cart.length);
      cargar.forEach(function (f) {
        var pid = f.prod.id;
        var ya = cart.find(function (c) { return String(c.productId) === String(pid); });
        if (ya) ya.qtyCajas += f.cajas;
        else cart.push({ productId: pid, qtyCajas: f.cajas, source: SOURCE });
        if (typeof logCartAddEvent === "function") logCartAddEvent(pid, SOURCE);
      });

      // Nº de OC a observaciones (si no había nada escrito): viaja con el pedido.
      var obs = $id("obsPedidoInput");
      if (obs && !String(obs.value || "").trim()) {
        obs.value = "OC " + fmt.nombre + " Nº " + (oc.nro || "?") + (oc.entrega ? " · entrega pedida " + oc.entrega : "");
        if (typeof _obsSyncBtn === "function") _obsSyncBtn();
      }

      if (typeof saveCartToLS === "function") saveCartToLS();
      if (typeof updateCart === "function") updateCart();
      if (typeof renderProducts === "function") renderProducts();
      if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
      if (typeof showSection === "function") showSection("carrito");
      mostrarInforme(fmt, res);
    } catch (e) {
      alert(e && e.message ? e.message : "No se pudo leer la orden de compra.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = txtBtn; }
    }
  }

  function mostrarInforme(fmt, res) {
    var oc = res.oc;
    var t = typeof calcTotals === "function" ? calcTotals() : null;
    var filas = res.filas.slice().sort(function (a, b) {
      return (b.problemas.length ? 1 : 0) - (a.problemas.length ? 1 : 0) || a.orden - b.orden;
    });
    var conProblema = res.filas.filter(function (f) { return f.problemas.length; }).length;

    var aviso = res.coincide
      ? '<div class="ocpdf-ok">✓ El total de la OC coincide con nuestro programa: <b>' + plata(res.totalOc) + "</b> sin IVA, a precio de lista.</div>"
      : '<div class="ocpdf-mal">✗ El total NO coincide. OC: <b>' + plata(res.totalOc) + "</b> · nuestro programa: <b>" + plata(res.totalNuestro) +
        "</b> · diferencia <b>" + plata(res.diferencia) + "</b>. Revisá los renglones marcados antes de confirmar.</div>";

    var extra = [];
    if (Math.abs(res.sumaRenglones - res.totalOc) >= 1) extra.push("La suma de los renglones de la OC (" + plata(res.sumaRenglones) + ") no da el TOTAL GENERAL impreso.");
    if (oc.noLeidas.length) extra.push(oc.noLeidas.length + " renglón(es) de la OC no se pudieron leer: " + oc.noLeidas.map(esc).join(" · "));

    var cuerpo = filas.map(function (f) {
      var l = f.l;
      var cod = esc(l.codOc) + (f.nota ? '<div class="ocpdf-nota">' + esc(f.nota) + "</div>" : "");
      var est = f.problemas.length ? '<span class="ocpdf-x">' + f.problemas.map(esc).join("<br>") + "</span>" : '<span class="ocpdf-v">✓</span>';
      return "<tr" + (f.problemas.length ? ' class="ocpdf-fila-mal"' : "") + "><td>" + cod + '</td><td class="ocpdf-desc">' + esc(l.desc) +
        "</td><td>" + l.unidades.toLocaleString("es-AR") + "</td><td>" + (f.cajas || "—") + "</td><td>" + plata(l.pu) +
        "</td><td>" + (f.puNuestro == null ? "—" : plata(f.puNuestro)) + "</td><td>" + plata(l.total) + "</td><td>" + est + "</td></tr>";
    }).join("");

    var html =
      '<div class="ocpdf-cab">OC Nº <b>' + esc(oc.nro || "—") + "</b> · " + esc(fmt.nombre) +
      (oc.emision ? " · emitida " + esc(oc.emision) : "") + (oc.entrega ? " · entrega pedida " + esc(oc.entrega) : "") + "</div>" +
      aviso +
      (extra.length ? '<div class="ocpdf-mal">' + extra.join("<br>") + "</div>" : "") +
      '<div class="ocpdf-tabla-wrap"><table class="ocpdf-tabla"><thead><tr>' +
      "<th>Cód<br>OC</th><th>Descripción</th><th>Unid.</th><th>Cajas</th><th>PU OC</th><th>PU<br>nuestro</th><th>Total OC</th><th>" +
      (conProblema ? conProblema + " a revisar" : "Estado") + "</th></tr></thead><tbody>" + cuerpo +
      '</tbody><tfoot><tr><td colspan="6">Total OC (s/IVA) · nuestro programa a lista</td><td>' + plata(res.totalOc) + "</td><td>" + plata(res.totalNuestro) + "</td></tr></tfoot></table></div>" +
      (t ? '<p class="ocpdf-pie">Tu pedido en la página: <b>' + plata(t.finalTotal) + " + IVA</b>, con tus descuentos. La OC va a precio de lista; por eso los dos números son distintos.</p>" : "") +
      '<button type="button" class="modal-submit" onclick="ocPdfCerrar()">Ver el carrito</button>';

    var m = $id("modalOcPdf");
    if (!m) return;
    $id("ocPdfBody").innerHTML = html;
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }

  function ocPdfCerrar() {
    var m = $id("modalOcPdf");
    if (!m) return;
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  }

  window.ocPdfSyncBtn = ocPdfSyncBtn;
  window.ocPdfAbrir = ocPdfAbrir;
  window.ocPdfArchivo = ocPdfArchivo;
  window.ocPdfCerrar = ocPdfCerrar;
})();
