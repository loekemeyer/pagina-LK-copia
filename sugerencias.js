// ================= SUPABASE =================
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

let ALL_SUGS = [];
let SHOW_ALL_SUGS = false;
let WEB_ORDER_DISCOUNT = 0.02; // default fallback}
let activeTab = "sugerencias"; // o "novedades"

// ================= IMÁGENES (igual que mayorista) =================
// Endpoint /render/image/public/ requiere image transformations (no habilitado en el tenant).
// /object/public/ sirve la imagen directo. Las fotos ya están en 400x400 WebP.
const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_PARAMS = ``;

function imgUrlByCod(cod) {
  const c = String(cod || "").trim();
  if (!c) return "img/no-image.jpg";
  return `${BASE_IMG}${encodeURIComponent(c)}.webp${IMG_PARAMS}`;
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ================= UI HELPERS =================
const $ = (id) => document.getElementById(id);

async function getWebOrderDiscount() {
  try {
    const { data, error } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "web_order_discount")
      .single();

    if (error) throw error;
    return Number(data?.value) || 0;
  } catch (e) {
    console.warn("No se pudo leer web_order_discount, usando default 0.02", e);
    return 0.02;
  }
}

function setStatus(msg) {
  $("status").style.display = "block";
  $("status").innerText = msg;
}

function showTable(show) {
  $("tablaSug").style.display = show ? "table" : "none";
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
      return obj[k];
  }
  return fallback;
}

function fmtPrecio(n) {
  const val = Number(n);
  if (isNaN(val)) return "";
  return val.toLocaleString("es-AR", { minimumFractionDigits: 2 });
}

// ================= STATE =================
let cliente = null;
let sugerenciasGlobal = [];
let sugMostrados = 5;

// ================= AUTH =================
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
    .select("cod_cliente, business_name, dto_vol")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();

  if (error) {
    console.error("getCliente error:", error);
    setStatus("No se pudo cargar el cliente (RLS o datos).");
    return null;
  }
  if (!data) {
    setStatus("No se encontró tu cliente asociado. (customers.auth_user_id)");
    return null;
  }
  return data;
}

// ================= DATA (RPC) =================
async function loadSugerencias(codCliente) {
  try {
    setStatus(
      activeTab === "novedades"
        ? "Cargando novedades…"
        : "Cargando sugerencias…",
    );

    // Traer datos según pestaña
    const rows =
      activeTab === "novedades"
        ? await fetchNovedades()
        : await fetchSugerencias(codCliente);

    sugerenciasGlobal = rows || [];

    // Reset cantidad mostrada
    sugMostrados = 5; // arranca en 5 para ambas

    renderSug();
    setStatus("");
  } catch (e) {
    console.error("loadSugerencias crash:", e);
    sugerenciasGlobal = [];
    renderSug();
    setStatus("Error cargando datos.");
  }
}

