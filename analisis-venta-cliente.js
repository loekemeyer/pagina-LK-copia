"use strict";

// ============================================================
// Análisis Venta Cliente — admin only
// Doc: .planning/PLAN.md
// ============================================================

// Renombrados con prefijo AVC_ para no chocar con script.js (que declara
// SUPABASE_URL y SUPABASE_ANON_KEY como const cuando este JS carga embebido
// en mayorista.html en customer mode).
var AVC_SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
var AVC_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

// Si ya existe supabaseClient (mayorista), lo reutilizamos para compartir auth.
// Sino creamos uno nuevo (admin standalone).
var sb = (typeof window !== "undefined" && window.supabaseClient) ||
  window.supabase.createClient(AVC_SUPABASE_URL, AVC_SUPABASE_ANON_KEY);

// Embedded mode: cuando este script corre dentro de admin.html (sidebar admin
// con .sidebar-nav). En ese caso admin.js ya hizo la auth + admin check y ya
// muestra la app shell, asi que evitamos togglear loadingScreen/appShell y
// evitamos redirigir a /mayorista en caso de fallo (admin.js lo maneja).
var AVC_EMBEDDED = !!document.querySelector(".sidebar-nav");

// Customer mode: cuando este script corre dentro de mayorista.html en la
// sección #perfil del cliente. En ese caso:
//   - NO se hace admin check (el cliente NO es admin)
//   - Se auto-loadea SU PROPIO cod_cliente (no permitir buscar otros)
//   - Se OCULTA el bloque Acuerdo (DV%, Com%, s/lista) — interno
//   - Se OCULTAN controles de búsqueda y reporte total
var AVC_CUSTOMER_MODE = document.body && document.body.classList.contains("avc-customer-mode");

// ============================================================
// ESTADO GLOBAL
// ============================================================
var currentCustomer = null; // { id, cod_cliente, business_name, ... }
var currentAddresses = []; // [{ id, direccion, ... }]
var productByCod = {}; // cod -> { descripcion, categoria, ... }
var productById = {}; // id -> cod
var estadisticaMadre = {}; // cod -> { ranking, e_madre_uni_mes, descripcion, categoria }
var sugerenciasCache = []; // resultado RPC sugerencias_cliente
var novedadesCache = []; // resultado RPC novedades_marca
var movements = []; // historial unificado (RPC get_customer_history) — fuente única para Consolidado + bloques globales
var webMovements = []; // solo pedidos web (orders+order_items) — usado para separar por sucursal
var branches = []; // [{ key, label, type, address?, movements: [], analysis: {...} }]
var activeBranchKey = null;
var ranking12m = null; // { pos, total, unidades }
var percentilLifetime = null; // { pct, pos, total, avgPerMonth, monthsActive, totalUnits }
var _percentilGlobalCache = null; // cache global: [{ cod, avg, ... }]

// Constantes
var DISRUPTIVA_RATIO = 1.5;
var BAJA_MIN_COMPRAS = 2;
var BAJA_MAX_COLS = 5;
var TOP_OFRECER = 15;

// ============================================================
// AUTH GATE
// ============================================================
// Renombrado de checkAuth a avcCheckAuth para evitar pisar admin.js#checkAuth
// (function declarations son hoisted y la ultima gana cuando los dos scripts
// estan en la misma pagina).
async function avcCheckAuth() {
  // En modo embebido (admin.html) o modo cliente (mayorista.html #perfil),
  // ya hubo gate de auth previo (admin.js o script.js). Saltamos check.
  if (AVC_EMBEDDED || AVC_CUSTOMER_MODE) return true;

  var statusEl = document.getElementById("authStatus");
  var sess = await sb.auth.getSession();
  if (sess.error || !sess.data || !sess.data.session) {
    if (statusEl) statusEl.textContent = "Sin sesión. Redirigiendo...";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1200);
    return false;
  }
  var userId = sess.data.session.user.id;
  var adminCheck = await sb
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (adminCheck.error || !adminCheck.data) {
    if (statusEl) statusEl.textContent = "Acceso denegado. Solo admins.";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1500);
    return false;
  }
  document.getElementById("loadingScreen").style.display = "none";
  document.getElementById("appShell").style.display = "block";
  return true;
}

// ============================================================
// HELPERS
// ============================================================
function $(id) {
  return document.getElementById(id);
}

function setStatus(msg, kind) {
  var el = $("busquedaStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className =
    "avc-search-status" + (kind ? " avc-search-status--" + kind : "");
}

function normSuc(s) {
  // lowercase + quitar acentos (combining marks U+0300..U+036F) + colapsar espacios
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var MESES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

function fmtMonthYear(dt) {
  if (!dt) return "";
  var d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return "";
  return MESES[d.getMonth()] + "-" + String(d.getFullYear()).slice(-2);
}

function fmtMonthYearMM(dt) {
  if (!dt) return "";
  var d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return "";
  return String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}

function monthKey(dt) {
  var d = dt instanceof Date ? dt : new Date(dt);
  return d.getFullYear() * 12 + d.getMonth();
}

function fmtNumber(n, dec) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("es-AR", {
    minimumFractionDigits: dec || 0,
    maximumFractionDigits: dec || 0,
  });
}

// ============================================================
// PAGE INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async function () {
  var ok = await avcCheckAuth();
  if (!ok) return;

  var form = $("formBuscar");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var cod = String($("inputCodCliente").value || "").trim();
      if (!cod) return;
      buscarCliente(cod);
    });
  }

  var btnExp = $("btnExportarExcel");
  if (btnExp) btnExp.addEventListener("click", onExportarExcel);

  var btnTot = $("btnReporteTotal");
  if (btnTot) btnTot.addEventListener("click", onReporteTotal);

  // Customer mode (mayorista #perfil): exponemos init + auto-poll para
  // detectar cuando script.js carga el customerProfile.
  if (AVC_CUSTOMER_MODE) {
    var _avcLoaded = false;
    window.avcInitCustomerMode = async function (codCliente) {
      if (!codCliente) return;
      if (
        currentCustomer &&
        String(currentCustomer.cod_cliente) === String(codCliente)
      ) {
        return;
      }
      _avcLoaded = true;
      var es = $("emptyState");
      if (es) {
        es.style.display = "block";
        es.innerHTML =
          '<div style="padding:14px;color:#666;text-align:center;font-size:13px">' +
          "⏳ Cargando tu análisis…</div>";
      }
      try {
        await buscarCliente(String(codCliente));
      } catch (err) {
        console.error("AVC customer init error:", err);
      }
      // Post-check: si no se cargaron branches, mostrar mensaje de error visible
      setTimeout(function () {
        var es2 = $("emptyState");
        var hasContent =
          (currentCustomer && branches && branches.length > 0) || false;
        if (!hasContent && es2) {
          es2.style.display = "block";
          es2.innerHTML =
            '<div style="padding:14px;color:#b00020;background:#fff5f5;' +
            'border:1px solid #ffd1d1;border-radius:10px;font-size:13px;text-align:center">' +
            "⚠️ No se pudo cargar tu análisis. Es posible que aún no tengas " +
            "historial de compras o que los permisos no estén configurados. " +
            "Si seguís viendo esto, avisanos." +
            "</div>";
        }
      }, 200);
    };

    // Auto-poll: si script.js no nos llama (timing), watch customerProfile
    // por hasta 10s y disparamos init solos cuando aparece.
    var pollTries = 0;
    var pollInterval = setInterval(function () {
      pollTries++;
      if (_avcLoaded) {
        clearInterval(pollInterval);
        return;
      }
      var cp = window.__lkCustomerProfile;
      if (cp && cp.cod_cliente) {
        clearInterval(pollInterval);
        window.avcInitCustomerMode(String(cp.cod_cliente));
      } else if (pollTries > 100) {
        // 10s sin customerProfile → mostrar mensaje
        clearInterval(pollInterval);
        var es2 = $("emptyState");
        if (es2)
          es2.textContent =
            "Iniciá sesión para ver tu análisis.";
      }
    }, 100);
  }
});

// buscarCliente debe ser async wrapper para que .catch() funcione (lo es)

// ============================================================
// BÚSQUEDA + CARGA — FASE 4
// ============================================================
async function buscarCliente(codCliente) {
  setStatus("Buscando cliente " + codCliente + "...");
  $("emptyState").style.display = "none";
  $("clienteInfo").style.display = "none";
  $("sucursalTabs").style.display = "none";
  $("sucursalContent").style.display = "none";
  // Toggle ambos botones de exportar (legacy en page-header + nuevo inline)
  var _btnExpReset = $("btnExportarExcel");
  if (_btnExpReset) _btnExpReset.disabled = true;
  var _btnExpInlineReset = $("btnExportarExcelInline");
  if (_btnExpInlineReset) _btnExpInlineReset.disabled = true;
  // Ocultar razón social header mientras busca (se muestra al encontrar)
  var _rsHeaderResetEl = $("clienteRazonSocial");
  if (_rsHeaderResetEl) {
    _rsHeaderResetEl.hidden = true;
    _rsHeaderResetEl.innerHTML = "";
  }

  // reset estado
  currentCustomer = null;
  currentAddresses = [];
  movements = [];
  branches = [];
  activeBranchKey = null;
  ranking12m = null;
  percentilLifetime = null;

  try {
    // 1. Customer
    var custR = await sb
      .from("customers")
      .select("id, cod_cliente, business_name, cuit, mail, dto_vol, vend")
      .eq("cod_cliente", String(codCliente))
      .maybeSingle();
    if (custR.error) throw new Error(custR.error.message);
    if (!custR.data) {
      setStatus("Cliente " + codCliente + " no existe.", "err");
      return;
    }
    currentCustomer = custR.data;
    var _rs = (currentCustomer.business_name || "").trim();
    // Mostrar razón social arriba del input "Código Cliente" + btn Exportar
    // adentro de la misma card (se entiende que exporta el Excel de este cliente)
    var _rsHeaderEl = $("clienteRazonSocial");
    if (_rsHeaderEl) {
      _rsHeaderEl.innerHTML =
        '<span class="avc-rs-label">Razón Social:</span>' +
        '<span class="avc-rs-value">' +
        (_rs || "—") +
        "</span>" +
        '<span class="avc-rs-cod">Cod ' +
        String(currentCustomer.cod_cliente || "") +
        "</span>" +
        '<button type="button" id="btnExportarExcelInline" ' +
        'class="avc-btn avc-btn-primary avc-rs-export">' +
        '<span aria-hidden="true">📊</span> Exportar Excel' +
        "</button>";
      _rsHeaderEl.hidden = false;
      // Wire del botón inline directo al handler de exportar
      var _newExportBtn = document.getElementById("btnExportarExcelInline");
      if (_newExportBtn && !_newExportBtn.__wired) {
        _newExportBtn.addEventListener("click", onExportarExcel);
        _newExportBtn.__wired = true;
      }
    }

    // 2. Addresses
    setStatus("Cargando sucursales...");
    var addrR = await sb
      .from("customer_delivery_addresses")
      .select("slot, label, direccion_entrega, zona_expreso, pending_isis")
      .eq("customer_id", currentCustomer.id)
      .order("slot", { ascending: true });
    if (addrR.error) throw new Error(addrR.error.message);
    currentAddresses = addrR.data || [];

    // 3. Estadística Madre + Productos + Comisiones — SIEMPRE tolerantes a errores
    // (en customer mode pueden fallar por RLS; loadEstadisticaMadre y
    // loadCommissions ya retornan vacío en error, loadProducts y loadWebMovements
    // tiran throw — los wrappamos individualmente para no romper toda la búsqueda).
    setStatus("Cargando catálogo y estadística madre...");
    var settled = await Promise.allSettled([
      loadProducts(),
      loadEstadisticaMadre(),
      loadCommissions(),
    ]);
    settled.forEach(function (res, i) {
      if (res.status === "rejected") {
        var name = ["loadProducts", "loadEstadisticaMadre", "loadCommissions"][i];
        console.warn("[AVC] " + name + " falló:", res.reason);
      }
    });

    // 4. Histórico oficial del cliente (RPC que usa la página Historial)
    setStatus("Cargando historial de compras...");
    try {
      movements = await loadHistory(currentCustomer.cod_cliente);
    } catch (errH) {
      console.warn("[AVC] loadHistory falló:", errH);
      movements = [];
    }

    // 5. Movs web (para poder separar por sucursal en pestañas)
    setStatus("Cargando pedidos web (para sucursales)...");
    try {
      webMovements = await loadWebMovements(currentCustomer.id);
    } catch (errW) {
      console.warn("[AVC] loadWebMovements falló:", errW);
      webMovements = [];
    }

    // 6. Ranking 12m — solo en admin mode (cliente no necesita ver su ranking)
    if (!AVC_CUSTOMER_MODE) {
      setStatus("Calculando ranking...");
      try {
        await computeRanking12m(currentCustomer.id);
      } catch (errR) {
        console.warn("[AVC] computeRanking12m falló:", errR);
      }
      // Percentil lifetime: unidades/mes promedio desde primera compra.
      try {
        await computePercentilLifetime(currentCustomer.cod_cliente);
      } catch (errP) {
        console.warn("[AVC] computePercentilLifetime falló:", errP);
      }
    }

    // 7. Construir branches (Consolidado + 1 por sucursal del cliente)
    branches = buildBranches();

    // 9. Set global de items comprados por el cliente (cualquier sucursal/fuente)
    var globalPurchasedItems = new Set();
    movements.forEach(function (m) {
      globalPurchasedItems.add(m.item_code);
    });

    // 10. Análisis GLOBAL del cliente — Altas / Bajas / Probó1Vez / A Ofrecer
    //     se calculan sobre TODOS los movs y se comparten entre branches.
    //     (Stats/Disruptivas/Evolución sí son por branch.)
    var globalBranch = {
      key: "__global__",
      label: "global",
      type: "consolidated",
      movements: movements,
    };
    var globalAnalysis = computeAnalysis(
      globalBranch,
      globalPurchasedItems,
    );

    branches.forEach(function (br) {
      // Mismo dataset siempre (única branch tras la migración a get_customer_history)
      br.analysis = computeAnalysis(br, globalPurchasedItems);
      // override de secciones globales del cliente (idempotente con la única branch)
      br.analysis.altas = globalAnalysis.altas;
      br.analysis.bajas = globalAnalysis.bajas;
      br.analysis.probo1Vez = globalAnalysis.probo1Vez;
      br.analysis.aOfrecer = globalAnalysis.aOfrecer;
    });

    // 10. Render
    renderClienteInfo();
    renderTabs();
    if (branches.length) {
      activateBranch(branches[0].key);
    }
    $("clienteInfo").style.display = "block";
    $("sucursalTabs").style.display = "flex";
    $("sucursalContent").style.display = "flex";
    // Habilitar ambos botones (legacy + inline)
    var _btnExpDone = $("btnExportarExcel");
    if (_btnExpDone) _btnExpDone.disabled = false;
    var _btnExpInlineDone = $("btnExportarExcelInline");
    if (_btnExpInlineDone) _btnExpInlineDone.disabled = false;

    setStatus(
      "Listo — " +
        movements.length +
        " movimientos cargados, " +
        branches.length +
        " sucursal(es).",
      "ok",
    );
  } catch (err) {
    console.error("buscarCliente error", err);
    setStatus("Error: " + (err.message || err), "err");
  }
}

