/* =====================================================================
   Modulo "Consulta de clientes"  ·  consulta.html
   ---------------------------------------------------------------------
   Pantalla de SOLO LECTURA para un empleado que no es admin ni cliente.
   Entra con CUIT + clave (mismo esquema sintetico <digitos>@cuit.loekemeyer
   del resto del sitio) y ve, por cliente:
       - "No le compran": articulos que el cliente NO compra y que compra el
         resto del padron, ordenados por penetracion.
       - "Si le compran": el historial por articulo, 12m contra los 12 previos.

   Todo el calculo vive en Supabase (consulta_buscar_clientes /
   consulta_historial / consulta_faltantes, en sql/consulta_clientes.sql).
   Aca no hay reglas de negocio: si algo esta mal, se arregla en la RPC.

   Quien puede entrar lo decide la tabla consulta_usuarios; las RPC tienen el
   guard adentro, asi que esta pantalla NO es la seguridad, es la cara.
   ===================================================================== */

// ================= SUPABASE =================
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Fotos: mismo bloque que script.js / historial.js / sugerencias.js.
// Endpoint /render/image/ NO va (image transformations deshabilitado en el
// tenant): las fotos ya estan pre-renderizadas 400x400 webp.
const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_PARAMS = `?v=20260916`;

function imgUrlByCod(cod) {
  const c = String(cod || "").trim();
  if (!c) return "img/no-image.jpg";
  return `${BASE_IMG}${encodeURIComponent(c)}.webp${IMG_PARAMS}`;
}

// ================= ESTADO =================
const $ = (id) => document.getElementById(id);

let PERFIL = null; // { nombre, es_admin }
let CLIENTE = null; // { cod_cliente, business_name, cuit, ... }
let FALTANTES = [];
let HISTORIAL = [];
let TAB = "falta"; // "falta" | "compra"
let buscarTimer = null;

