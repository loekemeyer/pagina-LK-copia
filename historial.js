// ================= SUPABASE =================
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ================= IMÁGENES =================
// Endpoint /render/image/public/ requiere image transformations (no habilitado en el tenant).
// /object/public/ sirve la imagen directo. Las fotos ya están en 400x400 WebP.
const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_PARAMS = ``;

// ================= CATALOGO ACTIVO =================
let CATALOGO_CODES = new Set();

function imgUrlByCod(cod) {
  const c = String(cod || "").trim();
  if (!c) return "img/no-image.jpg";
  return `${BASE_IMG}${encodeURIComponent(c)}.webp${IMG_PARAMS}`;
}

// helpers
const $ = (id) => document.getElementById(id);
const statusBox = $("status");
const tabla = $("tabla");
const thead = $("thead");
const tbody = $("tbody");

function setStatus(msg) {
  statusBox.style.display = "block";
  statusBox.innerText = msg;
  tabla.style.display = "none";
}

async function getSession() {
  const { data, error } = await sb.auth.getSession();
  if (error) {
    console.error("getSession error:", error);
    setStatus("Error de sesión.");
    return null;
  }

  if (!data?.session) {
    setStatus("No hay sesión iniciada. Volviendo a Mayorista…");
    setTimeout(() => (location.href = "/mayorista"), 800);
    return null;
  }

  return data.session;
}

async function getCliente(session) {
  const { data, error } = await sb
    .from("customers")
    .select("cod_cliente, business_name")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();

  if (error) {
    console.error("getCliente error:", error);
    setStatus("No se pudo cargar el cliente (RLS o datos).");
    return null;
  }
  if (!data) {
    setStatus(
      "No se encontró tu cliente asociado. (falta vincular auth_user_id)",
    );
    return null;
  }
  return data;
}

/**
 * IMPORTANTE:
 * Esta vista debe existir:
 *   public.v_customer_item_month
 * con columnas: customer_code, ym (YYYY-MM), item_code, description, boxes
 *
 * FIX CLAVE:
 * Filtramos por customer_code acá para evitar que una view que NO respeta RLS
 * mezcle clientes y te infle totales.
 */
async function getHistory(codCliente) {
  const cc = String(codCliente).trim();

  const { data, error } = await sb.rpc("get_customer_history", {
    p_cod_cliente: cc,
  });

  if (error) {
    console.error("getHistory error:", error);
    setStatus("Error cargando historial.");
    return [];
  }

  const rows = data || [];
  rows.sort((a, b) => String(b.ym || "").localeCompare(String(a.ym || "")));
  return rows;
}

async function getCatalogCodes() {
  const { data, error } = await sb
    .from("products")
    .select("cod")
    .eq("active", true);

  if (error) {
    console.error("getCatalogCodes error:", error);
    return new Set();
  }

  return new Set(
    (data || []).map((r) => String(r.cod || "").trim()).filter(Boolean),
  );
}

// Artículos LOKE excluidos del historial
const EXCLUDED_CODES = new Set([
  "101",
  "103",
  "104",
  "108",
  "110",
  "111",
  "112",
  "113",
  "114",
  "115",
  "116",
  "119",
  "120",
  "121",
  "123",
  "186",
  "193",
]);