// ============================================================
// CARGADORES
// ============================================================
async function loadProducts() {
  if (Object.keys(productByCod).length) return;
  var off = 0;
  while (true) {
    var r = await sb
      .from("products")
      .select(
        "id, cod, description, category, subcategory, badge_status, active, uxb, list_price",
      )
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (p) {
      var cod = String(p.cod || "").trim().toUpperCase();
      if (!cod) return;
      productByCod[cod] = {
        id: p.id,
        descripcion: p.description || cod,
        categoria: p.category || p.subcategory || "",
        badge: String(p.badge_status || "").trim().toUpperCase(),
        active: p.active !== false,
        uxb: Number(p.uxb) || 1,
        listPrice: Number(p.list_price) || 0,
      };
      productById[p.id] = cod;
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
}

// Items LOKE excluidos del histórico (mismo set que historial.js)
var EXCLUDED_CODES = new Set([
  "101","103","104","108","110","111","112","113","114","115","116","119","120","121","123","186","193",
]);

// ymToDate: 'YYYY-MM' -> Date al día 15 del mes (centro, evita bordes)
function ymToDate(ym) {
  var s = String(ym || "").trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  return new Date(y, m - 1, 15);
}

async function loadEstadisticaMadre() {
  if (Object.keys(estadisticaMadre).length) return;
  var off = 0;
  while (true) {
    var r = await sb
      .from("estadistica_madre")
      .select(
        "cod, descripcion, categoria, ranking, e_madre_uni_mes, tendencia_uni",
      )
      .range(off, off + 999);
    if (r.error) {
      // tabla puede no existir todavía — log y seguir
      console.warn("estadistica_madre no disponible:", r.error.message);
      return;
    }
    var batch = r.data || [];
    batch.forEach(function (e) {
      var cod = String(e.cod || "").trim().toUpperCase();
      if (!cod) return;
      estadisticaMadre[cod] = e;
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
}

// Carga histórico oficial del cliente desde el RPC que usa la página Historial
// (fuente de verdad — incluye web + ERP, agregado mensual en cajas).
async function loadHistory(codCliente) {
  var r = await sb.rpc("get_customer_history", {
    p_cod_cliente: String(codCliente),
  });
  if (r.error) {
    console.warn("get_customer_history error", r.error);
    return [];
  }
  var rows = r.data || [];
  var movs = [];
  rows.forEach(function (row) {
    var cod = String(row.item_code || "").trim().toUpperCase();
    if (!cod) return;
    if (EXCLUDED_CODES.has(cod)) return;
    var dt = ymToDate(row.ym);
    if (!dt) return;
    var boxes = Number(row.boxes) || 0;
    if (boxes <= 0) return;
    var uxb = (productByCod[cod] && productByCod[cod].uxb) || 1;
    var qty = boxes * uxb;
    // Si products no trae descripción, usar la del row
    if (productByCod[cod] && !productByCod[cod].descripcion) {
      productByCod[cod].descripcion =
        String(row.description || "").trim() || cod;
    }
    movs.push({
      fecha: dt,
      ym: row.ym,
      item_code: cod,
      qty: qty,
      boxes: boxes,
      sucursal: "",
      sucursalRaw: "",
      fuente: "historial",
      orderId: null,
    });
  });
  // ordenar asc
  movs.sort(function (a, b) {
    return a.fecha - b.fecha;
  });
  return movs;
}

// helper: clave de "pedido" para agrupar movs por (orden web única) o (mes calendario para fuentes agregadas)
function _orderKey(m) {
  if (m.fuente === "web" && m.orderId) return "w_" + m.orderId;
  // historial / erp: agrupar por mes calendario
  return (
    "m_" + m.fecha.getFullYear() + "-" + (m.fecha.getMonth() + 1)
  );
}

async function loadWebMovements(customerId) {
  var allOrderIds = [];
  var orderMeta = {}; // id -> { fecha, sucursalRaw, sucursalNorm }
  var off = 0;
  while (true) {
    var r = await sb
      .from("orders")
      .select("id, created_at, sheets_payload")
      .eq("customer_id", customerId)
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (o) {
      var sp = o.sheets_payload || {};
      var sucRaw =
        sp.sucursal_entrega ||
        sp.sucursalEntrega ||
        sp.delivery ||
        sp.delivery_label ||
        "";
      orderMeta[o.id] = {
        fecha: new Date(o.created_at),
        sucursalRaw: sucRaw,
        sucursalNorm: normSuc(sucRaw),
      };
      allOrderIds.push(o.id);
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
  if (!allOrderIds.length) return [];

  var movs = [];
  for (var bi = 0; bi < allOrderIds.length; bi += 200) {
    var slice = allOrderIds.slice(bi, bi + 200);
    var ioff = 0;
    while (true) {
      var ir = await sb
        .from("order_items")
        .select("order_id, product_id, cajas, uxb, is_loke")
        .in("order_id", slice)
        .range(ioff, ioff + 999);
      if (ir.error) throw new Error(ir.error.message);
      var ibatch = ir.data || [];
      ibatch.forEach(function (it) {
        var meta = orderMeta[it.order_id];
        if (!meta) return;
        var cod = productById[it.product_id];
        if (!cod) return;
        var cajas = Number(it.cajas) || 0;
        var uxb = Number(it.uxb) || 0;
        var qty = cajas * uxb;
        if (!qty) return;
        movs.push({
          fecha: meta.fecha,
          item_code: cod,
          qty: qty,
          boxes: cajas,
          sucursal: meta.sucursalNorm,
          sucursalRaw: meta.sucursalRaw,
          fuente: "web",
          orderId: it.order_id,
        });
      });
      if (ibatch.length < 1000) break;
      ioff += 1000;
    }
  }
  return movs;
}

async function loadSalesHistory(codCliente) {
  try {
    var r = await sb.rpc("get_customer_sales_history", {
      p_customer_code: String(codCliente),
    });
    if (r.error) {
      console.warn("get_customer_sales_history error:", r.error.message);
      return [];
    }
    var data = r.data || [];
    var movs = [];
    data.forEach(function (sl) {
      // campos que varían según la implementación del RPC. Intentamos varios alias:
      var cod = String(
        sl.item_code || sl.cod || sl.codigo || sl.product_code || "",
      )
        .trim()
        .toUpperCase();
      if (!cod) return;
      var fecha = sl.fecha || sl.date || sl.invoice_date || sl.fecha_venta;
      if (!fecha) return;
      var d = new Date(fecha);
      if (isNaN(d.getTime())) return;
      var qty = Number(
        sl.unidades || sl.qty || sl.cantidad || sl.quantity || 0,
      );
      if (!qty) return;
      movs.push({
        fecha: d,
        item_code: cod,
        qty: qty,
        sucursal: "", // ERP no tiene sucursal
        sucursalRaw: "",
        fuente: "erp",
        orderId: sl.order_id || sl.invoice_id || null,
      });
    });
    return movs;
  } catch (e) {
    console.warn("loadSalesHistory exc", e);
    return [];
  }
}

async function loadSugerenciasFor(codCliente) {
  try {
    var r = await sb.rpc("sugerencias_cliente", {
      p_customer: String(codCliente),
    });
    if (!r.error) sugerenciasCache = r.data || [];
  } catch (e) {
    sugerenciasCache = [];
  }
}

async function loadNovedades() {
  try {
    var r = await sb.rpc("novedades_marca");
    if (!r.error) novedadesCache = r.data || [];
  } catch (e) {
    novedadesCache = [];
  }
}

async function computeRanking12m(customerId) {
  // Pos del cliente actual entre todos los clientes con compras web últimos 12m por unidades.
  // Cálculo cliente-side (web only) — el ERP no es accesible para todos los clientes vía RPC.
  try {
    var since = new Date();
    since.setMonth(since.getMonth() - 12);
    var sinceISO = since.toISOString();

    // Trae todos los orders 12m con customer_id
    var allOrders = [];
    var off = 0;
    while (true) {
      var r = await sb
        .from("orders")
        .select("id, customer_id")
        .gte("created_at", sinceISO)
        .range(off, off + 999);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      allOrders = allOrders.concat(batch);
      if (batch.length < 1000) break;
      off += 1000;
    }
    if (!allOrders.length) return;
    var ordCust = {};
    allOrders.forEach(function (o) {
      ordCust[o.id] = o.customer_id;
    });
    var orderIds = allOrders.map(function (o) {
      return o.id;
    });

    var unitsByCust = {};
    for (var bi = 0; bi < orderIds.length; bi += 200) {
      var slice = orderIds.slice(bi, bi + 200);
      var ioff = 0;
      while (true) {
        var ir = await sb
          .from("order_items")
          .select("order_id, cajas, uxb")
          .in("order_id", slice)
          .range(ioff, ioff + 999);
        if (ir.error) throw new Error(ir.error.message);
        var ibatch = ir.data || [];
        ibatch.forEach(function (it) {
          var cid = ordCust[it.order_id];
          if (!cid) return;
          var u = (Number(it.cajas) || 0) * (Number(it.uxb) || 0);
          unitsByCust[cid] = (unitsByCust[cid] || 0) + u;
        });
        if (ibatch.length < 1000) break;
        ioff += 1000;
      }
    }
    var ranking = Object.keys(unitsByCust).map(function (cid) {
      return { customer_id: cid, units: unitsByCust[cid] };
    });
    ranking.sort(function (a, b) {
      return b.units - a.units;
    });
    var pos = ranking.findIndex(function (x) {
      return x.customer_id === customerId;
    });
    ranking12m = {
      pos: pos === -1 ? null : pos + 1,
      total: ranking.length,
      unidades: unitsByCust[customerId] || 0,
    };
  } catch (e) {
    console.warn("computeRanking12m error", e);
    ranking12m = null;
  }
}

// ============================================================
// PERCENTIL LIFETIME — promedio unidades/mes desde primera compra
// Comparado contra TODOS los clientes. Cache global (1x por sesión admin).
// ============================================================
async function computePercentilLifetime(codClienteActual) {
  percentilLifetime = null;
  var codActual = String(codClienteActual || "").trim();
  if (!codActual) return;

  // Si ya tenemos el cache global, usarlo
  var ranked = _percentilGlobalCache;
  if (!ranked) {
    try {
      // 1) Cargar v_customer_item_month (cod_cliente, ym, item_code, boxes)
      var allRows = [];
      var pp = 0;
      while (true) {
        var r = await sb
          .from("v_customer_item_month")
          .select("cod_cliente, ym, item_code, boxes")
          .range(pp * 1000, (pp + 1) * 1000 - 1);
        if (r.error) throw r.error;
        var batch = r.data || [];
        allRows = allRows.concat(batch);
        if (batch.length < 1000) break;
        pp++;
        if (pp > 500) break;
      }

      // 2) Mapa uxb por cod (de productByCod / productsCache)
      var uxbByCod = {};
      var prodCache = (typeof productByCod === "object" && productByCod) || {};
      Object.keys(prodCache).forEach(function (k) {
        var p = prodCache[k];
        if (p && p.uxb != null) uxbByCod[String(k).toUpperCase()] = Number(p.uxb) || 0;
      });

      // 3) Agregar por cliente: total unidades + primer y último ym
      var byCust = {};
      allRows.forEach(function (row) {
        var cod = String(row.cod_cliente || "").trim();
        if (!cod) return;
        var item = String(row.item_code || "").trim().toUpperCase();
        var uxb = uxbByCod[item] || 1;
        var units = (Number(row.boxes) || 0) * uxb;
        if (units <= 0) return;
        var ym = String(row.ym || "");
        if (!byCust[cod]) byCust[cod] = { totalUnits: 0, firstYm: ym, lastYm: ym };
        var b = byCust[cod];
        b.totalUnits += units;
        if (ym < b.firstYm) b.firstYm = ym;
        if (ym > b.lastYm) b.lastYm = ym;
      });

      // 4) Calcular avg/mes para cada cliente
      function monthsBetween(ymStart, ymEnd) {
        var ms = ymStart.match(/^(\d{4})-(\d{2})/);
        var me = ymEnd.match(/^(\d{4})-(\d{2})/);
        if (!ms || !me) return 1;
        var diff = (Number(me[1]) - Number(ms[1])) * 12 + (Number(me[2]) - Number(ms[2])) + 1;
        return Math.max(diff, 1);
      }
      ranked = Object.keys(byCust).map(function (cod) {
        var b = byCust[cod];
        // mesesActivos = desde primera compra hasta HOY (no hasta última)
        // así clientes que dejaron de comprar penalizan
        var nowYm =
          new Date().getFullYear() + "-" +
          String(new Date().getMonth() + 1).padStart(2, "0");
        var months = monthsBetween(b.firstYm, nowYm);
        return {
          cod: cod,
          totalUnits: b.totalUnits,
          monthsActive: months,
          avgPerMonth: b.totalUnits / months,
          firstYm: b.firstYm,
          lastYm: b.lastYm,
        };
      });
      ranked.sort(function (a, b) { return b.avgPerMonth - a.avgPerMonth; });
      _percentilGlobalCache = ranked;
      console.log("[AVC] percentil cache built: " + ranked.length + " clientes");
    } catch (e) {
      console.warn("computePercentilLifetime build cache error", e);
      return;
    }
  }

  // 5) Encontrar al cliente actual y calcular percentil
  var pos = ranked.findIndex(function (x) { return x.cod === codActual; });
  if (pos === -1) return;
  var me = ranked[pos];
  // Percentil: 100 = mejor, 0 = peor.
  // pct = (total - rank) / total * 100  (rank desde 0)
  var pct = Math.round(((ranked.length - pos) / ranked.length) * 100);
  percentilLifetime = {
    pct: pct,
    pos: pos + 1,
    total: ranked.length,
    avgPerMonth: me.avgPerMonth,
    monthsActive: me.monthsActive,
    totalUnits: me.totalUnits,
  };
}

// ============================================================
// BRANCHES — agrupa movimientos por sucursal
// ============================================================
function buildBranches() {
  var list = [];

  // Consolidado: histórico oficial (todas las compras del cliente, todas las fuentes)
  list.push({
    key: "__consolidated__",
    label: "Total",
    type: "consolidated",
    address: null,
    movements: movements.slice(),
  });

  // 1 pestaña por sucursal — usa solo pedidos WEB filtrados por dirección/label/slot.
  // (El histórico oficial ERP no distingue sucursal, así que estas pestañas
  //  reflejan únicamente la actividad web por delivery address.)
  function addrCandidates(addr) {
    var c = [];
    if (addr.label) c.push(normSuc(addr.label));
    if (addr.direccion_entrega) c.push(normSuc(addr.direccion_entrega));
    if (addr.slot != null) c.push(normSuc(String(addr.slot)));
    return c.filter(Boolean);
  }
  currentAddresses.forEach(function (addr) {
    var cands = addrCandidates(addr);
    var movs = webMovements.filter(function (m) {
      return m.sucursal && cands.indexOf(m.sucursal) !== -1;
    });
    // Pestaña corta: solo label si existe, sino dirección, sino slot
    var label =
      (addr.label && String(addr.label).trim()) ||
      (addr.direccion_entrega && String(addr.direccion_entrega).trim()) ||
      "Sucursal " + addr.slot;
    list.push({
      key: "addr_" + addr.slot,
      label: label,
      type: "branch",
      address: addr,
      movements: movs,
    });
  });

  // Pedidos web cuyo sucursal_entrega no matcheó ninguna address registrada
  var matchedNorm = new Set();
  currentAddresses.forEach(function (a) {
    addrCandidates(a).forEach(function (n) {
      matchedNorm.add(n);
    });
  });
  var orphanMovs = webMovements.filter(function (m) {
    return m.sucursal && !matchedNorm.has(m.sucursal);
  });
  if (orphanMovs.length) {
    list.push({
      key: "__orphans__",
      label: "Sin asignar",
      type: "branch",
      address: null,
      movements: orphanMovs,
    });
  }

  return list;
}

// ============================================================
// COMPUTE ANALYSIS — FASE 5
// ============================================================
function computeAnalysis(branch, globalPurchased) {
  var movs = branch.movements;

  // index por item_code y por fecha de pedido (mes)
  var byItem = {}; // cod -> [{ fecha, qty, ... }]
  movs.forEach(function (m) {
    if (!byItem[m.item_code]) byItem[m.item_code] = [];
    byItem[m.item_code].push(m);
  });
  Object.keys(byItem).forEach(function (cod) {
    byItem[cod].sort(function (a, b) {
      return a.fecha - b.fecha;
    });
  });

  // Pedidos únicos del cliente: web → 1 por orderId; historial/erp → 1 por mes calendario
  var ordersMap = {}; // ordKey -> { fecha, items: {cod: qty}, itemsBoxes: {cod: boxes} }
  movs.forEach(function (m) {
    var key = _orderKey(m);
    if (!ordersMap[key]) {
      ordersMap[key] = { fecha: m.fecha, items: {}, itemsBoxes: {} };
    }
    ordersMap[key].items[m.item_code] =
      (ordersMap[key].items[m.item_code] || 0) + (Number(m.qty) || 0);
    ordersMap[key].itemsBoxes[m.item_code] =
      (ordersMap[key].itemsBoxes[m.item_code] || 0) +
      (Number(m.boxes) || 0);
  });
  var orders = Object.keys(ordersMap)
    .map(function (k) {
      return ordersMap[k];
    })
    .sort(function (a, b) {
      return a.fecha - b.fecha;
    });

  // ---------- ALTAS (primera vez ever en esta branch) ----------
  var altas = Object.keys(byItem).map(function (cod) {
    var first = byItem[cod][0];
    var info =
      productByCod[cod] ||
      estadisticaMadre[cod] || { descripcion: cod, categoria: "" };
    return {
      cod: cod,
      descripcion: info.descripcion,
      categoria: info.categoria || "",
      fecha: first.fecha,
      qty: first.qty,
    };
  });
  altas.sort(function (a, b) {
    return b.fecha - a.fecha;
  });

  // ---------- BAJAS + PROBÓ 1 VEZ ----------
  var bajas = [];
  var probo1Vez = [];

  Object.keys(byItem).forEach(function (cod) {
    var compras = byItem[cod];
    var info =
      productByCod[cod] ||
      estadisticaMadre[cod] || { descripcion: cod, categoria: "" };

    // contar pedidos únicos donde aparece el item
    var pedidosConItem = new Set();
    compras.forEach(function (c) {
      var key =
        c.fuente === "web" && c.orderId
          ? "w_" + c.orderId
          : "erp_" + c.fecha.toISOString().slice(0, 10);
      pedidosConItem.add(key);
    });

    if (pedidosConItem.size < BAJA_MIN_COMPRAS) {
      probo1Vez.push({
        cod: cod,
        descripcion: info.descripcion,
        categoria: info.categoria || "",
        mes: fmtMonthYear(compras[0].fecha),
        fecha: compras[0].fecha,
        qty: compras[0].qty,
      });
      return;
    }

    var primera = compras[0].fecha;
    var ultima = compras[compras.length - 1].fecha;

    // pedidos posteriores a la última compra del item
    var posteriores = orders.filter(function (o) {
      return o.fecha > ultima;
    });
    if (!posteriores.length) return; // último pedido fue con el item; no hay bajas que reportar

    // si en algún posterior reaparece, sale de Bajas (no debería pasar porque "ultima" sería más nueva, pero por las dudas)
    var reaparece = posteriores.some(function (o) {
      return o.items[cod];
    });
    if (reaparece) return;

    // agrupar posteriores por mes-año, máx 5
    var seenMonths = new Set();
    var bajasMeses = [];
    for (var i = 0; i < posteriores.length && bajasMeses.length < BAJA_MAX_COLS; i++) {
      var mk = monthKey(posteriores[i].fecha);
      if (seenMonths.has(mk)) continue;
      seenMonths.add(mk);
      bajasMeses.push(fmtMonthYear(posteriores[i].fecha));
    }

    if (!bajasMeses.length) return;

    var ultimaQty = compras[compras.length - 1].qty;
    var sumQty = compras.reduce(function (acc, c) {
      return acc + (Number(c.qty) || 0);
    }, 0);
    var promQty = compras.length ? sumQty / compras.length : 0;

    bajas.push({
      cod: cod,
      descripcion: info.descripcion,
      plazoCompro:
        fmtMonthYearMM(primera) + " - " + fmtMonthYearMM(ultima),
      bajas: bajasMeses,
      ultimaCompra: ultima,
      ultimaQty: ultimaQty,
      promedioQty: promQty,
      comprasCount: pedidosConItem.size,
    });
  });

  // Orden: más bajas primero (items que dejaron de comprarse hace más tiempo).
  // Tiebreaker: última compra más reciente arriba.
  bajas.sort(function (a, b) {
    var na = (a.bajas || []).length;
    var nb = (b.bajas || []).length;
    if (nb !== na) return nb - na;
    return b.ultimaCompra - a.ultimaCompra;
  });
  probo1Vez.sort(function (a, b) {
    return b.fecha - a.fecha;
  });

  // ---------- A OFRECER (top 15) ----------
  // Excluye TODO lo comprado por el cliente (cualquier sucursal),
  // no solo lo del branch actual.
  var excludedItems = globalPurchased || new Set(Object.keys(byItem));
  var aOfrecer = computeAOfrecer(excludedItems);

  // ---------- STATS ----------
  var stats = computeStats(orders, branch);

  // ---------- DISRUPTIVAS (última compra) ----------
  var disruptivas = [];
  if (orders.length) {
    var ultima = orders[orders.length - 1];
    Object.keys(ultima.items).forEach(function (cod) {
      var qtyAct = ultima.items[cod];
      var hist = byItem[cod] || [];
      // promedio histórico = avg de pedidos anteriores donde aparece (excluyendo este)
      var prevPedidos = []; // qty agregado por pedido distinto de este
      var seenKey = new Set();
      hist.forEach(function (m) {
        var k =
          m.fuente === "web" && m.orderId
            ? "w_" + m.orderId
            : "erp_" + m.fecha.toISOString().slice(0, 10);
        if (m.fecha >= ultima.fecha) return;
        if (seenKey.has(k)) {
          prevPedidos[prevPedidos.length - 1] += m.qty;
        } else {
          seenKey.add(k);
          prevPedidos.push(m.qty);
        }
      });
      if (!prevPedidos.length) return;
      var prom =
        prevPedidos.reduce(function (a, b) {
          return a + b;
        }, 0) / prevPedidos.length;
      if (qtyAct >= DISRUPTIVA_RATIO * prom) {
        var info =
          productByCod[cod] ||
          estadisticaMadre[cod] || { descripcion: cod, categoria: "" };
        disruptivas.push({
          cod: cod,
          descripcion: info.descripcion,
          qtyActual: qtyAct,
          promedio: prom,
          ratio: qtyAct / prom,
        });
      }
    });
    disruptivas.sort(function (a, b) {
      return b.ratio - a.ratio;
    });
  }

  // ---------- EVOLUCIÓN MENSUAL 5 AÑOS ----------
  var evolucion = computeEvolucion(movs);

  return {
    altas: altas,
    bajas: bajas,
    probo1Vez: probo1Vez,
    aOfrecer: aOfrecer,
    stats: stats,
    disruptivas: disruptivas,
    evolucion: evolucion,
    ordersCount: orders.length,
  };
}

function computeAOfrecer(excludedSet) {
  // Productos NUEVOS del catálogo (badge_status === "NUEVO") activos,
  // excluyendo los items que el cliente ya compró (set provisto, normalmente global).
  var excluded = excludedSet instanceof Set ? excludedSet : new Set();

  var arr = [];
  Object.keys(productByCod).forEach(function (cod) {
    var p = productByCod[cod];
    if (!p) return;
    if (p.badge !== "NUEVO") return;
    if (p.active === false) return;
    if (excluded.has(cod)) return;
    var em = estadisticaMadre[cod];
    arr.push({
      cod: cod,
      descripcion: p.descripcion || cod,
      categoria: p.categoria || (em ? em.categoria : "") || "",
      ranking: em ? em.ranking : null,
      e_madre: em ? em.e_madre_uni_mes : null,
    });
  });

  // ordenar por ranking estadística madre asc (null al final), luego descripción
  arr.sort(function (a, b) {
    var ra = a.ranking == null ? 1e9 : a.ranking;
    var rb = b.ranking == null ? 1e9 : b.ranking;
    if (ra !== rb) return ra - rb;
    return String(a.descripcion).localeCompare(String(b.descripcion));
  });
  return arr.slice(0, TOP_OFRECER);
}

// ============================================================
// ACUERDO — índice precio_lista / precio_neto
// Fórmula: cascada del Excel "Formato Calculo Acuerdo"
//   bruto = (1 - dto_vol) * (1 - dto_pago) * (1 - dto_web)
//   neto  = bruto * (1 - flete) * (1 - comision) * (1 - costo_fin)
//   acuerdo = 1 / neto
// dto_vol = customers.dto_vol (por cliente)
// comision = customer_commissions.rate (por cliente). Sin valor o cliente fuera de tabla → 0%.
// resto: tasas fijas del formato (ajustar acá si cambian)
// ============================================================
var ACUERDO_RATES = {
  dtoPago: 0.25,
  dtoWeb: 0.02,
  flete: 0.015,
  costoFin: 0,
  comisionFallback: 0, // cliente sin valor en planilla → 0% por ahora
};

// Cache cargado una vez por sesión: cod_cliente (string) -> rate (number) | null
var commissionByCod = null;
async function loadCommissions() {
  if (commissionByCod) return commissionByCod;
  commissionByCod = {};
  var r = await sb
    .from("customer_commissions")
    .select("cod_cliente, rate")
    .limit(5000);
  if (r.error) {
    console.warn("loadCommissions error", r.error.message);
    return commissionByCod;
  }
  (r.data || []).forEach(function (row) {
    var k = String(row.cod_cliente);
    var v = row.rate == null ? null : Number(row.rate);
    commissionByCod[k] = v;
  });
  return commissionByCod;
}

function comisionForCustomer(c) {
  if (!c || !commissionByCod) return ACUERDO_RATES.comisionFallback;
  var key = String(c.cod_cliente || "");
  var v = commissionByCod[key];
  if (v == null || !isFinite(v)) return ACUERDO_RATES.comisionFallback;
  return v;
}

function computeAcuerdo(customer) {
  if (!customer) return null;
  var dtoVol = Number(customer.dto_vol || 0);
  if (!isFinite(dtoVol)) dtoVol = 0;
  if (dtoVol > 1) dtoVol = dtoVol / 100; // normalizar si viniera como % crudo
  var comision = comisionForCustomer(customer);
  var r = ACUERDO_RATES;
  var bruto = (1 - dtoVol) * (1 - r.dtoPago) * (1 - r.dtoWeb);
  var neto = bruto * (1 - r.flete) * (1 - comision) * (1 - r.costoFin);
  if (neto <= 0) return null;
  return {
    indice: 1 / neto, // ej 1.51
    netoPct: neto, // ej 0.6624 = 66.24% de la lista
    descuentoTotalPct: 1 - neto, // ej 0.3376 = 33.76% off lista
    dtoVol: dtoVol,
    comision: comision,
  };
}

// ============================================================
// FRECUENCIA ALERT — flag cliente que se "sale" de su frecuencia de compra
//   level=null   : insuficientes pedidos / sin freq / al día
//   level='due'  : pasó >= 1× freq desde última compra (esperando pedido)
//   level='overdue': pasó >= 1.5× freq (atrasado)
// Mín. 3 pedidos para considerar la freq confiable.
// ============================================================
var FREQ_ALERT_DUE_RATIO = 1.0;
var FREQ_ALERT_OVERDUE_RATIO = 1.5;
var FREQ_ALERT_MIN_ORDERS = 3;

function computeFrequencyAlert(s) {
  if (!s || !s.frecuenciaMeses || !s.ultimaCompra) return null;
  if ((s.pedidos || 0) < FREQ_ALERT_MIN_ORDERS) return null;
  var nowMs = Date.now();
  var last = s.ultimaCompra instanceof Date ? s.ultimaCompra.getTime() : 0;
  if (!last) return null;
  var monthsSinceLast = (nowMs - last) / (1000 * 60 * 60 * 24 * 30.4375);
  if (monthsSinceLast <= 0) return null;
  var ratio = monthsSinceLast / s.frecuenciaMeses;
  var level = null;
  if (ratio >= FREQ_ALERT_OVERDUE_RATIO) level = "overdue";
  else if (ratio >= FREQ_ALERT_DUE_RATIO) level = "due";
  if (!level) return null;
  return {
    level: level,
    monthsSinceLast: monthsSinceLast,
    freq: s.frecuenciaMeses,
    ratio: ratio,
  };
}

function computeStats(orders, branch) {
  if (!orders.length) {
    return {
      pedidos: 0,
      frecuenciaMeses: null,
      promCajas: null,
      promUnidades: null,
      acuerdo: null,
      ranking: branch.type === "consolidated" ? ranking12m : null,
    };
  }

  // frecuencia: meses promedio entre pedidos consecutivos.
  // Si el cliente tiene MUCHOS pedidos (>20), usar solo los últimos 2 años
  // para que la frecuencia refleje su comportamiento actual (no histórico
  // que puede tener años de menor actividad / etapas distintas).
  var freq = null;
  if (orders.length >= 2) {
    var ordersForFreq = orders;
    if (orders.length > 20) {
      var twoYearsAgo = Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000;
      var recent = orders.filter(function (o) {
        return o.fecha.getTime() >= twoYearsAgo;
      });
      // Usar el subset si quedan al menos 2 pedidos; sino mantener el full.
      if (recent.length >= 2) ordersForFreq = recent;
    }
    var diffs = [];
    for (var i = 1; i < ordersForFreq.length; i++) {
      var ms = ordersForFreq[i].fecha - ordersForFreq[i - 1].fecha;
      diffs.push(ms / (1000 * 60 * 60 * 24 * 30.4375));
    }
    freq =
      diffs.reduce(function (a, b) {
        return a + b;
      }, 0) / diffs.length;
  }

  // promedio CAJAS por pedido + total unidades (referencia)
  var totalU = 0;
  var totalB = 0;
  orders.forEach(function (o) {
    Object.keys(o.items).forEach(function (cod) {
      totalU += o.items[cod];
    });
    Object.keys(o.itemsBoxes || {}).forEach(function (cod) {
      totalB += o.itemsBoxes[cod];
    });
  });
  var promCajas = totalB / orders.length;
  var promUni = totalU / orders.length;

  return {
    pedidos: orders.length,
    frecuenciaMeses: freq,
    promCajas: promCajas,
    promUnidades: promUni,
    totalCajas: totalB,
    totalUnidades: totalU,
    acuerdo: null,
    ranking: branch.type === "consolidated" ? ranking12m : null,
    primeraCompra: orders[0].fecha,
    ultimaCompra: orders[orders.length - 1].fecha,
  };
}

function computeEvolucion(movs) {
  // Ventana: desde la PRIMERA compra del cliente hasta el mes actual.
  // (Antes era fijo en 60 meses → ocultaba historial de clientes con +5 años.)
  var ahora = new Date();
  var endKey = ahora.getFullYear() * 12 + ahora.getMonth();
  var bucketU = {};
  var bucketM = {};
  var minKey = null;
  movs.forEach(function (m) {
    var k = m.fecha.getFullYear() * 12 + m.fecha.getMonth();
    if (minKey === null || k < minKey) minKey = k;
    var qty = Number(m.qty) || 0;
    bucketU[k] = (bucketU[k] || 0) + qty;
    var price =
      (productByCod[m.item_code] && productByCod[m.item_code].listPrice) || 0;
    bucketM[k] = (bucketM[k] || 0) + qty * price;
  });
  // Sin movs → ventana de 12 meses como fallback razonable
  var startKey = minKey !== null ? minKey : endKey - 11;
  var rows = [];
  for (var k = endKey; k >= startKey; k--) {
    var year = Math.floor(k / 12);
    var mon = k % 12;
    rows.push({
      mes: MESES[mon] + "-" + String(year).slice(-2),
      year: year,
      mon: mon,
      unidades: bucketU[k] || 0,
      monto: bucketM[k] || 0,
    });
  }
  return rows;
}

// ============================================================
// RENDER
// ============================================================
function renderClienteInfo() {
  var c = currentCustomer;
  var info = $("clienteInfo");
  if (!c) {
    info.style.display = "none";
    return;
  }
  // Métricas claras del cliente:
  //  - Artículos distintos: cantidad de cods únicos en todo el histórico
  //  - Meses con compra: meses calendario donde compró algo (cualquier item)
  var itemsSet = new Set();
  var monthSet = new Set();
  movements.forEach(function (m) {
    itemsSet.add(m.item_code);
    monthSet.add(m.fecha.getFullYear() + "-" + (m.fecha.getMonth() + 1));
  });
  // Badge de alerta de frecuencia (consolidado)
  var alertBadge = "";
  var consolidated = branches.find(function (b) {
    return b.type === "consolidated";
  });
  if (consolidated && consolidated.analysis && consolidated.analysis.stats) {
    var fa = computeFrequencyAlert(consolidated.analysis.stats);
    if (fa) {
      var cls =
        fa.level === "overdue"
          ? "avc-alert-badge avc-alert-badge--danger"
          : "avc-alert-badge avc-alert-badge--warn";
      var icon = fa.level === "overdue" ? "🚨" : "⚠️";
      var label =
        fa.level === "overdue" ? "ATRASADO" : "ESPERANDO PEDIDO";
      var detail =
        "últ. hace " +
        fmtNumber(fa.monthsSinceLast, 1) +
        " m (frecuencia " +
        fmtNumber(fa.freq, 1) +
        " m)";
      alertBadge =
        '<span class="' +
        cls +
        '" title="' +
        escHtml(detail) +
        '">' +
        icon +
        " " +
        label +
        " · " +
        escHtml(detail) +
        "</span> ";
    }
  }

  info.innerHTML =
    '<div class="avc-info-card">' +
    alertBadge +
    "<strong>" +
    escHtml(c.business_name || "") +
    "</strong>" +
    (c.cuit ? " — CUIT " + escHtml(c.cuit) : "") +
    (c.mail ? " — " + escHtml(c.mail) : "") +
    " — Sucursales registradas: " +
    currentAddresses.length +
    " — Artículos distintos: " +
    itemsSet.size +
    " — Meses con compra: " +
    monthSet.size +
    "</div>";
}

function renderTabs() {
  var tabs = $("sucursalTabs");
  tabs.innerHTML = branches
    .map(function (br) {
      var ds = new Set();
      br.movements.forEach(function (m) {
        ds.add(m.item_code);
      });
      // tooltip extendido: incluye dirección si la tiene
      var tooltipParts = [ds.size + " artículos distintos"];
      if (br.address) {
        if (br.address.label) tooltipParts.push("Label: " + br.address.label);
        if (br.address.direccion_entrega)
          tooltipParts.push("Dirección: " + br.address.direccion_entrega);
      }
      return (
        '<button class="avc-tab" data-key="' +
        escHtml(br.key) +
        '" title="' +
        escHtml(tooltipParts.join(" • ")) +
        '">' +
        escHtml(br.label) +
        " (" +
        ds.size +
        ")</button>"
      );
    })
    .join("");
  tabs.querySelectorAll(".avc-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      activateBranch(btn.dataset.key);
    });
  });
}

function activateBranch(key) {
  activeBranchKey = key;
  $("sucursalTabs")
    .querySelectorAll(".avc-tab")
    .forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.key === key);
    });
  var br = branches.find(function (b) {
    return b.key === key;
  });
  if (!br) return;
  renderBranchContent(br);
}

function renderBranchContent(br) {
  var cont = $("sucursalContent");
  var a = br.analysis;
  var html = "";

  // STATS
  html += renderStatsBlock(br, a.stats);

  // ALTAS (collapsible)
  html += renderTableBlock(
    "Altas (primera compra)",
    a.altas,
    [
      { key: "descripcion", label: "Descripción" },
      { key: "categoria", label: "Categoría" },
      {
        key: "fecha",
        label: "1ra Compra",
        fmt: function (v) {
          return fmtMonthYear(v);
        },
      },
      {
        key: "qty",
        label: "Unidades",
        cls: "num",
        fmt: function (v) {
          return fmtNumber(v);
        },
      },
    ],
    null,
    true,
  );

  // BAJAS (collapsible)
  html += renderBajasBlock(a.bajas, true);

  // PROBÓ 1 VEZ (collapsible)
  html += renderTableBlock(
    "Probó solo 1 vez",
    a.probo1Vez,
    [
      { key: "descripcion", label: "Descripción" },
      { key: "mes", label: "Mes/Año" },
      {
        key: "qty",
        label: "Unidades",
        cls: "num",
        fmt: function (v) {
          return fmtNumber(v);
        },
      },
    ],
    "Items con una sola compra histórica.",
    true,
  );

  // A OFRECER (collapsible) — Top N productos NUEVOS del catálogo no comprados
  // SOLO admin: en customer mode no se muestra (sugerencias internas).
  if (!AVC_CUSTOMER_MODE) {
    html += renderTableBlock(
      "A Ofrecer (Top " + TOP_OFRECER + " Nuevos)",
      a.aOfrecer,
      [
        { key: "descripcion", label: "Descripción" },
        { key: "categoria", label: "Categoría" },
        {
          key: "ranking",
          label: "Ranking Madre",
          cls: "num",
          fmt: function (v) {
            return v == null ? "—" : v;
          },
        },
        {
          key: "e_madre",
          label: "E.Madre Uni/Mes",
          cls: "num",
          fmt: function (v) {
            return v == null ? "—" : fmtNumber(v);
          },
        },
      ],
      "Productos marcados NUEVO en el catálogo que el cliente todavía no compró.",
      true,
    );
  }

  // DISRUPTIVAS
  if (a.disruptivas.length) {
    html += renderDisruptivasBlock(a.disruptivas);
  }

  // EVOLUCIÓN (gráfico)
  html += renderEvolucionBlock(a.evolucion);

  cont.innerHTML = html;

  // Inicializar charts después de insertar el HTML
  initEvoCharts(cont);

  // Re-inicializar el chart cuando se abre el details (Chart.js puede dimensionar mal si arranca oculto)
  cont.querySelectorAll("details.avc-collapsible").forEach(function (det) {
    det.addEventListener(
      "toggle",
      function () {
        if (det.open) initEvoCharts(det);
      },
      { once: false },
    );
  });
}

function wrapCollapsible(title, count, bodyHtml, opts) {
  opts = opts || {};
  var openAttr = opts.open ? " open" : "";
  var bodyCls =
    "avc-block-body" + (opts.bodyClass ? " " + opts.bodyClass : "");
  return (
    '<details class="avc-block avc-collapsible"' +
    openAttr +
    ">" +
    '<summary class="avc-block-head">' +
    '<span class="avc-caret" aria-hidden="true">▸</span>' +
    '<h3 class="avc-block-title">' +
    escHtml(title) +
    "</h3>" +
    (count != null
      ? '<span class="avc-block-count">' + escHtml(count) + "</span>"
      : "") +
    "</summary>" +
    '<div class="' +
    bodyCls +
    '">' +
    bodyHtml +
    "</div></details>"
  );
}

function renderStatsBlock(br, s) {
  var cards = [];
  cards.push(stat("Pedidos", fmtNumber(s.pedidos)));
  var freqAlert = computeFrequencyAlert(s);
  var freqValue =
    s.frecuenciaMeses == null ? "—" : fmtNumber(s.frecuenciaMeses, 1) + " m";
  var freqSub = "meses entre pedidos";
  var freqOpts = {};
  if (freqAlert) {
    freqSub =
      "últ. hace " +
      fmtNumber(freqAlert.monthsSinceLast, 1) +
      " m · esperaba cada " +
      fmtNumber(freqAlert.freq, 1) +
      " m";
    if (freqAlert.level === "overdue") {
      freqOpts = { tone: "danger", icon: "🚨" };
    } else {
      freqOpts = { tone: "warn", icon: "⚠️" };
    }
  }
  cards.push(stat("Frecuencia", freqValue, freqSub, freqOpts));
  cards.push(
    stat(
      "Promedio cajas",
      s.promCajas == null ? "—" : fmtNumber(Math.round(s.promCajas)),
      "por pedido",
    ),
  );
  if (br.type === "consolidated" && s.ranking) {
    cards.push(
      stat(
        "Ranking 12m",
        s.ranking.pos != null ? "#" + s.ranking.pos : "—",
        "de " +
          (s.ranking.total || 0) +
          " — " +
          fmtNumber(s.ranking.unidades) +
          " uni",
      ),
    );
  }
  // Percentil lifetime (avg unidades/mes desde primera compra vs todos)
  if (
    br.type === "consolidated" &&
    !AVC_CUSTOMER_MODE &&
    typeof percentilLifetime !== "undefined" &&
    percentilLifetime
  ) {
    var pl = percentilLifetime;
    var tone = pl.pct >= 80 ? "good" : pl.pct >= 50 ? "" : pl.pct >= 20 ? "warn" : "danger";
    var icon = pl.pct >= 80 ? "🏆" : pl.pct >= 50 ? "" : pl.pct >= 20 ? "⚠️" : "🚨";
    var opts = {};
    if (tone === "good") opts = { icon: icon };
    else if (tone === "warn") opts = { tone: "warn", icon: icon };
    else if (tone === "danger") opts = { tone: "danger", icon: icon };
    cards.push(
      stat(
        "Percentil",
        "P" + pl.pct,
        "#" + pl.pos + " de " + pl.total + " · " +
          fmtNumber(Math.round(pl.avgPerMonth)) + " uni/mes (" +
          pl.monthsActive + "m)",
        opts,
      ),
    );
  }
  // Acuerdo: solo visible para admin (NO en customer mode dentro de mayorista).
  var ac = !AVC_CUSTOMER_MODE ? computeAcuerdo(currentCustomer) : null;
  if (ac) {
    var dvPct = ac.dtoVol * 100;
    var comPct = ac.comision * 100;
    var offPct = ac.descuentoTotalPct * 100;
    cards.push(
      stat(
        "Acuerdo",
        fmtNumber(ac.indice, 2),
        "DV " +
          fmtNumber(dvPct, dvPct % 1 === 0 ? 0 : 1) +
          "% · Com " +
          fmtNumber(comPct, comPct % 1 === 0 ? 0 : 1) +
          "% · " +
          fmtNumber(offPct, 1) +
          "% s/lista",
      ),
    );
  } else if (!AVC_CUSTOMER_MODE) {
    cards.push(stat("Acuerdo", "—", "sin datos"));
  }
  if (s.primeraCompra && s.ultimaCompra) {
    cards.push(
      stat(
        "Plazo Compras",
        fmtMonthYear(s.primeraCompra) + " — " + fmtMonthYear(s.ultimaCompra),
        "primera → última",
      ),
    );
  } else if (s.primeraCompra) {
    cards.push(stat("Primera compra", fmtMonthYear(s.primeraCompra)));
  } else if (s.ultimaCompra) {
    cards.push(stat("Última compra", fmtMonthYear(s.ultimaCompra)));
  }

  var body = '<div class="avc-stats-grid">' + cards.join("") + "</div>";
  return wrapCollapsible("Estadísticas", null, body, { open: true });
}

function stat(label, value, sub, opts) {
  opts = opts || {};
  var cls = "avc-stat-card";
  if (opts.tone === "warn") cls += " avc-stat-card--warn";
  else if (opts.tone === "danger") cls += " avc-stat-card--danger";
  var icon = "";
  if (opts.icon) {
    icon = '<span class="avc-stat-icon" aria-hidden="true">' + opts.icon + "</span> ";
  }
  return (
    '<div class="' +
    cls +
    '">' +
    '<div class="avc-stat-label">' +
    icon +
    escHtml(label) +
    "</div>" +
    '<div class="avc-stat-value">' +
    escHtml(value) +
    "</div>" +
    (sub
      ? '<div class="avc-stat-sub">' + escHtml(sub) + "</div>"
      : "") +
    "</div>"
  );
}

function renderTableBlock(title, rows, cols, hint, _legacy, opts) {
  // Siempre collapsible.
  opts = opts || {};
  var tableClass = "avc-table" + (opts.dense ? " avc-table--dense" : "");
  if (!rows.length) {
    return wrapCollapsible(
      title,
      0,
      '<div class="avc-block-empty">Sin datos.</div>',
    );
  }
  // auto-tag para columna de descripción (permite wrap con max-width)
  function _colCls(c) {
    if (c.cls) return c.cls;
    if (c.key === "descripcion") return "desc";
    return "";
  }
  var th = cols
    .map(function (c) {
      var cls = _colCls(c);
      return (
        "<th" + (cls ? ' class="' + cls + '"' : "") + ">" +
        escHtml(c.label) +
        "</th>"
      );
    })
    .join("");
  var tb = rows
    .map(function (r) {
      return (
        "<tr>" +
        cols
          .map(function (c) {
            var v = r[c.key];
            if (c.fmt) v = c.fmt(v);
            var cls = _colCls(c);
            return (
              "<td" +
              (cls ? ' class="' + cls + '"' : "") +
              ">" +
              escHtml(v == null ? "" : v) +
              "</td>"
            );
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
  var hintHtml = hint
    ? '<div style="padding:0 0 6px; color:var(--text3); font-size:11.5px">' +
      escHtml(hint) +
      "</div>"
    : "";
  var bodyClass = opts.dense
    ? '<div class="avc-block-body avc-block-body--dense">'
    : '<div class="avc-block-body-inner">';
  // wrapCollapsible ya envuelve el body en .avc-block-body con padding default.
  // Para dense, sustituimos el padding default usando override en CSS.
  var body =
    hintHtml +
    '<div class="avc-table-wrap"><table class="' +
    tableClass +
    '"><thead><tr>' +
    th +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible(title, rows.length, body, {
    bodyClass: opts.dense ? "avc-block-body--dense" : null,
  });
}

function renderBajasBlock(rows /* , _legacy */) {
  if (!rows.length) {
    return wrapCollapsible(
      "Bajas",
      0,
      '<div class="avc-block-empty">Sin bajas.</div>',
    );
  }
  // Bajas: sin descripción (la columna se tapaba). Identifica por Cod.
  // Orden columnas: 5ta → 1ra (más nueva a la izquierda, más vieja a la derecha)
  var ths =
    "<th>Cod</th><th>Plazo Compro</th>" +
    '<th class="num">Últ. compra (uni)</th><th class="num">Promedio (uni)</th>' +
    "<th>5ta Baja</th><th>4ta Baja</th><th>3ra Baja</th><th>2da Baja</th><th>1ra Baja</th>";
  var tb = rows
    .map(function (r) {
      var cells = [
        { v: r.cod },
        { v: r.plazoCompro },
        { v: fmtNumber(r.ultimaQty), cls: "num" },
        { v: fmtNumber(r.promedioQty, 1), cls: "num" },
        { v: r.bajas[4] || "" },
        { v: r.bajas[3] || "" },
        { v: r.bajas[2] || "" },
        { v: r.bajas[1] || "" },
        { v: r.bajas[0] || "" },
      ];
      return (
        "<tr>" +
        cells
          .map(function (c) {
            return (
              "<td" +
              (c.cls ? ' class="' + c.cls + '"' : "") +
              ">" +
              escHtml(c.v) +
              "</td>"
            );
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
  var body =
    '<div class="avc-table-wrap"><table class="avc-table"><thead><tr>' +
    ths +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible("Bajas", rows.length, body);
}

function renderDisruptivasBlock(rows) {
  var hint =
    '<div style="padding:0 0 10px; color:var(--text3); font-size:12px">' +
    "Líneas cuya cantidad ≥ " +
    DISRUPTIVA_RATIO +
    "× el promedio histórico de ese cliente para el item.</div>";
  var tb = rows
    .map(function (r) {
      return (
        '<tr class="avc-disruptive">' +
        '<td class="desc">' +
        escHtml(r.descripcion) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.qtyActual) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.promedio, 1) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.ratio, 2) +
        "×</td>" +
        "</tr>"
      );
    })
    .join("");
  var body =
    hint +
    '<div class="avc-table-wrap"><table class="avc-table"><thead><tr>' +
    '<th class="desc">Descripción</th><th class="num">Qty última</th><th class="num">Prom histórico</th><th class="num">Ratio</th>' +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible("⚡ Disruptivas (última compra)", rows.length, body);
}

// el chartId es único por branch para no pisar canvases entre tabs
var _evoChartId = 0;
var _evoChartInstances = {};

function renderEvolucionBlock(rows) {
  var canvasId = "avcEvoChart_" + ++_evoChartId;
  // datos asc (más viejo a más nuevo) — invertimos porque vienen desc
  var asc = rows.slice().reverse();
  var labels = asc.map(function (r) {
    return r.mes;
  });
  var dataU = asc.map(function (r) {
    return r.unidades;
  });
  var dataM = asc.map(function (r) {
    return Math.round(r.monto || 0);
  });
  var dataJson = encodeURIComponent(
    JSON.stringify({ labels: labels, dataU: dataU, dataM: dataM }),
  );
  var hint =
    '<div style="padding:0 0 8px; color:var(--text3); font-size:11.5px">' +
    "Importes calculados como Unidades × Precio de lista actual " +
    "(aproximación; los precios reales cambian en el tiempo).</div>";
  var body =
    hint +
    '<div style="position:relative; height:300px">' +
    '<canvas id="' +
    canvasId +
    '" data-evo="' +
    dataJson +
    '"></canvas>' +
    "</div>";
  // Subtítulo dinámico: rango real desde primera compra
  var rangoTxt = "";
  if (rows.length) {
    var primera = rows[rows.length - 1].mes; // último del array desc = más viejo
    var ultima = rows[0].mes;
    rangoTxt = " (" + primera + " → " + ultima + ")";
  }
  return wrapCollapsible(
    "Evolución mensual" + rangoTxt,
    rows.length + " meses",
    body,
  );
}

function initEvoCharts(rootEl) {
  if (typeof Chart === "undefined") return;
  // destruir instancias previas
  Object.keys(_evoChartInstances).forEach(function (k) {
    try {
      _evoChartInstances[k].destroy();
    } catch (e) {}
    delete _evoChartInstances[k];
  });
  var canvases = rootEl.querySelectorAll("canvas[data-evo]");
  canvases.forEach(function (cv) {
    try {
      var raw = cv.getAttribute("data-evo");
      var parsed = JSON.parse(decodeURIComponent(raw));
      var ctx = cv.getContext("2d");
      _evoChartInstances[cv.id] = new Chart(ctx, {
        data: {
          labels: parsed.labels,
          datasets: [
            {
              type: "bar",
              label: "Unidades",
              data: parsed.dataU,
              backgroundColor: "rgba(33, 33, 34, 0.7)",
              borderColor: "rgba(33, 33, 34, 1)",
              borderWidth: 1,
              borderRadius: 3,
              maxBarThickness: 22,
              yAxisID: "yU",
              order: 2,
            },
            {
              type: "line",
              label: "Importe ($)",
              data: parsed.dataM,
              borderColor: "rgba(213, 0, 0, 1)",
              backgroundColor: "rgba(213, 0, 0, 0.12)",
              borderWidth: 2,
              tension: 0.25,
              pointRadius: 2,
              pointHoverRadius: 4,
              pointBackgroundColor: "rgba(213, 0, 0, 1)",
              fill: false,
              yAxisID: "yM",
              order: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              display: true,
              position: "top",
              align: "end",
              labels: { font: { size: 11 }, boxWidth: 14 },
            },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var v = Number(ctx.parsed.y || 0);
                  if (ctx.dataset.label === "Importe ($)") {
                    return (
                      "Importe: $ " +
                      v.toLocaleString("es-AR", {
                        maximumFractionDigits: 0,
                      })
                    );
                  }
                  return "Uni: " + v.toLocaleString("es-AR");
                },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                font: { size: 10 },
                maxRotation: 45,
                minRotation: 45,
                autoSkip: true,
                maxTicksLimit: 24,
              },
              grid: { display: false },
            },
            yU: {
              type: "linear",
              position: "left",
              beginAtZero: true,
              ticks: {
                font: { size: 11 },
                callback: function (v) {
                  return Number(v).toLocaleString("es-AR");
                },
              },
              grid: { color: "rgba(0,0,0,0.05)" },
              title: {
                display: true,
                text: "Unidades",
                font: { size: 10 },
                color: "rgba(0,0,0,0.5)",
              },
            },
            yM: {
              type: "linear",
              position: "right",
              beginAtZero: true,
              ticks: {
                font: { size: 11 },
                color: "rgba(213, 0, 0, 1)",
                callback: function (v) {
                  var n = Number(v);
                  if (n >= 1000000)
                    return "$ " + (n / 1000000).toFixed(1) + "M";
                  if (n >= 1000) return "$ " + Math.round(n / 1000) + "k";
                  return "$ " + n;
                },
              },
              grid: { display: false },
              title: {
                display: true,
                text: "Importe $",
                font: { size: 10 },
                color: "rgba(213, 0, 0, 0.7)",
              },
            },
          },
        },
      });
    } catch (e) {
      console.warn("evo chart init", e);
    }
  });
}

// ============================================================
// EXPORT EXCEL — FASE 7
// ============================================================
// ============================================================
// EXCEL STYLE HELPERS — paleta + estilos predefinidos
// ============================================================
var _XL_COLORS = {
  brandRed: "C0392B",
  brandRedLight: "F5B7B1",
  dark: "2C3E50",
  darkBlue: "1F4E79",
  green: "27AE60",
  greenLight: "D5F5E3",
  yellow: "F39C12",
  yellowLight: "FCF3CF",
  gray: "95A5A6",
  grayLight: "ECF0F1",
  zebra: "F8F9FA",
  white: "FFFFFF",
  border: "BDC3C7",
};

var _XL_BORDER_THIN = { style: "thin", color: { rgb: _XL_COLORS.border } };
var _XL_BORDER_MED = { style: "medium", color: { rgb: _XL_COLORS.dark } };

// Estilo: título principal del archivo (header de hoja)
function _xlTitleStyle(bgColor) {
  return {
    font: { bold: true, sz: 14, color: { rgb: _XL_COLORS.white } },
    fill: { fgColor: { rgb: bgColor || _XL_COLORS.dark } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: {
      top: _XL_BORDER_MED,
      bottom: _XL_BORDER_MED,
      left: _XL_BORDER_MED,
      right: _XL_BORDER_MED,
    },
  };
}

// Subtítulo del archivo (línea debajo del título)
function _xlSubtitleStyle() {
  return {
    font: { italic: true, sz: 10, color: { rgb: _XL_COLORS.gray } },
    alignment: { horizontal: "center", vertical: "center" },
  };
}

// Sección (BAJAS, ALTAS, etc) — merged
function _xlSectionStyle(bgColor) {
  return {
    font: { bold: true, sz: 12, color: { rgb: _XL_COLORS.white } },
    fill: { fgColor: { rgb: bgColor || _XL_COLORS.darkBlue } },
    alignment: { horizontal: "left", vertical: "center", indent: 1 },
    border: { bottom: _XL_BORDER_THIN },
  };
}

// Subtítulo de sección (descripción debajo del header)
function _xlSectionSubtitleStyle() {
  return {
    font: { italic: true, sz: 10, color: { rgb: "7F8C8D" } },
    alignment: { horizontal: "left", vertical: "center", indent: 1 },
  };
}

// Header de tabla (fila de columnas)
function _xlTableHeaderStyle() {
  return {
    font: { bold: true, sz: 10, color: { rgb: _XL_COLORS.dark } },
    fill: { fgColor: { rgb: _XL_COLORS.grayLight } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: {
      top: _XL_BORDER_THIN,
      bottom: { style: "medium", color: { rgb: _XL_COLORS.dark } },
      left: _XL_BORDER_THIN,
      right: _XL_BORDER_THIN,
    },
  };
}

// Celda de datos (con border + zebra opcional)
function _xlDataStyle(opts) {
  opts = opts || {};
  var s = {
    font: { sz: 10, color: { rgb: "2C3E50" } },
    alignment: {
      horizontal: opts.right ? "right" : opts.center ? "center" : "left",
      vertical: "center",
    },
    border: {
      top: _XL_BORDER_THIN,
      bottom: _XL_BORDER_THIN,
      left: _XL_BORDER_THIN,
      right: _XL_BORDER_THIN,
    },
  };
  if (opts.zebra) {
    s.fill = { fgColor: { rgb: _XL_COLORS.zebra } };
  }
  if (opts.bold) {
    s.font.bold = true;
  }
  if (opts.color) {
    s.font.color = { rgb: opts.color };
  }
  return s;
}

// Stat key/value (labels en datos del cliente, indicadores)
function _xlStatLabelStyle() {
  return {
    font: { bold: true, sz: 10, color: { rgb: _XL_COLORS.dark } },
    fill: { fgColor: { rgb: _XL_COLORS.grayLight } },
    alignment: { horizontal: "left", vertical: "center", indent: 1 },
    border: {
      top: _XL_BORDER_THIN,
      bottom: _XL_BORDER_THIN,
      left: _XL_BORDER_THIN,
      right: _XL_BORDER_THIN,
    },
  };
}
function _xlStatValueStyle() {
  return {
    font: { sz: 10, color: { rgb: "2C3E50" } },
    alignment: { horizontal: "left", vertical: "center", indent: 1 },
    border: {
      top: _XL_BORDER_THIN,
      bottom: _XL_BORDER_THIN,
      left: _XL_BORDER_THIN,
      right: _XL_BORDER_THIN,
    },
  };
}

// Aplica estilos a un worksheet recorriendo las celdas y detectando patrones
// (filas de título mergeadas → titleStyle, headers de tabla → tableHeaderStyle,
// datos de tabla → dataStyle con zebra). Es un post-process del aoa_to_sheet.
function _applyStylesToSheet(ws, mergedRows, opts) {
  opts = opts || {};
  var range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  var totalCols = range.e.c + 1;
  // mergedRows: índice de fila → "title" | "section" | "subtitle"
  for (var R = 0; R <= range.e.r; R++) {
    var rowInfo = mergedRows[R];
    for (var C = 0; C <= range.e.c; C++) {
      var cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
      var cell = ws[cellAddr];
      if (!cell) {
        // Crear celda vacía para que el estilo aplique al merge completo
        ws[cellAddr] = { v: "", t: "s" };
        cell = ws[cellAddr];
      }
      if (rowInfo === "title") {
        cell.s = _xlTitleStyle(opts.titleBg);
      } else if (rowInfo === "subtitle") {
        cell.s = _xlSubtitleStyle();
      } else if (rowInfo === "section") {
        cell.s = _xlSectionStyle(opts.sectionBg);
      } else if (rowInfo === "sectionSub") {
        cell.s = _xlSectionSubtitleStyle();
      } else if (rowInfo === "tableHeader") {
        cell.s = _xlTableHeaderStyle();
      } else if (rowInfo === "stat") {
        cell.s = C === 0 ? _xlStatLabelStyle() : _xlStatValueStyle();
      } else if (rowInfo && rowInfo.type === "data") {
        var isNum =
          typeof cell.v === "number" ||
          (typeof cell.v === "string" && /^[\-]?[\d.,]+$/.test(cell.v));
        cell.s = _xlDataStyle({
          zebra: rowInfo.zebra,
          right: isNum && C > 0,
        });
      }
      // Filas vacías sin info quedan sin estilo
    }
  }
  // Altura de filas título y sección
  ws["!rows"] = ws["!rows"] || [];
  for (var i = 0; i <= range.e.r; i++) {
    var info = mergedRows[i];
    if (info === "title") ws["!rows"][i] = { hpt: 30 };
    else if (info === "section") ws["!rows"][i] = { hpt: 22 };
    else if (info === "tableHeader") ws["!rows"][i] = { hpt: 28 };
  }
}

function onExportarExcel() {
  if (!currentCustomer || !branches.length) {
    alert("Buscá un cliente primero.");
    return;
  }
  try {
    var wb = XLSX.utils.book_new();

    // ============== HOJA RESUMEN ==============
    var resumen = [];
    var rsName = currentCustomer.business_name || "—";
    var nowStr = new Date().toLocaleString("es-AR");
    var totalCols = 5; // ancho del bloque de título (para merges)

    resumen.push(["ANÁLISIS DE VENTA — " + rsName]);
    resumen.push(["Generado: " + nowStr]);
    resumen.push([]);

    // ----- DATOS DEL CLIENTE -----
    resumen.push(["DATOS DEL CLIENTE"]);
    resumen.push(["Razón Social", rsName]);
    resumen.push(["Código Cliente", String(currentCustomer.cod_cliente || "")]);
    resumen.push(["CUIT", currentCustomer.cuit || "—"]);
    resumen.push(["Email", currentCustomer.mail || "—"]);
    resumen.push([]);

    // ----- INDICADORES GENERALES -----
    resumen.push(["INDICADORES GENERALES"]);
    resumen.push(["Movimientos totales", movements.length]);
    resumen.push(["Sucursales del cliente", currentAddresses.length]);
    var consolidatedBr = branches.find(function (b) {
      return b.type === "consolidated";
    });
    if (consolidatedBr && consolidatedBr.analysis && consolidatedBr.analysis.stats) {
      var cs = consolidatedBr.analysis.stats;
      resumen.push(["Cantidad de pedidos", cs.pedidos || 0]);
      if (cs.frecuenciaMeses != null) {
        resumen.push([
          "Frecuencia promedio (meses)",
          Number(cs.frecuenciaMeses.toFixed(1)),
        ]);
      }
      if (cs.promCajas != null) {
        resumen.push([
          "Promedio cajas por pedido",
          Number(cs.promCajas.toFixed(1)),
        ]);
      }
      if (cs.primeraCompra)
        resumen.push(["Primera compra", fmtMonthYearMM(cs.primeraCompra)]);
      if (cs.ultimaCompra)
        resumen.push(["Última compra", fmtMonthYearMM(cs.ultimaCompra)]);
    }
    resumen.push([]);

    // ----- DETALLE POR SUCURSAL -----
    resumen.push(["DETALLE POR SUCURSAL"]);
    resumen.push([
      "Sucursal",
      "Pedidos",
      "Movimientos",
      "Última compra",
      "Primera compra",
    ]);
    branches.forEach(function (br) {
      var s = br.analysis.stats;
      resumen.push([
        br.label,
        s.pedidos || 0,
        br.movements.length,
        s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "—",
        s.primeraCompra ? fmtMonthYearMM(s.primeraCompra) : "—",
      ]);
    });
    resumen.push([]);

    // ----- ÍNDICE DE HOJAS -----
    resumen.push(["ÍNDICE DE HOJAS"]);
    resumen.push(["Hoja", "Contenido"]);
    branches.forEach(function (br) {
      resumen.push([br.label, "Análisis detallado de la sucursal"]);
    });

    var wsRes = XLSX.utils.aoa_to_sheet(resumen);
    wsRes["!cols"] = [
      { wch: 32 },
      { wch: 40 },
      { wch: 14 },
      { wch: 16 },
      { wch: 16 },
    ];
    // Merges + clasificación de filas para styling
    var resMerges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }, // título principal
      { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } }, // generado
    ];
    var resRowTypes = { 0: "title", 1: "subtitle" };
    // Detectar secciones (filas all-caps) y filas de datos
    var inTable = false;
    resumen.forEach(function (row, i) {
      if (i <= 1) return; // ya clasificadas
      var isAllCaps =
        row.length === 1 &&
        typeof row[0] === "string" &&
        /^[A-ZÁÉÍÓÚÑ ]{6,}$/.test(row[0]);
      if (isAllCaps) {
        resMerges.push({
          s: { r: i, c: 0 },
          e: { r: i, c: totalCols - 1 },
        });
        resRowTypes[i] = "section";
        inTable = false;
      } else if (row.length > 1 && row.every(function (c) { return c !== undefined && c !== null; })) {
        // Posible header de tabla (fila con varios valores no-vacíos)
        // Heurística: si la fila siguiente tiene mismo nro de cols → es header
        var next = resumen[i + 1];
        if (
          next &&
          next.length === row.length &&
          !inTable
        ) {
          resRowTypes[i] = "tableHeader";
          inTable = true;
        } else if (inTable) {
          // Fila de datos en tabla activa
          resRowTypes[i] = { type: "data", zebra: i % 2 === 0 };
        } else {
          // Stat key/value (2 cols)
          resRowTypes[i] = "stat";
        }
      } else if (row.length === 2) {
        resRowTypes[i] = "stat";
      }
    });
    wsRes["!merges"] = resMerges;
    _applyStylesToSheet(wsRes, resRowTypes, { titleBg: _XL_COLORS.brandRed });
    XLSX.utils.book_append_sheet(wb, wsRes, "Resumen");

    // ============== HOJAS POR SUCURSAL ==============
    branches.forEach(function (br) {
      var aoa = buildBranchAOA(br);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      // Anchos: optimizados para Cod / Descripción / fechas / nums
      ws["!cols"] = [
        { wch: 10 }, // Cod
        { wch: 40 }, // Descripción / Plazo Compro
        { wch: 18 }, // Categoría / Plazo Compro
        { wch: 14 }, // Fecha / Últ. compra
        { wch: 14 }, // Unidades / Promedio
        { wch: 12 }, // 5ta Baja
        { wch: 12 }, // 4ta Baja
        { wch: 12 }, // 3ra Baja
        { wch: 12 }, // 2da Baja
        { wch: 12 }, // 1ra Baja
      ];
      var brTotalCols = 10;
      var brMerges = [];
      var brRowTypes = {};
      // Heurística: 2 primeras filas son cabecera (título + subtítulo timestamp)
      brMerges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: brTotalCols - 1 } });
      brMerges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: brTotalCols - 1 } });
      brRowTypes[0] = "title";
      brRowTypes[1] = "subtitle";

      var inTable = false;
      var lastWasSection = false;
      aoa.forEach(function (row, i) {
        if (i <= 1) return;
        var isOneCellAllCaps =
          row.length === 1 &&
          typeof row[0] === "string" &&
          /^[A-ZÁÉÍÓÚÑ0-9 \-—()]{4,}$/.test(row[0]);
        var isOneCellSubtitle =
          row.length === 1 &&
          typeof row[0] === "string" &&
          !isOneCellAllCaps &&
          row[0].length > 0;
        if (isOneCellAllCaps) {
          brMerges.push({
            s: { r: i, c: 0 },
            e: { r: i, c: brTotalCols - 1 },
          });
          brRowTypes[i] = "section";
          inTable = false;
          lastWasSection = true;
        } else if (isOneCellSubtitle && lastWasSection) {
          brMerges.push({
            s: { r: i, c: 0 },
            e: { r: i, c: brTotalCols - 1 },
          });
          brRowTypes[i] = "sectionSub";
          lastWasSection = false;
        } else if (
          row.length >= 2 &&
          !inTable &&
          row.every(function (c) {
            return c !== undefined && c !== null && c !== "";
          })
        ) {
          // Fila de header de tabla (todos los headers son texto, primera tras sectionSub o section)
          brRowTypes[i] = "tableHeader";
          inTable = true;
          lastWasSection = false;
        } else if (inTable && row.length >= 2) {
          // Fila de datos
          brRowTypes[i] = { type: "data", zebra: i % 2 === 0 };
          lastWasSection = false;
        } else if (row.length === 2) {
          // Stat key/value (línea de 2 cols)
          brRowTypes[i] = "stat";
          lastWasSection = false;
        }
      });
      ws["!merges"] = brMerges;
      _applyStylesToSheet(ws, brRowTypes, {
        titleBg: _XL_COLORS.darkBlue,
        sectionBg: _XL_COLORS.dark,
      });

      var sheetName = sanitizeSheetName(br.label, 25);
      var base = sheetName;
      var n = 1;
      while (wb.SheetNames.indexOf(sheetName) !== -1) {
        sheetName = base + " " + ++n;
      }
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    // Filename: cliente-cod-fecha
    var safeName = String(rsName).replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 30);
    var fname =
      "analisis-" +
      safeName +
      "-" +
      currentCustomer.cod_cliente +
      "-" +
      new Date().toISOString().slice(0, 10) +
      ".xlsx";
    XLSX.writeFile(wb, fname);
  } catch (err) {
    console.error("export excel error", err);
    alert("Error generando Excel: " + (err.message || err));
  }
}