// ================= HELPERS =================
function num(n, dec = 0) {
  const v = Number(n || 0);
  return v.toLocaleString("es-AR", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function plata(n) {
  const v = Number(n || 0);
  return "$" + v.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

function fecha(f) {
  if (!f) return "—";
  const p = String(f).slice(0, 10).split("-");
  if (p.length !== 3) return String(f);
  return `${p[2]}/${p[1]}/${p[0]}`;
}

// Meses enteros desde una fecha ISO hasta hoy. Sirve para "hace X meses".
function mesesDesde(f) {
  if (!f) return null;
  const d = new Date(String(f).slice(0, 10) + "T00:00:00");
  if (isNaN(d)) return null;
  const hoy = new Date();
  return (
    (hoy.getFullYear() - d.getFullYear()) * 12 + (hoy.getMonth() - d.getMonth())
  );
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function cuitDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function cuitLindo(v) {
  const d = cuitDigits(v);
  if (d.length !== 11) return v || "—";
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
}

// ================= LOGIN =================
async function entrar() {
  const cuit = cuitDigits($("cuitInput").value);
  const clave = ($("passInput").value || "").trim();
  const err = $("loginError");
  err.textContent = "";

  if (!cuit || !clave) {
    err.textContent = "Completá CUIT y clave.";
    return;
  }

  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Entrando…";

  const { error } = await sb.auth.signInWithPassword({
    email: `${cuit}@cuit.loekemeyer`,
    password: clave,
  });

  $("loginBtn").disabled = false;
  $("loginBtn").textContent = "Entrar";

  if (error) {
    err.textContent = "CUIT o clave incorrectos.";
    return;
  }

  const ok = await cargarPerfil();
  if (!ok) {
    // Credencial valida pero sin permiso para ESTE modulo: se cierra la sesion
    // para no dejarlo a medio loguear en el resto del sitio.
    await sb.auth.signOut();
    err.textContent =
      "Tu usuario no tiene acceso a este módulo. Pedile el alta a Loekemeyer.";
  }
}

async function cargarPerfil() {
  const { data, error } = await sb.rpc("consulta_perfil");
  if (error || !data || !data.ok) return false;
  PERFIL = data;
  $("loginWrap").hidden = true;
  $("app").hidden = false;
  $("topbarUser").textContent = data.nombre || "";
  $("buscarInput").focus();
  return true;
}

async function salir() {
  await sb.auth.signOut();
  location.reload();
}

// ================= BUSCADOR =================
async function buscar() {
  const q = ($("buscarInput").value || "").trim();
  const cont = $("resultados");
  const hint = $("buscarHint");

  if (q.length < 2) {
    cont.innerHTML = "";
    hint.textContent = "";
    return;
  }

  hint.textContent = "Buscando…";
  const { data, error } = await sb.rpc("consulta_buscar_clientes", {
    p_q: q,
    p_limit: 30,
  });

  if (error) {
    hint.textContent = "";
    cont.innerHTML = `<div class="res-vacio">No se pudo buscar: ${esc(error.message)}</div>`;
    return;
  }

  const filas = data || [];
  hint.textContent = filas.length
    ? `${filas.length} cliente${filas.length === 1 ? "" : "s"}`
    : "";

  if (!filas.length) {
    cont.innerHTML = `<div class="res-vacio">Ningún cliente con “${esc(q)}”.</div>`;
    return;
  }

  cont.innerHTML = filas
    .map((c, i) => {
      const m = mesesDesde(c.ultima_compra);
      const cuando =
        c.ultima_compra == null
          ? "sin compras"
          : `última compra ${fecha(c.ultima_compra)}${m != null ? ` · hace ${m} mes${m === 1 ? "" : "es"}` : ""}`;
      return `
      <div class="res-item" data-i="${i}">
        <span class="res-cod">${esc(c.cod_cliente)}</span>
        <span class="res-nombre">${esc(c.business_name)}</span>
        <span class="res-meta">${esc(cuitLindo(c.cuit))} · ${esc(cuando)} · ${num(c.cajas_12m)} cajas 12m</span>
      </div>`;
    })
    .join("");

  cont.querySelectorAll(".res-item").forEach((el) => {
    el.addEventListener("click", () => abrirCliente(filas[Number(el.dataset.i)]));
  });
}

// ================= FICHA =================
async function abrirCliente(cli) {
  CLIENTE = cli;
  $("fichaCard").hidden = false;
  $("fichaNombre").textContent = cli.business_name;
  $("fichaMeta").textContent = `Código ${cli.cod_cliente} · CUIT ${cuitLindo(cli.cuit)}`;
  $("kpis").innerHTML = `<div class="kpi"><div class="kpi-lab">Cargando</div><div class="kpi-val">…</div></div>`;
  $("tablaBody").innerHTML = "";
  $("tablaPie").textContent = "";
  $("filtroInput").value = "";
  $("chkAntes").checked = false;
  $("fichaCard").scrollIntoView({ behavior: "smooth", block: "start" });

  const cod = String(cli.cod_cliente);
  const [rf, rh] = await Promise.all([
    sb.rpc("consulta_faltantes", { p_cod: cod, p_limit: 500 }),
    sb.rpc("consulta_historial", { p_cod: cod }),
  ]);

  if (rf.error || rh.error) {
    $("kpis").innerHTML = "";
    $("tablaPie").textContent =
      "No se pudieron traer los datos: " +
      esc((rf.error || rh.error).message || "");
    return;
  }

  FALTANTES = rf.data || [];
  HISTORIAL = rh.data || [];
  renderKpis();
  renderTabla();
}

function cerrarFicha() {
  CLIENTE = null;
  $("fichaCard").hidden = true;
  $("buscarInput").focus();
  $("buscarInput").select();
}

function renderKpis() {
  const compra12 = HISTORIAL.filter((h) => Number(h.cajas_12m) > 0);
  const cajas12 = compra12.reduce((a, h) => a + Number(h.cajas_12m || 0), 0);
  const neto12 = compra12.reduce((a, h) => a + Number(h.neto_12m || 0), 0);
  const dejaron = FALTANTES.filter((f) => Number(f.cajas_hist) > 0);
  const m = mesesDesde(CLIENTE.ultima_compra);

  const kpis = [
    ["Última compra", CLIENTE.ultima_compra ? fecha(CLIENTE.ultima_compra) : "—"],
    ["Artículos que compra", num(compra12.length)],
    ["Cajas 12 meses", num(cajas12)],
    ["Facturado 12 meses", plata(neto12)],
    ["No le compran", num(FALTANTES.length), true],
    ["Compraba y dejó", num(dejaron.length), true],
  ];

  $("kpis").innerHTML = kpis
    .map(
      ([lab, val, alerta]) => `
      <div class="kpi${alerta ? " kpi--alerta" : ""}">
        <div class="kpi-lab">${esc(lab)}</div>
        <div class="kpi-val">${esc(val)}</div>
      </div>`,
    )
    .join("");

  if (m != null && m >= 6) {
    $("fichaMeta").textContent +=
      ` · ⚠ sin comprar hace ${m} meses`;
  }
}

// ================= TABLA =================
// Devuelve las filas visibles de la pestaña activa, ya filtradas.
function filasVisibles() {
  const q = ($("filtroInput").value || "").trim().toLowerCase();
  const soloAntes = $("chkAntes").checked;
  let filas = TAB === "falta" ? FALTANTES : HISTORIAL;

  if (TAB === "falta" && soloAntes) {
    filas = filas.filter((f) => Number(f.cajas_hist) > 0);
  }
  if (q) {
    filas = filas.filter((f) =>
      (String(f.cod) + " " + String(f.descripcion || "")).toLowerCase().includes(q),
    );
  }
  return filas;
}

function renderTabla() {
  $("chkAntesWrap").style.display = TAB === "falta" ? "" : "none";
  const filas = filasVisibles();

  if (TAB === "falta") {
    $("tablaHead").innerHTML = `
      <tr>
        <th></th><th>Cód.</th><th>Artículo</th>
        <th class="num">% clientes</th>
        <th class="num">Clientes</th>
        <th class="num">Cajas prom.</th>
        <th>Antes compraba</th>
      </tr>`;
    $("tablaBody").innerHTML = filas
      .map((f) => {
        const antes =
          Number(f.cajas_hist) > 0
            ? `<span class="dejo">dejó</span> ${num(f.cajas_hist)} cajas · ${fecha(f.ultima_compra)}`
            : "<span style='color:#9ca3af'>nunca lo compró</span>";
        const pct = Number(f.pct_clientes || 0);
        return `
        <tr>
          <td><img class="tabla-foto" loading="lazy" src="${esc(imgUrlByCod(f.cod))}"
                   onerror="this.src='img/no-image.jpg'" alt=""></td>
          <td class="cod">${esc(f.cod)}</td>
          <td class="art">${esc(f.descripcion)}</td>
          <td class="num ${pct >= 50 ? "pct-fuerte" : ""}">${num(pct)}%</td>
          <td class="num">${num(f.clientes_compran)}</td>
          <td class="num">${num(f.cajas_prom_cliente, 1)}</td>
          <td>${antes}</td>
        </tr>`;
      })
      .join("");
    $("tablaPie").innerHTML = `
      ${num(filas.length)} de ${num(FALTANTES.length)} artículos ·
      “% clientes” es sobre los clientes de Loekemeyer que compraron algo en los
      últimos 12 meses (sin las cadenas de supermercado, que compran pocos
      artículos en volumen enorme). “Cajas prom.” es lo que compra por año un
      cliente que sí lo lleva.`;
  } else {
    $("tablaHead").innerHTML = `
      <tr>
        <th></th><th>Cód.</th><th>Artículo</th>
        <th class="num">Cajas 12m</th>
        <th class="num">12m previos</th>
        <th class="num">Var.</th>
        <th>Última compra</th>
        <th class="num">Facturado 12m</th>
      </tr>`;
    $("tablaBody").innerHTML = filas
      .map((h) => {
        const c12 = Number(h.cajas_12m || 0);
        const cpv = Number(h.cajas_prev12 || 0);
        let varTxt = "—";
        let varCls = "";
        if (cpv === 0 && c12 > 0) {
          varTxt = "nuevo";
          varCls = "var-nuevo";
        } else if (cpv > 0) {
          const p = Math.round(((c12 - cpv) / cpv) * 100);
          varTxt = (p > 0 ? "+" : "") + num(p) + "%";
          varCls = p >= 0 ? "var-sube" : "var-baja";
        }
        return `
        <tr>
          <td><img class="tabla-foto" loading="lazy" src="${esc(imgUrlByCod(h.cod))}"
                   onerror="this.src='img/no-image.jpg'" alt=""></td>
          <td class="cod">${esc(h.cod)}</td>
          <td class="art">${esc(h.descripcion)}</td>
          <td class="num">${num(c12)}</td>
          <td class="num">${num(cpv)}</td>
          <td class="num ${varCls}">${varTxt}</td>
          <td>${fecha(h.ultima_compra)}</td>
          <td class="num">${plata(h.neto_12m)}</td>
        </tr>`;
      })
      .join("");
    $("tablaPie").innerHTML = `
      ${num(filas.length)} de ${num(HISTORIAL.length)} artículos ·
      incluye lo que compró alguna vez, no sólo el último año. Las devoluciones
      no cuentan como compra. Facturado en neto (con el descuento por volumen
      del cliente y el de pedido web), a precios de hoy.`;
  }
}

// ================= EXCEL =================
function descargarExcel() {
  if (!CLIENTE) return;
  const filas = filasVisibles();
  if (!filas.length) return;

  const datos =
    TAB === "falta"
      ? filas.map((f) => ({
          Código: f.cod,
          Artículo: f.descripcion,
          Categoría: f.categoria || "",
          "% clientes": Number(f.pct_clientes || 0),
          "Clientes que lo compran": Number(f.clientes_compran || 0),
          "Cajas prom. por cliente": Number(f.cajas_prom_cliente || 0),
          "Cajas que compró históricamente": Number(f.cajas_hist || 0),
          "Última vez que lo compró": f.ultima_compra || "",
        }))
      : filas.map((h) => ({
          Código: h.cod,
          Artículo: h.descripcion,
          Categoría: h.categoria || "",
          "Cajas 12m": Number(h.cajas_12m || 0),
          "Cajas 12m previos": Number(h.cajas_prev12 || 0),
          "Cajas históricas": Number(h.cajas_hist || 0),
          "Última compra": h.ultima_compra || "",
          "Facturado 12m": Number(h.neto_12m || 0),
        }));

  const ws = XLSX.utils.json_to_sheet(datos);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    ws,
    TAB === "falta" ? "No le compran" : "Si le compran",
  );
  const hoy = new Date().toISOString().slice(0, 10);
  const nombre = String(CLIENTE.business_name || CLIENTE.cod_cliente)
    .replace(/[^\wáéíóúñ ]/gi, "")
    .slice(0, 40)
    .trim();
  XLSX.writeFile(
    wb,
    `${TAB === "falta" ? "No-compra" : "Compra"} - ${nombre} - ${hoy}.xlsx`,
  );
}

// ================= EVENTOS =================
document.addEventListener("DOMContentLoaded", async () => {
  $("loginBtn").addEventListener("click", entrar);
  ["cuitInput", "passInput"].forEach((id) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") entrar();
    });
  });
  $("logoutBtn").addEventListener("click", salir);
  $("cerrarFicha").addEventListener("click", cerrarFicha);
  $("btnExcel").addEventListener("click", descargarExcel);

  $("buscarInput").addEventListener("input", () => {
    clearTimeout(buscarTimer);
    buscarTimer = setTimeout(buscar, 350);
  });

  $("filtroInput").addEventListener("input", renderTabla);
  $("chkAntes").addEventListener("change", renderTabla);

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      TAB = t.dataset.tab;
      document
        .querySelectorAll(".tab")
        .forEach((x) => x.classList.toggle("is-active", x === t));
      $("filtroInput").value = "";
      renderTabla();
    });
  });

  // Sesion ya abierta (volvio a la pagina sin cerrar): se entra derecho.
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    const ok = await cargarPerfil();
    if (!ok) await sb.auth.signOut();
  }
});