// ================= RENDER =================
function renderSug() {
  const thead = $("theadSug");
  const tbody = $("tbodySug");

  thead.innerHTML = `
    <tr>
      <th style="width:120px">Img</th>
      <th style="width:80px">Cod</th>
      <th>Descripción</th>
      <th style="width:70px">UxB</th>
      <th style="width:140px">Tu precio contado</th>
      <th style="width:300px">Motivo</th>
      <th style="width:220px">Pedido</th>
    </tr>
  `;

  tbody.innerHTML = "";

  const slice = sugerenciasGlobal.slice(0, sugMostrados);

  slice.forEach((r) => {
    const cod = pick(r, ["cod", "codigo", "item_code"]);
    const desc = pick(r, ["description", "descripcion", "articulo"]);
    const uxb = pick(r, ["uxb"]);
    const listPrice =
      Number(pick(r, ["list_price", "price_cash", "precio"])) || 0;
    const dtoVol = Number(cliente?.dto_vol || 0);

    // tuPrecio = list_price * (1 - dto_vol)
    const tuPrecio = listPrice * (1 - dtoVol);

    // tuPrecioContado = tuPrecio * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.25)
    const tuPrecioContado = Math.round(
      tuPrecio * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.25),
    );
    const msg = pick(r, ["texto_clientes", "mensaje", "texto"], "");
    const pid = String(pick(r, ["product_id", "id", "productId"], "")).trim();

    tbody.innerHTML += `
      <tr>
        <td class="imgcell">
          <img
            class="sug-img"
            src="${imgUrlByCod(cod)}"
            alt="${String(desc || "")}"
            width="400"
            height="400"
            loading="lazy"
            onerror="this.onerror=null;this.src='img/no-image.jpg'"
          />
        </td>
        <td>${cod}</td>
        <td class="desc">${desc}</td>
        <td class="uxb-cell">${uxb}</td>
        <td class="price-cell">
  $${tuPrecioContado.toLocaleString("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}
</td>       
        <td class="msg">${msg}</td>
        <td>
          <div class="sug-action">
            <div class="sug-stepper">
              <button type="button" class="sug-step-btn" onclick="sugDec('${pid}')">−</button>
              <input id="sugqty-${pid}" class="sug-step-in" type="number" min="0" value="0" />
              <button type="button" class="sug-step-btn" onclick="sugInc('${pid}')">+</button>
            </div>

            <button
              type="button"
              class="sug-add-btn"
              id="sugadd-${pid}"
              onclick="sugAdd('${pid}')"
              ${pid ? "" : "disabled"}
              title="${pid ? "" : "Falta product_id en la sugerencia"}"
            >
              Agregar al pedido
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  showTable(true);

  const btnVerMas = $("btnVerMas");
  if (btnVerMas) {
    btnVerMas.style.display =
      sugerenciasGlobal.length > sugMostrados ? "block" : "none";
  }
}

// Trae los clientes linkeados al vendedor (misma lógica que mayorista)
async function loadLinkedCustomersSug() {
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
    console.error("loadLinkedCustomersSug error:", e);
    return [];
  }
}

// Busca dto_vol (y confirma business_name) del cliente en la tabla customers
async function fetchCustomerFull(customerId) {
  try {
    const { data, error } = await sb
      .from("customers")
      .select("cod_cliente, business_name, dto_vol")
      .eq("id", customerId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.error("fetchCustomerFull error:", e);
    return null;
  }
}

function renderClienteSelectorSug(linked, currentCod, onChangeClient) {
  const old = document.getElementById("sug-cliente-selector");
  if (old) old.remove();
  if (!linked || !linked.length) return;

  const wrap = document.createElement("div");
  wrap.id = "sug-cliente-selector";
  wrap.className = "sug-cliente-selector";

  const label = document.createElement("label");
  label.setAttribute("for", "sugClienteSelect");
  label.textContent = "Ver sugerencias de:";
  label.className = "sug-cliente-label";

  const sel = document.createElement("select");
  sel.id = "sugClienteSelect";
  sel.className = "sug-cliente-select";

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

// ================= INIT =================
async function init() {
  try {
    setStatus("Cargando…");

    $("btnVerMas")?.addEventListener("click", () => {
      sugMostrados = Math.min(sugerenciasGlobal.length, sugMostrados + 5);
      renderSug();
    });

    const session = await getSession();
    if (!session) return;

    // FAST PATH ADMIN OVERRIDE: si URL tiene ?cod=X, ignorar todo lo demás
    // (linked / LS / selector) y mostrar solo ese cliente.
    const adminCodEarly = (() => {
      try {
        const p = new URLSearchParams(window.location.search);
        return (p.get("cod") || "").trim();
      } catch (e) {
        return "";
      }
    })();
    console.log("[sugerencias] adminCod from URL:", adminCodEarly || "(none)");

    if (adminCodEarly) {
      // Body marker — CSS oculta elementos no relevantes en contexto admin
      document.body.classList.add("lk-admin-embed");
      let bizName = "";
      let dtoVol = 0;
      try {
        const r = await sb
          .from("customers")
          .select("business_name, dto_vol")
          .eq("cod_cliente", adminCodEarly)
          .maybeSingle();
        if (r && r.data) {
          bizName = r.data.business_name || "";
          dtoVol = r.data.dto_vol != null ? Number(r.data.dto_vol) : 0;
        }
      } catch (e) {
        console.warn("admin override: fetch customer failed", e);
      }
      cliente = {
        cod_cliente: adminCodEarly,
        business_name: bizName,
        dto_vol: dtoVol,
      };
      console.log("[sugerencias] ADMIN MODE — cliente:", cliente);

      $("cliente").innerText =
        `Cliente: ${cliente.business_name || "(sin nombre)"} (${cliente.cod_cliente})`;

      WEB_ORDER_DISCOUNT = await getWebOrderDiscount();
      await loadSugerencias(cliente.cod_cliente);

      // Tabs siguen funcionando — sin selector de clientes
      $("tabSugerencias")?.addEventListener("click", async () => {
        activeTab = "sugerencias";
        $("tabSugerencias")?.classList.add("active");
        $("tabNovedades")?.classList.remove("active");
        sugMostrados = 5;
        await loadSugerencias(cliente.cod_cliente);
      });
      $("tabNovedades")?.addEventListener("click", async () => {
        activeTab = "novedades";
        $("tabNovedades")?.classList.add("active");
        $("tabSugerencias")?.classList.remove("active");
        sugMostrados = 5;
        await loadSugerencias(cliente.cod_cliente);
      });
      return;
    }

    const linked = await loadLinkedCustomersSug();

    // (path normal — vendedor o cliente final)
    const adminCod = (() => {
      try {
        const p = new URLSearchParams(window.location.search);
        return (p.get("cod") || "").trim();
      } catch (e) {
        return "";
      }
    })();

    let vendorSelectedCod = "";
    let vendorSelectedName = "";
    let vendorSelectedDtoVol = null;

    if (adminCod) {
      try {
        const r = await sb
          .from("customers")
          .select("cod_cliente, business_name, dto_vol")
          .eq("cod_cliente", adminCod)
          .maybeSingle();
        if (r && r.data) {
          vendorSelectedCod = String(r.data.cod_cliente || "").trim();
          vendorSelectedName = r.data.business_name || "";
          vendorSelectedDtoVol = r.data.dto_vol != null ? String(r.data.dto_vol) : null;
        }
      } catch (e) {
        console.warn("admin override: fetch customer failed", e);
      }
    } else {
      vendorSelectedCod = (() => {
        try {
          return (
            localStorage.getItem("lk_vendor_selected_cod_cliente") || ""
          ).trim();
        } catch (e) {
          return "";
        }
      })();
      vendorSelectedName = (() => {
        try {
          return (
            localStorage.getItem("lk_vendor_selected_business_name") || ""
          ).trim();
        } catch (e) {
          return "";
        }
      })();
      vendorSelectedDtoVol = (() => {
        try {
          return localStorage.getItem("lk_vendor_selected_dto_vol");
        } catch (e) {
          return null;
        }
      })();
    }

    if (vendorSelectedCod) {
      cliente = {
        cod_cliente: vendorSelectedCod,
        business_name: vendorSelectedName,
        dto_vol:
          vendorSelectedDtoVol !== null ? Number(vendorSelectedDtoVol) : 0,
      };
    } else if (linked && linked.length) {
      // Vendedor / grupo sin cliente pre-seleccionado: usar el primero vinculado
      const first = linked[0];
      const fullFirst = await fetchCustomerFull(first.customer_id);
      const dto =
        fullFirst && fullFirst.dto_vol != null ? Number(fullFirst.dto_vol) : 0;
      cliente = {
        cod_cliente: String(first.cod_cliente || "").trim(),
        business_name:
          (fullFirst && fullFirst.business_name) || first.business_name || "",
        dto_vol: dto,
      };
      try {
        localStorage.setItem(
          "lk_vendor_selected_cod_cliente",
          String(cliente.cod_cliente),
        );
        localStorage.setItem(
          "lk_vendor_selected_business_name",
          cliente.business_name || "",
        );
        localStorage.setItem("lk_vendor_selected_dto_vol", String(dto));
      } catch (e) {}
    } else {
      cliente = await getCliente(session);
      if (!cliente) return;
    }

    $("cliente").innerText =
      `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;

    WEB_ORDER_DISCOUNT = await getWebOrderDiscount();
    await loadSugerencias(cliente.cod_cliente);

    renderClienteSelectorSug(linked, cliente.cod_cliente, async (newClient) => {
      setStatus("Cargando…");
      const full = await fetchCustomerFull(newClient.customer_id);
      const dto = full && full.dto_vol != null ? Number(full.dto_vol) : 0;
      cliente = {
        cod_cliente: newClient.cod_cliente,
        business_name: (full && full.business_name) || newClient.business_name,
        dto_vol: dto,
      };
      try {
        localStorage.setItem(
          "lk_vendor_selected_cod_cliente",
          String(cliente.cod_cliente || ""),
        );
        localStorage.setItem(
          "lk_vendor_selected_business_name",
          cliente.business_name || "",
        );
        localStorage.setItem("lk_vendor_selected_dto_vol", String(dto));
      } catch (e) {}
      $("cliente").innerText =
        `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;
      sugMostrados = 5;
      await loadSugerencias(cliente.cod_cliente);
    });
  } catch (e) {
    console.error("Init crash:", e);
    setStatus("Error inesperado. Ver consola.");
  }

  // Tabs
  $("tabSugerencias")?.addEventListener("click", async () => {
    activeTab = "sugerencias";
    $("tabSugerencias")?.classList.add("active");
    $("tabNovedades")?.classList.remove("active");

    sugMostrados = 5;
    await loadSugerencias(cliente.cod_cliente);
  });

  $("tabNovedades")?.addEventListener("click", async () => {
    activeTab = "novedades";
    $("tabNovedades")?.classList.add("active");
    $("tabSugerencias")?.classList.remove("active");

    sugMostrados = 5;
    await loadSugerencias(cliente.cod_cliente);
  });
}

// ===== LOADER CONTROL (solo 1ra vez, con failsafe) =====
function setupLoaderOnce() {
  const loader = document.getElementById("pageLoader");
  if (!loader) return;

  const key = `lk_loader_seen_v1:${location.pathname.split("/").pop()}`;

  // si ya se vio, sacar instantáneo
  try {
    if (localStorage.getItem(key) === "1") {
      loader.remove();
      return;
    }
  } catch {}

  const kill = () => {
    const l = document.getElementById("pageLoader");
    if (!l) return;
    l.style.transition = "opacity 0.4s ease";
    l.style.opacity = "0";
    setTimeout(() => l.remove(), 450);
  };

  // pase lo que pase: máximo 12s
  setTimeout(kill, 12000);

  // normal: 5-10s
  const delay = 5000 + Math.random() * 5000;
  setTimeout(() => {
    try {
      localStorage.setItem(key, "1");
    } catch {}
    kill();
  }, delay);
}

async function fetchSugerencias(codCliente) {
  const { data, error } = await sb.rpc("sugerencias_cliente", {
    p_customer: String(codCliente),
  });
  if (error) throw error;
  return data || [];
}

async function fetchNovedades() {
  const { data, error } = await sb.rpc("novedades_marca");
  if (error) throw error;
  return data || [];
}
document.addEventListener("DOMContentLoaded", () => {
  setupLoaderOnce();
  init();
});

// ================= CARRITO (shared con mayorista) =================
const CART_LS_KEY = "lk_mayorista_cart_v1";

function readCartLS() {
  try {
    const raw = localStorage.getItem(CART_LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCartLS(arr) {
  try {
    localStorage.setItem(CART_LS_KEY, JSON.stringify(arr));
  } catch {}
}

function addToCartLS(productId, qtyCajas) {
  const pid = String(productId || "").trim();
  const q = Math.max(1, parseInt(qtyCajas, 10) || 1);
  if (!pid) return;

  const cart = readCartLS();
  const found = cart.find((x) => String(x.productId) === pid);

  if (found) {
    found.qtyCajas = Math.max(1, (parseInt(found.qtyCajas, 10) || 0) + q);
  } else {
    cart.push({ productId: pid, qtyCajas: q, source: "sugerencias" });
    logCartAddEventSug(pid);
  }

  writeCartLS(cart);
}

// Registra en background el click de "agregar" desde el módulo Sugerencias
// (misma tabla que usa mayorista.html para medir uso por módulo).
function logCartAddEventSug(productId) {
  sb.auth
    .getSession()
    .then(({ data }) => {
      const session = data && data.session;
      if (!session) return;
      return sb.from("cart_add_events").insert({
        customer_id: null,
        auth_user_id: session.user.id,
        product_id: productId,
        source: "sugerencias",
      });
    })
    .catch(() => {});
}

// Handlers globales para onclick del HTML
window.sugDec = function (pid) {
  const el = document.getElementById(`sugqty-${pid}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) - 1);
};

window.sugInc = function (pid) {
  const el = document.getElementById(`sugqty-${pid}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) + 1);
};

window.sugAdd = function (pid) {
  const el = document.getElementById(`sugqty-${pid}`);
  const qty = el ? Math.max(0, parseInt(el.value, 10) || 0) : 0;

  // ✅ si está en 0, no agrega
  if (qty <= 0) return;

  addToCartLS(pid, qty);

  const btn = document.getElementById(`sugadd-${pid}`);
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