function sanitizeSheetName(name, maxLen) {
  var s = String(name || "Hoja").replace(/[\\\/\?\*\[\]:]/g, "-");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || "Hoja";
}

function buildBranchAOA(br) {
  var rows = [];
  var a = br.analysis;
  var s = a.stats;
  var rsName = (currentCustomer && currentCustomer.business_name) || "—";

  // Cabecera de hoja: cliente + sucursal + total movs
  rows.push(["ANÁLISIS — " + rsName + "  ·  Sucursal: " + br.label]);
  rows.push([
    "Movimientos: " + br.movements.length +
      "  ·  Generado: " + new Date().toLocaleString("es-AR"),
  ]);
  rows.push([]);

  // ===== ESTADÍSTICAS =====
  rows.push(["ESTADÍSTICAS"]);
  rows.push(["Métrica", "Valor"]);
  rows.push(["Cantidad de pedidos", s.pedidos || 0]);
  rows.push([
    "Frecuencia promedio (meses entre pedidos)",
    s.frecuenciaMeses == null ? "—" : Number(s.frecuenciaMeses.toFixed(1)),
  ]);
  rows.push([
    "Promedio cajas por pedido",
    s.promCajas == null ? "—" : Number(s.promCajas.toFixed(1)),
  ]);
  rows.push([
    "Promedio unidades por pedido",
    s.promUnidades == null ? "—" : Math.round(s.promUnidades),
  ]);
  if (br.type === "consolidated" && s.ranking) {
    rows.push([
      "Ranking 12m (posición global)",
      s.ranking.pos != null
        ? "#" + s.ranking.pos + " de " + s.ranking.total
        : "—",
    ]);
    rows.push(["Unidades últimos 12m", s.ranking.unidades]);
  }
  if (s.primeraCompra)
    rows.push(["Primera compra", fmtMonthYearMM(s.primeraCompra)]);
  if (s.ultimaCompra)
    rows.push(["Última compra", fmtMonthYearMM(s.ultimaCompra)]);
  // Acuerdo (DV%, Com%, s/lista) — removido: dato comercial interno.
  rows.push([]);

  // ===== ALTAS =====
  rows.push(["ALTAS — " + a.altas.length + " items"]);
  rows.push(["Productos comprados por primera vez"]);
  rows.push(["Cod", "Descripción", "Categoría", "1ra Compra", "Unidades"]);
  a.altas.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.categoria,
      fmtMonthYear(r.fecha),
      r.qty,
    ]);
  });
  if (!a.altas.length) rows.push(["—", "Sin altas en el período", "", "", ""]);
  rows.push([]);

  // ===== BAJAS =====
  rows.push(["BAJAS — " + a.bajas.length + " items"]);
  rows.push(["Productos que dejó de comprar (más bajas arriba)"]);
  rows.push([
    "Cod",
    "Descripción",
    "Plazo Compro",
    "Últ. compra (uni)",
    "Promedio (uni)",
    "5ta Baja",
    "4ta Baja",
    "3ra Baja",
    "2da Baja",
    "1ra Baja",
  ]);
  a.bajas.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.plazoCompro,
      Math.round(r.ultimaQty),
      Number((r.promedioQty || 0).toFixed(1)),
      r.bajas[4] || "",
      r.bajas[3] || "",
      r.bajas[2] || "",
      r.bajas[1] || "",
      r.bajas[0] || "",
    ]);
  });
  if (!a.bajas.length) rows.push(["—", "Sin bajas detectadas", "", "", "", "", "", "", "", ""]);
  rows.push([]);

  // ===== PROBÓ 1 VEZ =====
  rows.push(["PROBÓ SOLO 1 VEZ — " + a.probo1Vez.length + " items"]);
  rows.push(["Items con única compra histórica"]);
  rows.push(["Cod", "Descripción", "Mes/Año", "Unidades"]);
  a.probo1Vez.forEach(function (r) {
    rows.push([r.cod, r.descripcion, r.mes, r.qty]);
  });
  if (!a.probo1Vez.length) rows.push(["—", "Sin items en esta categoría", "", ""]);
  rows.push([]);

  // ===== A OFRECER =====
  rows.push(["A OFRECER — Top " + TOP_OFRECER + " (" + a.aOfrecer.length + " sugerencias)"]);
  rows.push(["Productos sugeridos en base a Estadística Madre"]);
  rows.push([
    "Cod",
    "Descripción",
    "Categoría",
    "Ranking Madre",
    "E.Madre Uni/Mes",
  ]);
  a.aOfrecer.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.categoria,
      r.ranking == null ? "" : r.ranking,
      r.e_madre == null ? "" : r.e_madre,
    ]);
  });
  if (!a.aOfrecer.length) rows.push(["—", "Sin sugerencias disponibles", "", "", ""]);
  rows.push([]);

  // ===== DISRUPTIVAS =====
  if (a.disruptivas.length) {
    rows.push(["DISRUPTIVAS — " + a.disruptivas.length + " items"]);
    rows.push(["Líneas con qty muy distinta al promedio histórico (última compra)"]);
    rows.push([
      "Cod",
      "Descripción",
      "Qty última",
      "Prom histórico",
      "Ratio",
    ]);
    a.disruptivas.forEach(function (r) {
      rows.push([
        r.cod,
        r.descripcion,
        r.qtyActual,
        Number(r.promedio.toFixed(1)),
        Number(r.ratio.toFixed(2)) + "x",
      ]);
    });
    rows.push([]);
  }

  // ===== EVOLUCIÓN MENSUAL =====
  // Rango dinámico (desde primera compra)
  var evoRange = "";
  if (a.evolucion && a.evolucion.length) {
    evoRange = " (" + a.evolucion[a.evolucion.length - 1].mes + " → " + a.evolucion[0].mes + ")";
  }
  rows.push(["EVOLUCIÓN MENSUAL" + evoRange]);
  rows.push(["Compras agregadas por mes"]);
  rows.push(["Mes", "Unidades"]);
  a.evolucion.forEach(function (r) {
    rows.push([r.mes, r.unidades]);
  });

  return rows;
}

