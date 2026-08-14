// vendor-import-excel.js
// -----------------------------------------------------------------------------
// Módulo "Importar Excels Megashops" para el vendedor (Pablo, vend 10006) en
// mayorista.html. Un solo upload de un Excel de grupo (Poy / Megashop / Primer
// Precio) → se explota en N pedidos (uno por sucursal con cantidades), cada uno
// pre-resuelto (cliente por CUIT + dirección + productos matcheados). El
// vendedor revisa y confirma por pedido o "Confirmar todos". Confirma directo
// (submit_order_fast + sheets-proxy + entregas), igual que el admin.
//
// Reusa los helpers puros del loader (window.ExcelKrikosCore) y el catálogo
// (window.scotApi, provisto por scotapi-shim.js). NO duplica parseo ni match.
// -----------------------------------------------------------------------------
window.VendorImportExcel = (function () {
  var GROUPS = [
    { key: "poy", label: "Grupo Poy" },
    { key: "megashop", label: "Grupo Megashop" },
    { key: "primerprecio", label: "Grupo Primer Precio" },
  ];

  var $mount = null;
  var state = { group: "", fileName: "", orders: [], parsing: false };
  var cssDone = false;

  function core() { return window.ExcelKrikosCore; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtMoney(n) { return Math.round(Number(n || 0)).toLocaleString("es-AR"); }
  function toast(msg, type) { if (window.toast) window.toast(msg, type); }

  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css = [
      "#vieMount{max-width:920px;margin:0 auto}",
      ".vie-top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px}",
      ".vie-sel,.vie-file{padding:9px 12px;border:1px solid #ccc;border-radius:8px;font-size:14px;background:#fff}",
      ".vie-status{font-size:13px;color:#666;margin:8px 0;text-align:center}",
      ".vie-up{max-width:560px;margin:8px auto 4px;background:#fff;border:1px solid #e6e6e6;border-radius:14px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.06)}",
      ".vie-lbl{display:block;font-size:11px;color:#888;margin:0 0 6px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}",
      ".vie-up .vie-sel{width:100%;padding:11px 12px;border:1px solid #ccc;border-radius:10px;font-size:14px;background:#fff}",
      ".vie-drop{margin-top:14px;border:2px dashed #cfd6e4;border-radius:12px;padding:26px 16px;text-align:center;cursor:pointer;transition:.15s;background:#fafbff}",
      ".vie-drop:hover,.vie-drop.drag{border-color:#1f6feb;background:#eef4ff}",
      ".vie-drop.disabled{opacity:.45;pointer-events:none}",
      ".vie-drop .ic{font-size:30px;line-height:1}",
      ".vie-drop .t1{font-weight:700;font-size:15px;margin-top:8px}",
      ".vie-drop .t2{font-size:12px;color:#888;margin-top:2px}",
      ".vie-spinner{display:inline-block;width:15px;height:15px;border:2px solid #cfd6e4;border-top-color:#1f6feb;border-radius:50%;animation:vie-spin .7s linear infinite;vertical-align:middle;margin-right:8px}",
      "@keyframes vie-spin{to{transform:rotate(360deg)}}",
      ".vie-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:44px 16px;color:#555}",
      ".vie-spinner.big{width:42px;height:42px;border-width:3px;margin:0}",
      ".vie-loading .lt{margin-top:14px;font-size:14px;font-weight:600}",
      ".vie-order{position:relative;display:flex;flex-direction:column;min-height:196px}",
      ".vie-x{position:absolute;top:6px;right:8px;width:24px;height:24px;border:0;background:transparent;font-size:18px;line-height:1;color:#b3b3b3;cursor:pointer;border-radius:6px}",
      ".vie-x:hover{color:#c0392b;background:#f6eaea}",
      ".vie-btn.primary.mis{background:#e0483a}",
      ".vie-allbar{display:flex;justify-content:flex-end;margin-bottom:12px}",
      ".vie-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:stretch}",
      ".vie-order{border:1px solid #e2e2e2;border-radius:12px;padding:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.05)}",
      ".vie-order.done{border-color:#8bc48b;background:#f3faf3}",
      ".vie-order.err{border-color:#e0a0a0;background:#fdf3f3}",
      ".vie-suc{font-weight:700;font-size:15px;line-height:1.2}",
      ".vie-cust{font-size:12px;color:#333;margin-top:2px}",
      ".vie-cust .warn{color:#c0392b;font-weight:600}",
      ".vie-deliv-ro{font-size:12px;color:#555;margin-top:4px}",
      ".vie-meta{font-size:12px;font-weight:600;margin:8px 0 6px;min-height:32px}",
      ".vie-tbl{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;table-layout:fixed}",
      ".vie-tbl th,.vie-tbl td{border-bottom:1px solid #eee;padding:4px 5px;text-align:left;word-break:break-word;overflow-wrap:anywhere}",
      ".vie-tbl td.r,.vie-tbl th.r{text-align:right}",
      ".vie-tbl tr.nomatch td{color:#c0392b}",
      ".vie-btn{padding:8px 16px;border:0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}",
      ".vie-btn.primary{background:#1f6feb;color:#fff}",
      ".vie-btn.all{background:#111;color:#fff}",
      ".vie-btn.full{width:100%;margin-top:8px;padding:9px}",
      ".vie-btn:disabled{opacity:.5;cursor:default}",
      ".vie-done-tag{color:#2e7d32;font-weight:600;font-size:13px;margin-top:8px;text-align:center}",
      ".vie-details{margin-top:auto;padding-top:8px}",
      ".vie-details summary{cursor:pointer;font-size:12px;color:#1f6feb}",
      ".vie-tbl td.pmis{color:#e67e22;font-weight:700;background:#fff6ec}",
      ".vie-fix{margin:8px 0 0;padding:8px;border:1px dashed #d0d0d0;border-radius:8px;background:#fafafa}",
      ".vie-frow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0}",
      ".vie-in{flex:1;min-width:120px;padding:7px 10px;border:1px solid #ccc;border-radius:8px;font-size:13px}",
      ".vie-btn.sm{padding:7px 12px;font-size:13px;background:#1f6feb;color:#fff}",
      ".vie-error-box{color:#c0392b;font-size:13px;padding:8px}",
    ].join("\n");
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  }

  // ---- armado de items para una sucursal (copia parametrizada de rebuildItems) ----
  function buildItemsForBranch(sheet, branchCol) {
    var cols = sheet.cols;
    var items = [];
    sheet.dataRows.forEach(function (row) {
      if (core().isJunkRow(row, cols)) return;
      var rawQty = branchCol >= 0 ? Number(window.scotApi.parseNum(row[branchCol])) : 0;
      if (!rawQty || rawQty <= 0) return;
      var match = core().matchRowToProduct(row, cols);
      var p = match ? match.product : null;
      var excelUxb = cols.uxbCol != null ? Number(window.scotApi.parseNum(row[cols.uxbCol])) : 0;
      var prodUxb = p ? Number(p.uxb || 0) : 0;
      var uxb = excelUxb || prodUxb;
      var uxbMismatch = !!(p && excelUxb > 0 && prodUxb > 0 && excelUxb !== prodUxb);
      var cajas = uxb > 0 ? Math.round(rawQty / uxb) : Math.round(rawQty);
      var unitPrice = cols.priceCol != null ? Number(window.scotApi.parseNum(row[cols.priceCol])) : 0;
      if (!unitPrice && p) unitPrice = Number(p.list_price || 0);
      var listPrice = 0;
      if (cols.listPriceCol != null) listPrice = Number(window.scotApi.parseNum(row[cols.listPriceCol])) || 0;
      if (!listPrice && p) listPrice = Number(p.list_price || 0);
      var rawDesc = cols.descCol != null ? String(row[cols.descCol] || "") : "";
      // Precio que puso el CLIENTE en el Excel (crudo, sin fallback) para cruzar
      // contra nuestro precio LK (product.list_price).
      var excelPrice = cols.priceCol != null ? Number(window.scotApi.parseNum(row[cols.priceCol])) : 0;
      var excelList = cols.listPriceCol != null ? Number(window.scotApi.parseNum(row[cols.listPriceCol])) : 0;
      var lkList = p ? Number(p.list_price || 0) : 0;
      var precioCliente = excelList || excelPrice;
      var precioMismatch = !!(p && precioCliente > 0 && lkList > 0 && Math.round(precioCliente) !== Math.round(lkList));
      items.push({
        rawDesc: rawDesc, rawQty: rawQty, uxb: uxb, cajas: cajas,
        excelUxb: excelUxb, prodUxb: prodUxb, uxbMismatch: uxbMismatch,
        cajasMismatch: uxb > 0 && cajas * uxb !== Math.round(rawQty),
        excelPrice: excelPrice, excelList: excelList, lkList: lkList,
        precioCliente: precioCliente, precioMismatch: precioMismatch,
        unitPrice: unitPrice, listPrice: listPrice, product: p,
        isLoke: match ? match.isLoke : false,
        codLk: p ? String(p.cod || "").trim() : null,
        description: p ? p.description : rawDesc,
        found: !!p, included: !!p,
      });
    });
    return items;
  }

  // ---- submit de un pedido (copia parametrizada de submitOrder) ----
  async function submitBranchOrder(order) {
    var validItems = order.items.filter(function (it) { return it.included && it.found && (it.cajas || 0) > 0; });
    if (!validItems.length) throw new Error("Sin items válidos");
    var sessRes = await window.sb.auth.getSession();
    var session = sessRes.data && sessRes.data.session;
    if (!session) throw new Error("Sesión inválida");
    var authToken = session.access_token;
    var apiKey = window.SUPABASE_ANON_KEY || "";
    var subtotal = 0;
    var rpcItems = validItems.map(function (it) {
      var line = it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
      subtotal += line;
      return {
        product_id: it.product.id, cajas: it.cajas, uxb: it.uxb, is_loke: !!it.isLoke,
        unit_list_price: Number(it.listPrice || it.unitPrice || 0),
        unit_your_price: Number(it.unitPrice || 0), line_total: line,
      };
    });
    var paymentMethodText = "Contado";
    var rpcResult = await window.sb.rpc("submit_order_fast", {
      p_auth_user_id: session.user.id, p_customer_id: order.customer.id, p_status: "pendiente",
      p_payment_method: paymentMethodText, p_payment_discount: 0, p_web_discount: 0,
      p_subtotal: subtotal, p_total: subtotal, p_items: rpcItems,
    });
    if (rpcResult.error || !rpcResult.data) {
      throw new Error((rpcResult.error && (rpcResult.error.message || rpcResult.error.details)) || "RPC falló");
    }
    var orderId = rpcResult.data;
    var branchLabel = order.branchLabel || "";
    var deliveryDireccion = order.delivery || branchLabel || "";
    var sucursalEntrega = branchLabel
      ? (order.customer.business_name || "") + " — " + branchLabel
      : (order.customer.business_name || "");
    var sheetsPayload = {
      order_number: String(orderId), pdf_oc: "", cod_cliente: String(order.customer.cod_cliente || ""),
      vend: String(order.customer.vend || ""), condicion_pago: paymentMethodText, condicion_pago_code: 1,
      sucursal_entrega: sucursalEntrega, cliente_nuevo: "", is_promo: false, is_chef: false,
      target_sheet: "Pedidos Web", empresa: "LK", extra_discount: 0, deuda: Number(order.customer.debt || 0),
      payment_term: order.customer.payment_term == null ? null : Number(order.customer.payment_term),
      credit_limit: order.customer.credit_limit == null ? null : Number(order.customer.credit_limit),
      source: "Excel", items: validItems.map(function (it) { return { cod_art: it.codLk, cajas: it.cajas, uxb: it.uxb }; }),
    };
    window.sb.from("orders").update({
      sheets_payload: sheetsPayload, is_promo: false, extra_discount: 0, placed_by_auth_user_id: session.user.id,
    }).eq("id", orderId).then(function () {});
    core().sendToSheetsWithRetry(sheetsPayload, authToken, 3, apiKey).then(function () {
      window.sb.from("orders").update({ sheets_sent: true }).eq("id", orderId).then(function () {});
    }).catch(function (e) { console.warn("vie sheets:", e); });
    var entregasPayload = {
      order_number: orderId, fecha: new Date().toLocaleDateString("es-AR"),
      cod_cliente: order.customer.cod_cliente, cliente: order.customer.business_name,
      vendedor: order.customer.vend || "", direccion_entrega: deliveryDireccion, barrio_entrega: "",
      empresa: "LK", is_promo: false, extra_discount: 0,
      items: validItems.map(function (it) { return { cod_art: it.codLk, description: it.description || "", cajas: it.cajas, uxb: it.uxb }; }),
    };
    core().sendToEntregas(entregasPayload, authToken, apiKey);
    return orderId;
  }

  // ---- parseo + explosión ----
  async function handleFile(file) {
    if (!core() || !window.scotApi) { setStatus("Módulo no cargó (falta ExcelKrikosCore/scotApi).", "err"); return; }
    if (!window.XLSX) { setStatus("XLSX no cargó. Recargá la página.", "err"); return; }
    state.parsing = true; state.orders = []; state.fileName = file.name;
    setStatus('<span class="vie-spinner"></span>Procesando "' + esc(file.name) + '"…');
    showLoading();
    try {
      var buf = await file.arrayBuffer();
      var parsed = core().parseWorkbook(buf, file.name);
      var idx = -1;
      for (var i = 0; i < parsed.sheets.length; i++) { if (parsed.sheets[i].headerIdx >= 0) { idx = i; break; } }
      if (idx < 0) { setStatus("No se detectó una tabla de pedido con encabezados válidos.", "err"); state.parsing = false; clearLoading(); return; }
      var sheet = parsed.sheets[idx];
      var cols = sheet.cols;
      var autoEntries = core().parseFacturacionSheet(parsed.sheets);
      await Promise.all([window.scotApi.loadAllProducts(), window.scotApi.loadAllLokeProducts()]);
      var orders = [];
      cols.branchCols.forEach(function (bi) {
        var items = buildItemsForBranch(sheet, bi);
        if (!items.length) return; // sucursal sin pedido → no genera pedido
        var header = String(cols.headers[bi] || "").trim();
        var info = core().resolveBranchCustomer(header) || core().resolveBranchAuto(header, autoEntries);
        orders.push({
          branchCol: bi, branchLabel: header, info: info, items: items,
          customer: null, delivery: info ? info.delivery : "", status: "pending", orderId: null,
        });
      });
      // resolver clientes por CUIT (auto)
      for (var k = 0; k < orders.length; k++) {
        if (orders[k].info && orders[k].info.cuit) {
          orders[k].customer = await core().loadCustomerByCuit(orders[k].info.cuit);
        }
      }
      state.orders = orders;
      state.parsing = false;
      if (!orders.length) { setStatus("El Excel no tiene sucursales con pedido (columnas con cantidades).", "err"); clearLoading(); return; }
      var resolved = orders.filter(function (o) { return o.customer; }).length;
      setStatus(orders.length + " pedido(s) detectado(s) · " + resolved + " con cliente auto-resuelto. Revisá y confirmá.");
      renderOrders();
    } catch (e) {
      console.error("vie handleFile:", e);
      setStatus("Error procesando Excel: " + (e.message || e), "err");
      state.parsing = false;
      clearLoading();
    }
  }

  function setStatus(html, type) {
    var s = $mount && $mount.querySelector("#vieStatus");
    if (s) { s.innerHTML = html; s.style.color = type === "err" ? "#c0392b" : "#666"; }
  }
  function showLoading() {
    var box = $mount && $mount.querySelector("#vieOrders");
    if (box) box.innerHTML = '<div class="vie-loading"><span class="vie-spinner big"></span><div class="lt">Procesando pedido… separando por sucursal</div></div>';
  }
  function clearLoading() {
    var box = $mount && $mount.querySelector("#vieOrders");
    if (box && box.querySelector(".vie-loading")) box.innerHTML = "";
  }

  function orderCardHtml(o, i) {
    var found = o.items.filter(function (it) { return it.found; });
    var missing = o.items.filter(function (it) { return !it.found; });
    var priceMis = found.filter(function (it) { return it.precioMismatch; }).length;
    var uxbMis = found.filter(function (it) { return it.uxbMismatch; }).length;
    var hasErr = priceMis > 0 || uxbMis > 0;
    var impClte = found.reduce(function (a, it) { return a + (it.precioCliente || 0) * (it.cajas || 0) * (it.uxb || 0); }, 0);
    var impLK = found.reduce(function (a, it) { return a + (it.lkList || 0) * (it.cajas || 0) * (it.uxb || 0); }, 0);
    var cust = o.customer
      ? esc(o.customer.cod_cliente + " · " + (o.customer.business_name || "")) +
        (String(o.customer.vend || "") !== "6" ? ' <span class="warn">(vend ' + esc(o.customer.vend || "-") + ", no Pablo)</span>" : "")
      : '<span class="warn">Cliente NO resuelto' + (o.info && o.info.cuit ? " — CUIT " + esc(o.info.cuit) : "") + "</span>";
    var rows = o.items.map(function (it) {
      var pcCls = it.precioMismatch ? " pmis" : "";
      var pcCell = it.found
        ? '<td class="r' + pcCls + '">$' + fmtMoney(it.precioCliente || 0) + '</td><td class="r' + pcCls + '">$' + fmtMoney(it.lkList || 0) + "</td>"
        : '<td class="r">—</td><td class="r">—</td>';
      return '<tr class="' + (it.found ? "" : "nomatch") + '">' +
        "<td>" + esc(it.description || it.rawDesc) + (it.found ? "" : " ⚠") + "</td>" +
        "<td>" + esc(it.codLk || "—") + "</td>" +
        '<td class="r">' + (it.cajas || 0) + (it.cajasMismatch ? "*" : "") + "</td>" +
        '<td class="r' + (it.uxbMismatch ? " pmis" : "") + '">' + (it.uxb || 0) + (it.uxbMismatch ? "⚠" : "") + "</td>" +
        pcCell + "</tr>";
    }).join("");
    var canSubmit = o.customer && found.length && o.status !== "done";
    // Corrección manual SOLO del cliente cuando no resolvió. La sucursal NO se
    // edita: se muestra con el nombre/formato del Excel (read-only).
    var fix = "";
    if (o.status !== "done" && !o.customer) {
      fix = '<div class="vie-fix"><div class="vie-frow">' +
        '<input class="vie-in vieCustIn" data-i="' + i + '" placeholder="Cód cliente o CUIT" />' +
        '<button class="vie-btn sm vieCustBtn" data-i="' + i + '">Buscar</button></div></div>';
    }
    var deliv = esc(o.delivery || o.branchLabel || "");
    return '<div class="vie-order ' + (o.status === "done" ? "done" : o.status === "err" ? "err" : "") + '" data-i="' + i + '">' +
      (o.status !== "done" ? '<button class="vie-x vieCancel" data-i="' + i + '" title="Cancelar este pedido">×</button>' : "") +
      '<div class="vie-suc">' + esc(o.branchLabel || "Sucursal") + "</div>" +
      '<div class="vie-cust">' + cust + "</div>" +
      (deliv ? '<div class="vie-deliv-ro">📍 ' + deliv + "</div>" : "") +
      '<div class="vie-meta" style="color:' + (hasErr ? "#c0392b" : "#1f6feb") + '">' +
      "Ítems: " + found.length +
      " · Importe Pedido Clte: $" + fmtMoney(impClte) +
      " · Importe Pedido LK: $" + fmtMoney(impLK) +
      (missing.length ? " · " + missing.length + " sin match" : "") +
      (priceMis ? " · " + priceMis + " precio(s) ≠ LK" : "") +
      (uxbMis ? " · " + uxbMis + " UxB ≠ LK" : "") + "</div>" +
      (o.status === "done"
        ? '<div class="vie-done-tag">✓ Pedido ' + esc(o.orderId) + " subido</div>"
        : '<button class="vie-btn primary full' + (hasErr ? " mis" : "") + ' vieConfirm"' + (canSubmit ? "" : " disabled") + ' data-i="' + i + '">Confirmar pedido' + (hasErr ? " ⚠" : "") + "</button>") +
      fix +
      '<details class="vie-details"><summary>Ver ' + o.items.length + " ítems (precio/UxB cliente vs LK)</summary>" +
      '<table class="vie-tbl"><colgroup><col style="width:36%"><col style="width:13%"><col style="width:12%"><col style="width:12%"><col style="width:13%"><col style="width:14%"></colgroup>' +
      '<thead><tr><th>Producto</th><th>Cód</th><th class="r">Cajas</th><th class="r">UxB</th><th class="r">P. cli</th><th class="r">P. LK</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></details></div>";
  }

  // Buscar cliente manualmente por cod_cliente o CUIT.
  async function lookupCustomer(text) {
    var t = String(text || "").trim();
    if (!t) return null;
    var sel = "id,cod_cliente,business_name,cuit,vend,debt,dto_vol,payment_term,credit_limit";
    if (/^\d+$/.test(t) && t.length <= 8) {
      var r = await window.sb.from("customers").select(sel).eq("cod_cliente", Number(t)).limit(1);
      if (!r.error && r.data && r.data[0]) return r.data[0];
    }
    var d = t.replace(/\D/g, "");
    if (d.length >= 10) {
      var r2 = await window.sb.from("customers").select(sel).eq("cuit", d).limit(1);
      if (!r2.error && r2.data && r2.data[0]) return r2.data[0];
    }
    return null;
  }

  function renderOrders() {
    var box = $mount.querySelector("#vieOrders");
    if (!box) return;
    if (!state.orders.length) { box.innerHTML = ""; return; }
    var pend = state.orders.filter(function (o) { return o.customer && o.status !== "done" && o.items.some(function (it) { return it.found; }); }).length;
    // "Confirmar todos" NO aparece si algún pedido tiene un precio mal cargado
    // (hay que revisarlos/confirmarlos de a uno).
    var anyMis = state.orders.some(function (o) { return o.status !== "done" && o.customer && orderHasMismatch(o); });
    var allbar = anyMis
      ? '<div class="vie-allbar"><span style="font-size:12px;color:#c0392b;font-weight:600">⚠ Hay precios mal cargados — confirmá los pedidos de a uno.</span></div>'
      : '<div class="vie-allbar"><button class="vie-btn all" id="vieConfirmAll"' + (pend ? "" : " disabled") + ">Confirmar todos (" + pend + ")</button></div>";
    box.innerHTML = allbar +
      '<div class="vie-grid">' + state.orders.map(orderCardHtml).join("") + "</div>";
    box.querySelectorAll(".vieConfirm").forEach(function (b) {
      b.addEventListener("click", function () { confirmOne(parseInt(b.dataset.i, 10)); });
    });
    box.querySelectorAll(".vieCustBtn").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = parseInt(b.dataset.i, 10);
        var inp = box.querySelector('.vieCustIn[data-i="' + i + '"]');
        manualResolve(i, inp ? inp.value : "");
      });
    });
    box.querySelectorAll(".vieCancel").forEach(function (b) {
      b.addEventListener("click", function () { cancelOrder(parseInt(b.dataset.i, 10)); });
    });
    var allBtn = box.querySelector("#vieConfirmAll");
    if (allBtn) allBtn.addEventListener("click", confirmAll);
  }

  function orderHasMismatch(o) {
    return o.items.some(function (it) { return it.found && it.precioMismatch; });
  }
  function cancelOrder(i) {
    if (i < 0 || i >= state.orders.length) return;
    state.orders.splice(i, 1);
    renderOrders();
  }

  async function manualResolve(i, text) {
    var o = state.orders[i];
    if (!o) return;
    if (!String(text || "").trim()) { toast("Ingresá cód cliente o CUIT", "warning"); return; }
    var btn = $mount.querySelector('.vieCustBtn[data-i="' + i + '"]');
    if (btn) { btn.disabled = true; btn.textContent = "Buscando…"; }
    try {
      var c = await lookupCustomer(text);
      if (c) { o.customer = c; toast("Cliente " + c.cod_cliente + " asignado", "success"); }
      else { toast("No se encontró cliente con ese código/CUIT", "warning"); }
    } catch (e) { console.error("vie manualResolve:", e); toast("Error buscando cliente", "error"); }
    renderOrders();
  }

  async function confirmOne(i) {
    var o = state.orders[i];
    if (!o || o.status === "done" || !o.customer) return;
    if (orderHasMismatch(o) && !window.confirm("Seguro? Hay un precio mal cargado.")) return;
    var btn = $mount.querySelector('.vieConfirm[data-i="' + i + '"]');
    if (btn) { btn.disabled = true; btn.textContent = "Subiendo…"; }
    try {
      var id = await submitBranchOrder(o);
      o.status = "done"; o.orderId = id;
      toast("Pedido " + id + " subido", "success");
    } catch (e) {
      o.status = "err";
      console.error("vie confirmOne:", e);
      toast("Error: " + (e.message || e), "error");
    }
    renderOrders();
  }

  async function confirmAll() {
    var anyMis = state.orders.some(function (o) { return o.status !== "done" && o.customer && orderHasMismatch(o); });
    if (anyMis && !window.confirm("Seguro? Hay un precio mal cargado en uno o más pedidos.")) return;
    var allBtn = $mount.querySelector("#vieConfirmAll");
    if (allBtn) { allBtn.disabled = true; allBtn.textContent = "Subiendo…"; }
    for (var i = 0; i < state.orders.length; i++) {
      var o = state.orders[i];
      if (o.status === "done" || !o.customer || !o.items.some(function (it) { return it.found; })) continue;
      try { var id = await submitBranchOrder(o); o.status = "done"; o.orderId = id; }
      catch (e) { o.status = "err"; console.error("vie confirmAll:", e); }
    }
    renderOrders();
    toast("Confirmación masiva finalizada", "success");
  }

  function render() {
    injectCSS();
    $mount.innerHTML =
      '<div class="vie-up">' +
        '<label class="vie-lbl" for="vieGroup">Grupo</label>' +
        '<select class="vie-sel" id="vieGroup"><option value="">— Elegí el grupo —</option>' +
        GROUPS.map(function (g) { return '<option value="' + g.key + '">' + esc(g.label) + "</option>"; }).join("") +
        "</select>" +
        '<div class="vie-drop disabled" id="vieDrop">' +
          '<div class="ic">⬆️</div>' +
          '<div class="t1">Arrastrá el Excel acá</div>' +
          '<div class="t2">o hacé click para elegir (.xlsx)</div>' +
        "</div>" +
        '<input type="file" id="vieFile" accept=".xlsx,.xls" style="display:none" />' +
      "</div>" +
      '<div class="vie-status" id="vieStatus">Elegí el grupo y subí el Excel. Se separa un pedido por sucursal.</div>' +
      '<div id="vieOrders"></div>';
    var grpSel = $mount.querySelector("#vieGroup");
    var fileInp = $mount.querySelector("#vieFile");
    var drop = $mount.querySelector("#vieDrop");
    grpSel.addEventListener("change", function () {
      state.group = grpSel.value;
      drop.classList.toggle("disabled", !state.group);
    });
    drop.addEventListener("click", function () { if (state.group) fileInp.click(); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); if (state.group) drop.classList.add("drag"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("drag"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault(); drop.classList.remove("drag");
      if (!state.group) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    fileInp.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
    });
  }

  // API pública: montar en un elemento (llamado desde script.js al abrir la sección)
  function mount(elOrId) {
    $mount = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!$mount) return;
    state = { group: "", fileName: "", orders: [], parsing: false };
    render();
  }

  return { mount: mount };
})();