function renderTabla(rows) {
  if (!rows || !rows.length) {
    setStatus("Sin datos");
    return;
  }

  // Filtrar artículos excluidos
  rows = rows.filter((r) => !EXCLUDED_CODES.has((r.item_code || "").trim()));

  if (!rows.length) {
    setStatus("Sin datos");
    return;
  }

  // 1) Meses presentes (ym ya viene como 'YYYY-MM')
  const mesesSet = new Set();
  for (const r of rows) {
    const ym = (r.ym || "").trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    mesesSet.add(ym);
  }

  // Orden: más reciente a la izquierda (DESC)
  const meses = Array.from(mesesSet).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const meses60 = meses.slice(0, 60);

  // 2) Agrupar por item_code y sumar cajas por mes
  const map = {};
  for (const r of rows) {
    const item = (r.item_code || "").trim();
    if (!item) continue;

    const key = (r.ym || "").trim();
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!meses60.includes(key)) continue;

    const boxes = Number(r.boxes) || 0;

    if (!map[item]) {
      map[item] = {
        desc: (r.description || "").trim() || item,
        total: 0,
        meses: {},
      };
    }

    map[item].total += boxes;
    map[item].meses[key] = (map[item].meses[key] || 0) + boxes;
  }

  // Orden solo por total vendido (mayor a menor)
  const arr = Object.entries(map)
    .map(([cod, v]) => ({
      cod,
      ...v,
      enCatalogo: CATALOGO_CODES.has(String(cod).trim()),
    }))
    .sort((a, b) => b.total - a.total);

  // 3) Header — fila de AÑO + fila de MES

  thead.innerHTML = "";

  // --- Fila de año (colspan por grupo) ---
  const trYear = document.createElement("tr");

  // 5 columnas fijas vacías (Cod, Desc, Foto, Total, Pedido)
  for (let i = 0; i < 5; i++) {
    const th = document.createElement("th");
    th.className = "year-empty";
    if (i === 0) th.rowSpan = 1;
    trYear.appendChild(th);
  }

  // Agrupar meses consecutivos por año
  const yearGroups = [];
  let curYear = null;
  let curCount = 0;
  for (const ym of meses60) {
    const y = ym.slice(0, 4);
    if (y === curYear) {
      curCount++;
    } else {
      if (curYear !== null) yearGroups.push({ year: curYear, span: curCount });
      curYear = y;
      curCount = 1;
    }
  }
  if (curYear !== null) yearGroups.push({ year: curYear, span: curCount });

  for (const g of yearGroups) {
    const th = document.createElement("th");
    th.className = "year-th";
    th.colSpan = g.span;
    th.innerText = g.year;
    trYear.appendChild(th);
  }

  thead.appendChild(trYear);

  // --- Fila de meses ---
  const trh = document.createElement("tr");

  ["Cod", "Descripción", "Imagen", "Total", "Pedido"].forEach((t) => {
    const th = document.createElement("th");
    th.innerText = t;
    trh.appendChild(th);
  });

  // formato mmm-yy
  meses60.forEach((ym) => {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    const fecha = new Date(y, m - 1, 1);

    const nombre = fecha
      .toLocaleString("es-AR", { month: "short" })
      .replace(".", "")
      .toLowerCase();

    const th = document.createElement("th");
    th.className = "mes-th";
    th.innerText = nombre;
    trh.appendChild(th);
  });

  thead.appendChild(trh);

  // 4) Body
  tbody.innerHTML = "";

  for (const p of arr) {
    const tr = document.createElement("tr");

    const tdCod = document.createElement("td");
    tdCod.innerText = p.cod;
    tr.appendChild(tdCod);

    const tdDesc = document.createElement("td");
    tdDesc.innerText = p.desc;
    tdDesc.className = "desc";
    tr.appendChild(tdDesc);

    const tdFoto = document.createElement("td");
    const img = document.createElement("img");
    img.src = imgUrlByCod(p.cod);
    img.alt = p.desc || p.cod;
    img.width = 400;
    img.height = 400;
    img.loading = "lazy";
    img.className = "h-img-mini";
    img.onerror = function () {
      this.style.display = "none";
    };
    tdFoto.appendChild(img);
    tr.appendChild(tdFoto);

    const tdTotal = document.createElement("td");
    tdTotal.innerText = p.total;
    tr.appendChild(tdTotal);

    const cod = String(p.cod).trim();
    const enCatalogo = CATALOGO_CODES.has(cod);

    const tdPedido = document.createElement("td");
    tdPedido.className = "pedido-td";

    if (enCatalogo) {
      tdPedido.innerHTML = `
        <div class="h-action">
          <div class="h-stepper">
            <button type="button" class="h-step-btn" onclick="hDec('${cod}')">−</button>
            <input id="hqty-${cod}" class="h-step-in" type="number" min="0" value="0" />
            <button type="button" class="h-step-btn" onclick="hInc('${cod}')">+</button>
          </div>
          <button type="button" class="h-add-btn" id="hadd-${cod}" onclick="hAdd('${cod}')">
            Agregar
          </button>
        </div>
      `;
    } else {
      tdPedido.innerHTML = `
        <span class="h-inactive">Inactivo</span>
      `;
    }

    tr.appendChild(tdPedido);

    meses60.forEach((ym) => {
      const td = document.createElement("td");
      const val = p.meses[ym] ? String(p.meses[ym]) : "";
      td.innerText = val;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  // 5) Mostrar y habilitar scroll horizontal
  statusBox.style.display = "none";
  tabla.style.display = "table";
  tabla.style.width = "max-content";
  tabla.style.minWidth = "100%";

  // Sync dual scroll width
  const topInner = document.getElementById("scrollTopInner");
  if (topInner) topInner.style.width = tabla.scrollWidth + "px";
}

// Trae los clientes linkeados al vendedor (igual lógica que mayorista)
async function loadLinkedCustomersHistorial() {
  try {
    const [vendorRes, groupRes] = await Promise.all([
      sb.rpc("get_my_linked_customers"),
      sb.rpc("get_my_group_customers"),
    ]);
    const vendorList = vendorRes.error ? [] : vendorRes.data || [];
    const groupList = groupRes.error ? [] : groupRes.data || [];
    const seen = {};
    const merged = [];
    vendorList.forEach((c) => {
      if (!seen[c.customer_id]) {
        seen[c.customer_id] = true;
        merged.push(c);
      }
    });
    groupList.forEach((c) => {
      if (!seen[c.customer_id]) {
        seen[c.customer_id] = true;
        merged.push(c);
      }
    });
    return merged;
  } catch (e) {
    console.error("loadLinkedCustomersHistorial error:", e);
    return [];
  }
}

function renderClienteSelectorHistorial(linked, currentCod, onChangeClient) {
  const old = document.getElementById("hist-cliente-selector");
  if (old) old.remove();
  if (!linked || !linked.length) return;

  const wrap = document.createElement("div");
  wrap.id = "hist-cliente-selector";
  wrap.className = "hist-cliente-selector";

  const label = document.createElement("label");
  label.setAttribute("for", "histClienteSelect");
  label.textContent = "Ver historial de:";
  label.className = "hist-cliente-label";

  const sel = document.createElement("select");
  sel.id = "histClienteSelect";
  sel.className = "hist-cliente-select";

  linked.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.cod_cliente);
    opt.textContent = `${c.business_name} (${c.cod_cliente})`;
    if (String(c.cod_cliente) === String(currentCod)) opt.selected = true;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    const match = linked.find((c) => String(c.cod_cliente) === sel.value);
    if (!match) return;
    onChangeClient(match);
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);

  const clienteDiv = document.getElementById("cliente");
  if (clienteDiv && clienteDiv.parentNode) {
    clienteDiv.parentNode.insertBefore(wrap, clienteDiv);
  }
}