// ============================================================
// REPORTE TOTAL CLIENTES — FASE 8
// ============================================================
var rtCanceled = false;

async function onReporteTotal() {
  if (
    !confirm(
      "Generar reporte de TODOS los clientes con movimientos.\n\n" +
        "Esto puede tardar varios minutos. ¿Continuar?",
    )
  ) {
    return;
  }
  // En Fase 11 acá va validación de 2da clave WhatsApp.

  rtShowOverlay();
  rtCanceled = false;

  try {
    rtSetMessage("Cargando catálogo y estadística madre...");
    await Promise.all([loadProducts(), loadEstadisticaMadre(), loadNovedades()]);

    rtSetMessage("Listando clientes con pedidos...");
    var customerIds = await rtFetchCustomerIdsWithOrders();
    if (rtCanceled) return rtAbort();

    rtSetMessage("Cargando datos de clientes...");
    // Trae todos los customers de una vez (con paginación)
    var customersMap = {};
    var off = 0;
    while (true) {
      var r = await sb
        .from("customers")
        .select("id, cod_cliente, business_name, cuit")
        .range(off, off + 999);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      batch.forEach(function (c) {
        customersMap[c.id] = c;
      });
      if (batch.length < 1000) break;
      off += 1000;
    }
    if (rtCanceled) return rtAbort();

    var clientes = customerIds
      .map(function (id) {
        return customersMap[id];
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return String(a.cod_cliente || "").localeCompare(
          String(b.cod_cliente || ""),
          undefined,
          { numeric: true },
        );
      });

    var wb = XLSX.utils.book_new();

    // Hoja Índice
    var idx = [
      ["Reporte Total Clientes"],
      ["Generado", new Date().toLocaleString("es-AR")],
      ["Total clientes", clientes.length],
      [],
      ["Cod", "Cliente", "CUIT", "Pedidos", "Última compra"],
    ];
    var idxRowStart = idx.length; // donde arrancan los rows
    var indexRows = [];

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(idx),
      "Indice",
    );

    // Por cada cliente
    for (var i = 0; i < clientes.length; i++) {
      if (rtCanceled) return rtAbort();
      var c = clientes[i];
      rtSetProgress(i + 1, clientes.length, c);

      try {
        var data = await rtBuildClienteData(c);
        var sheetName = sanitizeSheetName(
          (c.cod_cliente || "?") +
            "-" +
            (c.business_name || "").slice(0, 18),
          25,
        );
        var base = sheetName;
        var n = 1;
        while (wb.SheetNames.indexOf(sheetName) !== -1) {
          sheetName = base + " " + ++n;
        }
        var ws = XLSX.utils.aoa_to_sheet(data.aoa);
        ws["!cols"] = [
          { wch: 12 },
          { wch: 36 },
          { wch: 18 },
          { wch: 14 },
          { wch: 14 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, sheetName);

        indexRows.push([
          c.cod_cliente,
          c.business_name || "",
          c.cuit || "",
          data.pedidos,
          data.ultimaCompra || "",
        ]);
      } catch (e) {
        console.warn("rt cliente " + c.cod_cliente + " error", e);
        indexRows.push([
          c.cod_cliente,
          c.business_name || "",
          c.cuit || "",
          "ERROR",
          (e.message || e).toString().slice(0, 80),
        ]);
      }
    }

    // Re-escribir hoja Índice con rows finales
    var idxFull = idx.concat(indexRows);
    var wsIdx = XLSX.utils.aoa_to_sheet(idxFull);
    wsIdx["!cols"] = [
      { wch: 10 },
      { wch: 40 },
      { wch: 14 },
      { wch: 10 },
      { wch: 14 },
    ];
    // reemplazar
    wb.Sheets["Indice"] = wsIdx;

    rtSetMessage("Generando archivo...");
    var fname =
      "reporte-total-clientes-" +
      new Date().toISOString().slice(0, 10) +
      ".xlsx";
    XLSX.writeFile(wb, fname);
    rtHideOverlay();
    alert(
      "Reporte generado: " + clientes.length + " clientes en " + fname,
    );
  } catch (err) {
    console.error("onReporteTotal error", err);
    rtHideOverlay();
    alert("Error: " + (err.message || err));
  }
}

async function rtFetchCustomerIdsWithOrders() {
  var ids = new Set();
  var off = 0;
  while (true) {
    var r = await sb
      .from("orders")
      .select("customer_id")
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (o) {
      if (o.customer_id) ids.add(o.customer_id);
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
  return Array.from(ids);
}

async function rtBuildClienteData(c) {
  // movs web
  var webMovs = await loadWebMovements(c.id);
  // movs erp
  var erpMovs = await loadSalesHistory(c.cod_cliente);
  var movs = webMovs.concat(erpMovs);
  movs.sort(function (a, b) {
    return a.fecha - b.fecha;
  });

  // RPC sugerencias para este cliente
  var sugStash = sugerenciasCache;
  try {
    var sr = await sb.rpc("sugerencias_cliente", {
      p_customer: String(c.cod_cliente),
    });
    sugerenciasCache = sr.error ? [] : sr.data || [];
  } catch (e) {
    sugerenciasCache = [];
  }

  // Análisis sobre branch consolidada
  var fakeBranch = {
    key: "rt_" + c.id,
    label: c.business_name || c.cod_cliente,
    type: "consolidated",
    address: null,
    movements: movs,
  };
  var analysis = computeAnalysis(fakeBranch);
  // restore cache global (no contaminar)
  sugerenciasCache = sugStash;

  var s = analysis.stats;
  var aoa = [];
  aoa.push(["Cliente: " + (c.business_name || c.cod_cliente)]);
  aoa.push(["Cod", c.cod_cliente, "CUIT", c.cuit || ""]);
  aoa.push([
    "Pedidos",
    s.pedidos || 0,
    "Frecuencia (m)",
    s.frecuenciaMeses == null ? "" : Number(s.frecuenciaMeses.toFixed(1)),
  ]);
  aoa.push([
    "Promedio cajas/pedido",
    s.promCajas == null ? "" : Number(s.promCajas.toFixed(1)),
    "Última compra",
    s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "",
  ]);
  aoa.push([]);

  aoa.push(["ALTAS"]);
  aoa.push(["Cod", "Descripción", "Categoría", "1ra Compra", "Unidades"]);
  analysis.altas.slice(0, 50).forEach(function (r) {
    aoa.push([r.cod, r.descripcion, r.categoria, fmtMonthYear(r.fecha), r.qty]);
  });
  aoa.push([]);

  aoa.push(["BAJAS"]);
  aoa.push([
    "Cod",
    "Descripción",
    "Plazo Compro",
    "Últ. compra (uni)",
    "Promedio (uni)",
    "5ta Baja",
    "4ta Baja",
    "3ra Baja",
    "2da Baja",
    "1ra Baja",
  ]);
  analysis.bajas.forEach(function (r) {
    aoa.push([
      r.cod,
      r.descripcion,
      r.plazoCompro,
      Math.round(r.ultimaQty),
      Number((r.promedioQty || 0).toFixed(1)),
      r.bajas[4] || "",
      r.bajas[3] || "",
      r.bajas[2] || "",
      r.bajas[1] || "",
      r.bajas[0] || "",
    ]);
  });
  aoa.push([]);

  aoa.push(["PROBÓ SOLO 1 VEZ"]);
  aoa.push(["Cod", "Descripción", "Mes/Año", "Unidades"]);
  analysis.probo1Vez.forEach(function (r) {
    aoa.push([r.cod, r.descripcion, r.mes, r.qty]);
  });
  aoa.push([]);

  aoa.push(["A OFRECER (Top " + TOP_OFRECER + ")"]);
  aoa.push([
    "Cod",
    "Descripción",
    "Categoría",
    "Ranking Madre",
    "E.Madre Uni/Mes",
  ]);
  analysis.aOfrecer.forEach(function (r) {
    aoa.push([
      r.cod,
      r.descripcion,
      r.categoria,
      r.ranking == null ? "" : r.ranking,
      r.e_madre == null ? "" : r.e_madre,
    ]);
  });
  aoa.push([]);

  if (analysis.disruptivas.length) {
    aoa.push(["DISRUPTIVAS (última compra)"]);
    aoa.push([
      "Cod",
      "Descripción",
      "Qty última",
      "Prom histórico",
      "Ratio",
    ]);
    analysis.disruptivas.forEach(function (r) {
      aoa.push([
        r.cod,
        r.descripcion,
        r.qtyActual,
        Number(r.promedio.toFixed(1)),
        Number(r.ratio.toFixed(2)),
      ]);
    });
  }

  return {
    aoa: aoa,
    pedidos: s.pedidos || 0,
    ultimaCompra: s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "",
  };
}

// ---- overlay simple ----
function rtShowOverlay() {
  var ov = document.getElementById("rtOverlay");
  if (ov) {
    ov.style.display = "flex";
    return;
  }
  var div = document.createElement("div");
  div.id = "rtOverlay";
  div.style.cssText =
    "position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9999;" +
    " display:flex; align-items:center; justify-content:center;";
  div.innerHTML =
    '<div style="background:#fff; border-radius:14px; padding:28px 36px; min-width:420px; max-width:90vw; box-shadow:0 20px 50px rgba(0,0,0,0.3)">' +
    '<h3 style="font-family:Syne,sans-serif; margin:0 0 12px; font-size:18px">Generando reporte total</h3>' +
    '<div id="rtMessage" style="font-size:13px; color:#374151; margin-bottom:10px">Iniciando...</div>' +
    '<div style="background:#f3f4f6; border-radius:8px; height:10px; overflow:hidden; margin-bottom:6px">' +
    '<div id="rtBar" style="background:#d50000; height:100%; width:0%; transition:width 0.2s"></div>' +
    "</div>" +
    '<div id="rtProgress" style="font-size:12px; color:#6b7280; margin-bottom:14px">—</div>' +
    '<button id="rtCancel" type="button" style="background:#fff; border:1px solid #d1d5db; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px">Cancelar</button>' +
    "</div>";
  document.body.appendChild(div);
  document.getElementById("rtCancel").addEventListener("click", function () {
    rtCanceled = true;
    rtSetMessage("Cancelando...");
  });
}

function rtHideOverlay() {
  var ov = document.getElementById("rtOverlay");
  if (ov) ov.style.display = "none";
}

function rtSetMessage(msg) {
  var el = document.getElementById("rtMessage");
  if (el) el.textContent = msg;
}

function rtSetProgress(done, total, c) {
  var pct = total ? Math.round((done * 100) / total) : 0;
  var bar = document.getElementById("rtBar");
  if (bar) bar.style.width = pct + "%";
  var pr = document.getElementById("rtProgress");
  if (pr) {
    pr.textContent =
      done +
      " / " +
      total +
      " — " +
      (c.cod_cliente || "?") +
      " " +
      (c.business_name || "");
  }
}

function rtAbort() {
  rtHideOverlay();
  alert("Cancelado por el usuario.");
}

// ============================================================
// ESTADÍSTICA MADRE — IMPORTADOR
// (movido desde admin.js — ahora vive en esta página)
// ============================================================
var emParsedRows = null;

function emNormHeader(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\n\r]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function emFindCol(headers, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    for (var j = 0; j < headers.length; j++) {
      if (headers[j] === c) return j;
    }
  }
  for (var k = 0; k < candidates.length; k++) {
    var cc = candidates[k];
    for (var l = 0; l < headers.length; l++) {
      if (headers[l] && headers[l].indexOf(cc) !== -1) return l;
    }
  }
  return -1;
}

function emCleanDesc(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function emParseFile(buf) {
  var wb = XLSX.read(buf, { type: "array" });
  var sheetName = wb.SheetNames.find(function (n) {
    return /loeke\s*madre.*\d/i.test(n);
  });
  if (!sheetName) {
    sheetName = wb.SheetNames.find(function (n) {
      return /loeke\s*madre/i.test(n);
    });
  }
  if (!sheetName) throw new Error("No se encontró hoja 'Loeke Madre …'");
  var sheet = wb.Sheets[sheetName];
  var raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  var headerRowIdx = -1;
  for (var i = 0; i < Math.min(raw.length, 12); i++) {
    var row = raw[i].map(emNormHeader);
    if (row.indexOf("cod nuevo isis") !== -1) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new Error(
      "No se encontró fila de encabezado (esperaba 'Cod Nuevo Isis').",
    );
  }

  var headers = raw[headerRowIdx].map(emNormHeader);

  var col = {
    categoria: emFindCol(headers, ["cat art", "categoria", "cat"]),
    ranking: emFindCol(headers, ["ranking"]),
    descripcion: emFindCol(headers, ["descripcion"]),
    cod: emFindCol(headers, ["cod nuevo isis", "cod"]),
    e_madre_uni_mes: emFindCol(headers, [
      "emadre uni x mes",
      "e madre uni x mes",
      "estadistica madre uni x mes",
    ]),
    tendencia_uni: emFindCol(headers, ["tendencia en uni", "tendencia uni"]),
    uni_x_caja: emFindCol(headers, ["uni x caja"]),
    e_madre_cajas: emFindCol(headers, ["emadre en cajas", "e madre en cajas"]),
    proveedor: emFindCol(headers, ["proveedor"]),
  };

  if (col.cod === -1)
    throw new Error("No se encontró columna 'Cod Nuevo Isis'.");
  if (col.descripcion === -1)
    throw new Error("No se encontró columna 'Descripcion'.");

  var rows = [];
  for (var r = headerRowIdx + 1; r < raw.length; r++) {
    var rawRow = raw[r];
    if (!rawRow || rawRow.length === 0) continue;
    var cod = String(rawRow[col.cod] || "").trim();
    if (!cod) continue;
    if (!/^\w[\w\-/.]*$/i.test(cod)) continue;

    var desc = emCleanDesc(rawRow[col.descripcion]);
    if (!desc) continue;

    function num(v) {
      if (v === "" || v == null) return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    function intg(v) {
      var n = num(v);
      return n == null ? null : Math.round(n);
    }
    function str(v) {
      var s = String(v || "").trim();
      return s || null;
    }

    rows.push({
      cod: cod,
      descripcion: desc,
      categoria: col.categoria !== -1 ? str(rawRow[col.categoria]) : null,
      ranking: col.ranking !== -1 ? intg(rawRow[col.ranking]) : null,
      e_madre_uni_mes:
        col.e_madre_uni_mes !== -1 ? num(rawRow[col.e_madre_uni_mes]) : null,
      tendencia_uni:
        col.tendencia_uni !== -1 ? num(rawRow[col.tendencia_uni]) : null,
      uni_x_caja: col.uni_x_caja !== -1 ? intg(rawRow[col.uni_x_caja]) : null,
      e_madre_cajas:
        col.e_madre_cajas !== -1 ? num(rawRow[col.e_madre_cajas]) : null,
      proveedor: col.proveedor !== -1 ? str(rawRow[col.proveedor]) : null,
    });
  }

  return { sheetName: sheetName, rows: rows };
}

function emRenderPreview(rows) {
  var preview = document.getElementById("emPreview");
  if (!preview) return;
  if (!rows || !rows.length) {
    preview.style.display = "none";
    preview.innerHTML = "";
    return;
  }
  var sample = rows.slice(0, 50);
  var html =
    '<table style="width:100%; border-collapse:collapse; font-size:12px">';
  html +=
    "<thead><tr>" +
    [
      "Cod",
      "Descripción",
      "Categoría",
      "Ranking",
      "E.Madre Uni/Mes",
      "Tendencia",
      "Uni x Caja",
      "Cajas/Mes",
      "Proveedor",
    ]
      .map(function (h) {
        return (
          '<th style="background:#f9fafb; padding:6px 8px; text-align:left; border-bottom:1px solid #e5e7eb; position:sticky; top:0">' +
          h +
          "</th>"
        );
      })
      .join("") +
    "</tr></thead><tbody>";
  sample.forEach(function (r) {
    html +=
      "<tr>" +
      [
        r.cod,
        r.descripcion,
        r.categoria || "",
        r.ranking != null ? r.ranking : "",
        r.e_madre_uni_mes != null ? r.e_madre_uni_mes : "",
        r.tendencia_uni != null ? r.tendencia_uni.toFixed(3) : "",
        r.uni_x_caja != null ? r.uni_x_caja : "",
        r.e_madre_cajas != null ? r.e_madre_cajas.toFixed(2) : "",
        r.proveedor || "",
      ]
        .map(function (v) {
          return (
            '<td style="padding:5px 8px; border-bottom:1px solid #f3f4f6">' +
            String(v) +
            "</td>"
          );
        })
        .join("") +
      "</tr>";
  });
  html += "</tbody></table>";
  if (rows.length > sample.length) {
    html +=
      '<div style="padding:8px 12px; color:#6b7280; font-size:12px">' +
      "+" +
      (rows.length - sample.length) +
      " filas más (no mostradas)…</div>";
  }
  preview.innerHTML = html;
  preview.style.display = "block";
}

function emSetStatus(msg, kind) {
  var el = document.getElementById("emStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color =
    kind === "err"
      ? "#b91c1c"
      : kind === "ok"
        ? "#166534"
        : kind === "warn"
          ? "#b45309"
          : "#374151";
}

function emHandleFile(file) {
  var nameEl = document.getElementById("emFileName");
  var btnImp = document.getElementById("emBtnImportar");
  if (nameEl) nameEl.textContent = file.name;
  emSetStatus("Leyendo archivo...");
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var parsed = emParseFile(e.target.result);
      emParsedRows = parsed.rows;
      emRenderPreview(emParsedRows);
      emSetStatus(
        "Hoja: '" +
          parsed.sheetName +
          "' — " +
          emParsedRows.length +
          " items listos para importar.",
        "ok",
      );
      if (btnImp) btnImp.disabled = emParsedRows.length === 0;
    } catch (err) {
      console.error("emParseFile error", err);
      emSetStatus("Error: " + (err.message || err), "err");
      emParsedRows = null;
      if (btnImp) btnImp.disabled = true;
    }
  };
  reader.onerror = function () {
    emSetStatus("Error al leer archivo.", "err");
  };
  reader.readAsArrayBuffer(file);
}

function emDedupRows(rows) {
  var map = {};
  var dups = 0;
  rows.forEach(function (r) {
    var key = String(r.cod || "").trim().toUpperCase();
    if (!key) return;
    if (map[key]) dups++;
    map[key] = Object.assign({}, r, { cod: key });
  });
  return { rows: Object.values(map), dups: dups };
}

function emFormatDateDDMMYY(d) {
  var dd = String(d.getDate()).padStart(2, "0");
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var yy = String(d.getFullYear()).slice(-2);
  return dd + "/" + mm + "/" + yy;
}

function emRefreshLastImportLabel() {
  var el = document.getElementById("emLastImport");
  if (!el) return;
  var stored = localStorage.getItem("lastImport_em");
  el.textContent = stored
    ? "(últ. importación: " + emFormatDateDDMMYY(new Date(stored)) + ")"
    : "";
}

async function emImportar() {
  if (!emParsedRows || !emParsedRows.length) {
    emSetStatus("No hay datos para importar.", "warn");
    return;
  }
  var btn = document.getElementById("emBtnImportar");
  if (btn) btn.disabled = true;

  try {
    var deduped = emDedupRows(emParsedRows);
    var rowsToImport = deduped.rows;
    if (deduped.dups > 0) {
      emSetStatus(
        "Detectados " +
          deduped.dups +
          " cods duplicados — se conserva última ocurrencia. Importando " +
          rowsToImport.length +
          " filas únicas...",
        "warn",
      );
    }

    var BATCH = 500;
    var total = rowsToImport.length;
    var done = 0;
    for (var i = 0; i < total; i += BATCH) {
      var batch = rowsToImport.slice(i, i + BATCH);
      var r = await sb
        .from("estadistica_madre")
        .upsert(batch, { onConflict: "cod" });
      if (r.error) {
        throw new Error(r.error.message || "Error en upsert.");
      }
      done += batch.length;
      emSetStatus(
        "Importando... " +
          done +
          "/" +
          total +
          (deduped.dups > 0 ? " (dedup: " + deduped.dups + ")" : ""),
      );
    }
    try {
      localStorage.setItem("lastImport_em", new Date().toISOString());
    } catch (_) {}
    emRefreshLastImportLabel();
    emSetStatus(
      "Importación OK: " +
        done +
        " items upserteados a estadistica_madre" +
        (deduped.dups > 0
          ? " (" + deduped.dups + " duplicados consolidados)"
          : "") +
        ".",
      "ok",
    );
  } catch (err) {
    console.error("emImportar error", err);
    emSetStatus("Error en importación: " + (err.message || err), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  var input = document.getElementById("emFileInput");
  if (input) {
    input.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) emHandleFile(f);
    });
  }
  var btnImp = document.getElementById("emBtnImportar");
  if (btnImp) btnImp.addEventListener("click", emImportar);
  emRefreshLastImportLabel();
});