async function init() {
  try {
    setStatus("Cargando...");
    const session = await getSession();
    if (!session) return;

    // ADMIN OVERRIDE: si la URL tiene ?cod=X (uso desde panel admin via
    // iframe), tiene prioridad sobre cualquier otra detección de cliente.
    const adminCod = (() => {
      try {
        const p = new URLSearchParams(window.location.search);
        return (p.get("cod") || "").trim();
      } catch (e) {
        return "";
      }
    })();
    console.log("[historial] adminCod from URL:", adminCod || "(none)");

    // FAST PATH: admin override — NO leer linked customers, NO LS, NO selector
    if (adminCod) {
      // Marca el body para que CSS pueda ocultar elementos no deseados en
      // contexto admin embed (botón Volver a productos, info-box, etc.)
      document.body.classList.add("lk-admin-embed");
      let businessName = "";
      try {
        const r = await sb
          .from("customers")
          .select("business_name")
          .eq("cod_cliente", adminCod)
          .maybeSingle();
        if (r && r.data) businessName = r.data.business_name || "";
      } catch (e) {
        console.warn("admin override: fetch business_name failed", e);
      }
      const cliente = {
        cod_cliente: adminCod,
        business_name: businessName,
      };
      console.log("[historial] ADMIN MODE — cliente:", cliente);

      $("cliente").innerText =
        `Cliente: ${cliente.business_name || "(sin nombre)"} (${cliente.cod_cliente})`;

      CATALOGO_CODES = await getCatalogCodes();

      const rows = await getHistory(cliente.cod_cliente);
      console.log("[historial] rows for cod " + cliente.cod_cliente + ":", rows.length);
      await renderTabla(rows);
      return; // no renderizamos selector ni nada más
    }

    const linked = await loadLinkedCustomersHistorial();

    // If a vendor has selected a client, use that client instead
    const vendorSelectedCod = (() => {
      try {
        return (
          localStorage.getItem("lk_vendor_selected_cod_cliente") || ""
        ).trim();
      } catch (e) {
        return "";
      }
    })();
    let vendorSelectedName = (() => {
      try {
        return (
          localStorage.getItem("lk_vendor_selected_business_name") || ""
        ).trim();
      } catch (e) {
        return "";
      }
    })();

    let cliente;
    if (vendorSelectedCod) {
      cliente = {
        cod_cliente: vendorSelectedCod,
        business_name: vendorSelectedName,
      };
    } else if (linked && linked.length) {
      // Vendedor / grupo sin cliente pre-seleccionado: usar el primero vinculado
      const first = linked[0];
      cliente = {
        cod_cliente: String(first.cod_cliente || "").trim(),
        business_name: first.business_name || "",
      };
      try {
        localStorage.setItem(
          "lk_vendor_selected_cod_cliente",
          cliente.cod_cliente,
        );
        localStorage.setItem(
          "lk_vendor_selected_business_name",
          cliente.business_name,
        );
        if (first.dto_vol != null) {
          localStorage.setItem(
            "lk_vendor_selected_dto_vol",
            String(first.dto_vol),
          );
        }
      } catch (e) {}
    } else {
      cliente = await getCliente(session);
      if (!cliente) return;
    }

    $("cliente").innerText =
      `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;

    CATALOGO_CODES = await getCatalogCodes();

    const rows = await getHistory(cliente.cod_cliente);
    await renderTabla(rows);

    renderClienteSelectorHistorial(
      linked,
      cliente.cod_cliente,
      async (newClient) => {
        cliente = {
          cod_cliente: newClient.cod_cliente,
          business_name: newClient.business_name,
        };
        try {
          localStorage.setItem(
            "lk_vendor_selected_cod_cliente",
            String(newClient.cod_cliente || ""),
          );
          localStorage.setItem(
            "lk_vendor_selected_business_name",
            newClient.business_name || "",
          );
          if (newClient.dto_vol != null) {
            localStorage.setItem(
              "lk_vendor_selected_dto_vol",
              String(newClient.dto_vol),
            );
          }
        } catch (e) {}
        $("cliente").innerText =
          `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;
        setStatus("Cargando...");
        const rows2 = await getHistory(cliente.cod_cliente);
        await renderTabla(rows2);
      },
    );
  } catch (e) {
    console.error("Init crash:", e);
    setStatus("Error inesperado cargando historial. Ver consola.");
  }
}

// ====== Cola de agregados desde Historial (por COD) ======
const HISTORY_PENDING_KEY = "lk_pending_adds_cod_v1";

function readPendingAdds() {
  try {
    const raw = localStorage.getItem(HISTORY_PENDING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePendingAdds(arr) {
  try {
    localStorage.setItem(HISTORY_PENDING_KEY, JSON.stringify(arr));
  } catch {}
}

window.hDec = function (cod) {
  const el = document.getElementById(`hqty-${cod}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) - 1);
};

window.hInc = function (cod) {
  const el = document.getElementById(`hqty-${cod}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) + 1);
};

// Registra en background el click de "Volver a pedir" desde Historial
// (misma tabla que usa mayorista.html para medir uso por módulo). Acá solo
// tenemos el código de producto (no el id), se guarda en product_cod.
function logCartAddEventHist(cod) {
  sb.auth
    .getSession()
    .then(({ data }) => {
      const session = data && data.session;
      if (!session) return;
      return sb.from("cart_add_events").insert({
        customer_id: null,
        auth_user_id: session.user.id,
        product_cod: cod,
        source: "historial",
      });
    })
    .catch(() => {});
}

window.hAdd = function (cod) {
  const code = String(cod).trim();

  // seguridad extra
  if (!CATALOGO_CODES.has(code)) return;

  const el = document.getElementById(`hqty-${code}`);
  const qty = el ? Math.max(0, parseInt(el.value, 10) || 0) : 0;

  if (qty <= 0) return;

  const list = readPendingAdds();
  const found = list.find((x) => String(x.cod).trim() === code);

  if (found) found.qty = (parseInt(found.qty, 10) || 0) + qty;
  else list.push({ cod: code, qty });

  writePendingAdds(list);
  logCartAddEventHist(code);

  const btn = document.getElementById(`hadd-${code}`);
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "Agregado ✓";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 900);
  }
};

document.addEventListener("DOMContentLoaded", init);
