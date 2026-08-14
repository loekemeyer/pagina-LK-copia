"use strict";

var SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
var SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";
var TABLE_CUSTOMERS = "customers";
var TABLE_ADDRESSES = "customer_delivery_addresses";

var PPP_ADMIN_CUIT = "30515842450";
var isPPPAdmin = false;

var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- AUTH: usar sesion existente de Supabase ----
async function checkAuth() {
  var statusEl = document.getElementById("authStatus");

  var result = await sb.auth.getSession();
  if (result.error || !result.data || !result.data.session) {
    if (statusEl)
      statusEl.textContent = "No hay sesion. Redirigiendo a Mayorista...";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1200);
    return false;
  }
  var userId = result.data.session.user.id;
  var adminCheck = await sb
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (adminCheck.error || !adminCheck.data) {
    if (statusEl)
      statusEl.textContent = "Acceso denegado. Solo administradores.";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1500);
    return false;
  }
  var email = (result.data.session.user.email || "").toLowerCase();
  var cuitFromEmail = email.split("@")[0];
  isPPPAdmin = cuitFromEmail === PPP_ADMIN_CUIT;
  if (!isPPPAdmin) {
    var pppBtn = document.getElementById("navPPPBtn");
    if (pppBtn) pppBtn.style.display = "none";
    var pppPage = document.getElementById("estado-pedidos");
    if (pppPage) pppPage.style.display = "none";
    var deudaBtn = document.getElementById("navDeudaBtn");
    if (deudaBtn) deudaBtn.style.display = "none";
    var deudaPage = document.getElementById("reporte-deuda");
    if (deudaPage) deudaPage.style.display = "none";
    // Cruce PPP ahora vive como desplegable dentro de Cargar PPP — se oculta
    // automaticamente con la pagina padre. Solo lo escondemos extra por las dudas.
    var cruceDet = document.getElementById("cruceDetails");
    if (cruceDet) cruceDet.style.display = "none";
  }
  document.getElementById("loadingScreen").style.display = "none";
  // 2FA por email solo se exige al admin PPP (CUIT 30-51584245-0). Resto entra directo.
  if (isPPPAdmin) {
    var otpOk = await ensureEmailOtp();
    if (!otpOk) return false;
  }
  document.getElementById("appShell").style.display = "flex";
  return true;
}

// checkAuth() corre una sola vez al cargar. Si el tab queda abierto y el access
// token vence sin que el auto-refresh llegue a correr (maquina suspendida, red
// caida), los requests siguen saliendo pero como rol anon: las tablas con policy
// anon (products) se leen igual y las admin-only (customers, loke_products)
// devuelven 0 filas SIN error. El panel entonces miente — muestra "cliente no
// encontrado" o "item sin LK" en vez de "estas deslogueado". Este watcher corta
// eso avisando apenas la sesion muere.
var _sessionDead = false;
function watchSession() {
  if (!sb.auth.onAuthStateChange) return;
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT" || (!session && event !== "INITIAL_SESSION")) {
      if (_sessionDead) return;
      _sessionDead = true;
      toast(
        "Sesion vencida. Recarga la pagina (F5) — hasta entonces los datos pueden verse incompletos.",
        "error",
      );
    } else if (session) {
      _sessionDead = false;
    }
  });
}

// true si hay sesion viva con permisos de admin. Usado por modulos que leen
// tablas admin-only y necesitan distinguir "sin permiso" de "no existe".
// getSession() refresca el token solo si puede, asi que esto ademas repara
// sesiones recuperables antes de contestar.
async function hasLiveAdminSession() {
  var r = await sb.auth.getSession();
  var session = r && r.data ? r.data.session : null;
  if (!session) return false;
  var expMs = Number(session.expires_at || 0) * 1000;
  if (expMs && expMs <= Date.now()) return false;
  var a = await sb
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();
  return !a.error && !!a.data;
}
window.hasLiveAdminSession = hasLiveAdminSession;

// ---- 2FA por email (solo PPP admin) ----
var EMAIL_OTP_RECIPIENT_DISPLAY = "loekemeyer.n8n@gmail.com";

async function ensureEmailOtp() {
  // sessionStorage por tab: si ya verificó esta sesión de browser, no pide de nuevo
  try {
    if (sessionStorage.getItem("admin_2fa_ok") === "1") return true;
  } catch (e) {}
  return await emailOtpFlow();
}

function _otpShow(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = "flex";
}
function _otpHide(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = "none";
}
async function _otpLogoutAndRedirect() {
  try {
    await sb.auth.signOut();
  } catch (e) {}
  location.href = "/mayorista";
}

async function _otpCallFunction(action, code) {
  var sess = await sb.auth.getSession();
  if (sess.error || !sess.data.session) {
    return { error: { message: "Sin sesion", code: "no_session" } };
  }
  var token = sess.data.session.access_token;
  try {
    var res = await fetch(SUPABASE_URL + "/functions/v1/admin-otp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: action, code: code }),
    });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      return {
        error: {
          message: data.error || "HTTP " + res.status,
          code: data.error,
        },
      };
    }
    return { data: data };
  } catch (e) {
    return { error: { message: String(e), code: "network" } };
  }
}

async function emailOtpFlow() {
  var step1 = document.getElementById("emailOtpStep1");
  var step2 = document.getElementById("emailOtpStep2");
  var sendBtn = document.getElementById("emailOtpSendBtn");
  var sendErr = document.getElementById("emailOtpSendError");
  var codeInput = document.getElementById("emailOtpCode");
  var verifyBtn = document.getElementById("emailOtpVerifyBtn");
  var verifyErr = document.getElementById("emailOtpVerifyError");
  var resendBtn = document.getElementById("emailOtpResendBtn");
  var logoutBtn = document.getElementById("emailOtpLogout");
  var recip1 = document.getElementById("emailOtpRecipient");
  var recip2 = document.getElementById("emailOtpRecipient2");

  if (recip1) recip1.textContent = EMAIL_OTP_RECIPIENT_DISPLAY;
  if (recip2) recip2.textContent = EMAIL_OTP_RECIPIENT_DISPLAY;
  if (codeInput) codeInput.value = "";
  if (sendErr) sendErr.textContent = "";
  if (verifyErr) verifyErr.textContent = "";
  if (step1) step1.style.display = "";
  if (step2) step2.style.display = "none";
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = "Enviar código";
  }
  if (verifyBtn) {
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Verificar";
  }
  if (resendBtn) {
    resendBtn.disabled = false;
    resendBtn.textContent = "Reenviar código";
  }

  _otpShow("emailOtpOverlay");

  return new Promise(function (resolve) {
    async function doSend(isResend) {
      var btn = isResend ? resendBtn : sendBtn;
      var errEl = isResend ? verifyErr : sendErr;
      btn.disabled = true;
      var prevTxt = btn.textContent;
      btn.textContent = "Enviando...";
      errEl.textContent = "";

      var r = await _otpCallFunction("send", null);
      if (r.error) {
        if (r.error.code === "rate_limited") {
          errEl.textContent = "Demasiados intentos. Esperá 10 minutos.";
        } else if (r.error.code === "mail_failed") {
          errEl.textContent =
            "No se pudo enviar el mail. Avisá a IT.";
        } else {
          errEl.textContent = "Error enviando código: " + r.error.message;
        }
        btn.disabled = false;
        btn.textContent = prevTxt;
        return;
      }

      step1.style.display = "none";
      step2.style.display = "";
      btn.textContent = prevTxt;

      if (isResend) {
        var sec = 30;
        resendBtn.disabled = true;
        resendBtn.textContent = "Reenviar en " + sec + "s";
        var iv = setInterval(function () {
          sec--;
          if (sec <= 0) {
            clearInterval(iv);
            resendBtn.textContent = "Reenviar código";
            resendBtn.disabled = false;
          } else {
            resendBtn.textContent = "Reenviar en " + sec + "s";
          }
        }, 1000);
      }

      setTimeout(function () {
        if (codeInput) codeInput.focus();
      }, 50);
    }

    async function doVerify() {
      var code = (codeInput.value || "").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) {
        verifyErr.textContent = "Ingresá el código de 6 dígitos.";
        return;
      }
      verifyBtn.disabled = true;
      verifyErr.textContent = "Verificando...";

      var r = await _otpCallFunction("verify", code);
      if (r.error) {
        if (r.error.code === "invalid_code") {
          verifyErr.textContent = "Código inválido o vencido.";
        } else {
          verifyErr.textContent = "Error: " + r.error.message;
        }
        verifyBtn.disabled = false;
        codeInput.value = "";
        codeInput.focus();
        return;
      }
      try {
        sessionStorage.setItem("admin_2fa_ok", "1");
      } catch (e) {}
      _otpHide("emailOtpOverlay");
      resolve(true);
    }

    sendBtn.onclick = function () {
      doSend(false);
    };
    resendBtn.onclick = function () {
      doSend(true);
    };
    verifyBtn.onclick = doVerify;
    codeInput.onkeydown = function (e) {
      if (e.key === "Enter") doVerify();
    };
    logoutBtn.onclick = function () {
      _otpHide("emailOtpOverlay");
      _otpLogoutAndRedirect();
      resolve(false);
    };
  });
}

// ---- IMPORT DATES ----
function formatDateDDMMYY(date) {
  var d = new Date(date);
  var day = String(d.getDate()).padStart(2, "0");
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var year = String(d.getFullYear()).slice(-2);
  var hours = String(d.getHours()).padStart(2, "0");
  var minutes = String(d.getMinutes()).padStart(2, "0");
  return day + "/" + month + "/" + year + " " + hours + ":" + minutes;
}

function getLastImportDate(key) {
  var stored = localStorage.getItem("lastImport_" + key);
  if (!stored) return "-";
  return formatDateDDMMYY(new Date(stored));
}

function setLastImportDate(key) {
  localStorage.setItem("lastImport_" + key, new Date().toISOString());
  var el = document.getElementById(key + "LastImport");
  if (el) el.textContent = formatDateDDMMYY(new Date());
}

function loadImportDates() {
  var lcEl = document.getElementById("lcLastImport");
  if (lcEl) lcEl.textContent = getLastImportDate("lc");
  var ppEl = document.getElementById("ppLastImport");
  if (ppEl) ppEl.textContent = getLastImportDate("pp");
  var deudaEl = document.getElementById("deudaLastImport");
  if (deudaEl) deudaEl.textContent = getLastImportDate("deuda");
}

// Llama al cargar la página
document.addEventListener("DOMContentLoaded", loadImportDates);

// ---- IMPORT PROGRESS (in-zone) ----
function showUploadProgress(uploadId, totalItems) {
  var progressDiv = document.getElementById(uploadId + "UploadProgress");
  var progressText = document.getElementById(uploadId + "ProgressText");
  var progressFill = document.getElementById(uploadId + "ProgressFill");
  var msgEl = document.getElementById(uploadId + "ProgressMsg");

  if (!progressDiv) return;
  progressDiv.style.display = "flex";
  progressText.textContent = "0/" + totalItems;
  progressFill.style.width = "0%";
  msgEl.textContent = "Procesando...";
}

function updateUploadProgress(uploadId, current, total, message) {
  var progressText = document.getElementById(uploadId + "ProgressText");
  var progressFill = document.getElementById(uploadId + "ProgressFill");
  var msgEl = document.getElementById(uploadId + "ProgressMsg");

  if (!progressText) return;
  progressText.textContent = current + "/" + total;
  var pct = total > 0 ? (current / total) * 100 : 0;
  progressFill.style.width = pct + "%";
  if (message) msgEl.textContent = message;
}

function hideUploadProgress(uploadId) {
  var progressDiv = document.getElementById(uploadId + "UploadProgress");
  if (progressDiv) progressDiv.style.display = "none";
}

// ---- HELPERS ----
function cleanCuit(val) {
  return String(val || "").replace(/[^0-9]/g, "");
}
function fixDto(val) {
  var n = parseFloat(val);
  if (isNaN(n) || n === 0) return val;
  return n > 0 && n < 1 ? n * 100 : n;
}
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Genera contraseña aleatoria de 30 caracteres alfanuméricos.
// Excluye 0, O, 1, I, l para evitar confusiones al leer.
function generatePassword30() {
  var chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  var result = "";
  for (var i = 0; i < 30; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Estado del modal expo — persiste mientras el modal está abierto para un nuevo cliente
var _expoCard = null;          // card cotizador inline (idx=99)
var _expoSavedCustomer = null; // { id, cod_cliente, business_name, dto_vol, vend }

// Genera CUIT sintetico para vendedores: '99' + 9 digitos random.
// Verifica unicidad contra customers.cuit con reintentos.
async function generateSyntheticVendorCuit() {
  for (var i = 0; i < 20; i++) {
    var rand = String(Math.floor(Math.random() * 1e9));
    while (rand.length < 9) rand = "0" + rand;
    var candidate = "99" + rand;
    var existing = await sb
      .from(TABLE_CUSTOMERS)
      .select("id")
      .eq("cuit", candidate)
      .limit(1);
    if (existing.error) {
      throw new Error(
        "Error verificando CUIT sintetico: " + existing.error.message,
      );
    }
    if (!existing.data || existing.data.length === 0) {
      return candidate;
    }
  }
  throw new Error("No se pudo generar CUIT sintetico unico tras 20 intentos");
}

// Crea usuario en Supabase Auth y devuelve el auth_user_id.
// Usa un cliente separado para no perder la sesion del admin.
async function createAuthUser(cuit, pin) {
  if (!cuit) return null;
  var digits = cuit.replace(/[^0-9]/g, "");
  if (!digits) return null;
  var email = digits + "@cuit.loekemeyer";
  var tmpClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  var result = await tmpClient.auth.signUp({ email: email, password: pin });
  if (result.error) {
    // Si el usuario ya existe, intentar login para obtener su id
    if (result.error.message.toLowerCase().includes("already registered")) {
      var loginResult = await tmpClient.auth.signInWithPassword({
        email: email,
        password: pin,
      });
      if (!loginResult.error && loginResult.data.user) {
        return loginResult.data.user.id;
      }
      // Si no puede loguearse (pin distinto), avisar pero no bloquear
      console.warn(
        "Usuario auth ya existe para " + digits + " pero con PIN distinto",
      );
      toast(
        "Aviso: ya existe usuario auth para este CUIT con otro PIN",
        "warning",
      );
      return null;
    }
    console.warn(
      "No se pudo crear usuario auth para " +
        digits +
        ": " +
        result.error.message,
    );
    toast(
      "Aviso: cliente se creará sin acceso login (" +
        result.error.message +
        ")",
      "warning",
    );
    return null;
  }
  return result.data.user ? result.data.user.id : null;
}

function toast(msg, type) {
  type = type || "success";
  var wrap = document.getElementById("toastWrap");
  var el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = '<span class="toast-dot"></span>' + msg;
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    setTimeout(function () {
      el.remove();
    }, 300);
  }, 3500);
}

// Loader global: spinner con mensaje opcional
function showLoader(msg) {
  var el = document.getElementById("adminLoader");
  var m = document.getElementById("adminLoaderMsg");
  if (!el) return;
  if (m) m.textContent = msg || "Procesando...";
  el.hidden = false;
}
function hideLoader() {
  var el = document.getElementById("adminLoader");
  if (el) el.hidden = true;
}
// Espera a que el browser pinte el loader antes de correr trabajo pesado sincrono
function deferHeavy(fn) {
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          resolve(fn());
        } catch (e) {
          resolve(Promise.reject(e));
        }
      });
    });
  });
}

// ---- SUPABASE CRUD (usa sesion autenticada) ----
async function sbSelect(table, filters) {
  var q = sb.from(table).select("*");
  if (filters) {
    filters.split("&").forEach(function (p) {
      var m = p.match(/^(\w+)=eq\.(.+)$/);
      if (m) q = q.eq(m[1], m[2]);
      var o = p.match(/^order=(\w+)\.(\w+)$/);
      if (o) q = q.order(o[1], { ascending: o[2] === "asc" });
    });
  }
  var result = await q;
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

async function sbSelectAll(table, orderQuery) {
  var PAGE = 1000,
    all = [],
    offset = 0,
    batch;
  do {
    var q = sb
      .from(table)
      .select("*")
      .range(offset, offset + PAGE - 1);
    if (orderQuery) {
      orderQuery.split("&").forEach(function (p) {
        var o = p.match(/^order=(\w+)\.(\w+)$/);
        if (o) q = q.order(o[1], { ascending: o[2] === "asc" });
      });
    }
    var result = await q;
    if (result.error) throw new Error(result.error.message);
    batch = result.data || [];
    all = all.concat(batch);
    offset += PAGE;
  } while (batch.length === PAGE);
  return all;
}

async function sbInsert(table, data) {
  var result = await sb
    .from(table)
    .insert(Array.isArray(data) ? data : [data])
    .select();
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

async function sbUpdate(table, id, idCol, data) {
  var result = await sb.from(table).update(data).eq(idCol, id).select();
  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

// Algunos vendedores son la misma persona y comparten cartera en el login.
// Si el cliente viene con el vend de la izquierda, el link se crea contra el vendedor del vend de la derecha.
// El campo customers.vend NO se toca: el sheet de pedidos web sigue mostrando el vendedor real del cliente.
var VENDOR_ALIASES = {
  10: "12", // Lisa Katz (10) y Tomas Schindler (12): Tomas es el unico que loguea y ve ambas carteras.
};

// ---- AUTO-LINK: vincular cliente al vendedor en user_customer_links ----
async function linkCustomerToVendor(vend, customerId) {
  if (!vend || !customerId) return;
  var targetVend = VENDOR_ALIASES[vend] || vend;
  try {
    // Buscar al vendedor: es un cliente que ya tiene links y cuyo campo vend coincide
    // Primero obtener todos los auth_user_id distintos que actuan como vendedores
    var linksResult = await sb
      .from("user_customer_links")
      .select("auth_user_id");
    if (linksResult.error || !linksResult.data || !linksResult.data.length) {
      console.warn("No se encontraron links de vendedores");
      return;
    }
    // IDs unicos de vendedores
    var vendorAuthIds = [];
    linksResult.data.forEach(function (l) {
      if (vendorAuthIds.indexOf(l.auth_user_id) === -1)
        vendorAuthIds.push(l.auth_user_id);
    });
    // Buscar cual de esos vendedores tiene vend = targetVend (con alias aplicado).
    // Filtro `cod_cliente LIKE '100%'`: solo los vendedores sinteticos creados con
    // `generateSyntheticVendorCuit` (cod 10001..10099) cuentan como vendedores reales.
    // Sin este filtro, cualquier cliente comun cuyo auth_user_id figure en
    // user_customer_links (su self-link) pasaba a ser candidato a "vendedor" y
    // los nuevos clientes con vend huerfano (sin login humano que lo administre)
    // se colgaban de el por azar — el caso vend=7 / Tierra Nativa / Bazar Monica.
    var vendorResult = await sb
      .from(TABLE_CUSTOMERS)
      .select("auth_user_id")
      .in("auth_user_id", vendorAuthIds)
      .eq("vend", targetVend)
      .like("cod_cliente", "100__")
      .limit(1);
    if (vendorResult.error || !vendorResult.data || !vendorResult.data.length) {
      console.warn(
        "No se encontro vendedor con vend=" +
          targetVend +
          (targetVend !== vend ? " (alias de " + vend + ")" : ""),
      );
      return;
    }
    var vendorAuthId = vendorResult.data[0].auth_user_id;
    // Verificar si ya existe el link para no duplicar
    var existing = await sb
      .from("user_customer_links")
      .select("auth_user_id")
      .eq("auth_user_id", vendorAuthId)
      .eq("customer_id", customerId)
      .maybeSingle();
    if (existing.data) return; // ya existe
    // Insertar el link
    var ins = await sb
      .from("user_customer_links")
      .insert({ auth_user_id: vendorAuthId, customer_id: customerId });
    if (ins.error) {
      console.warn(
        "Error al vincular cliente al vendedor: " + ins.error.message,
      );
    }
  } catch (err) {
    console.warn("linkCustomerToVendor error: " + err.message);
  }
}

// ---- NAVIGATION ----
document.querySelectorAll(".nav-item").forEach(function (btn) {
  btn.addEventListener("click", function () {
    // Links externos (sin data-page) navegan al href, no togglean secciones
    if (!btn.dataset.page) return;
    document.querySelectorAll(".nav-item").forEach(function (b) {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    document.querySelectorAll(".page").forEach(function (p) {
      p.classList.remove("active");
    });
    document.getElementById(btn.dataset.page).classList.add("active");
    // Asegurar que el grupo padre quede expandido al activar un sub-item
    var parentGroup = btn.closest(".nav-group");
    if (parentGroup) parentGroup.classList.remove("collapsed");
    // Lazy load para tabs costosos
    if (
      btn.dataset.page === "sucursales-pendientes" &&
      typeof cargarSucursalesPendientes === "function"
    ) {
      cargarSucursalesPendientes();
    }
    if (btn.dataset.page === "estadistica-clientes") {
      // Siempre se entra con las tres tarjetas cerradas
      if (typeof colapsarTarjetasEstadistica === "function") {
        colapsarTarjetasEstadistica();
      }
      if (typeof cargarEstadisticaClientes === "function") {
        cargarEstadisticaClientes();
      }
      // El ranking se carga solo, a 12 meses; no depende de la carga de arriba
      if (typeof cargaInicialRankingInactivos === "function") {
        cargaInicialRankingInactivos();
      }
    }
    if (
      btn.dataset.page === "ranking-clientes" &&
      typeof inicRankingClientes === "function"
    ) {
      inicRankingClientes();
    }
    if (
      btn.dataset.page === "grupos-clientes" &&
      typeof cargarGruposClientes === "function"
    ) {
      cargarGruposClientes();
    }
    if (
      btn.dataset.page === "gerente-ventas" &&
      typeof cargarGerenteVentas === "function"
    ) {
      cargarGerenteVentas();
    }
    if (
      btn.dataset.page === "estadistica-madre" &&
      typeof cargarEstadisticaMadre === "function" &&
      !_estMadreData
    ) {
      cargarEstadisticaMadre();
    }
    if (
      btn.dataset.page === "registro-envios" &&
      typeof cargarRegistroEnvios === "function"
    ) {
      cargarRegistroEnvios();
    }
    if (
      btn.dataset.page === "origen-pedidos" &&
      typeof cargarOrigenPedidos === "function"
    ) {
      cargarOrigenPedidos();
    }
    if (
      btn.dataset.page === "uso-modulos" &&
      typeof cargarUsoModulos === "function"
    ) {
      // Se entra siempre con el filtro en el mes corriente (del 1 a hoy)
      if (typeof setRangoMesActualUsoModulos === "function") {
        setRangoMesActualUsoModulos();
      }
      cargarUsoModulos();
    }
  });
});

var origenPedidosRefreshBtn = document.getElementById(
  "origenPedidosRefreshBtn",
);
if (origenPedidosRefreshBtn) {
  origenPedidosRefreshBtn.addEventListener("click", cargarOrigenPedidos);
}

["origenPedidosDesde", "origenPedidosHasta"].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener("change", cargarOrigenPedidos);
});

var origenPedidosLimpiarBtn = document.getElementById(
  "origenPedidosLimpiarBtn",
);
if (origenPedidosLimpiarBtn) {
  origenPedidosLimpiarBtn.addEventListener("click", function () {
    var desde = document.getElementById("origenPedidosDesde");
    var hasta = document.getElementById("origenPedidosHasta");
    if (desde) desde.value = "";
    if (hasta) hasta.value = "";
    cargarOrigenPedidos();
  });
}

var usoModulosRefreshBtn = document.getElementById("usoModulosRefreshBtn");
if (usoModulosRefreshBtn) {
  usoModulosRefreshBtn.addEventListener("click", cargarUsoModulos);
}

["usoModulosDesde", "usoModulosHasta"].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener("change", cargarUsoModulos);
});

var usoModulosLimpiarBtn = document.getElementById("usoModulosLimpiarBtn");
if (usoModulosLimpiarBtn) {
  usoModulosLimpiarBtn.addEventListener("click", function () {
    var desde = document.getElementById("usoModulosDesde");
    var hasta = document.getElementById("usoModulosHasta");
    if (desde) desde.value = "";
    if (hasta) hasta.value = "";
    cargarUsoModulos();
  });
}

// ---- GROUP TOGGLES (modulos colapsables) ----
document.querySelectorAll(".nav-group-toggle").forEach(function (toggle) {
  toggle.addEventListener("click", function () {
    var group = toggle.closest(".nav-group");
    if (!group) return;
    var isCollapsed = group.classList.contains("collapsed");
    // Cerrar todos los grupos abiertos
    document.querySelectorAll(".nav-group").forEach(function (g) {
      g.classList.add("collapsed");
    });
    // Abrir el clickeado solo si estaba cerrado
    if (isCollapsed) group.classList.remove("collapsed");
  });
});

// Estado inicial: colapsar grupos que no contienen el item activo
(function initNavGroups() {
  document.querySelectorAll(".nav-group").forEach(function (group) {
    if (!group.querySelector(".nav-item.active")) {
      group.classList.add("collapsed");
    }
  });
})();

// Lazy-load del cruce PPP cuando el usuario abre el desplegable.
// Se ejecuta solo en la primera apertura para no recargar a cada toggle.
(function () {
  var det = document.getElementById("cruceDetails");
  if (!det) return;
  var loaded = false;
  det.addEventListener("toggle", function () {
    if (det.open && !loaded && typeof loadCrucePPP === "function") {
      loaded = true;
      loadCrucePPP();
    }
  });
})();

// ---- TABS (removed - single page now) ----

// ---- CARGA MANUAL ----
document
  .getElementById("clearManualBtn")
  .addEventListener("click", function () {
    [
      "manualCod",
      "manualCuit",
      "manualRazon",
      "manualMail",
      "manualVend",
      "manualDto",
    ].forEach(function (id) {
      document.getElementById(id).value = "";
    });
  });

// Toggle del checkbox "Es vendedor": deshabilita y limpia el campo CUIT.
(function () {
  var chk = document.getElementById("manualIsVendor");
  var cuitInput = document.getElementById("manualCuit");
  if (!chk || !cuitInput) return;
  var origPlaceholder = cuitInput.placeholder;
  chk.addEventListener("change", function () {
    if (chk.checked) {
      cuitInput.value = "";
      cuitInput.disabled = true;
      cuitInput.placeholder = "(automatico)";
    } else {
      cuitInput.disabled = false;
      cuitInput.placeholder = origPlaceholder;
    }
  });
})();

document
  .getElementById("saveManualBtn")
  .addEventListener("click", async function () {
    var cod = document.getElementById("manualCod").value.trim();
    var razon = document.getElementById("manualRazon").value.trim();
    var isVendor = document.getElementById("manualIsVendor").checked;
    if (!cod) {
      toast("Ingresa un codigo de cliente", "warning");
      return;
    }
    if (!razon) {
      toast("Ingresa la razon social", "warning");
      return;
    }
    var usernameVal = document
      .getElementById("manualUsername")
      .value.trim()
      .toLowerCase();
    if (isVendor && !usernameVal) {
      toast("Vendedor requiere usuario", "warning");
      return;
    }
    var dto = parseFloat(document.getElementById("manualDto").value);
    this.disabled = true;
    try {
      var cuitForPayload;
      if (isVendor) {
        cuitForPayload = await generateSyntheticVendorCuit();
      } else {
        cuitForPayload = cleanCuit(
          document.getElementById("manualCuit").value,
        );
      }
      var payload = {
        cod_cliente: cod,
        business_name: razon,
        cuit: cuitForPayload,
        vend: document.getElementById("manualVend").value.trim(),
        dto_vol: isNaN(dto) ? null : dto / 100,
        mail: document.getElementById("manualMail").value.trim(),
        pin: generatePin(),
      };
      if (usernameVal) payload.username = usernameVal;
      var authId = await createAuthUser(payload.cuit, payload.pin);
      if (authId) payload.auth_user_id = authId;
      var inserted = await sbInsert(TABLE_CUSTOMERS, payload);
      if (payload.vend && inserted.length) {
        await linkCustomerToVendor(payload.vend, inserted[0].id);
      }
      toast(
        isVendor ? "Vendedor creado correctamente" : "Cliente creado correctamente",
      );
      [
        "manualCod",
        "manualCuit",
        "manualRazon",
        "manualMail",
        "manualVend",
        "manualDto",
        "manualUsername",
      ].forEach(function (id) {
        document.getElementById(id).value = "";
      });
      var chkReset = document.getElementById("manualIsVendor");
      if (chkReset && chkReset.checked) {
        chkReset.checked = false;
        chkReset.dispatchEvent(new Event("change"));
      }
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

["manualDto", "editDto"].forEach(function (id) {
  document.getElementById(id).addEventListener("blur", function () {
    if (this.value !== "") this.value = fixDto(this.value);
  });
});

// ---- EXCEL IMPORT ----
var importData = [];
var dropZone = document.getElementById("dropZone");
var fileInput = document.getElementById("fileInput");

dropZone.addEventListener("dragover", function (e) {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", function () {
  dropZone.classList.remove("drag-over");
});
dropZone.addEventListener("drop", function (e) {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", function () {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var wb = XLSX.read(e.target.result, { type: "array" });
    var sheet = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // Usa parser inteligente para detectar columnas
    var schema = {
      cod_cliente: { keywords: ["cod", "code", "código", "codigo"], type: "code", required: true },
      business_name: { keywords: ["razon", "razón", "social", "nombre", "business", "empresa"], type: "text", required: true },
      cuit: { keywords: ["cuit", "cile", "ruc"], type: "cuit", required: false },
      vend: { keywords: ["vendedor", "vendor", "vendedora"], type: "text", required: false },
      dto_vol: { keywords: ["desc", "descuento", "discount"], type: "number", required: false },
      mail: { keywords: ["mail", "email", "correo"], type: "email", required: false }
    };

    var mapped = ExcelParserSmart.mapExcelToSchema(rows, schema);

    importData = mapped.map(function (r) {
      return {
        cod_cliente: r.cod_cliente,
        business_name: r.business_name,
        cuit: r.cuit || "",
        vend: r.vend || "",
        dto_vol: r.dto_vol ? r.dto_vol / 100 : null,
        mail: r.mail || "",
        pin: generatePin(),
      };
    });

    renderPreview(importData);
  };
  reader.readAsArrayBuffer(file);
}

function renderPreview(data) {
  if (!data.length) return;
  document.getElementById("previewSection").style.display = "block";
  document.getElementById("previewCount").textContent =
    data.length + " filas detectadas";
  var cols = [
    "cod_cliente",
    "business_name",
    "cuit",
    "vend",
    "dto_vol",
    "mail",
  ];
  document.getElementById("previewHead").innerHTML = cols
    .map(function (c) {
      return "<th>" + c + "</th>";
    })
    .join("");
  document.getElementById("previewBody").innerHTML = data
    .map(function (r) {
      return (
        "<tr>" +
        cols
          .map(function (c) {
            return "<td>" + (r[c] != null ? r[c] : "") + "</td>";
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
}

document.getElementById("clearImport").addEventListener("click", function () {
  importData = [];
  document.getElementById("previewSection").style.display = "none";
  fileInput.value = "";
});

document
  .getElementById("importBtn")
  .addEventListener("click", async function () {
    if (!importData.length) return;
    this.disabled = true;
    try {
      for (var i = 0; i < importData.length; i++) {
        var row = importData[i];
        var authId = await createAuthUser(row.cuit, row.pin);
        if (authId) row.auth_user_id = authId;
      }
      var insertedRows = await sbInsert(TABLE_CUSTOMERS, importData);
      // Vincular cada cliente importado a su vendedor
      for (var j = 0; j < insertedRows.length; j++) {
        if (insertedRows[j].vend) {
          await linkCustomerToVendor(insertedRows[j].vend, insertedRows[j].id);
        }
      }
      toast(importData.length + " clientes importados");
      importData = [];
      document.getElementById("previewSection").style.display = "none";
      fileInput.value = "";
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

// ---- CARGAR SUCURSAL ----
document
  .getElementById("buscarClienteBtn")
  .addEventListener("click", buscarCliente);
document
  .getElementById("sucCodInput")
  .addEventListener("keydown", function (e) {
    if (e.key === "Enter") buscarCliente();
  });

var currentSearchedCliente = null;

async function buscarCliente() {
  var cod = document.getElementById("sucCodInput").value.trim();
  if (!cod) {
    toast("Ingresa un codigo de cliente", "warning");
    return;
  }
  try {
    var clientes = await sbSelect(TABLE_CUSTOMERS, "cod_cliente=eq." + cod);
    if (!clientes.length) {
      toast("Cliente no encontrado", "warning");
      return;
    }
    var c = clientes[0];
    currentSearchedCliente = c;
    document.getElementById("ci-razon").textContent = c.business_name || "-";
    document.getElementById("ci-cuit").textContent = c.cuit || "-";
    document.getElementById("ci-vend").textContent = c.vend || "-";
    document.getElementById("ci-mail").textContent = c.mail || "-";
    document.getElementById("clienteInfo").style.display = "block";

    var addrs = await sbSelect(
      TABLE_ADDRESSES,
      "customer_id=eq." + c.id + "&order=slot.asc",
    );
    document.getElementById("sucursalesSection").style.display = "block";
    document.getElementById("sucCount").textContent =
      addrs.length + " sucursal" + (addrs.length !== 1 ? "es" : "");
    renderSucursalesList(addrs, c.id);
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
}

function renderSucursalesList(addrs, clienteId) {
  var list = document.getElementById("sucList");
  if (!addrs.length) {
    list.innerHTML =
      '<div class="cc-suc-empty">Sin sucursales registradas</div>';
    return;
  }
  list.innerHTML = addrs
    .map(function (a) {
      var dirInfo = "";
      if (a.direccion_entrega) {
        dirInfo =
          '<div style="font-size:12px;color:var(--text3);margin-top:2px">Entrega: <strong>' +
          a.direccion_entrega +
          "</strong>" +
          (a.zona_expreso
            ? " — Zona: <strong>" + a.zona_expreso + "</strong>"
            : "") +
          "</div>";
      }
      return (
        '<div class="suc-item"><div class="suc-left"><div class="suc-slot">' +
        a.slot +
        '</div><div><div class="suc-label">' +
        a.label +
        "</div>" +
        dirInfo +
        "</div></div>" +
        '<button class="btn-danger" onclick="deleteSucursal(\'' +
        clienteId +
        "'," +
        a.slot +
        ')">Eliminar</button></div>'
      );
    })
    .join("");
}

window.deleteSucursal = async function (clienteId, slot) {
  if (!confirm("Eliminar esta sucursal?")) return;
  try {
    await sb
      .from(TABLE_ADDRESSES)
      .delete()
      .eq("customer_id", clienteId)
      .eq("slot", slot);
    toast("Sucursal eliminada");
    buscarCliente();
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
};

document.getElementById("addSucBtn").addEventListener("click", function () {
  document.getElementById("addSucForm").style.display = "block";
  document.getElementById("newSucLabel").focus();
});
document.getElementById("cancelSucBtn").addEventListener("click", function () {
  document.getElementById("addSucForm").style.display = "none";
});
document
  .getElementById("saveSucBtn")
  .addEventListener("click", async function () {
    if (!currentSearchedCliente) return;
    var label = document.getElementById("newSucLabel").value.trim();
    var slot = parseInt(document.getElementById("newSucSlot").value) || 1;
    var dirEntrega = document.getElementById("newSucDirEntrega").value.trim();
    var zona = document.getElementById("newSucZona").value.trim();
    if (!label) {
      toast("Ingresa una direccion", "warning");
      return;
    }
    this.disabled = true;
    try {
      var payload = {
        customer_id: currentSearchedCliente.id,
        label: label,
        slot: slot,
      };
      if (dirEntrega) payload.direccion_entrega = dirEntrega;
      if (zona) payload.zona_expreso = zona;
      await sbInsert(TABLE_ADDRESSES, payload);
      toast("Sucursal agregada");
      document.getElementById("addSucForm").style.display = "none";
      document.getElementById("newSucLabel").value = "";
      document.getElementById("newSucDirEntrega").value = "";
      document.getElementById("newSucZona").value = "";
      buscarCliente();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

// ---- MODIFICAR CLIENTES ----
var allClientes = [];
var allAddresses = [];

async function loadClientes() {
  var grid = document.getElementById("clientesList");
  grid.innerHTML =
    '<div class="loading-row"><span class="spinner"></span>Cargando clientes...</div>';
  try {
    allClientes = await sbSelectAll(TABLE_CUSTOMERS, "order=cod_cliente.asc");
    allAddresses = await sbSelectAll(TABLE_ADDRESSES, "order=slot.asc");
    renderClientes(allClientes, allAddresses);
  } catch (err) {
    grid.innerHTML =
      '<div class="empty-state"><p>Error al cargar clientes</p><small>' +
      err.message +
      "</small></div>";
  }
}

function renderClientes(clientes, addresses) {
  var grid = document.getElementById("clientesList");
  if (!clientes.length) {
    grid.innerHTML =
      '<div class="empty-state"><p>No se encontraron clientes</p></div>';
    return;
  }
  grid.innerHTML = clientes
    .map(function (c) {
      var addrs = addresses
        .filter(function (a) {
          return a.customer_id === c.id;
        })
        .sort(function (a, b) {
          return a.slot - b.slot;
        });
      return (
        '<div class="cliente-card"><div class="cc-header" onclick="toggleCard(this)">' +
        '<span class="cc-cod">' +
        (c.cod_cliente || "?") +
        "</span>" +
        '<div class="cc-info"><div class="cc-razon">' +
        (c.business_name || "-") +
        '</div><div class="cc-cuit">CUIT: ' +
        (c.cuit || "-") +
        "</div></div>" +
        '<div class="cc-meta"><span class="cc-badge">' +
        addrs.length +
        " suc.</span>" +
        '<svg class="cc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div>' +
        '<div class="cc-body"><div class="cc-detail-grid">' +
        '<div class="cc-detail-item"><div class="label">Vendedor</div><div class="val">' +
        (c.vend || "-") +
        "</div></div>" +
        '<div class="cc-detail-item"><div class="label">Mail</div><div class="val">' +
        (c.mail || "-") +
        "</div></div>" +
        '<div class="cc-detail-item"><div class="label">Dto. Vol</div><div class="val">' +
        (c.dto_vol != null ? (c.dto_vol * 100).toFixed(0) + "%" : "-") +
        "</div></div>" +
        '<div class="cc-detail-item"><div class="label">PIN</div><div class="val">' +
        (c.pin || "-") +
        "</div></div></div>" +
        '<div class="suc-section-header"><h4 style="font-size:14px;font-weight:700">Sucursales</h4>' +
        '<button class="btn-primary" style="padding:7px 14px;font-size:13px" onclick="openAddSucModal(\'' +
        c.id +
        "'," +
        addrs.length +
        ')">Agregar</button></div>' +
        '<div class="cc-suc-grid" id="suc-grid-' +
        c.id +
        '">' +
        (addrs.length
          ? addrs
              .map(function (a) {
                return renderSucItem(a, c.id);
              })
              .join("")
          : '<div class="cc-suc-empty">Sin sucursales</div>') +
        "</div>" +
        '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">' +
        '<button class="btn-ghost" style="font-size:13px;padding:8px 16px" onclick="openEditModal(\'' +
        c.id +
        "')\">Editar</button>" +
        '<button class="btn-danger" onclick="deleteCliente(\'' +
        c.id +
        "')\">Eliminar</button></div></div></div>"
      );
    })
    .join("");
}

function renderSucItem(a, clienteId) {
  var dirInfo = "";
  if (a.direccion_entrega) {
    dirInfo =
      '<div style="font-size:11px;color:var(--text3)">Entrega: ' +
      a.direccion_entrega +
      (a.zona_expreso ? " | Zona: " + a.zona_expreso : "") +
      "</div>";
  }
  return (
    '<div class="cc-suc-item"><div class="cc-suc-slot">' +
    a.slot +
    "</div>" +
    '<div style="flex:1"><span class="cc-suc-label" id="suc-label-' +
    clienteId +
    "-" +
    a.slot +
    '">' +
    a.label +
    "</span>" +
    dirInfo +
    "</div>" +
    '<button class="btn-ghost" style="padding:5px 10px;font-size:12px" onclick="editSucursalInline(\'' +
    clienteId +
    "'," +
    a.slot +
    ')">Editar</button>' +
    '<button class="btn-danger" style="padding:5px 10px;font-size:12px" onclick="deleteSucursalInline(\'' +
    clienteId +
    "'," +
    a.slot +
    ')">Eliminar</button></div>'
  );
}

window.editSucursalInline = async function (clienteId, slot) {
  var addr = allAddresses.find(function (x) {
    return x.customer_id === clienteId && x.slot === slot;
  });
  if (!addr) return;
  var newLabel = prompt("Direccion del cliente (label):", addr.label);
  if (newLabel === null) return;
  var newDir = prompt(
    "Direccion real de entrega:",
    addr.direccion_entrega || "",
  );
  if (newDir === null) return;
  var newZona = prompt("Zona Expreso:", addr.zona_expreso || "");
  if (newZona === null) return;
  var updates = {};
  if (newLabel.trim() && newLabel.trim() !== addr.label)
    updates.label = newLabel.trim();
  if (newDir.trim() !== (addr.direccion_entrega || ""))
    updates.direccion_entrega = newDir.trim() || null;
  if (newZona.trim() !== (addr.zona_expreso || ""))
    updates.zona_expreso = newZona.trim() || null;
  if (!Object.keys(updates).length) return;
  try {
    await sb
      .from(TABLE_ADDRESSES)
      .update(updates)
      .eq("customer_id", clienteId)
      .eq("slot", slot);
    Object.assign(addr, updates);
    var labelEl = document.getElementById(
      "suc-label-" + clienteId + "-" + slot,
    );
    if (labelEl && updates.label) labelEl.textContent = updates.label;
    toast("Sucursal actualizada");
    loadClientes();
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
};

window.toggleCard = function (header) {
  var body = header.nextElementSibling;
  var chevron = header.querySelector(".cc-chevron");
  body.classList.toggle("open");
  chevron.classList.toggle("open");
};

window.deleteCliente = async function (clienteId) {
  if (!confirm("Eliminar este cliente y todas sus sucursales?")) return;
  try {
    var linkDel = await sb
      .from("user_customer_links")
      .delete()
      .eq("customer_id", clienteId);
    if (linkDel.error) throw new Error(linkDel.error.message);
    var addrDel = await sb
      .from(TABLE_ADDRESSES)
      .delete()
      .eq("customer_id", clienteId);
    if (addrDel.error) throw new Error(addrDel.error.message);
    var custDel = await sb.from(TABLE_CUSTOMERS).delete().eq("id", clienteId);
    if (custDel.error) throw new Error(custDel.error.message);
    toast("Cliente eliminado");
    loadClientes();
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
};

// ---- EDITAR MODAL ----
window.openEditModal = function (clienteId) {
  var c = allClientes.find(function (x) {
    return x.id === clienteId;
  });
  if (!c) return;
  document.getElementById("editClienteId").value = c.id;
  document.getElementById("editModalTitle").textContent =
    c.business_name || "Editar Cliente";
  // En modo edición: ocultar tabs y contraseña
  document.getElementById("editClienteTabs").style.display = "none";
  document.getElementById("editPasswordRow").style.display = "none";
  document.getElementById("editPanelDatos").style.display = "";
  document.getElementById("editPanelPedido").style.display = "none";
  document.getElementById("saveEditCliente").textContent = "Guardar Cambios";
  document.getElementById("editCod").value = c.cod_cliente || "";
  document.getElementById("editCuit").value = c.cuit || "";
  document.getElementById("editRazon").value = c.business_name || "";
  document.getElementById("editMail").value = c.mail || "";
  document.getElementById("editVend").value = c.vend || "";
  document.getElementById("editDto").value =
    c.dto_vol != null ? (c.dto_vol * 100).toFixed(0) : "";
  document.getElementById("editUsername").value = c.username || "";
  document.getElementById("editClienteModal").style.display = "flex";
};

["closeEditModal", "closeEditModal2"].forEach(function (id) {
  document.getElementById(id).addEventListener("click", function () {
    document.getElementById("editClienteModal").style.display = "none";
  });
});

document
  .getElementById("saveEditCliente")
  .addEventListener("click", async function () {
    var id = document.getElementById("editClienteId").value;
    var dto = parseFloat(document.getElementById("editDto").value);
    var editUsernameVal = document
      .getElementById("editUsername")
      .value.trim()
      .toLowerCase();
    var payload = {
      cod_cliente: document.getElementById("editCod").value.trim(),
      cuit: cleanCuit(document.getElementById("editCuit").value),
      business_name: document.getElementById("editRazon").value.trim(),
      mail: document.getElementById("editMail").value.trim(),
      vend: document.getElementById("editVend").value.trim(),
      dto_vol: isNaN(dto) ? null : dto / 100,
      username: editUsernameVal || null,
    };
    if (!payload.cod_cliente) {
      toast("Ingresa un codigo", "warning");
      return;
    }
    if (!payload.business_name) {
      toast("Ingresa la razon social", "warning");
      return;
    }
    this.disabled = true;
    try {
      if (id) {
        // Obtener el vend anterior para detectar cambio de vendedor
        var prevCustomer = allClientes.find(function (c) {
          return c.id === id;
        });
        var prevVend = prevCustomer ? prevCustomer.vend || "" : "";
        await sbUpdate(TABLE_CUSTOMERS, id, "id", payload);
        // Si cambio el vendedor, vincular al nuevo
        if (payload.vend && payload.vend !== prevVend) {
          await linkCustomerToVendor(payload.vend, id);
        }
        toast("Cliente actualizado");
        // Modo expo: si hay cliente expo activo, actualizar estado y mostrar pedido
        if (_expoSavedCustomer) {
          _expoSavedCustomer = Object.assign(_expoSavedCustomer, {
            cod_cliente: payload.cod_cliente,
            business_name: payload.business_name,
            dto_vol: parseFloat(payload.dto_vol) || 0,
            vend: payload.vend || "",
          });
          _editClienteActivarTab("pedido");
          _expoInitCard();
          loadClientes();
          return; // no cerrar modal en modo expo
        }
      } else {
        // Nuevo cliente — modo expo: crear y quedar en el modal
        var pwd30El = document.getElementById("editPassword");
        payload.pin = (pwd30El && pwd30El.value.length >= 20)
          ? pwd30El.value
          : generatePassword30();
        var authId = await createAuthUser(payload.cuit, payload.pin);
        if (authId) payload.auth_user_id = authId;
        var insertedEdit = await sbInsert(TABLE_CUSTOMERS, payload);
        if (!insertedEdit.length) throw new Error("No se pudo crear el cliente");
        if (payload.vend) {
          await linkCustomerToVendor(payload.vend, insertedEdit[0].id);
        }
        document.getElementById("editClienteId").value = insertedEdit[0].id;
        _expoSavedCustomer = {
          id: insertedEdit[0].id,
          cod_cliente: payload.cod_cliente,
          business_name: payload.business_name,
          dto_vol: parseFloat(payload.dto_vol) || 0,
          vend: payload.vend || "",
        };
        toast("Cliente creado");
        _editClienteActivarTab("pedido");
        _expoInitCard();
        loadClientes();
        return; // no cerrar el modal
      }
      document.getElementById("editClienteModal").style.display = "none";
      loadClientes();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

// ---- REPARAR AUTH (clientes sin auth_user_id) ----
document
  .getElementById("repairAuthBtn")
  .addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = "Reparando...";
    try {
      var sinAuth = allClientes.filter(function (c) {
        return !c.auth_user_id && c.cuit && c.pin;
      });
      if (!sinAuth.length) {
        toast("Todos los clientes ya tienen auth_user_id", "success");
        return;
      }
      var reparados = 0,
        errores = 0;
      for (var i = 0; i < sinAuth.length; i++) {
        var c = sinAuth[i];
        try {
          var authId = await createAuthUser(c.cuit, String(c.pin));
          if (authId) {
            await sbUpdate(TABLE_CUSTOMERS, c.id, "id", {
              auth_user_id: authId,
            });
            reparados++;
            toast(
              "Auth creado para " + c.cod_cliente + " (" + c.cuit + ")",
              "success",
            );
          } else {
            errores++;
          }
        } catch (err) {
          errores++;
          toast("Error en " + c.cod_cliente + ": " + err.message, "error");
        }
      }
      toast(
        "Reparacion completa: " + reparados + " OK, " + errores + " errores",
        reparados ? "success" : "warning",
      );
      loadClientes();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Reparar Auth";
    }
  });

// ---- VERIFICAR PINES (sweep de desincronizaciones auth.users <-> customers.pin) ----
// Intenta signInWithPassword por cada cliente y lista los que el PIN guardado no abre.
// Es solo lectura: no modifica ninguna tabla. El fix (update auth.users) lo ejecuta
// el admin a mano via SQL Editor con el SQL que copia cada fila.
var verifyPinsInProgress = false;

function buildPinFixSql(email, pin) {
  // email y pin vienen de la DB (no de input libre), pero igual escapamos comillas simples.
  var safeEmail = String(email).replace(/'/g, "''");
  var safePin = String(pin).replace(/'/g, "''");
  return (
    "update auth.users set encrypted_password = crypt('" +
    safePin +
    "', gen_salt('bf')) where email = '" +
    safeEmail +
    "';"
  );
}

async function tryLoginWithStoredPin(tmpClient, email, pin) {
  try {
    var res = await tmpClient.auth.signInWithPassword({
      email: email,
      password: String(pin),
    });
    if (res.error) {
      var msg = (res.error.message || "").toLowerCase();
      if (
        msg.indexOf("rate") !== -1 ||
        msg.indexOf("too many") !== -1 ||
        res.error.status === 429
      )
        return "rate";
      return "fail";
    }
    try {
      await tmpClient.auth.signOut();
    } catch (_) {}
    return "ok";
  } catch (e) {
    var m = (e && e.message ? e.message : "").toLowerCase();
    if (m.indexOf("rate") !== -1 || m.indexOf("too many") !== -1) return "rate";
    return "fail";
  }
}

document
  .getElementById("verifyPinsCloseBtn")
  .addEventListener("click", function () {
    document.getElementById("verifyPinsPanel").style.display = "none";
  });

document
  .getElementById("verifyPinsBtn")
  .addEventListener("click", async function () {
    if (verifyPinsInProgress) return;

    if (!allClientes.length) {
      toast("Cargá primero la lista de clientes (Actualizar)", "warning");
      return;
    }

    if (
      !window.confirm(
        "Esto va a intentar hacer login con el PIN guardado de cada cliente (~1–2 min). Es solo lectura, no modifica datos. ¿Continuar?",
      )
    ) {
      return;
    }

    verifyPinsInProgress = true;

    var btn = this;
    var origTxt = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verificando...";

    var panel = document.getElementById("verifyPinsPanel");
    var progressEl = document.getElementById("verifyPinsProgress");
    var summaryEl = document.getElementById("verifyPinsSummary");
    var listEl = document.getElementById("verifyPinsList");
    panel.style.display = "block";
    listEl.innerHTML = "";
    summaryEl.textContent = "Preparando...";
    progressEl.style.width = "0%";

    var candidatos = allClientes.filter(function (c) {
      return (
        c.auth_user_id && c.pin && c.cuit && cleanCuit(c.cuit).length >= 10
      );
    });
    var total = candidatos.length;

    if (!total) {
      summaryEl.textContent =
        "No hay clientes con PIN + auth_user_id para verificar.";
      btn.disabled = false;
      btn.textContent = origTxt;
      verifyPinsInProgress = false;
      return;
    }

    var tmpClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );

    var okCount = 0,
      rateCount = 0,
      done = 0;
    var broken = [];
    var CONCURRENCY = 3;
    var idx = 0;

    function updateSummary() {
      var pct = total ? Math.round((done * 100) / total) : 0;
      progressEl.style.width = pct + "%";
      summaryEl.textContent =
        done +
        " / " +
        total +
        " revisados — " +
        okCount +
        " OK, " +
        broken.length +
        " desincronizados" +
        (rateCount ? ", " + rateCount + " rate-limit" : "");
    }

    function renderBroken(c) {
      var email = cleanCuit(c.cuit) + "@cuit.loekemeyer";
      var sql = buildPinFixSql(email, c.pin);
      var row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:#fff8ec;border:1px solid #f0d29c;border-radius:8px";
      var info = document.createElement("div");
      info.innerHTML =
        "<strong>COD " +
        c.cod_cliente +
        "</strong> — CUIT " +
        c.cuit +
        " — PIN guardado: <code>" +
        c.pin +
        "</code>";
      var copyBtn = document.createElement("button");
      copyBtn.className = "btn-ghost";
      copyBtn.type = "button";
      copyBtn.textContent = "Copiar SQL";
      copyBtn.addEventListener("click", function () {
        (navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(sql)
          : Promise.reject(new Error("no-clipboard"))
        )
          .then(function () {
            toast("SQL copiado para COD " + c.cod_cliente, "success");
          })
          .catch(function () {
            window.prompt("Copiá este SQL manualmente:", sql);
          });
      });
      row.appendChild(info);
      row.appendChild(copyBtn);
      listEl.appendChild(row);
    }

    async function worker() {
      while (idx < total) {
        var myIdx = idx++;
        var c = candidatos[myIdx];
        var email = cleanCuit(c.cuit) + "@cuit.loekemeyer";
        var result = await tryLoginWithStoredPin(tmpClient, email, c.pin);
        if (result === "rate") {
          await new Promise(function (r) {
            setTimeout(r, 2500);
          });
          result = await tryLoginWithStoredPin(tmpClient, email, c.pin);
          if (result === "rate") rateCount++;
        }
        if (result === "ok") okCount++;
        else if (result === "fail") {
          broken.push(c);
          renderBroken(c);
        }
        done++;
        updateSummary();
        await new Promise(function (r) {
          setTimeout(r, 120);
        });
      }
    }

    try {
      var workers = [];
      for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
      await Promise.all(workers);
      summaryEl.textContent =
        "Terminado: " +
        done +
        " revisados — " +
        okCount +
        " OK, " +
        broken.length +
        " desincronizados" +
        (rateCount
          ? ", " + rateCount + " sin poder verificar (rate-limit)"
          : "");
      if (!broken.length) {
        listEl.innerHTML =
          '<div style="padding:12px;background:#eafaf0;border:1px solid #b7e4c7;border-radius:8px">✅ Todos los PINes guardados coinciden con auth.</div>';
      }
      toast(
        "Verificación completa: " +
          broken.length +
          " desincronizados de " +
          done,
        broken.length ? "warning" : "success",
      );
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = origTxt;
      verifyPinsInProgress = false;
    }
  });

// ---- MODAL CLIENTE: helpers de tabs ----
function _editClienteActivarTab(tab) {
  var isDatos = tab === "datos";
  document.getElementById("editPanelDatos").style.display = isDatos ? "" : "none";
  document.getElementById("editPanelPedido").style.display = isDatos ? "none" : "";
  document.getElementById("editTabDatos").classList.toggle("active", isDatos);
  document.getElementById("editTabPedido").classList.toggle("active", !isDatos);
  // Cambiar texto del botón guardar según el tab activo
  var saveBtn = document.getElementById("saveEditCliente");
  if (isDatos) {
    saveBtn.style.display = "";
  } else {
    // En el tab Pedido el cliente ya fue creado; no tiene sentido "Guardar"
    saveBtn.style.display = "none";
  }
}

document.getElementById("editTabDatos").addEventListener("click", function () {
  _editClienteActivarTab("datos");
});
document.getElementById("editTabPedido").addEventListener("click", function () {
  _editClienteActivarTab("pedido");
  // Si ya tiene cliente guardado, mostrar cotizador directo
  if (_expoSavedCustomer) _expoInitCard();
});

// ---- EXPO: auto-guardar nuevo cliente silenciosamente al cambiar al tab Pedido ----
async function _expoAutoSave() {
  var cuit = document.getElementById("editCuit").value.trim();
  var razon = document.getElementById("editRazon").value.trim();
  if (!cuit || !razon) {
    toast("Ingresá la razón social y el CUIT primero", "warning");
    return false;
  }
  var cod = document.getElementById("editCod").value.trim();
  var id = document.getElementById("editClienteId").value;
  if (id && _expoSavedCustomer) {
    // Ya guardado: actualizar silenciosamente
    var updatePayload = {
      cod_cliente: cod ? parseInt(cod, 10) : null,
      business_name: razon,
      cuit: cuit || null,
      vend: document.getElementById("editVend").value.trim() || null,
      dto_vol: parseFloat(document.getElementById("editDto").value) || 0,
      username: document.getElementById("editUsername").value.trim() || null,
    };
    try {
      await sbUpdate(TABLE_CUSTOMERS, id, "id", updatePayload);
      _expoSavedCustomer = Object.assign(_expoSavedCustomer, {
        cod_cliente: cod,
        business_name: razon,
        dto_vol: parseFloat(updatePayload.dto_vol) || 0,
        vend: updatePayload.vend || "",
      });
    } catch (e) { /* silencioso — el usuario puede seguir cargando el pedido */ }
    return true;
  }
  // Buscar si ya existe un cliente con ese CUIT
  try {
    var existing = await sb.from(TABLE_CUSTOMERS).select("id,cod_cliente,business_name,dto_vol,vend").eq("cuit", cuit).maybeSingle();
    if (existing.data) {
      var ex = existing.data;
      document.getElementById("editClienteId").value = ex.id;
      _expoSavedCustomer = {
        id: ex.id,
        cod_cliente: ex.cod_cliente,
        business_name: ex.business_name || razon,
        dto_vol: ex.dto_vol || 0,
        vend: ex.vend || "",
      };
      toast("Cliente ya existente vinculado", "info");
      return true;
    }
  } catch (e) { /* ignorar, seguir con INSERT */ }

  // Primer guardado: INSERT
  var pwd30El = document.getElementById("editPassword");
  var pin = (pwd30El && pwd30El.value.length >= 20) ? pwd30El.value : generatePassword30();
  document.getElementById("editPassword").value = pin;
  var payload = {
    cod_cliente: cod ? parseInt(cod, 10) : null,
    business_name: razon,
    cuit: cuit || null,
    vend: document.getElementById("editVend").value.trim() || null,
    dto_vol: parseFloat(document.getElementById("editDto").value) || 0,
    username: document.getElementById("editUsername").value.trim() || null,
    pin: pin,
  };
  try {
    var authId = await createAuthUser(cuit, pin);
    if (authId) payload.auth_user_id = authId;
    var inserted = await sbInsert(TABLE_CUSTOMERS, payload);
    if (!inserted.length) throw new Error("insert vacío");
    document.getElementById("editClienteId").value = inserted[0].id;
    _expoSavedCustomer = {
      id: inserted[0].id,
      cod_cliente: cod ? parseInt(cod, 10) : null,
      business_name: razon,
      dto_vol: parseFloat(payload.dto_vol) || 0,
      vend: payload.vend || "",
    };
    if (payload.vend) await linkCustomerToVendor(payload.vend, inserted[0].id);
    loadClientes();
    return true;
  } catch (e) {
    toast("Error al guardar: " + e.message, "error");
    return false;
  }
}

// ---- EXPO: botón "Cargar" en panel Pedido ----
window.expoCargar = async function () {
  var btn = document.getElementById("btnExpoCargar");
  if (btn) { btn.disabled = true; btn.textContent = "Cargando..."; }
  var saved = await _expoAutoSave();
  if (!saved) {
    if (btn) { btn.disabled = false; btn.textContent = "Cargar"; }
    return;
  }
  _expoInitCard();
};

// ---- EXPO: inicializar card cotizador inline en panel Pedido ----
function _expoInitCard() {
  if (!_expoSavedCustomer) return;
  // Si ya hay card para el mismo cliente, no reinicializar (preservar carrito)
  if (
    _expoCard &&
    _expoCard.customer &&
    _expoCard.customer.id === _expoSavedCustomer.id
  ) return;
  var contenido = document.getElementById("editPedidoContenido");
  contenido.innerHTML = "";
  var root = document.createElement("div");
  root.className = "cp-card cp-card-expo";
  root.dataset.idx = "99";
  root.innerHTML = cpBuildCardHTML(99);
  contenido.appendChild(root);
  _expoCard = {
    idx: 99,
    root: root,
    customer: null,
    history: { web: [], sales: [] },
    pendingFileData: null,
    pendingFileIsPdf: false,
    parsed: [],
    invalid: [],
    payment: null,
    delivery: "",
    flyers: [],
    upsellMsg: "",
    submitted: false,
    orderId: null,
    historyLoading: false,
    historyMode: false,
    deliveryAddresses: [],
    deliveryLoading: false,
    selectedDeliveryIdx: null,
    finalDelivery: "",
    pdfPaymentRaw: "",
    searchCod: root.querySelector(".cp-search-cod"),
    searchBtn: root.querySelector(".cp-search-btn"),
    suggestEl: root.querySelector(".cp-suggest"),
    suggestTimer: null,
    customerWrap: root.querySelector(".cp-card-customer-wrap"),
    dropZone: root.querySelector(".cp-dropzone"),
    fileInput: root.querySelector(".cp-file-input"),
    resetBtn: root.querySelector(".cp-card-reset"),
    status: root.querySelector(".cp-card-status"),
    summaryWrap: root.querySelector(".cp-card-summary-wrap"),
    msgWrap: root.querySelector(".cp-card-msg-wrap"),
    flyersWrap: root.querySelector(".cp-card-flyers-wrap"),
    actionsWrap: root.querySelector(".cp-card-actions-wrap"),
  };
  cpWireCard(_expoCard);
  cpCardSelectCustomer(_expoCard, _expoSavedCustomer);
}

// Botón copiar contraseña
document.getElementById("copyPasswordBtn").addEventListener("click", function () {
  var pwd = document.getElementById("editPassword").value;
  if (!pwd) return;
  (navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(pwd)
    : Promise.reject(new Error("no-clipboard"))
  ).then(function () {
    toast("Contraseña copiada");
  }).catch(function () {
    // Fallback selección manual
    document.getElementById("editPassword").select();
    toast("Seleccioná y copiá la contraseña manualmente", "warning");
  });
});

// ---- NUEVO CLIENTE ----
document.getElementById("newClienteBtn").addEventListener("click", function () {
  // Resetear estado expo
  _expoCard = null;
  _expoSavedCustomer = null;
  document.getElementById("editClienteId").value = "";
  document.getElementById("editModalTitle").textContent = "Nuevo Cliente";
  [
    "editCod",
    "editCuit",
    "editRazon",
    "editMail",
    "editVend",
    "editDto",
    "editUsername",
  ].forEach(function (id) {
    document.getElementById(id).value = "";
  });
  // Generar contraseña de 30 caracteres y mostrarla
  var pwd = generatePassword30();
  document.getElementById("editPassword").value = pwd;
  document.getElementById("editPasswordRow").style.display = "block";
  // Mostrar tabs y resetear al panel Datos
  document.getElementById("editClienteTabs").style.display = "flex";
  _editClienteActivarTab("datos");
  // Resetear panel Pedido: mostrar botón Cargar
  document.getElementById("editPedidoContenido").innerHTML =
    '<div class="expo-cargar-hint">' +
    '<p>Completá los datos del cliente y hacé clic en <strong>Cargar</strong> para continuar.</p>' +
    '<button class="btn-primary" id="btnExpoCargar" onclick="expoCargar()">Cargar</button>' +
    '</div>';
  document.getElementById("saveEditCliente").textContent = "Guardar Cambios";
  document.getElementById("editClienteModal").style.display = "flex";
});

// ---- AGREGAR SUCURSAL MODAL ----
window.openAddSucModal = function (clienteId, currentCount) {
  document.getElementById("modalSucClienteId").value = clienteId;
  document.getElementById("modalSucLabel").value = "";
  document.getElementById("modalSucSlot").value = currentCount + 1;
  document.getElementById("modalSucDirEntrega").value = "";
  document.getElementById("modalSucZona").value = "";
  document.getElementById("addSucModal").style.display = "flex";
};

["closeAddSucModal", "closeAddSucModal2"].forEach(function (id) {
  document.getElementById(id).addEventListener("click", function () {
    document.getElementById("addSucModal").style.display = "none";
  });
});

document
  .getElementById("saveModalSuc")
  .addEventListener("click", async function () {
    var clienteId = document.getElementById("modalSucClienteId").value;
    var label = document.getElementById("modalSucLabel").value.trim();
    var slot = parseInt(document.getElementById("modalSucSlot").value) || 1;
    var dirEntrega = document.getElementById("modalSucDirEntrega").value.trim();
    var zona = document.getElementById("modalSucZona").value.trim();
    if (!label) {
      toast("Ingresa una direccion", "warning");
      return;
    }
    this.disabled = true;
    try {
      var payload = { customer_id: clienteId, label: label, slot: slot };
      if (dirEntrega) payload.direccion_entrega = dirEntrega;
      if (zona) payload.zona_expreso = zona;
      await sbInsert(TABLE_ADDRESSES, payload);
      toast("Sucursal agregada");
      document.getElementById("addSucModal").style.display = "none";
      loadClientes();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

// ---- ELIMINAR SUCURSAL INLINE ----
window.deleteSucursalInline = async function (clienteId, slot) {
  if (!confirm("Eliminar esta sucursal?")) return;
  try {
    await sb
      .from(TABLE_ADDRESSES)
      .delete()
      .eq("customer_id", clienteId)
      .eq("slot", slot);
    toast("Sucursal eliminada");
    loadClientes();
  } catch (err) {
    toast("Error: " + err.message, "error");
  }
};

// ---- FILTROS ----
["filterCod", "filterCuit", "filterRazon"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", applyFilters);
});
document.getElementById("clearFilters").addEventListener("click", function () {
  document.getElementById("filterCod").value = "";
  document.getElementById("filterCuit").value = "";
  document.getElementById("filterRazon").value = "";
  renderClientes(allClientes, allAddresses);
});

function applyFilters() {
  var cod = document.getElementById("filterCod").value.trim();
  var cuit = document.getElementById("filterCuit").value.trim();
  var razon = document.getElementById("filterRazon").value.trim().toLowerCase();
  var filtered = allClientes.filter(function (c) {
    if (cod && !String(c.cod_cliente || "").includes(cod)) return false;
    if (cuit && !String(c.cuit || "").includes(cuit)) return false;
    if (
      razon &&
      !String(c.business_name || "")
        .toLowerCase()
        .includes(razon)
    )
      return false;
    return true;
  });
  renderClientes(filtered, allAddresses);
}

document
  .getElementById("refreshClientesBtn")
  .addEventListener("click", loadClientes);

// ---- ESTADO DE PEDIDOS (TRACKING) ----
var TABLE_TRACKING = "order_tracking";
var trackingData = [];
var trackingActiveTab = "a_programar";

// Convierte numero serial de Excel a fecha legible "dd/mm/yyyy"
function excelDateToStr(val) {
  if (!val) return "";
  var s = String(val).trim();
  // Si ya tiene barras o letras, es texto → devolver tal cual
  if (/[\/\-a-zA-Z]/.test(s)) return s;
  var num = Number(s);
  if (isNaN(num) || num < 1000 || num > 100000) return s;
  // Excel serial: days since 1900-01-01 (con bug del 29/2/1900)
  var d = new Date((num - 25569) * 86400000);
  var dd = String(d.getUTCDate()).padStart(2, "0");
  var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  var yy = d.getUTCFullYear();
  return dd + "/" + mm + "/" + yy;
}

// Detecta si una fila es encabezado (no datos)
function isHeaderRow(npVal, codVal) {
  if (/NP|N°|COD|RAZON|FECHA|DIRECCION/i.test(npVal)) return true;
  if (/NP|N°|COD|RAZON|FECHA|DIRECCION/i.test(codVal)) return true;
  return false;
}

// Drag & drop + file input
(function () {
  var dz = document.getElementById("trackingDropZone");
  var fi = document.getElementById("trackingFileInput");
  if (!dz || !fi) return;
  dz.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragenter", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", function (e) {
    // Solo quitar el highlight si realmente se salio de la zona (no al pasar sobre hijos)
    if (e.target === dz || !dz.contains(e.relatedTarget))
      dz.classList.remove("drag-over");
  });
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dz.classList.remove("drag-over");
    if (e.dataTransfer.files.length)
      handleTrackingFile(e.dataTransfer.files[0]);
  });
  // Click en cualquier parte de la zona (fuera del boton/label) abre el file picker
  dz.addEventListener("click", function (e) {
    if (e.target.closest("label, input, button")) return;
    fi.click();
  });
  fi.addEventListener("change", function () {
    if (fi.files.length) handleTrackingFile(fi.files[0]);
  });
  // Evita que el navegador abra el archivo si se suelta fuera de la zona
  window.addEventListener("dragover", function (e) {
    e.preventDefault();
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
  });
})();

function handleTrackingFile(file) {
  showLoader("Leyendo " + file.name + "...");
  var reader = new FileReader();
  reader.onload = function (e) {
    // deferHeavy da al navegador un par de frames para pintar el spinner antes del parseo sincrono
    deferHeavy(function () {
      try {
        var wb = XLSX.read(e.target.result, { type: "array" });

        // 1) Hoja "Programacion Diaria" → A Programar + Programados
        var sheetProg = wb.SheetNames.find(function (n) {
          return (
            n.toLowerCase().indexOf("programacion") >= 0 ||
            n.toLowerCase().indexOf("programación") >= 0
          );
        });
        if (!sheetProg) {
          toast("No se encontro la hoja 'Programacion Diaria'", "error");
          return;
        }
        trackingData = parseTrackingSheet(wb.Sheets[sheetProg]);

        // 2) Hoja "Pedidos Entregados ..." → Enviados / Retirados
        var sheetEntr = wb.SheetNames.find(function (n) {
          return n.toLowerCase().indexOf("entregado") >= 0;
        });
        if (sheetEntr) {
          var enviados = parseEntregadosSheet(wb.Sheets[sheetEntr]);
          trackingData = trackingData.concat(enviados);
          toast(
            "Leidas hojas: " +
              sheetProg +
              " + " +
              sheetEntr +
              " (" +
              enviados.length +
              " entregados)",
          );
        } else {
          toast(
            "Hoja de entregados no encontrada entre: " +
              wb.SheetNames.join(", "),
            "warning",
          );
        }

        renderTrackingPreview();
      } catch (err) {
        toast("Error al leer el Excel: " + err.message, "error");
      } finally {
        hideLoader();
      }
    });
  };
  reader.onerror = function () {
    hideLoader();
    toast("No se pudo leer el archivo", "error");
  };
  reader.readAsArrayBuffer(file);
}

function parseTrackingSheet(sheet) {
  var range = XLSX.utils.decode_range(sheet["!ref"]);
  var rows = [];
  for (var r = range.s.r; r <= range.e.r; r++) {
    var row = [];
    for (var c = range.s.c; c <= range.e.c; c++) {
      var cell = sheet[XLSX.utils.encode_cell({ r: r, c: c })];
      row.push(cell ? String(cell.v != null ? cell.v : "") : "");
    }
    rows.push(row);
  }

  // Scan for section headers
  var sections = []; // {type, startRow, headerRow}
  for (var i = 0; i < rows.length; i++) {
    var joined = rows[i].join(" ").toUpperCase();
    if (
      joined.indexOf("PEDIDOS SUPER") >= 0 ||
      joined.indexOf("SUPER PARA") >= 0
    ) {
      sections.push({ type: "skip", startRow: i });
    } else if (joined.indexOf("PEDIDOS A PROGRAMAR") >= 0) {
      sections.push({ type: "a_programar", startRow: i });
    } else if (
      joined.indexOf("PEDIDOS PROGRAMADOS") >= 0 ||
      (joined.indexOf("PROGRAMADOS") >= 0 && joined.indexOf("A PROGRAMAR") < 0)
    ) {
      sections.push({ type: "programado", startRow: i });
    } else if (
      joined.indexOf("ENVIADOS") >= 0 ||
      joined.indexOf("ENTREGADOS") >= 0
    ) {
      sections.push({ type: "enviado", startRow: i });
    }
  }

  var result = [];

  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s];
    if (sec.type === "skip") continue;
    var endRow =
      s + 1 < sections.length ? sections[s + 1].startRow : rows.length;

    // Find header row (first row after section title that has "NP" or "COD" in it)
    var headerIdx = -1;
    var colMap = {};
    for (
      var h = sec.startRow + 1;
      h < Math.min(sec.startRow + 5, endRow);
      h++
    ) {
      var hJoined = rows[h].join(" ").toUpperCase();
      if (hJoined.indexOf("NP") >= 0 || hJoined.indexOf("COD") >= 0) {
        headerIdx = h;
        // Map columns by header text
        for (var hc = 0; hc < rows[h].length; hc++) {
          var hVal = rows[h][hc].toUpperCase().trim();
          if (hVal.indexOf("NP") >= 0 && hVal.indexOf("NP") < 4) colMap.np = hc;
          if (hVal.indexOf("COD") >= 0 && hVal.indexOf("CLIENTE") >= 0)
            colMap.cod = hc;
          if (hVal === "COD" || hVal === "COD CLIENTE") colMap.cod = hc;
          if (
            hVal.indexOf("RAZON") >= 0 ||
            hVal.indexOf("RAZÓN") >= 0 ||
            hVal.indexOf("SOCIAL") >= 0
          )
            colMap.razon = hc;
          if (
            hVal.indexOf("CLIENTE") >= 0 &&
            hVal.indexOf("COD") < 0 &&
            !colMap.razon
          )
            colMap.razon = hc;
          if (hVal.indexOf("DIRECCION") >= 0 || hVal.indexOf("DIRECCIÓN") >= 0)
            colMap.dir = hc;
          if (hVal.indexOf("BARRIO") >= 0) colMap.barrio = hc;
          if (
            hVal.indexOf("FECHA") >= 0 &&
            (hVal.indexOf("ESTIMADA") >= 0 ||
              hVal.indexOf("ENTREGA") >= 0 ||
              hVal.indexOf("TURNO") >= 0)
          )
            colMap.fecha = hc;
          if (hVal.indexOf("FECHA") >= 0 && hVal.indexOf("RECEP") >= 0)
            colMap.fechaRecep = hc;
          // m3: preferir match exacto (Mt3 / M3 / M³) sobre Mt3 FC u otras
          // variantes con sufijos. Si ya hay un match exacto previo, no pisar.
          if (hVal === "M3" || hVal === "M³" || hVal === "MT3") {
            colMap.m3 = hc;
            colMap.m3Exact = true;
          } else if (
            !colMap.m3Exact &&
            (hVal.indexOf("VOLUMEN") >= 0 ||
              hVal.indexOf("M3") >= 0 ||
              hVal.indexOf("MT3") >= 0) &&
            hVal.length < 15
          ) {
            colMap.m3 = hc;
          }
        }
        break;
      }
    }
    if (headerIdx < 0) continue;

    // Parse data rows
    for (var dr = headerIdx + 1; dr < endRow; dr++) {
      var dRow = rows[dr];
      if (!dRow || !dRow.length) continue;
      var codVal =
        colMap.cod != null ? String(dRow[colMap.cod] || "").trim() : "";
      var npVal = colMap.np != null ? String(dRow[colMap.np] || "").trim() : "";
      if (!codVal && !npVal) continue;
      if (isHeaderRow(npVal, codVal)) continue; // skip sub-header rows
      var codNum = parseInt(codVal);
      if (isNaN(codNum) && !npVal) continue;

      var dirVal =
        colMap.dir != null ? String(dRow[colMap.dir] || "").trim() : "";
      var fechaRaw =
        colMap.fecha != null ? String(dRow[colMap.fecha] || "").trim() : "";
      var fechaVal = excelDateToStr(fechaRaw);

      var status = sec.type;
      if (sec.type === "enviado") {
        status =
          dirVal.toUpperCase().indexOf("VIRGILIO") >= 0
            ? "retirado"
            : "enviado";
      } else if (sec.type === "programado" && !fechaVal) {
        status = "a_programar";
      }

      var m3Raw =
        colMap.m3 != null ? String(dRow[colMap.m3] || "").trim() : "";
      var m3Num = parseM3Cell(m3Raw);

      result.push({
        cod_cliente: codNum || null,
        np_number: npVal || null,
        status: status,
        fecha_estimada: sec.type === "programado" ? fechaVal : null,
        fecha_entrega: sec.type === "enviado" ? fechaVal : null,
        direccion_entrega: dirVal || null,
        razon_social:
          colMap.razon != null
            ? String(dRow[colMap.razon] || "").trim() || null
            : null,
        barrio_entrega:
          colMap.barrio != null
            ? String(dRow[colMap.barrio] || "").trim() || null
            : null,
        m3_isis: m3Num,
        origen: detectOrigen(dRow),
      });
    }
  }

  return result.filter(function (r) {
    return r.cod_cliente || r.np_number;
  });
}

// Detecta el origen del pedido (WEB / COTIZADOR / SUPER / etc.)
// Escanea TODAS las celdas de la fila buscando un valor que coincida.
// El header de esa columna en el Excel suele estar vacio, asi que detectamos
// por contenido de la celda de datos.
function detectOrigen(dRow) {
  if (!dRow) return null;
  for (var i = 0; i < dRow.length; i++) {
    var val = String(dRow[i] || "").trim().toUpperCase();
    if (val === "WEB") return "WEB";
    if (val === "COTIZADOR") return "COTIZADOR";
    if (val === "SUPER") return "SUPER";
    if (val === "PROMO") return "PROMO";
  }
  return null;
}

// Parsea celda m3 del Excel. Acepta "0,13", "0.13", "0,1300", numero raw.
// Devuelve null si no se puede parsear (no rompe el resto del parser).
function parseM3Cell(raw) {
  if (raw == null || raw === "") return null;
  var s = String(raw).trim().replace(",", ".");
  var n = Number(s);
  if (isNaN(n) || n < 0 || n > 100) return null;
  return n;
}

function parseEntregadosSheet(sheet) {
  var range = XLSX.utils.decode_range(sheet["!ref"]);
  var rows = [];
  for (var r = range.s.r; r <= range.e.r; r++) {
    var row = [];
    for (var c = range.s.c; c <= range.e.c; c++) {
      var cell = sheet[XLSX.utils.encode_cell({ r: r, c: c })];
      row.push(cell ? String(cell.v != null ? cell.v : "") : "");
    }
    rows.push(row);
  }

  // Find header row — scan more rows, be more flexible with detection
  var headerIdx = -1;
  var colMap = {};
  for (var h = 0; h < Math.min(rows.length, 20); h++) {
    var hJoined = rows[h].join(" ").toUpperCase();
    if (hJoined.indexOf("NP") >= 0 || hJoined.indexOf("COD") >= 0) {
      headerIdx = h;
      for (var hc = 0; hc < rows[h].length; hc++) {
        var hVal = rows[h][hc].toUpperCase().trim();
        if (hVal.indexOf("NP") >= 0 && hVal.length < 10) colMap.np = hc;
        if (hVal.indexOf("COD") >= 0) colMap.cod = hc;
        if (
          hVal.indexOf("RAZON") >= 0 ||
          hVal.indexOf("RAZÓN") >= 0 ||
          hVal.indexOf("SOCIAL") >= 0
        )
          colMap.razon = hc;
        if (
          hVal.indexOf("CLIENTE") >= 0 &&
          hVal.indexOf("COD") < 0 &&
          !colMap.razon
        )
          colMap.razon = hc;
        if (hVal.indexOf("DIRECCION") >= 0 || hVal.indexOf("DIRECCIÓN") >= 0)
          colMap.dir = hc;
        if (hVal.indexOf("BARRIO") >= 0) colMap.barrio = hc;
        if (hVal.indexOf("FECHA") >= 0) colMap.fecha = hc;
        if (
          hVal === "M3" ||
          hVal === "M³" ||
          hVal.indexOf("VOLUMEN") >= 0 ||
          (hVal.indexOf("M3") >= 0 && hVal.length < 15)
        )
          colMap.m3 = hc;
      }
      break;
    }
  }
  if (headerIdx < 0) {
    console.warn(
      "Entregados: no se encontro fila de encabezado. Primeras filas:",
      rows.slice(0, 5),
    );
    return [];
  }

  var result = [];
  for (var dr = headerIdx + 1; dr < rows.length; dr++) {
    var dRow = rows[dr];
    if (!dRow || !dRow.length) continue;
    var codVal =
      colMap.cod != null ? String(dRow[colMap.cod] || "").trim() : "";
    var npVal = colMap.np != null ? String(dRow[colMap.np] || "").trim() : "";
    if (!codVal && !npVal) continue;
    if (isHeaderRow(npVal, codVal)) continue;
    var codNum = parseInt(codVal);
    if (isNaN(codNum) && !npVal) continue;

    var dirVal =
      colMap.dir != null ? String(dRow[colMap.dir] || "").trim() : "";
    var fechaRaw =
      colMap.fecha != null ? String(dRow[colMap.fecha] || "").trim() : "";
    var fechaVal = excelDateToStr(fechaRaw);

    var isVirgilio = dirVal.toUpperCase().indexOf("VIRGILIO") >= 0;

    var m3Raw =
      colMap.m3 != null ? String(dRow[colMap.m3] || "").trim() : "";
    var m3Num = parseM3Cell(m3Raw);

    result.push({
      cod_cliente: codNum || null,
      np_number: npVal || null,
      status: isVirgilio ? "retirado" : "enviado",
      fecha_estimada: null,
      fecha_entrega: fechaVal || null,
      direccion_entrega: dirVal || null,
      razon_social:
        colMap.razon != null
          ? String(dRow[colMap.razon] || "").trim() || null
          : null,
      barrio_entrega:
        colMap.barrio != null
          ? String(dRow[colMap.barrio] || "").trim() || null
          : null,
      m3_isis: m3Num,
      origen: detectOrigen(dRow),
    });
  }

  return result.filter(function (r) {
    return r.cod_cliente || r.np_number;
  });
}

function renderTrackingPreview() {
  if (!trackingData.length) {
    document.getElementById("trackingPreview").style.display = "none";
    return;
  }
  document.getElementById("trackingPreview").style.display = "block";
  document.getElementById("trackingPreviewCount").textContent =
    trackingData.length + " registros detectados";

  var counts = { a_programar: 0, programado: 0, enviado: 0 };
  trackingData.forEach(function (r) {
    if (r.status === "retirado") counts.enviado++;
    else counts[r.status] = (counts[r.status] || 0) + 1;
  });
  document.getElementById("countAProgramar").textContent = counts.a_programar;
  document.getElementById("countProgramado").textContent = counts.programado;
  document.getElementById("countEnviado").textContent = counts.enviado;

  renderTrackingTable(trackingActiveTab);
}

function renderTrackingTable(tab) {
  trackingActiveTab = tab;
  document.querySelectorAll(".tracking-tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.trackingTab === tab);
  });

  var filtered = trackingData.filter(function (r) {
    if (tab === "enviado")
      return r.status === "enviado" || r.status === "retirado";
    return r.status === tab;
  });

  var head = document.getElementById("trackingHead");
  var body = document.getElementById("trackingBody");

  var cols = [
    "NP",
    "Cod Cliente",
    "Razon Social",
    "Direccion",
    "Barrio",
    "Estado",
  ];
  if (tab === "programado") cols.push("Fecha Estimada");
  if (tab === "enviado") cols.push("Fecha Entrega");
  head.innerHTML = cols
    .map(function (c) {
      return "<th>" + c + "</th>";
    })
    .join("");

  if (!filtered.length) {
    body.innerHTML =
      '<tr><td colspan="' +
      cols.length +
      '" style="text-align:center;color:var(--text3);padding:30px">Sin registros en esta seccion</td></tr>';
    return;
  }

  body.innerHTML = filtered
    .map(function (r) {
      var statusLabel =
        r.status === "a_programar"
          ? "A Programar"
          : r.status === "programado"
            ? "Programado"
            : r.status === "retirado"
              ? "Retirado"
              : "Enviado";
      var html = "<tr>";
      html += "<td>" + (r.np_number || "-") + "</td>";
      html += "<td>" + (r.cod_cliente || "-") + "</td>";
      html += "<td>" + (r.razon_social || "-") + "</td>";
      html += "<td>" + (r.direccion_entrega || "-") + "</td>";
      html += "<td>" + (r.barrio_entrega || "-") + "</td>";
      html +=
        '<td><span class="status-badge ' +
        r.status +
        '">' +
        statusLabel +
        "</span></td>";
      if (tab === "programado")
        html += "<td>" + (r.fecha_estimada || "-") + "</td>";
      if (tab === "enviado")
        html += "<td>" + (r.fecha_entrega || "-") + "</td>";
      html += "</tr>";
      return html;
    })
    .join("");
}

// Tab clicks
document.querySelectorAll(".tracking-tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    renderTrackingTable(tab.dataset.trackingTab);
  });
});

// Clear (robust: limpia estado + DOM renderizado + file input)
function trackingClearAll() {
  trackingData = [];
  var prev = document.getElementById("trackingPreview");
  if (prev) prev.style.display = "none";
  var fi = document.getElementById("trackingFileInput");
  if (fi) fi.value = "";
  var head = document.getElementById("trackingHead");
  if (head) head.innerHTML = "";
  var body = document.getElementById("trackingBody");
  if (body) body.innerHTML = "";
  var pc = document.getElementById("trackingPreviewCount");
  if (pc) pc.textContent = "0 registros";
  ["countAProgramar", "countProgramado", "countEnviado"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = "0";
  });
}
var _clearBtn = document.getElementById("trackingClearBtn");
if (_clearBtn) _clearBtn.addEventListener("click", trackingClearAll);
// Delegacion como fallback por si el listener directo no quedo registrado
document.addEventListener("click", function (e) {
  var t = e.target;
  if (t && t.id === "trackingClearBtn") trackingClearAll();
});

// Upload to Supabase (replace all existing data)
document
  .getElementById("trackingUploadBtn")
  .addEventListener("click", async function () {
    if (!trackingData.length) return;
    this.disabled = true;
    showLoader("Subiendo tracking a Supabase...");
    try {
      // Delete all existing tracking data
      await sb.from(TABLE_TRACKING).delete().neq("id", 0);
      // Insert new data
      var payload = trackingData.map(function (r) {
        return {
          cod_cliente: r.cod_cliente,
          np_number: r.np_number,
          status: r.status,
          fecha_estimada: r.fecha_estimada,
          fecha_entrega: r.fecha_entrega,
          direccion_entrega: r.direccion_entrega,
          razon_social: r.razon_social,
          barrio_entrega: r.barrio_entrega,
          m3_isis: r.m3_isis,
          origen: r.origen,
        };
      });
      // Insert in batches of 500
      for (var i = 0; i < payload.length; i += 500) {
        await sbInsert(TABLE_TRACKING, payload.slice(i, i + 500));
      }
      toast(payload.length + " registros de tracking actualizados");
      // Disparar cruce PPP-web (no bloqueante: si falla, el upload ya esta hecho)
      runPPPCrossReference().catch(function (e) {
        console.warn("Cruce PPP-web fallo:", e);
      });
      trackingClearAll();
      loadTrackingDb();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
      hideLoader();
    }
  });

// Cruce PPP (ISIS) <-> pedidos web. Llama a la RPC server-side run_ppp_cross_reference,
// que limpia ppp_match y la repuebla. Despues dispara WhatsApp para los mismatches sin notificar.
async function runPPPCrossReference() {
  var resp = await sb.rpc("run_ppp_cross_reference", {
    p_tolerance_m3: 0.005,
    p_window_days: 30,
  });
  if (resp.error) {
    console.error("[cruce PPP] RPC error:", resp.error);
    toast("Cruce PPP fallo: " + resp.error.message, "error");
    return;
  }
  var s = resp.data || {};
  var msg =
    "Cruce PPP: " +
    (s.matched || 0) +
    " ok, " +
    (s.mismatch_m3 || 0) +
    " m3 no cuadra, " +
    (s.missing_codes || 0) +
    " codigos faltantes";
  toast(msg);

  // Disparar WhatsApp por cada mismatch/missing sin notificar
  try {
    await notifyPendingPPPMismatches();
  } catch (e) {
    console.warn("[cruce PPP] notificacion WhatsApp fallo:", e);
  }
}

// Toma los rows de ppp_match con notified_at IS NULL y status in (mismatch_m3,missing_codes)
// y dispara la Edge Function notify-m3-mismatch (esta en setup-bot, etapa 5).
async function notifyPendingPPPMismatches() {
  var pendR = await sb
    .from("ppp_match")
    .select("web_order_id,status,m3_web,m3_isis,dif_m3,codigos_faltantes,isis_np")
    .is("notified_at", null)
    .in("status", ["mismatch_m3", "missing_codes"]);
  if (pendR.error) throw pendR.error;
  var pending = pendR.data || [];
  if (!pending.length) return;

  var FN_URL =
    "https://kwkclwhmoygunqmlegrg.functions.supabase.co/notify-m3-mismatch";
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    try {
      var r = await fetch(FN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ web_order_id: p.web_order_id }),
      });
      if (r.ok) {
        await sb
          .from("ppp_match")
          .update({ notified_at: new Date().toISOString() })
          .eq("web_order_id", p.web_order_id);
      } else {
        console.warn(
          "[cruce PPP] notify fallo para",
          p.web_order_id,
          r.status,
        );
      }
    } catch (e) {
      console.warn("[cruce PPP] notify err para", p.web_order_id, e);
    }
  }
}

// Load current tracking from DB
async function loadTrackingDb() {
  var list = document.getElementById("trackingDbList");
  var count = document.getElementById("trackingDbCount");
  list.innerHTML =
    '<div class="loading-row"><span class="spinner"></span>Cargando...</div>';
  try {
    var data = await sbSelectAll(TABLE_TRACKING, "order=cod_cliente.asc");
    count.textContent = data.length + " registros en la base de datos";
    if (!data.length) {
      list.innerHTML =
        '<div class="tracking-empty">No hay datos de tracking cargados. Subi un Excel para empezar.</div>';
      return;
    }
    list.innerHTML = data
      .map(function (r) {
        var statusLabel =
          r.status === "a_programar"
            ? "A Programar"
            : r.status === "programado"
              ? "Programado"
              : r.status === "retirado"
                ? "Retirado"
                : "Enviado";
        var fecha = r.fecha_estimada || r.fecha_entrega || "";
        return (
          '<div class="tracking-db-row">' +
          '<span class="td-np">' +
          (r.np_number || "-") +
          "</span>" +
          '<span class="td-cod">' +
          (r.cod_cliente || "-") +
          "</span>" +
          '<span class="td-razon">' +
          (r.razon_social || "-") +
          "</span>" +
          '<span class="td-dir">' +
          (r.direccion_entrega || "-") +
          "</span>" +
          '<span class="status-badge ' +
          r.status +
          '">' +
          statusLabel +
          "</span>" +
          '<span class="td-fecha">' +
          fecha +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  } catch (err) {
    list.innerHTML =
      '<div class="tracking-empty">Error al cargar: ' + err.message + "</div>";
  }
}

document
  .getElementById("trackingRefreshDb")
  .addEventListener("click", loadTrackingDb);

document
  .getElementById("trackingDeleteAllBtn")
  .addEventListener("click", async function () {
    if (
      !confirm(
        "¿Eliminar TODAS las filas de order_tracking? Los clientes dejarán de ver el estado de sus pedidos hasta que subas una PPP nueva.",
      )
    )
      return;
    this.disabled = true;
    try {
      var res = await sb.from(TABLE_TRACKING).delete().neq("id", 0);
      if (res.error) throw new Error(res.error.message);
      toast("PPP eliminada completamente");
      loadTrackingDb();
    } catch (err) {
      toast("Error: " + err.message, "error");
    } finally {
      this.disabled = false;
    }
  });

// =====================================================
// ---- CRUCE PPP <-> PEDIDOS WEB ----------------------
// =====================================================
var cruceFilterCurrent = "mismatch_m3";

function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtM3(n) {
  if (n == null) return "-";
  var x = Number(n);
  if (isNaN(x)) return "-";
  return x.toFixed(3);
}

async function loadCrucePPP() {
  // 1) Stats por status
  var statR = await sb.from("ppp_match").select("status", { count: "exact" });
  if (statR.error) {
    toast("Error cargando cruce: " + statR.error.message, "error");
    return;
  }
  var rows = statR.data || [];
  var matched = 0,
    mismatch = 0,
    missing = 0;
  rows.forEach(function (r) {
    if (r.status === "matched") matched++;
    else if (r.status === "mismatch_m3") mismatch++;
    else if (r.status === "missing_codes") missing++;
  });
  document.getElementById("cruceMatched").textContent = matched;
  document.getElementById("cruceMismatch").textContent = mismatch;
  document.getElementById("cruceMissing").textContent = missing;
  document.getElementById("cruceTotal").textContent = rows.length;

  // 2) Codigos faltantes — top 30
  var missR = await sb
    .from("ppp_match")
    .select("codigos_faltantes")
    .eq("status", "missing_codes");
  var counts = {};
  (missR.data || []).forEach(function (r) {
    (r.codigos_faltantes || []).forEach(function (cod) {
      counts[cod] = (counts[cod] || 0) + 1;
    });
  });
  var top = Object.keys(counts)
    .map(function (k) {
      return { cod: k, n: counts[k] };
    })
    .sort(function (a, b) {
      return b.n - a.n;
    })
    .slice(0, 30);
  var mb = document.getElementById("cruceMissingBody");
  if (!top.length) {
    mb.innerHTML =
      '<tr><td colspan="2" style="text-align:center;color:var(--text3);padding:18px">Ningun codigo faltante.</td></tr>';
  } else {
    mb.innerHTML = top
      .map(function (x) {
        return (
          "<tr><td><strong>" +
          escapeHTML(x.cod) +
          "</strong></td><td>" +
          x.n +
          "</td></tr>"
        );
      })
      .join("");
  }

  // 3) Lista de cruces (filtrada)
  await renderCruceList();
}

async function renderCruceList() {
  var status = cruceFilterCurrent;
  var q = sb
    .from("ppp_match")
    .select(
      "web_order_id, isis_np, m3_web, m3_isis, dif_m3, status, codigos_faltantes, notified_at, resolved_at, orders!inner(id, created_at, customer_id, customers!inner(cod_cliente, business_name))",
    )
    .order("status", { ascending: false })
    .order("dif_m3", { ascending: false, nullsFirst: false })
    .limit(500);
  if (status && status !== "all") q = q.eq("status", status);
  var r = await q;
  if (r.error) {
    toast("Error: " + r.error.message, "error");
    return;
  }
  var data = r.data || [];
  document.getElementById("cruceListSub").textContent =
    data.length + " registros";
  var body = document.getElementById("cruceListBody");
  if (!data.length) {
    body.innerHTML =
      '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:20px">Sin registros.</td></tr>';
    return;
  }
  body.innerHTML = data
    .map(function (r) {
      var cust = (r.orders && r.orders.customers) || {};
      var fechaWeb = r.orders
        ? new Date(r.orders.created_at).toLocaleDateString("es-AR")
        : "";
      var npList = (r.isis_np || []).join(", ") || "-";
      var faltStr = (r.codigos_faltantes || []).slice(0, 4).join(", ");
      if ((r.codigos_faltantes || []).length > 4)
        faltStr +=
          " (+" + ((r.codigos_faltantes || []).length - 4) + " mas)";
      var notifPill = r.notified_at
        ? '<span title="' +
          escapeHTML(r.notified_at) +
          '">&#10003;</span>'
        : "";
      return (
        "<tr>" +
        "<td><strong>#" +
        r.web_order_id +
        "</strong></td>" +
        "<td>" +
        escapeHTML(cust.cod_cliente || "") +
        " &mdash; " +
        escapeHTML(cust.business_name || "") +
        "</td>" +
        "<td>" +
        fechaWeb +
        "</td>" +
        "<td>" +
        fmtM3(r.m3_web) +
        "</td>" +
        "<td>" +
        escapeHTML(npList) +
        "</td>" +
        "<td>" +
        fmtM3(r.m3_isis) +
        "</td>" +
        "<td>" +
        fmtM3(r.dif_m3) +
        "</td>" +
        "<td>" +
        escapeHTML(faltStr) +
        "</td>" +
        '<td><span class="cruce-pill ' +
        r.status +
        '">' +
        r.status.replace("_", " ") +
        "</span></td>" +
        "<td>" +
        notifPill +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
}

(function () {
  var btn = document.getElementById("cruceRunBtn");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    showLoader("Ejecutando cruce...");
    try {
      await runPPPCrossReference();
      await loadCrucePPP();
      document.getElementById("cruceLastRun").textContent =
        "Ultimo cruce: " + new Date().toLocaleString("es-AR");
    } catch (e) {
      toast("Cruce fallo: " + e.message, "error");
    } finally {
      btn.disabled = false;
      hideLoader();
    }
  });
  document
    .getElementById("cruceRefreshBtn")
    .addEventListener("click", loadCrucePPP);
  document
    .getElementById("cruceFilterStatus")
    .addEventListener("change", function (e) {
      cruceFilterCurrent = e.target.value;
      renderCruceList();
    });
})();

// =====================================================
// ---- CARGA / PROMO PEDIDOS — MULTI-CARD (3 cards) ----
// =====================================================
var cpAllProducts = [];
var cpItemGroups = {};

var UPSELL_CODES = [
  "598E",
  "589E",
  "566E",
  "522E",
  "539E",
  "583E",
  "536E",
  "538E",
  "540E",
  "584E",
];
var BASE_IMG = SUPABASE_URL + "/storage/v1/object/public/products-images/";
var BASE_FLYER = SUPABASE_URL + "/storage/v1/object/public/flyers/";

var CP_SHEETS_PROXY_URL =
  "https://kwkclwhmoygunqmlegrg.functions.supabase.co/sheets-proxy";
var CP_SHEETS_ENTREGAS_PROXY_URL =
  "https://kwkclwhmoygunqmlegrg.functions.supabase.co/sheets-entregas-proxy";
var CP_WEB_DISCOUNT = 0.02;
// Cliente especial con lista propia (Lista 30 - Lista GM). Sin descuentos.
var CP_GM_COD_CLIENTE = "4080";

// Mapeo columna 0-indexed (E=4 ... J=9) → discount + code + texto del metodo de pago
var CP_PAYMENT_MAP = {
  4: { discount: 0.25, code: 8, text: "Contado" },
  5: { discount: 0.2, code: 9, text: "Transferencia 15-30 dias" },
  6: { discount: 0.15, code: 10, text: "Transferencia 31-45 dias" },
  7: { discount: 0.1, code: 11, text: "Transferencia 46-60 dias" },
  8: { discount: 0.05, code: 12, text: "Echeq 90 dias" },
  9: { discount: 0.0, code: 13, text: "Echeq 120 dias" },
};

// Estado por card (3 slots)
var cpCards = [];

function formatMoney(n) {
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

async function cpLoadProducts() {
  var PAGE = 1000,
    all = [],
    offset = 0;
  do {
    var r = await sb
      .from("products")
      .select("id,cod,description,category,list_price,uxb,active,ranking")
      .eq("active", true)
      .range(offset, offset + PAGE - 1);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    all = all.concat(batch);
    offset += PAGE;
  } while (batch.length === PAGE);
  cpAllProducts = all;
}

async function cpLoadItemGroups() {
  var r = await sb.from("item_groups").select("item_code,group_id");
  if (r.error) {
    console.error("item_groups error", r.error);
    return;
  }
  cpItemGroups = {};
  (r.data || []).forEach(function (row) {
    cpItemGroups[String(row.item_code).trim().toUpperCase()] = row.group_id;
  });
}

function cpFindProduct(cod) {
  var c = String(cod || "")
    .trim()
    .toUpperCase();
  return cpAllProducts.find(function (p) {
    return (
      String(p.cod || "")
        .trim()
        .toUpperCase() === c
    );
  });
}

// ---- DOWNLOAD HELPERS (compartidos entre cards) ----
function cpDownloadBlob(url, filename) {
  fetch(url)
    .then(function (r) {
      return r.blob();
    })
    .then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(function () {
      toast("Error descargando " + filename, "error");
    });
}

function cpDownloadFlyerProducts(products) {
  products.forEach(function (p) {
    var codSafe = String(p.cod || "").trim();
    var flyerSrc = BASE_FLYER + "flyer_" + encodeURIComponent(codSafe) + ".webp";
    cpDownloadBlob(flyerSrc, "flyer_" + codSafe + ".webp");
  });
  toast("Descargando " + products.length + " flyers");
}

// ---- UPSELL LOGIC (por-card: recibe parsed + history) ----
var CP_UPSELL_ENABLED = true; // Cambiar a true para reactivar la generación de mensaje y flyers de la oferta 10%.
function cpGetUpsellProducts(parsed, history) {
  if (!CP_UPSELL_ENABLED) return [];
  var orderCods = new Set(
    parsed.map(function (r) {
      return String(r.cod || "")
        .trim()
        .toUpperCase();
    }),
  );

  var historyCods = new Set();
  var historyGroups = new Set();
  (history.web || []).forEach(function (wi) {
    var p = cpAllProducts.find(function (x) {
      return x.id === wi.product_id;
    });
    if (p) {
      var cod = String(p.cod || "")
        .trim()
        .toUpperCase();
      historyCods.add(cod);
      var g = cpItemGroups[cod];
      if (g) historyGroups.add(g);
    }
  });
  (history.sales || []).forEach(function (sl) {
    var cod = String(sl.item_code || "")
      .trim()
      .toUpperCase();
    historyCods.add(cod);
    var g = cpItemGroups[cod];
    if (g) historyGroups.add(g);
  });

  var orderGroups = new Set();
  orderCods.forEach(function (cod) {
    var g = cpItemGroups[cod];
    if (g) orderGroups.add(g);
  });

  var eligible = UPSELL_CODES.map(function (cod) {
    var codUp = cod.toUpperCase();
    if (orderCods.has(codUp)) return null;
    var g = cpItemGroups[codUp];
    if (g && orderGroups.has(g)) return null;
    if (historyCods.has(codUp)) return null;
    if (g && historyGroups.has(g)) return null;
    var p = cpAllProducts.find(function (x) {
      return (
        String(x.cod || "")
          .trim()
          .toUpperCase() === codUp
      );
    });
    if (!p) return null;
    return p;
  }).filter(Boolean);

  eligible.sort(function (a, b) {
    var ra = a.ranking != null ? Number(a.ranking) : Infinity;
    var rb = b.ranking != null ? Number(b.ranking) : Infinity;
    return ra - rb;
  });

  var usedGroups = new Set();
  var unique = [];
  for (var i = 0; i < eligible.length && unique.length < 3; i++) {
    var gId =
      cpItemGroups[
        String(eligible[i].cod || "")
          .trim()
          .toUpperCase()
      ];
    if (gId && usedGroups.has(gId)) continue;
    if (gId) usedGroups.add(gId);
    unique.push(eligible[i]);
  }
  return unique;
}

// ---- SHEETS SENDERS (version admin, usa sesion activa del admin) ----
function cpWithTimeout(promise, ms, label) {
  var t;
  var timeout = new Promise(function (_, reject) {
    t = setTimeout(function () {
      reject(new Error("Timeout (" + ms + "ms) en " + label));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () {
    clearTimeout(t);
  });
}

async function cpSendToSheets(payload, token) {
  var resp = await fetch(CP_SHEETS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  var data = await resp.json().catch(function () {
    return {};
  });
  if (!resp.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || "Proxy error " + resp.status);
  }
  return { ok: true };
}

async function cpSendToSheetsWithRetry(payload, token, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  var lastError = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await cpWithTimeout(
        cpSendToSheets(payload, token),
        25000,
        "sheets-proxy intento " + attempt,
      );
    } catch (e) {
      lastError = e;
      console.warn("cp sheets intento " + attempt + " fallo:", e);
      if (attempt < maxAttempts)
        await new Promise(function (r) {
          setTimeout(r, 1200);
        });
    }
  }
  throw lastError || new Error("Fallo envio a Sheets");
}

async function cpSendToEntregas(payload, token) {
  try {
    var resp = await fetch(CP_SHEETS_ENTREGAS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    var data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok || (data && data.ok === false)) {
      console.warn(
        "cp entregas sheet error:",
        (data && data.error) || resp.status,
      );
    }
  } catch (e) {
    console.warn("cp entregas sheet error:", e);
  }
}

// ---- EXCEL PARSING (items + payment + delivery) ----
function cpParsePaymentFromRaw(raw) {
  // Fila 6 (index 5) columnas E-J (index 4-9): buscar la unica celda con "X"
  var row6 = raw[5] || [];
  var marked = [];
  for (var col = 4; col <= 9; col++) {
    var cell = String(row6[col] || "")
      .trim()
      .toUpperCase();
    if (cell === "X") marked.push(col);
  }
  if (marked.length !== 1) return null;
  return Object.assign({ col: marked[0] }, CP_PAYMENT_MAP[marked[0]]);
}

function cpParseDeliveryFromRaw(raw) {
  // Celda D9 = raw[8][3]
  var row9 = raw[8] || [];
  return String(row9[3] || "").trim();
}

// Lee el "Total a Abonar" del Excel desde la celda H9 = raw[8][7].
// Incluye Dto x Pago + 2% Cot, SIN Dto x Volumen ni IVA.
function cpParseExcelTotal(raw) {
  if (!raw || !raw.length) return null;
  var row9 = raw[8];
  if (!row9) return null;
  var v = row9[7];
  if (v === "" || v == null) return null;
  var n;
  if (typeof v === "number") {
    n = v;
  } else {
    var s = String(v).replace(/[^0-9.,\-]/g, "");
    // Argentina: punto = miles, coma = decimal
    if (/,\d{1,2}$/.test(s)) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/\./g, "");
    }
    n = parseFloat(s);
  }
  return !isNaN(n) && n > 0 ? n : null;
}

// === Sustitución de códigos discontinuados (cotizador de clientes) ===
// El cliente puede pedir el código viejo; el pedido se carga con el nuevo.
// factor = cajas_nuevas / cajas_viejas → preserva las UNIDADES pedidas.
// Se sustituye el string ANTES de cpFindProduct, así 029/030 (hoy inactivos /
// "NO ENCONTRADO") resuelven a 437E/438E activos.
var CP_CODE_SUBSTITUTIONS = {
  // "565": { cod: "607E", factor: 1 }, // DESACTIVADO 2026-07-02: hay stock de 565, se carga 565. Reactivar cuando no haya stock.
  "323": { cod: "323E", factor: 1 },
  "548": { cod: "590E", factor: 2 },
  "029": { cod: "437E", factor: 1 },
  "030": { cod: "438E", factor: 1 },
};
function cpSubstituteCod(codRaw) {
  var c = String(codRaw || "").trim().toUpperCase();
  var sub = CP_CODE_SUBSTITUTIONS[c];
  if (!sub && /^[0-9]+$/.test(c)) {
    // tolerar ceros a la izquierda: "29" ↔ "029"
    var n = c.replace(/^0+/, "");
    sub =
      CP_CODE_SUBSTITUTIONS[n] ||
      CP_CODE_SUBSTITUTIONS["0" + n] ||
      CP_CODE_SUBSTITUTIONS["00" + n];
  }
  return sub || null;
}

function cpParseItems(raw) {
  var headerIdx = -1,
    codCol = -1,
    cajasCol = -1;
  for (var i = 0; i < Math.min(raw.length, 50); i++) {
    var row = raw[i];
    if (!row) continue;
    for (var j = 0; j < row.length; j++) {
      var cell = String(row[j] || "")
        .trim()
        .toLowerCase();
      if (cell === "cod" || cell === "codigo" || cell === "código") codCol = j;
      if (/pedido/i.test(cell) || /^caja/i.test(cell) || cell === "cajas")
        cajasCol = j;
    }
    if (codCol >= 0 && cajasCol >= 0) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    codCol = 3;
    cajasCol = 4;
    headerIdx = 0;
  }

  var items = [];
  for (var ri = headerIdx + 1; ri < raw.length; ri++) {
    var r = raw[ri];
    if (!r) continue;
    var cod = String(r[codCol] || "").trim();
    var cajas = parseInt(r[cajasCol]) || 0;
    if (!cod || cajas <= 0) continue;
    if (!/^[0-9]/.test(cod)) continue;

    // Sustitución de códigos discontinuados (preserva unidades vía factor).
    var codOriginal = null;
    var sub = cpSubstituteCod(cod);
    if (sub) {
      codOriginal = cod;
      cod = sub.cod;
      cajas = cajas * (sub.factor || 1);
    }

    var product = cpFindProduct(cod);
    items.push({
      cod: cod,
      cod_original: codOriginal,
      cajas: cajas,
      product: product,
      found: !!product,
      description: product ? product.description : "NO ENCONTRADO",
      uxb: product ? Number(product.uxb || 0) : 0,
      listPrice: product ? Number(product.list_price || 0) : 0,
    });
  }
  return items;
}

// Detecta si el Excel es el formato de Lista GM (tiene columna de precio $ x Uni)
function cpDetectGMFormat(raw) {
  // El encabezado está en fila 5 (índice 4); columna G (índice 6) = "$ x Uni"
  var headerRow = raw[4] || [];
  var colG = String(headerRow[6] || "").trim().toLowerCase();
  return colG.indexOf("x uni") !== -1 || colG.indexOf("$ x u") !== -1;
}

// Parser específico para cotizador Lista GM (cliente 4080 - Distribuidora GM)
// Toma el precio directamente del Excel (col G), sin aplicar ningún descuento.
function cpParseItemsGM(raw) {
  var items = [];
  // Datos desde fila 6 (índice 5) en adelante
  for (var i = 5; i < raw.length; i++) {
    var row = raw[i];
    if (!row) continue;
    var cod = String(row[3] || "").trim();
    var cajasRaw = row[4];
    var uxbRaw = Number(row[5]) || 0;
    var pricePerUnit = Number(row[6]) || 0;
    var desc = String(row[1] || "").trim();

    // Requiere código, cajas > 0 y precio > 0
    if (!cod || !cajasRaw || Number(cajasRaw) <= 0) continue;
    if (pricePerUnit <= 0) continue;
    var cajas = Number(cajasRaw);

    // Aplicar sustituciones de códigos (igual que parser normal)
    var codOriginal = null;
    var sub = cpSubstituteCod(cod);
    if (sub) {
      codOriginal = cod;
      cod = sub.cod;
      cajas = cajas * (sub.factor || 1);
    }

    var product = cpFindProduct(cod);
    var uxb = uxbRaw > 0 ? uxbRaw : (product ? Number(product.uxb || 1) : 1);

    items.push({
      cod: cod,
      cod_original: codOriginal,
      cajas: cajas,
      uxb: uxb,
      pricePerUnit: pricePerUnit,
      product: product,
      found: !!product,
      description: product ? product.description : (desc || "NO ENCONTRADO"),
      listPrice: pricePerUnit, // Para render genérico: el precio GM ES el precio de lista
      isGMItem: true,
    });
  }
  return items;
}

// =====================================================
// ---- PDF DE ORDEN DE COMPRA (Cargar Cotizadores) ----
// =====================================================
// Cliente elegido manualmente (buscador). El PDF (formato "PEDIDO DE
// COTIZACION" / Planexware, ej MESSINA) trae por item: codigo proveedor (= cod
// LK), codigo de barra (EAN 13), y cantidad EN UNIDADES. cajas = unidades / uxb.
// El metodo de pago NO viene en el PDF: se setea con un dropdown en la card
// (default Echeq 120 = 0% dto). El resto del flujo (precio lista - dtos, submit)
// es identico al del Excel.

// El proveedor puede mandar el codigo con o sin "E" final (ej "960" vs "960E").
// Devuelve variantes a probar: exacta primero, la otra como fallback.
function cpEVariants(cod) {
  var c = String(cod || "").trim().toUpperCase();
  if (!c) return [];
  if (/E$/.test(c)) return [c, c.slice(0, -1)];
  return [c, c + "E"];
}

// Condicion de pago declarada en el PDF ("Cond.Compra : 22 CUENTA CORRIENTE.
// 15 DIAS FF"). Devuelve { raw, days } o null. days = 0 si dice "contado".
function cpParsePdfPayment(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/Cond\.?\s*Compra\s*:?\s*(.+)/i);
    if (m && m[1].trim()) {
      var raw = m[1].trim();
      return { raw: raw, days: cpDaysFromText(raw) };
    }
  }
  return null;
}
function cpDaysFromText(t) {
  if (!t) return null;
  if (/contado/i.test(t)) return 0;
  var m = String(t).match(/(\d+)\s*d[ií]as/i);
  return m ? parseInt(m[1], 10) : null;
}
// Mapea dias de plazo al metodo de pago (columna de CP_PAYMENT_MAP) mas cercano.
// Sin dato => Echeq 120 (col 9, 0% dto).
function cpPayColFromDays(days) {
  if (days == null) return 9;
  if (days <= 0) return 4; // Contado
  if (days <= 30) return 5; // Transferencia 15-30 dias
  if (days <= 45) return 6; // Transferencia 31-45 dias
  if (days <= 60) return 7; // Transferencia 46-60 dias
  if (days <= 90) return 8; // Echeq 90 dias
  return 9; // Echeq 120 dias
}

// Parse numerico tolerante AR/US para los numeros del PDF.
function cpPdfNum(s) {
  if (s == null) return 0;
  var t = String(s).trim().replace(/[^0-9.,\-]/g, "");
  if (!t) return 0;
  var hasDot = t.indexOf(".") !== -1;
  var hasComma = t.indexOf(",") !== -1;
  var n;
  if (hasDot && hasComma) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      n = parseFloat(t.replace(/\./g, "").replace(",", "."));
    } else {
      n = parseFloat(t.replace(/,/g, ""));
    }
  } else if (hasComma) {
    n = parseFloat(t.replace(/\./g, "").replace(",", "."));
  } else {
    n = parseFloat(t);
  }
  return isNaN(n) ? 0 : n;
}

// Extrae texto del PDF con pdf.js, agrupando por coordenada Y (una fila visual =
// una linea). Mismo enfoque que admin-supercot.js.
async function cpExtractPdfText(data) {
  var pdf = await window.pdfjsLib.getDocument({ data: data }).promise;
  var allLines = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var page = await pdf.getPage(p);
    var content = await page.getTextContent();
    var rows = {};
    content.items.forEach(function (it) {
      var y = Math.round(it.transform[5]);
      var key = null;
      Object.keys(rows).forEach(function (k) {
        if (key == null && Math.abs(Number(k) - y) <= 1) key = k;
      });
      if (key == null) {
        rows[y] = [];
        key = y;
      }
      rows[key].push({ x: it.transform[4], str: it.str });
    });
    var keys = Object.keys(rows)
      .map(Number)
      .sort(function (a, b) {
        return b - a;
      });
    keys.forEach(function (k) {
      var row = rows[k].sort(function (a, b) {
        return a.x - b.x;
      });
      var line = row
        .map(function (r) {
          return r.str;
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) allLines.push(line);
    });
  }
  return allLines.join("\n");
}

// Sucursal / deposito de entrega declarado en el PDF (solo informativo; el admin
// elige la sucursal real al confirmar).
function cpParsePdfDelivery(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/Dep[oó]sito\s*Entrega:?\s*(.*)/i);
    if (!m) continue;
    var same = (m[1] || "").trim();
    if (same) return same;
    for (var j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      var v = (lines[j] || "").trim();
      if (v) return v;
    }
  }
  return "";
}

// Subtotal declarado en el PDF (informativo).
function cpParsePdfSubtotal(lines) {
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/Subtotal\s*:?\s*\$?\s*([\d.,]+)/i);
    if (m) {
      var v = cpPdfNum(m[1]);
      if (v > 0) return v;
    }
  }
  return null;
}

// Parsea items del PDF. Para cada linea con EAN de 13 digitos:
//  - cod proveedor = token inmediatamente antes del EAN (fallback EAN[9..12])
//  - uxb = "Caja x N" de la linea (fallback product.uxb)
//  - cantidad EN UNIDADES = primer numero despues del EAN
//  - cajas = cantidad / uxb (debe ser entero: descarta lineas sin pedido, donde
//    el primer numero es en realidad el precio unitario)
function cpParsePdfItems(text) {
  var lines = String(text || "")
    .split(/\n/)
    .map(function (l) {
      return l.trim();
    })
    .filter(Boolean);
  var items = [];
  var seen = {};
  var EAN_RE = /\b(\d{13})\b/;

  lines.forEach(function (line) {
    var m = line.match(EAN_RE);
    if (!m) return;
    var ean = m[1];
    var eanIdx = line.indexOf(ean);
    var before = line.substring(0, eanIdx).trim();
    var after = line.substring(eanIdx + ean.length).trim();

    var beforeTokens = before ? before.split(/\s+/) : [];
    var codToken = beforeTokens.length
      ? beforeTokens[beforeTokens.length - 1]
      : "";
    var uxbM = before.match(/Caja\s*x\s*(\d+)/i);
    var uxbPdf = uxbM ? parseInt(uxbM[1], 10) : 0;

    var afterNums = after.match(/[\d.,]+/g) || [];
    if (!afterNums.length) return;
    var cantidad = cpPdfNum(afterNums[0]);
    if (!(cantidad > 0) || cantidad % 1 !== 0) return; // no entero => linea sin pedido

    // Resolver producto: cod proveedor (con/sin "E"), luego EAN[9..12] (con/sin "E")
    var bases = [];
    if (codToken && /[0-9]/.test(codToken)) bases.push(codToken);
    bases.push(ean.substring(9, 12));
    var candidates = [];
    bases.forEach(function (b) {
      cpEVariants(b).forEach(function (v) {
        if (candidates.indexOf(v) < 0) candidates.push(v);
      });
    });
    var product = null;
    var cod = candidates[0];
    for (var i = 0; i < candidates.length; i++) {
      var pr = cpFindProduct(candidates[i]);
      if (pr) {
        product = pr;
        cod = candidates[i];
        break;
      }
    }

    var uxb = product ? Number(product.uxb || 0) : 0;
    if (!uxb) uxb = uxbPdf;
    if (!uxb) uxb = 1;
    if (cantidad % uxb !== 0) return; // no multiplo de la caja => descartar
    var cajas = Math.round(cantidad / uxb);
    if (cajas <= 0) return;

    // Sustitucion de codigos discontinuados (preserva unidades via factor)
    var codOriginal = null;
    var sub = cpSubstituteCod(cod);
    if (sub) {
      codOriginal = cod;
      cod = sub.cod;
      cajas = cajas * (sub.factor || 1);
      product = cpFindProduct(cod) || product;
    }

    var key = cod + "|" + ean;
    if (seen[key]) {
      seen[key].cajas += cajas; // mismo item repetido en el PDF: acumular
      return;
    }
    var item = {
      cod: cod,
      cod_original: codOriginal,
      cajas: cajas,
      product: product,
      found: !!product,
      description: product ? product.description : "NO ENCONTRADO",
      uxb: product ? Number(product.uxb || 0) : uxb,
      listPrice: product ? Number(product.list_price || 0) : 0,
    };
    seen[key] = item;
    items.push(item);
  });

  return {
    items: items,
    delivery: cpParsePdfDelivery(lines),
    subtotal: cpParsePdfSubtotal(lines),
    payment: cpParsePdfPayment(lines),
  };
}

function cpCardProcessPdfData(card, buf) {
  if (!window.pdfjsLib) {
    cpCardSetStatus(card, "pdf.js no disponible. Recargá la página.", "err");
    return;
  }
  try {
    if (
      window.pdfjsLib.GlobalWorkerOptions &&
      !window.pdfjsLib.GlobalWorkerOptions.workerSrc
    ) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
  } catch (e) {}

  cpCardSetStatus(card, "Leyendo PDF...");
  // Clonar el buffer: pdf.js puede detach el ArrayBuffer y romper un reintento.
  var data = buf.slice ? buf.slice(0) : buf;

  cpExtractPdfText(data)
    .then(function (text) {
      var res = cpParsePdfItems(text);
      if (!res.items.length) {
        cpCardSetStatus(
          card,
          "No se detectaron items en el PDF (código proveedor + cantidad).",
          "err",
        );
        toast("PDF sin items (Cotizador " + (card.idx + 1) + ")", "warning");
        return;
      }
      card.isGM = false;
      card.isPdf = true;
      card.parsed = res.items.filter(function (it) {
        return it.found;
      });
      card.invalid = res.items.filter(function (it) {
        return !it.found;
      });
      // Metodo de pago: preseleccionado segun la condicion del PDF (dias de
      // plazo). Si el PDF no la trae, Echeq 120 (0% dto). Editable en la card.
      var payCol = res.payment ? cpPayColFromDays(res.payment.days) : 9;
      card.payment = Object.assign({ col: payCol }, CP_PAYMENT_MAP[payCol]);
      card.pdfPaymentRaw = res.payment ? res.payment.raw : "";
      card.delivery = res.delivery || "";
      card.excelTotal = null;
      card.pdfSubtotal = res.subtotal || null;
      card.historyMode = false;
      card.selectedDeliveryIdx = null;

      cpCardBuildFlyers(card);
      cpCardRenderSummary(card);
      cpCardRenderActions(card);
      cpCardRenderBottomButtons(card);
      cpCardSetStatus(card, "");
      card.dropZone.classList.add("cp-drop-success-on");
      card.fileInput.value = "";
    })
    .catch(function (e) {
      console.error("cp pdf error:", e);
      cpCardSetStatus(
        card,
        "Error procesando el PDF: " + (e.message || e),
        "err",
      );
    });
}

// =====================================================
// ---- CARDS UI ----
// =====================================================

function cpBuildCardHTML(idx) {
  var num = idx + 1;
  return (
    "" +
    '<div class="cp-card-head">' +
    '<div class="cp-card-title">Cotizador ' +
    num +
    "</div>" +
    '<button type="button" class="cp-card-reset" title="Limpiar esta card">Limpiar</button>' +
    "</div>" +
    '<div class="cp-card-section cp-step-customer">' +
    '<div class="cp-card-search-row" style="position:relative">' +
    '<input class="field-input cp-search-cod" type="text" autocomplete="off" placeholder="Cod cliente o razón social"/>' +
    '<button type="button" class="btn-primary cp-search-btn">Buscar</button>' +
    '<div class="cp-suggest" style="display:none"></div>' +
    "</div>" +
    '<div class="cp-card-customer-wrap" style="display:none"></div>' +
    "</div>" +
    '<div class="cp-card-section">' +
    '<div class="upload-zone cp-dropzone">' +
    '<div class="cp-drop-idle">' +
    '<div class="upload-icon">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
    "</div>" +
    '<p class="upload-title">Arrastrá el cotizador (Excel o PDF) o</p>' +
    '<label class="btn-primary cp-file-label" for="cpFileInput-' +
    idx +
    '">Seleccionar</label>' +
    "</div>" +
    '<div class="cp-drop-success">' +
    '<div class="cp-drop-check" aria-hidden="true">&#10003;</div>' +
    '<p class="cp-drop-success-title">Cotizador cargado</p>' +
    '<button type="button" class="btn-ghost cp-drop-replace">Subir otro</button>' +
    "</div>" +
    '<input type="file" class="cp-file-input" id="cpFileInput-' +
    idx +
    '" accept=".xlsx,.xls,.csv,.pdf" hidden/>' +
    "</div>" +
    '<div class="cp-card-status"></div>' +
    "</div>" +
    '<div class="cp-card-summary-wrap" style="display:none"></div>' +
    '<div class="cp-card-flyers-wrap" style="display:none"></div>' +
    '<div class="cp-card-actions-wrap" style="display:none"></div>' +
    '<div class="cp-card-msg-wrap" style="display:none"></div>'
  );
}

function cpInitCards() {
  var grid = document.getElementById("cpCardsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  cpCards = [];
  for (var i = 0; i < 3; i++) {
    var root = document.createElement("div");
    root.className = "cp-card";
    root.dataset.idx = i;
    root.innerHTML = cpBuildCardHTML(i);
    grid.appendChild(root);

    var card = {
      idx: i,
      root: root,
      customer: null,
      history: { web: [], sales: [] },
      pendingFileData: null, // se guarda el ArrayBuffer si se subió archivo antes del cliente
      parsed: [],
      invalid: [],
      payment: null,
      delivery: "",
      flyers: [],
      upsellMsg: "",
      submitted: false,
      orderId: null,
      historyLoading: false,
      historyMode: false, // true si está generando flyers sólo por historial (sin cotizador)
      deliveryAddresses: [],
      deliveryLoading: false,
      selectedDeliveryIdx: null, // idx en deliveryAddresses elegido por el usuario (pendiente de confirmar)
      finalDelivery: "", // label exacto de la DB elegido al confirmar
      // Refs
      searchCod: root.querySelector(".cp-search-cod"),
      searchBtn: root.querySelector(".cp-search-btn"),
      suggestEl: root.querySelector(".cp-suggest"),
      suggestTimer: null,
      customerWrap: root.querySelector(".cp-card-customer-wrap"),
      dropZone: root.querySelector(".cp-dropzone"),
      fileInput: root.querySelector(".cp-file-input"),
      resetBtn: root.querySelector(".cp-card-reset"),
      status: root.querySelector(".cp-card-status"),
      summaryWrap: root.querySelector(".cp-card-summary-wrap"),
      msgWrap: root.querySelector(".cp-card-msg-wrap"),
      flyersWrap: root.querySelector(".cp-card-flyers-wrap"),
      actionsWrap: root.querySelector(".cp-card-actions-wrap"),
    };
    cpWireCard(card);
    cpCards.push(card);
  }

  // Modal handlers (solo wireamos cerrar; el onOk se setea en cpShowConfirm)
  document
    .getElementById("cpConfirmClose")
    .addEventListener("click", cpHideConfirm);
  document
    .getElementById("cpConfirmCancel")
    .addEventListener("click", cpHideConfirm);
}

function cpWireCard(card) {
  card.searchBtn.addEventListener("click", function () {
    cpCardSearchCustomer(card);
  });
  card.searchCod.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      cpHideSuggest(card);
      cpCardSearchCustomer(card);
    } else if (e.key === "Escape") {
      cpHideSuggest(card);
    }
  });
  card.searchCod.addEventListener("input", function () {
    if (card.suggestTimer) clearTimeout(card.suggestTimer);
    var q = card.searchCod.value;
    card.suggestTimer = setTimeout(function () {
      cpCardSuggestCustomers(card, q);
    }, 220);
  });
  card.searchCod.addEventListener("blur", function () {
    setTimeout(function () {
      cpHideSuggest(card);
    }, 180);
  });
  card.resetBtn.addEventListener("click", function () {
    cpCardReset(card);
  });

  card.dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    card.dropZone.classList.add("drag-over");
  });
  card.dropZone.addEventListener("dragleave", function () {
    card.dropZone.classList.remove("drag-over");
  });
  card.dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    card.dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length)
      cpCardHandleFile(card, e.dataTransfer.files[0]);
  });
  // Click en cualquier parte de la dropzone abre el file picker (estado idle).
  // Se ignoran clicks en label/botones que ya manejan el input por su cuenta.
  card.dropZone.addEventListener("click", function (e) {
    if (card.dropZone.classList.contains("cp-drop-success-on")) return;
    if (
      e.target.closest(".cp-file-label") ||
      e.target.closest(".cp-drop-replace")
    )
      return;
    card.fileInput.click();
  });
  card.fileInput.addEventListener("change", function () {
    if (card.fileInput.files.length)
      cpCardHandleFile(card, card.fileInput.files[0]);
  });
  var replaceBtn = card.dropZone.querySelector(".cp-drop-replace");
  if (replaceBtn)
    replaceBtn.addEventListener("click", function () {
      card.fileInput.click();
    });
}

function cpCardSetStatus(card, msg, kind) {
  if (kind === "ok" && msg) {
    card.status.innerHTML =
      '<span class="cp-status-check" aria-hidden="true">&#10003;</span> ' +
      String(msg).replace(/[&<>]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
      });
  } else {
    card.status.textContent = msg || "";
  }
  card.status.className = "cp-card-status" + (kind ? " " + kind : "");
}

function cpCardReset(card) {
  card.customer = null;
  card.history = { web: [], sales: [] };
  card.pendingFileData = null;
  card.pendingFileIsPdf = false;
  card.parsed = [];
  card.invalid = [];
  card.payment = null;
  card.delivery = "";
  card.excelTotal = null;
  card.isPdf = false;
  card.pdfSubtotal = null;
  card.pdfPaymentRaw = "";
  card.flyers = [];
  card.upsellMsg = "";
  card.submitted = false;
  card.orderId = null;
  card.historyMode = false;
  card.deliveryAddresses = [];
  card.deliveryLoading = false;
  card.selectedDeliveryIdx = null;
  card.finalDelivery = "";
  card.root.classList.remove("submitted");
  card.searchCod.value = "";
  card.fileInput.value = "";
  if (card.dropZone) card.dropZone.classList.remove("cp-drop-success-on");
  if (card.suggestEl) cpHideSuggest(card);
  card.customerWrap.style.display = "none";
  card.customerWrap.innerHTML = "";
  card.summaryWrap.style.display = "none";
  card.summaryWrap.innerHTML = "";
  card.msgWrap.style.display = "none";
  card.msgWrap.innerHTML = "";
  card.flyersWrap.style.display = "none";
  card.flyersWrap.innerHTML = "";
  card.actionsWrap.style.display = "none";
  card.actionsWrap.innerHTML = "";
  cpCardSetStatus(card, "");
}

function cpHideSuggest(card) {
  if (card.suggestEl) {
    card.suggestEl.style.display = "none";
    card.suggestEl.innerHTML = "";
  }
}

async function cpCardSuggestCustomers(card, q) {
  q = String(q || "").trim();
  if (q.length < 2) {
    cpHideSuggest(card);
    return;
  }
  var isNum = /^\d+$/.test(q);
  try {
    var promises = [
      sb
        .from("customers")
        .select("id,cod_cliente,business_name,dto_vol,vend,debt,payment_term,credit_limit")
        .ilike("business_name", "%" + q + "%")
        .order("business_name", { ascending: true })
        .limit(8),
    ];
    if (isNum) {
      promises.push(
        sb
          .from("customers")
          .select("id,cod_cliente,business_name,dto_vol,vend,debt,payment_term,credit_limit")
          .eq("cod_cliente", q)
          .limit(3),
      );
    }
    var results = await Promise.all(promises);
    var seen = {};
    var merged = [];
    results.forEach(function (r) {
      if (r.error || !r.data) return;
      r.data.forEach(function (c) {
        if (seen[c.id]) return;
        seen[c.id] = true;
        merged.push(c);
      });
    });
    // Si la query es numérica, priorizar cod exacto arriba
    if (isNum) {
      merged.sort(function (a, b) {
        var aMatch = String(a.cod_cliente) === q ? 0 : 1;
        var bMatch = String(b.cod_cliente) === q ? 0 : 1;
        return aMatch - bMatch;
      });
    }
    if (!merged.length) {
      card.suggestEl.innerHTML =
        '<div class="cp-suggest-empty">Sin resultados</div>';
      card.suggestEl.style.display = "block";
      return;
    }
    var html = merged
      .slice(0, 10)
      .map(function (c) {
        return (
          '<div class="cp-suggest-row" data-id="' +
          c.id +
          '">' +
          '<span class="cp-suggest-cod">' +
          cpEscHTML(c.cod_cliente || "") +
          "</span>" +
          '<span class="cp-suggest-name">' +
          cpEscHTML(c.business_name || "") +
          "</span>" +
          "</div>"
        );
      })
      .join("");
    card.suggestEl.innerHTML = html;
    card.suggestEl.style.display = "block";
    card.suggestEl.querySelectorAll(".cp-suggest-row").forEach(function (row) {
      row.addEventListener("mousedown", function (e) {
        e.preventDefault(); // evitar blur antes del click
        var id = Number(row.dataset.id);
        var c = merged.find(function (x) {
          return x.id === id;
        });
        if (c) {
          cpHideSuggest(card);
          card.searchCod.value = c.cod_cliente || "";
          cpCardSelectCustomer(card, c);
        }
      });
    });
  } catch (e) {
    console.error("cp suggest error:", e);
  }
}

async function cpCardSearchCustomer(card) {
  var q = card.searchCod.value.trim();
  if (!q) {
    toast("Ingresá código o razón social", "warning");
    return;
  }

  var isNum = /^\d+$/.test(q);
  var result;
  if (isNum) {
    result = await sb
      .from("customers")
      .select("*")
      .eq("cod_cliente", q)
      .limit(5);
  } else {
    result = await sb
      .from("customers")
      .select("*")
      .ilike("business_name", "%" + q + "%")
      .order("business_name", { ascending: true })
      .limit(15);
  }
  if (result.error) {
    toast("Error: " + result.error.message, "error");
    return;
  }
  if (!result.data || !result.data.length) {
    toast("Cliente no encontrado: " + q, "warning");
    return;
  }

  if (result.data.length === 1) {
    cpCardSelectCustomer(card, result.data[0]);
  } else {
    // Varios coincidentes (cod_cliente teoricamente unico, pero por las dudas)
    var html = '<div style="padding:10px;font-size:12px">';
    html +=
      '<div style="margin-bottom:6px;font-weight:600">Se encontraron varios:</div>';
    result.data.forEach(function (c) {
      html +=
        '<div class="cp-pick-row" data-id="' +
        c.id +
        '" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;cursor:pointer">' +
        "<strong>" +
        (c.cod_cliente || "") +
        "</strong> — " +
        (c.business_name || "") +
        "</div>";
    });
    html += "</div>";
    card.customerWrap.innerHTML = html;
    card.customerWrap.style.display = "block";
    card.customerWrap.querySelectorAll(".cp-pick-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var id = Number(row.dataset.id);
        var c = result.data.find(function (x) {
          return x.id === id;
        });
        if (c) cpCardSelectCustomer(card, c);
      });
    });
  }
}

function cpCardClearCotizadorState(card) {
  card.parsed = [];
  card.invalid = [];
  card.payment = null;
  card.delivery = "";
  card.excelTotal = null;
  card.isPdf = false;
  card.pdfSubtotal = null;
  card.pdfPaymentRaw = "";
  card.flyers = [];
  card.upsellMsg = "";
  card.pendingFileData = null;
  card.historyMode = false;
  card.selectedDeliveryIdx = null;
  card.finalDelivery = "";
  card.deliveryAddresses = [];
  card.deliveryLoading = false;
  card.submitted = false;
  card.orderId = null;
  card.root.classList.remove("submitted");
  if (card.dropZone) card.dropZone.classList.remove("cp-drop-success-on");
  if (card.fileInput) card.fileInput.value = "";
  card.summaryWrap.innerHTML = "";
  card.summaryWrap.style.display = "none";
  card.msgWrap.innerHTML = "";
  card.msgWrap.style.display = "none";
  card.flyersWrap.innerHTML = "";
  card.flyersWrap.style.display = "none";
  card.actionsWrap.innerHTML = "";
  card.actionsWrap.style.display = "none";
  cpCardSetStatus(card, "");
}

async function cpCardSelectCustomer(card, c) {
  // Si cambia el cliente (o ya había un cotizador cargado), reseteamos el upload
  // para forzar nueva carga con el cliente correcto.
  var prevCod = card.customer ? String(card.customer.cod_cliente) : null;
  var newCod = String(c.cod_cliente || "");
  var changingClient = prevCod && prevCod !== newCod;
  var savedPending = changingClient ? null : card.pendingFileData;
  if ((card.parsed && card.parsed.length) || card.pendingFileData || changingClient) {
    cpCardClearCotizadorState(card);
  }
  // Restaurar el archivo pendiente si no hubo cambio de cliente
  card.pendingFileData = savedPending;

  card.customer = c;
  card.customerWrap.innerHTML =
    "" +
    '<div class="cp-card-customer">' +
    '<div class="cp-c-name">' +
    (c.cod_cliente || "") +
    " — " +
    (c.business_name || "") +
    "</div>" +
    '<div class="cp-c-meta">Dto vol: ' +
    (c.dto_vol != null ? (Number(c.dto_vol) * 100).toFixed(0) + "%" : "0%") +
    " · Vend: " +
    (c.vend || "—") +
    "</div>" +
    '<button type="button" class="cp-history-link">Ver flyers por historial (sin cotizador)</button>' +
    "</div>";
  card.customerWrap.style.display = "block";
  card.customerWrap
    .querySelector(".cp-history-link")
    .addEventListener("click", function () {
      cpCardShowHistoryFlyers(card);
    });
  cpCardSetStatus(card, "Cargando historial...");

  // Cargar historial + sucursales en paralelo
  card.historyLoading = true;
  card.deliveryLoading = true;
  await Promise.all([
    cpCardLoadHistory(card, c).then(function () {
      card.historyLoading = false;
    }),
    cpCardLoadDeliveryAddresses(card, c).then(function () {
      card.deliveryLoading = false;
    }),
  ]);
  cpCardSetStatus(
    card,
    "Listo. Subí el cotizador o generá flyers por historial.",
  );

  // Si había archivo pending, procesarlo ahora
  if (card.pendingFileData) {
    if (card.pendingFileIsPdf) cpCardProcessPdfData(card, card.pendingFileData);
    else cpCardProcessFileData(card, card.pendingFileData);
    card.pendingFileData = null;
    card.pendingFileIsPdf = false;
  }
}

async function cpCardLoadDeliveryAddresses(card, c) {
  try {
    var r = await sb
      .from("customer_delivery_addresses")
      .select("slot,label,direccion_entrega,zona_expreso")
      .eq("customer_id", c.id)
      .order("slot", { ascending: true });
    if (r.error) {
      console.error("cp delivery addresses error", r.error);
      card.deliveryAddresses = [];
      return;
    }
    card.deliveryAddresses = r.data || [];
  } catch (e) {
    console.error("cp delivery addresses exception:", e);
    card.deliveryAddresses = [];
  }
}

function cpCardShowHistoryFlyers(card) {
  if (card.submitted) return;
  if (!card.customer) {
    toast("Primero elegí un cliente", "warning");
    return;
  }
  if (card.historyLoading) {
    toast("Esperá a que cargue el historial...", "warning");
    return;
  }
  card.historyMode = true;
  card.parsed = [];
  card.invalid = [];
  card.payment = null;
  card.delivery = "";
  card.summaryWrap.style.display = "none";
  card.summaryWrap.innerHTML = "";
  cpCardBuildFlyers(card);
  cpCardRenderActions(card);
  cpCardRenderBottomButtons(card);
  if (!card.flyers.length) {
    cpCardSetStatus(
      card,
      "Este cliente ya conoce todos los productos de la oferta.",
      "err",
    );
  } else {
    cpCardSetStatus(card, "Flyers por historial generados.", "ok");
  }
}

async function cpCardLoadHistory(card, c) {
  var webItems = [];
  try {
    var cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 18);
    var cutoffISO = cutoff.toISOString();

    var allOrderIds = [],
      oOffset = 0;
    var ordersBatch;
    do {
      var ordersR = await sb
        .from("orders")
        .select("id")
        .eq("customer_id", c.id)
        .gte("created_at", cutoffISO)
        .range(oOffset, oOffset + 999);
      if (ordersR.error || !ordersR.data) break;
      ordersBatch = ordersR.data;
      allOrderIds = allOrderIds.concat(
        ordersBatch.map(function (o) {
          return o.id;
        }),
      );
      oOffset += 1000;
    } while (ordersBatch.length === 1000);

    if (allOrderIds.length) {
      for (var bi = 0; bi < allOrderIds.length; bi += 200) {
        var batchIds = allOrderIds.slice(bi, bi + 200);
        var wiOffset = 0;
        var itemsBatch;
        do {
          var itemsR = await sb
            .from("order_items")
            .select("product_id,cajas,uxb,is_loke")
            .in("order_id", batchIds)
            .range(wiOffset, wiOffset + 999);
          if (itemsR.error || !itemsR.data) break;
          itemsBatch = itemsR.data;
          webItems = webItems.concat(itemsBatch);
          wiOffset += 1000;
        } while (itemsBatch.length === 1000);
      }
    }
  } catch (e) {
    console.error("cp web history error", e);
  }

  var salesLines = [];
  try {
    var slR = await sb.rpc("get_customer_sales_history", {
      p_customer_code: String(c.cod_cliente),
    });
    if (!slR.error && slR.data) salesLines = slR.data;
  } catch (e) {
    console.error("cp sales history error", e);
  }

  card.history = { web: webItems, sales: salesLines };
}

function cpCardHandleFile(card, file) {
  var isPdf = /\.pdf$/i.test(file.name || "") || file.type === "application/pdf";
  var reader = new FileReader();
  reader.onload = function (e) {
    var buf = e.target.result;
    if (!card.customer) {
      // Guardar y esperar a que seleccionen cliente (o procesar igual si ya eligió y solo el historial está cargando)
      card.pendingFileData = buf;
      card.pendingFileIsPdf = isPdf;
      cpCardSetStatus(card, "Archivo cargado. Elegí un cliente para procesar.");
      return;
    }
    if (card.historyLoading) {
      card.pendingFileData = buf;
      card.pendingFileIsPdf = isPdf;
      cpCardSetStatus(card, "Esperando historial...");
      return;
    }
    if (isPdf) cpCardProcessPdfData(card, buf);
    else cpCardProcessFileData(card, buf);
  };
  reader.readAsArrayBuffer(file);
}

function cpCardProcessFileData(card, buf) {
  try {
    var wb = XLSX.read(buf, { type: "array" });
    var sheetName = wb.SheetNames.find(function (n) {
      return /cotizador/i.test(n);
    });
    if (!sheetName && wb.SheetNames.length > 1) sheetName = wb.SheetNames[1];
    if (!sheetName) sheetName = wb.SheetNames[0];
    var sheet = wb.Sheets[sheetName];
    var raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    var isGM = cpDetectGMFormat(raw);
    card.isGM = isGM;
    card.isPdf = false;
    card.pdfSubtotal = null;

    var items, payment, delivery, excelTotal;

    if (isGM) {
      // Formato Lista GM (cliente 4080): precios del Excel, sin descuentos
      items = cpParseItemsGM(raw);
      payment = { text: "Lista GM", discount: 0, code: 0 };
      delivery = cpParseDeliveryFromRaw(raw);
      excelTotal = null; // No comparamos con total del Excel en este formato
    } else {
      items = cpParseItems(raw);
      payment = cpParsePaymentFromRaw(raw);
      delivery = cpParseDeliveryFromRaw(raw);
      excelTotal = cpParseExcelTotal(raw);
    }

    if (!items.length) {
      cpCardSetStatus(
        card,
        "No se encontraron items con cajas en el cotizador.",
        "err",
      );
      toast(
        "Cotizador sin items (Cotizador " + (card.idx + 1) + ")",
        "warning",
      );
      return;
    }
    if (!isGM && !payment) {
      cpCardSetStatus(
        card,
        "El cotizador no tiene exactamente una X marcada en fila 6 (E-J).",
        "err",
      );
      toast(
        "Cotizador " + (card.idx + 1) + ": método de pago inválido",
        "error",
      );
      return;
    }

    card.parsed = items.filter(function (it) {
      return it.found;
    });
    card.invalid = items.filter(function (it) {
      return !it.found;
    });
    card.payment = payment;
    card.delivery = delivery;
    card.excelTotal = excelTotal;
    card.historyMode = false;
    card.selectedDeliveryIdx = null;

    cpCardBuildFlyers(card);
    cpCardRenderSummary(card);
    cpCardRenderActions(card);
    cpCardRenderBottomButtons(card);
    cpCardSetStatus(card, "");
    card.dropZone.classList.add("cp-drop-success-on");
    card.fileInput.value = "";
  } catch (e) {
    console.error("cp parse error:", e);
    cpCardSetStatus(
      card,
      "Error procesando el archivo: " + (e.message || e),
      "err",
    );
  }
}

function cpCardBuildFlyers(card) {
  var upsellProducts = cpGetUpsellProducts(card.parsed, card.history);
  card.flyers = upsellProducts;

  if (!upsellProducts.length) {
    card.msgWrap.style.display = "none";
    card.flyersWrap.style.display = "none";
    return;
  }

  var dtoVol = Number(card.customer.dto_vol || 0);
  var now = new Date();
  var day = now.getDay();
  var daysUntilSunday = day === 0 ? 7 : 7 - day;
  var nextSun = new Date(now);
  nextSun.setDate(nextSun.getDate() + daysUntilSunday);
  var meses = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  var fechaDomingo =
    "domingo " + nextSun.getDate() + " de " + meses[nextSun.getMonth()];

  var preciosTexto = upsellProducts
    .map(function (p) {
      var codSafe = String(p.cod || "").trim();
      var listPrice = Number(p.list_price || 0);
      var contado =
        listPrice * (1 - dtoVol) * (1 - CP_WEB_DISCOUNT) * (1 - 0.25);
      var oferta = contado * (1 - 0.1);
      return codSafe + " = $" + formatMoney(oferta) + " + IVA";
    })
    .join("\n");

  var intro =
    "Hola " +
    (card.customer.business_name || "") +
    "! Recibimos tu pedido, y analizando tu historial de compras, y este pedido que me acabas de enviar. Vemos que no probaste con estos items nuevos que como lanzamiento los tenemos en oferta.";
  card.upsellMsg =
    intro +
    " Avisame si queres agregar alguno de ellos. Esta oferta es valida hasta el " +
    fechaDomingo +
    ". Como lanzamiento estamos haciendo descuentos del 10% en estos " +
    upsellProducts.length +
    " items. Tu precio contado quedaría en:\n" +
    preciosTexto;

  // El render de los botones (Ver detalle + Enviar oferta) lo hace
  // cpCardRenderBottomButtons() después de cpCardRenderActions, para que
  // queden al fondo de la card (debajo de la sección de sucursales).
  card.flyersWrap.innerHTML = "";
  card.flyersWrap.style.display = "none";
}

function cpCardOpenOffer(card) {
  if (!card || !card.flyers || !card.flyers.length) return;

  var flyersHtml = '<div class="cp-flyers-grid">';
  flyersHtml += card.flyers
    .map(function (p) {
      var codSafe = String(p.cod || "").trim();
      var flyerSrc =
        BASE_FLYER + "flyer_" + encodeURIComponent(codSafe) + ".webp";
      return (
        '<div class="flyer-item">' +
        '<img src="' +
        flyerSrc +
        '" alt="Flyer ' +
        codSafe +
        '" onerror="this.src=\'img/no-image.jpg\'">' +
        '<div class="flyer-item-footer">' +
        '<div class="flyer-item-cod">COD ' +
        codSafe +
        "</div>" +
        '<div class="flyer-item-desc">' +
        cpEscHTML(String(p.description || "")) +
        "</div>" +
        '<button class="flyer-item-dl" data-src="' +
        flyerSrc +
        '" data-cod="' +
        codSafe +
        '">Descargar</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");
  flyersHtml += "</div>";

  var html =
    '<div class="modal-overlay cp-offer-overlay">' +
    '<div class="modal-box cp-offer-box">' +
    '<div class="modal-header">' +
    "<h3>Enviar oferta — Cotizador " +
    (card.idx + 1) +
    "</h3>" +
    '<button type="button" class="modal-close cp-offer-close" aria-label="Cerrar">&times;</button>' +
    "</div>" +
    '<div class="modal-body cp-offer-body">' +
    '<div class="cp-msg-box cp-offer-msg">' +
    '<button type="button" class="btn-ghost cp-msg-copy">Copiar</button>' +
    "<pre></pre>" +
    "</div>" +
    flyersHtml +
    "</div>" +
    '<div class="modal-footer">' +
    '<button type="button" class="btn-ghost cp-offer-dl-all">Descargar todos los flyers (' +
    card.flyers.length +
    ")</button>" +
    '<button type="button" class="btn-primary cp-offer-close-btn">Cerrar</button>' +
    "</div>" +
    "</div>" +
    "</div>";

  var wrap = document.createElement("div");
  wrap.innerHTML = html;
  var overlay = wrap.firstChild;
  overlay.querySelector("pre").textContent = card.upsellMsg || "";
  document.body.appendChild(overlay);

  function escHandler(ev) {
    if (ev.key === "Escape") close();
  }
  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", escHandler);
  }
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) close();
  });
  overlay.querySelector(".cp-offer-close").addEventListener("click", close);
  overlay
    .querySelector(".cp-offer-close-btn")
    .addEventListener("click", close);
  overlay
    .querySelector(".cp-offer-dl-all")
    .addEventListener("click", function () {
      cpDownloadFlyerProducts(card.flyers);
    });
  overlay
    .querySelector(".cp-msg-copy")
    .addEventListener("click", function () {
      navigator.clipboard.writeText(card.upsellMsg || "").then(function () {
        toast("Mensaje copiado");
      });
    });
  overlay.querySelectorAll(".flyer-item-dl").forEach(function (btn) {
    btn.addEventListener("click", function () {
      cpDownloadBlob(
        btn.getAttribute("data-src"),
        "flyer_" + btn.getAttribute("data-cod") + ".webp",
      );
    });
  });
  document.addEventListener("keydown", escHandler);
}

function cpCardComputeTotals(card) {
  // Lista GM: precios del Excel, sin ningún descuento
  if (card.isGM) {
    var subtotalGM = 0;
    var totalCajasGM = 0;
    card.parsed.forEach(function (it) {
      var unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
      subtotalGM += Number(it.pricePerUnit || 0) * unidades;
      totalCajasGM += Number(it.cajas || 0);
    });
    return {
      subtotal: subtotalGM,
      subtotalNoVol: subtotalGM,
      listTotal: subtotalGM,
      finalTotal: subtotalGM,
      excelEquivTotal: subtotalGM,
      totalDiscounts: 0,
      totalCajas: totalCajasGM,
    };
  }

  var dtoVol = Number(card.customer.dto_vol || 0);
  var payDisc = Number(card.payment.discount || 0);
  var subtotal = 0; // subtotal con dto_vol + web aplicados (lo que la web llama "subtotal")
  var subtotalNoVol = 0; // subtotal SIN dto_vol (equivalente al Excel: solo web 2%)
  var listTotal = 0;
  var totalCajas = 0;
  card.parsed.forEach(function (it) {
    var unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
    var listPrice = Number(it.listPrice || 0);
    var unitYourPrice = listPrice * (1 - dtoVol) * (1 - CP_WEB_DISCOUNT);
    var unitNoVol = listPrice * (1 - CP_WEB_DISCOUNT);
    subtotal += unitYourPrice * unidades;
    subtotalNoVol += unitNoVol * unidades;
    listTotal += listPrice * unidades;
    totalCajas += Number(it.cajas || 0);
  });
  var finalTotal = subtotal * (1 - payDisc);
  // Equivalente Excel: incluye Dto x Pago + 2% Cot, SIN Dto x Volumen ni IVA
  var excelEquivTotal = subtotalNoVol * (1 - payDisc);
  var totalDiscounts = Math.max(0, listTotal - finalTotal);
  return {
    subtotal: subtotal,
    subtotalNoVol: subtotalNoVol,
    listTotal: listTotal,
    finalTotal: finalTotal,
    excelEquivTotal: excelEquivTotal,
    totalDiscounts: totalDiscounts,
    totalCajas: totalCajas,
  };
}

function cpCardRenderSummary(card) {
  var t = cpCardComputeTotals(card);

  // Lista GM: resumen simplificado, sin comparación con Excel
  if (card.isGM) {
    var gmHtml =
      '<div class="cp-card-summary">' +
      '<div class="cp-summary-row cp-summary-gm-badge">&#9654; Lista GM &mdash; sin descuentos</div>' +
      '<div class="cp-summary-row"><span>Artículos:</span><span>' + (card.parsed ? card.parsed.length : 0) + '</span></div>' +
      '<div class="cp-summary-row cp-summary-total"><span>Total Lista GM:</span><span>$&nbsp;' + formatMoney(t.finalTotal) + '</span></div>';
    if (card.invalid && card.invalid.length) {
      gmHtml += '<div class="cp-summary-row cp-summary-warn">&#9888; ' + card.invalid.length + ' artículo(s) no encontrado(s)</div>';
    }
    gmHtml += '</div>';
    if (card.parsed && card.parsed.length) {
      gmHtml +=
        '<button type="button" class="cp-detail-btn cp-detail-btn-summary" title="Ver detalle del pedido">' +
        '<span class="cp-detail-btn-icon" aria-hidden="true">+</span>' +
        '<span class="cp-detail-btn-label">Ver detalle del pedido</span>' +
        '</button>';
    }
    card.summaryWrap.innerHTML = gmHtml;
    card.summaryWrap.style.display = "block";
    card.summaryWrap.querySelector(".cp-detail-btn-summary") &&
      card.summaryWrap.querySelector(".cp-detail-btn-summary").addEventListener("click", function () {
        cpShowDetailOverlay(card);
      });
    return;
  }

  // PDF: resumen propio con dropdown de método de pago, sin comparación Excel
  if (card.isPdf) {
    cpCardRenderSummaryPdf(card);
    return;
  }

  var dtoVolPct = Number(card.customer.dto_vol || 0);
  var excelRaw = card.excelTotal; // null si no se pudo leer
  var hasExcel = excelRaw != null;
  var excelAdjusted = hasExcel ? excelRaw * (1 - dtoVolPct) : null;
  var refTotal = dtoVolPct > 0 ? t.finalTotal : t.excelEquivTotal;
  var compareValue = dtoVolPct > 0 ? excelAdjusted : excelRaw;
  var diffAbs = hasExcel ? Math.abs(compareValue - refTotal) : null;
  var totalsMatch = hasExcel && diffAbs < 1;

  // Caso compacto: si Excel coincide con el cálculo y no hay items inválidos,
  // mostrar solo "Todo Ok ✓". El usuario igual puede abrir "Ver detalle del
  // pedido" si quiere verificar items / método / sucursal.
  if (totalsMatch && !card.invalid.length) {
    var html =
      '<div class="cp-card-summary cp-summary-ok">' +
      '<span class="cp-summary-ok-check" aria-hidden="true">&#10003;</span>' +
      '<span class="cp-summary-ok-text">Todo OK!</span>' +
      "</div>";
    if (card.parsed && card.parsed.length) {
      html +=
        '<button type="button" class="cp-detail-btn cp-detail-btn-summary" title="Ver detalle del pedido">' +
        '<span class="cp-detail-btn-icon" aria-hidden="true">+</span>' +
        '<span class="cp-detail-btn-label">Ver detalle del pedido</span>' +
        "</button>";
    }
    card.summaryWrap.innerHTML = html;
    card.summaryWrap.style.display = "block";
    var dBtn = card.summaryWrap.querySelector(".cp-detail-btn");
    if (dBtn)
      dBtn.addEventListener("click", function () {
        cpCardOpenDetail(card);
      });
    return;
  }

  var html = '<div class="cp-card-summary">';
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Items</span><span class="cp-s-val">' +
    card.parsed.length +
    " (" +
    t.totalCajas +
    " cajas)</span></div>";
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Método de pago</span><span class="cp-s-val">' +
    card.payment.text +
    " (" +
    Math.round(card.payment.discount * 100) +
    "%)</span></div>";
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Sucursal</span><span class="cp-s-val">' +
    (card.delivery || '<span style="color:var(--warning)">(vacía)</span>') +
    "</span></div>";

  function _buildBadge(d) {
    return d < 1
      ? ' <span class="cp-excel-badge cp-excel-ok" title="Coincide">✓</span>'
      : ' <span class="cp-excel-badge cp-excel-warn" title="Diferencia: $' +
          formatMoney(d) +
          '">⚠ Δ $' +
          formatMoney(d) +
          "</span>";
  }

  // Total Web (sin dto. vol.)
  html +=
    '<div class="cp-summary-row cp-summary-total">' +
    '<span class="cp-s-label">Total Web</span>' +
    '<span class="cp-s-val">$' +
    formatMoney(t.excelEquivTotal) +
    "</span>" +
    "</div>";

  // Total Web - dto vol (negrita) — solo si hay dto vol
  if (dtoVolPct > 0) {
    html +=
      '<div class="cp-summary-row cp-summary-final">' +
      '<span class="cp-s-label">Total Web - dto vol (' +
      Math.round(dtoVolPct * 100) +
      "%)</span>" +
      '<span class="cp-s-val">$' +
      formatMoney(t.finalTotal) +
      " + IVA</span>" +
      "</div>";
  }

  // Total Excel (raw $X) - dto vol (Y%)   $excelAdjusted ✓
  if (hasExcel) {
    var label =
      dtoVolPct > 0
        ? "Total Excel ($" +
          formatMoney(excelRaw) +
          ") - dto vol (" +
          Math.round(dtoVolPct * 100) +
          "%)"
        : "Total Excel";
    html +=
      '<div class="cp-summary-row cp-summary-final cp-excel-row">' +
      '<span class="cp-s-label">' +
      label +
      "</span>" +
      '<span class="cp-s-val">$' +
      formatMoney(compareValue) +
      _buildBadge(diffAbs) +
      "</span>" +
      "</div>";
  } else {
    html +=
      '<div class="cp-summary-row cp-excel-row cp-excel-missing">' +
      '<span class="cp-s-label">Total Excel</span>' +
      '<span class="cp-s-val">— no encontrado</span>' +
      "</div>";
  }

  if (card.invalid.length) {
    html +=
      '<div class="cp-summary-warn">' +
      card.invalid.length +
      " ítems con código no reconocido serán omitidos al subir el pedido: " +
      card.invalid
        .map(function (x) {
          return x.cod;
        })
        .join(", ") +
      "</div>";
  }
  html += "</div>";
  if (card.parsed && card.parsed.length) {
    html +=
      '<button type="button" class="cp-detail-btn cp-detail-btn-summary" title="Ver detalle del pedido">' +
      '<span class="cp-detail-btn-icon" aria-hidden="true">+</span>' +
      '<span class="cp-detail-btn-label">Ver detalle del pedido</span>' +
      "</button>";
  }
  card.summaryWrap.innerHTML = html;
  card.summaryWrap.style.display = "block";
  var dBtn2 = card.summaryWrap.querySelector(".cp-detail-btn");
  if (dBtn2)
    dBtn2.addEventListener("click", function () {
      cpCardOpenDetail(card);
    });
}

function cpCardRenderSummaryPdf(card) {
  var t = cpCardComputeTotals(card);
  var dtoVolPct = Number(card.customer.dto_vol || 0);

  var payOpts = "";
  [4, 5, 6, 7, 8, 9].forEach(function (col) {
    var p = CP_PAYMENT_MAP[col];
    var sel = card.payment && card.payment.col === col ? " selected" : "";
    payOpts +=
      '<option value="' +
      col +
      '"' +
      sel +
      ">" +
      p.text +
      " (" +
      Math.round(p.discount * 100) +
      "%)</option>";
  });

  var html = '<div class="cp-card-summary">';
  html +=
    '<div class="cp-summary-row cp-summary-gm-badge">&#128196; Cargado desde PDF</div>';
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Items</span><span class="cp-s-val">' +
    card.parsed.length +
    " (" +
    t.totalCajas +
    " cajas)</span></div>";
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Método de pago</span>' +
    '<span class="cp-s-val"><select class="field-input cp-pdf-pay" style="padding:4px 6px;font-size:12px;width:auto">' +
    payOpts +
    "</select></span></div>";
  if (card.pdfPaymentRaw) {
    html +=
      '<div class="cp-summary-row" style="margin-top:-6px"><span class="cp-s-label" style="font-size:11px;color:var(--text3)">Cond. PDF</span>' +
      '<span class="cp-s-val" style="font-size:11px;color:var(--text3)">' +
      cpEscHTML(card.pdfPaymentRaw) +
      "</span></div>";
  }
  html +=
    '<div class="cp-summary-row"><span class="cp-s-label">Sucursal</span><span class="cp-s-val">' +
    (card.delivery ||
      '<span style="color:var(--warning)">(elegí al confirmar)</span>') +
    "</span></div>";
  html +=
    '<div class="cp-summary-row cp-summary-total"><span class="cp-s-label">Total Web</span><span class="cp-s-val">$' +
    formatMoney(t.excelEquivTotal) +
    "</span></div>";
  if (dtoVolPct > 0) {
    html +=
      '<div class="cp-summary-row cp-summary-final"><span class="cp-s-label">Total Web - dto vol (' +
      Math.round(dtoVolPct * 100) +
      ')</span><span class="cp-s-val">$' +
      formatMoney(t.finalTotal) +
      " + IVA</span></div>";
  }
  if (card.pdfSubtotal) {
    html +=
      '<div class="cp-summary-row cp-excel-row"><span class="cp-s-label">Subtotal OC (PDF)</span><span class="cp-s-val">$' +
      formatMoney(card.pdfSubtotal) +
      "</span></div>";
  }
  if (card.invalid.length) {
    html +=
      '<div class="cp-summary-warn">' +
      card.invalid.length +
      " ítems con código no reconocido serán omitidos al subir el pedido: " +
      card.invalid
        .map(function (x) {
          return x.cod;
        })
        .join(", ") +
      "</div>";
  }
  html += "</div>";
  if (card.parsed && card.parsed.length) {
    html +=
      '<button type="button" class="cp-detail-btn cp-detail-btn-summary" title="Ver detalle del pedido">' +
      '<span class="cp-detail-btn-icon" aria-hidden="true">+</span>' +
      '<span class="cp-detail-btn-label">Ver detalle del pedido</span>' +
      "</button>";
  }
  card.summaryWrap.innerHTML = html;
  card.summaryWrap.style.display = "block";

  var paySel = card.summaryWrap.querySelector(".cp-pdf-pay");
  if (paySel)
    paySel.addEventListener("change", function () {
      var col = parseInt(paySel.value, 10);
      card.payment = Object.assign({ col: col }, CP_PAYMENT_MAP[col]);
      cpCardRenderSummary(card);
      cpCardRenderActions(card);
      cpCardRenderBottomButtons(card);
    });
  var dBtn = card.summaryWrap.querySelector(".cp-detail-btn");
  if (dBtn)
    dBtn.addEventListener("click", function () {
      cpCardOpenDetail(card);
    });
}

function cpCardRenderBottomButtons(card) {
  // "Ver detalle del pedido" ahora se renderiza dentro de cpCardRenderSummary
  // (pegado al resumen del cotizador). Acá solo queda "Enviar oferta".
  var hasFlyers = card.flyers && card.flyers.length;
  if (!hasFlyers) {
    card.msgWrap.innerHTML = "";
    card.msgWrap.style.display = "none";
    return;
  }
  var btnsHtml = '<div class="cp-bottom-actions">';
  btnsHtml +=
    '<button type="button" class="btn-primary cp-offer-btn" title="Ver y compartir oferta de novedades">' +
    '<span class="cp-offer-btn-icon" aria-hidden="true">📣</span>' +
    '<span class="cp-offer-btn-label">Enviar oferta</span>' +
    '<span class="cp-offer-btn-count">' +
    card.flyers.length +
    " novedad" +
    (card.flyers.length === 1 ? "" : "es") +
    "</span>" +
    "</button>";
  btnsHtml += "</div>";
  card.msgWrap.innerHTML = btnsHtml;
  card.msgWrap.style.display = "block";

  var offerBtn = card.msgWrap.querySelector(".cp-offer-btn");
  if (offerBtn) {
    offerBtn.addEventListener("click", function () {
      cpCardOpenOffer(card);
    });
  }
}

function cpCardOpenDetail(card) {
  if (!card || !card.parsed || !card.parsed.length) return;
  var t = cpCardComputeTotals(card);
  var dtoVol = Number(card.customer.dto_vol || 0);
  var payDisc = Number(card.payment.discount || 0);

  var rowsHtml = card.parsed
    .map(function (it) {
      var unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
      var listPrice = Number(it.listPrice || 0);
      var unitYourPrice =
        listPrice * (1 - dtoVol) * (1 - CP_WEB_DISCOUNT);
      var lineSubtotal = unitYourPrice * unidades;
      var lineFinal = lineSubtotal * (1 - payDisc);
      return (
        "<tr>" +
        '<td class="cp-d-cod">' +
        cpEscHTML(it.cod) +
        (it.cod_original
          ? ' <span style="color:#c0392b;font-size:11px;">(pidió ' +
            cpEscHTML(it.cod_original) +
            ")</span>"
          : "") +
        "</td>" +
        '<td class="cp-d-desc">' +
        cpEscHTML(it.description) +
        "</td>" +
        '<td class="cp-d-num">' +
        it.cajas +
        "</td>" +
        '<td class="cp-d-num">' +
        it.uxb +
        "</td>" +
        '<td class="cp-d-num">' +
        unidades +
        "</td>" +
        '<td class="cp-d-num">$' +
        formatMoney(listPrice) +
        "</td>" +
        '<td class="cp-d-num">$' +
        formatMoney(unitYourPrice) +
        "</td>" +
        '<td class="cp-d-num cp-d-bold">$' +
        formatMoney(lineFinal) +
        "</td>" +
        "</tr>"
      );
    })
    .join("");

  var customerLine =
    cpEscHTML(card.customer.cod_cliente) +
    " — " +
    cpEscHTML(card.customer.razon_social || "");

  var html =
    '<div class="modal-overlay cp-detail-overlay">' +
    '<div class="modal-box cp-detail-box">' +
    '<div class="modal-header">' +
    "<h3>Detalle Cotizador " +
    (card.idx + 1) +
    "</h3>" +
    '<button type="button" class="modal-close cp-detail-close" aria-label="Cerrar">&times;</button>' +
    "</div>" +
    '<div class="modal-body cp-detail-body">' +
    '<div class="cp-detail-meta">' +
    "<div><strong>Cliente:</strong> " +
    customerLine +
    "</div>" +
    "<div><strong>Pago:</strong> " +
    cpEscHTML(card.payment.text) +
    " (" +
    Math.round(payDisc * 100) +
    "%)</div>" +
    "<div><strong>Dto. volumen:</strong> " +
    Math.round(dtoVol * 100) +
    "%</div>" +
    "<div><strong>Dto. web:</strong> " +
    Math.round(CP_WEB_DISCOUNT * 100) +
    "%</div>" +
    "<div><strong>Sucursal (D9):</strong> " +
    cpEscHTML(card.delivery || "—") +
    "</div>" +
    "</div>" +
    '<div class="cp-detail-table-wrap">' +
    '<table class="cp-detail-table">' +
    "<thead><tr>" +
    "<th>Cod</th>" +
    "<th>Descripción</th>" +
    "<th>Cajas</th>" +
    "<th>U×B</th>" +
    "<th>Unid.</th>" +
    "<th>P. Lista</th>" +
    "<th>P. Unit.</th>" +
    "<th>Subtotal línea</th>" +
    "</tr></thead>" +
    "<tbody>" +
    rowsHtml +
    "</tbody>" +
    "</table>" +
    "</div>" +
    (function () {
      var hasEx = card.excelTotal != null;
      var excelRaw = card.excelTotal;
      var excelAdj = hasEx ? excelRaw * (1 - dtoVol) : null;
      function mk(absD) {
        return absD < 1
          ? ' <span class="cp-excel-badge cp-excel-ok">✓</span>'
          : ' <span class="cp-excel-badge cp-excel-warn">⚠ Δ $' +
              formatMoney(absD) +
              "</span>";
      }
      var h = '<div class="cp-detail-totals">';
      // Total Web (sin dto. vol.)
      h +=
        '<div class="cp-detail-totrow"><span>Total Web</span><span>$' +
        formatMoney(t.excelEquivTotal) +
        "</span></div>";
      // Total Web - dto vol (negrita)
      if (dtoVol > 0) {
        h +=
          '<div class="cp-detail-totrow cp-detail-final"><span>Total Web - dto vol (' +
          Math.round(dtoVol * 100) +
          "%)</span><span>$" +
          formatMoney(t.finalTotal) +
          " + IVA</span></div>";
      }
      // Total Excel (raw $X) - dto vol (Y%)   $compareValue ✓
      if (hasEx) {
        var refTot = dtoVol > 0 ? t.finalTotal : t.excelEquivTotal;
        var compareVal = dtoVol > 0 ? excelAdj : excelRaw;
        var lbl =
          dtoVol > 0
            ? "Total Excel ($" +
              formatMoney(excelRaw) +
              ") - dto vol (" +
              Math.round(dtoVol * 100) +
              "%)"
            : "Total Excel";
        h +=
          '<div class="cp-detail-totrow cp-detail-final"><span>' +
          lbl +
          "</span><span>$" +
          formatMoney(compareVal) +
          mk(Math.abs(compareVal - refTot)) +
          "</span></div>";
      } else {
        h +=
          '<div class="cp-detail-totrow cp-excel-missing"><span>Total Excel</span><span>— no encontrado</span></div>';
      }
      h += "</div>";
      return h;
    })() +
    (card.invalid && card.invalid.length
      ? '<div class="cp-summary-warn">' +
        card.invalid.length +
        " ítems no reconocidos (omitidos): " +
        card.invalid
          .map(function (x) {
            return cpEscHTML(x.cod);
          })
          .join(", ") +
        "</div>"
      : "") +
    "</div>" +
    '<div class="modal-footer">' +
    '<button type="button" class="btn-primary cp-detail-close-btn">Cerrar</button>' +
    "</div>" +
    "</div>" +
    "</div>";

  var wrap = document.createElement("div");
  wrap.innerHTML = html;
  var overlay = wrap.firstChild;
  document.body.appendChild(overlay);

  function escHandler(ev) {
    if (ev.key === "Escape") close();
  }
  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener("keydown", escHandler);
  }
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) close();
  });
  overlay.querySelector(".cp-detail-close").addEventListener("click", close);
  overlay
    .querySelector(".cp-detail-close-btn")
    .addEventListener("click", close);
  document.addEventListener("keydown", escHandler);
}

function cpEscHTML(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c];
  });
}

function cpCardRenderActions(card) {
  if (card.submitted) {
    card.actionsWrap.innerHTML =
      "" +
      '<div class="cp-submitted-banner">' +
      "<span>✓ Pedido N° " +
      card.orderId +
      " subido a DB y Sheets.</span>" +
      "</div>";
    card.actionsWrap.style.display = "block";
    card.root.classList.add("submitted");
    return;
  }

  var canSubmit = !card.historyMode && card.parsed.length && card.payment;
  var hasAnyAction = card.flyers.length || canSubmit;
  if (!hasAnyAction) {
    card.actionsWrap.style.display = "none";
    card.actionsWrap.innerHTML = "";
    return;
  }

  var html = "";

  if (canSubmit) {
    var addrs = card.deliveryAddresses || [];
    var deliveryNorm = String(card.delivery || "")
      .trim()
      .toLowerCase();

    // Pre-seleccionar match de D9 en la primera renderización
    if (card.selectedDeliveryIdx == null && deliveryNorm && addrs.length) {
      var preIdx = addrs.findIndex(function (d) {
        return (
          String(d.label || "")
            .trim()
            .toLowerCase() === deliveryNorm
        );
      });
      if (preIdx >= 0) card.selectedDeliveryIdx = preIdx;
    }

    html += '<div class="cp-suc-section">';
    if (card.delivery) {
      html +=
        '<div class="cp-suc-header">Cotizador (D9): <strong>' +
        cpEscHTML(card.delivery) +
        "</strong> — elegí la sucursal:</div>";
    } else {
      html += '<div class="cp-suc-header">Elegí la sucursal de entrega:</div>';
    }

    if (card.deliveryLoading) {
      html += '<div class="cp-suc-loading">Cargando sucursales...</div>';
    } else {
      html += '<div class="cp-suc-grid">';
      addrs.forEach(function (d, i) {
        var labelNorm = String(d.label || "")
          .trim()
          .toLowerCase();
        var isMatch = deliveryNorm && labelNorm === deliveryNorm;
        var isSelected = card.selectedDeliveryIdx === i;
        var cls =
          "cp-suc-btn" +
          (isMatch ? " cp-suc-match" : "") +
          (isSelected ? " cp-suc-selected" : "");
        html +=
          '<button type="button" class="' +
          cls +
          '" data-idx="' +
          i +
          '" title="' +
          cpEscHTML(d.direccion_entrega || "") +
          '">' +
          (isMatch
            ? '<span class="cp-suc-star" aria-hidden="true">&#9733;</span> '
            : "") +
          (isSelected
            ? '<span class="cp-suc-check" aria-hidden="true">&#10003;</span> '
            : "") +
          cpEscHTML(d.label || "(sin label)") +
          "</button>";
      });
      html +=
        '<button type="button" class="cp-suc-btn cp-suc-new-toggle">+ Nueva sucursal</button>';
      html += "</div>";
    }

    html +=
      '<div class="cp-suc-new-form" style="display:none">' +
      '<div class="cp-suc-new-title">Nueva sucursal para este cliente</div>' +
      '<input type="text" class="field-input cp-new-suc-label" placeholder="Nombre / label (ej: Sucursal Centro)"/>' +
      '<input type="text" class="field-input cp-new-suc-dir" placeholder="Dirección real de entrega"/>' +
      '<input type="text" class="field-input cp-new-suc-zona" placeholder="Zona expreso"/>' +
      '<div class="cp-suc-new-actions">' +
      '<button type="button" class="btn-ghost cp-new-suc-cancel">Cancelar</button>' +
      '<button type="button" class="btn-primary cp-new-suc-save">Guardar sucursal</button>' +
      "</div>" +
      '<div class="cp-suc-new-err" style="display:none"></div>' +
      "</div>";

    var selIdx = card.selectedDeliveryIdx;
    var selLabel = selIdx != null && addrs[selIdx] ? addrs[selIdx].label : "";
    var confirmDisabled = selIdx == null;
    html +=
      '<button type="button" class="btn-primary btn-submit-order cp-btn-confirm"' +
      (confirmDisabled ? " disabled" : "") +
      ">" +
      (confirmDisabled
        ? "Elegí sucursal"
        : "Confirmar envío a " + cpEscHTML(selLabel)) +
      "</button>";

    html += "</div>";
  }

  card.actionsWrap.innerHTML = html;
  card.actionsWrap.style.display = "block";

  card.actionsWrap
    .querySelectorAll(".cp-suc-btn[data-idx]")
    .forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.dataset.idx, 10);
        card.selectedDeliveryIdx = idx;
        cpCardRenderActions(card);
      });
    });

  var newToggle = card.actionsWrap.querySelector(".cp-suc-new-toggle");
  var newForm = card.actionsWrap.querySelector(".cp-suc-new-form");
  if (newToggle && newForm) {
    newToggle.addEventListener("click", function () {
      var open = newForm.style.display !== "flex";
      newForm.style.display = open ? "flex" : "none";
      if (open) {
        var labelInput = newForm.querySelector(".cp-new-suc-label");
        if (labelInput) {
          labelInput.value = card.delivery || "";
          setTimeout(function () {
            labelInput.focus();
          }, 50);
        }
      }
    });
  }
  var newCancel = card.actionsWrap.querySelector(".cp-new-suc-cancel");
  if (newCancel)
    newCancel.addEventListener("click", function () {
      newForm.style.display = "none";
    });
  var newSave = card.actionsWrap.querySelector(".cp-new-suc-save");
  if (newSave)
    newSave.addEventListener("click", function () {
      cpCardSaveNewSucursal(card);
    });

  var confirmBtn = card.actionsWrap.querySelector(".cp-btn-confirm");
  if (confirmBtn)
    confirmBtn.addEventListener("click", function () {
      if (card.selectedDeliveryIdx == null) {
        toast("Elegí una sucursal", "warning");
        return;
      }
      cpCardSubmitWithSucursal(card, card.selectedDeliveryIdx);
    });
}

function cpCardSubmitWithSucursal(card, idx) {
  if (card.submitted) return;
  var addrs = card.deliveryAddresses || [];
  if (idx < 0 || idx >= addrs.length) {
    toast("Sucursal inválida", "error");
    return;
  }
  var match = addrs[idx];
  card.finalDelivery = match.label || "";
  card.finalDeliveryDireccion = match.direccion_entrega || "";
  card.finalDeliveryZona = match.zona_expreso || "";
  cpCardDoSubmit(card);
}

async function cpCardSaveNewSucursal(card) {
  var form = card.actionsWrap.querySelector(".cp-suc-new-form");
  if (!form) return;
  var btn = form.querySelector(".cp-new-suc-save");
  var errEl = form.querySelector(".cp-suc-new-err");
  var label = form.querySelector(".cp-new-suc-label").value.trim();
  var dir = form.querySelector(".cp-new-suc-dir").value.trim();
  var zona = form.querySelector(".cp-new-suc-zona").value.trim();
  errEl.style.display = "none";
  errEl.textContent = "";

  if (!label) {
    errEl.textContent = "Ingresá el nombre / label.";
    errEl.style.display = "block";
    return;
  }
  if (!dir) {
    errEl.textContent = "Ingresá la dirección real de entrega.";
    errEl.style.display = "block";
    return;
  }
  if (!zona) {
    errEl.textContent = "Ingresá la zona expreso.";
    errEl.style.display = "block";
    return;
  }

  var existing = card.deliveryAddresses || [];
  var dupNorm = label.toLowerCase();
  if (
    existing.some(function (d) {
      return (
        String(d.label || "")
          .trim()
          .toLowerCase() === dupNorm
      );
    })
  ) {
    errEl.textContent = "Ya existe una sucursal con ese label.";
    errEl.style.display = "block";
    return;
  }
  var nextSlot =
    existing.reduce(function (m, d) {
      return Math.max(m, Number(d.slot || 0));
    }, 0) + 1;

  btn.disabled = true;
  btn.textContent = "Guardando...";
  try {
    var r = await sb
      .from("customer_delivery_addresses")
      .insert({
        customer_id: card.customer.id,
        slot: nextSlot,
        label: label,
        direccion_entrega: dir,
        zona_expreso: zona,
      })
      .select()
      .single();
    if (r.error)
      throw new Error(r.error.message || "Error al insertar sucursal");

    card.deliveryAddresses = existing.concat([r.data]).sort(function (a, b) {
      return Number(a.slot) - Number(b.slot);
    });
    var newIdx = card.deliveryAddresses.findIndex(function (d) {
      return d.slot === r.data.slot;
    });
    card.selectedDeliveryIdx = newIdx;
    toast("Sucursal agregada y seleccionada", "success");
    cpCardRenderActions(card);
  } catch (e) {
    errEl.textContent = "Error: " + (e.message || e);
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Guardar sucursal";
  }
}

// ---- Confirm modal ----
var cpConfirmOnOk = null;

function cpShowConfirm(bodyHtml, onOk) {
  document.getElementById("cpConfirmBody").innerHTML = bodyHtml;
  document.getElementById("cpConfirmModal").style.display = "flex";
  cpConfirmOnOk = onOk;
  var ok = document.getElementById("cpConfirmOk");
  // reemplazar el handler cada vez
  ok.onclick = function () {
    if (cpConfirmOnOk) cpConfirmOnOk();
  };
}

function cpHideConfirm() {
  document.getElementById("cpConfirmModal").style.display = "none";
  cpConfirmOnOk = null;
  // limpiar campos de sucursal
  var inp = document.getElementById("cpDeliveryInput");
  if (inp) inp.value = "";
  var fromEx = document.getElementById("cpDeliveryFromExcel");
  if (fromEx) fromEx.textContent = "";
  var chipsWrap = document.getElementById("cpDeliveryChipsWrap");
  if (chipsWrap) chipsWrap.style.display = "none";
  var chips = document.getElementById("cpDeliveryChips");
  if (chips) chips.innerHTML = "";
  var err = document.getElementById("cpDeliveryError");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }
}

// ---- Submit order flow ----
function cpCardStartSubmit(card) {
  if (card.submitted) return;
  if (!card.customer || !card.parsed.length || !card.payment) {
    toast("Faltan datos para subir el pedido", "warning");
    return;
  }
  var t = cpCardComputeTotals(card);
  var bodyHtml =
    "" +
    '<div style="display:flex;flex-direction:column;gap:8px;font-size:13.5px">' +
    "<div><strong>Cliente:</strong> " +
    (card.customer.cod_cliente || "") +
    " — " +
    (card.customer.business_name || "") +
    "</div>" +
    "<div><strong>Método de pago:</strong> " +
    card.payment.text +
    " (" +
    Math.round(card.payment.discount * 100) +
    "%)</div>" +
    "<div><strong>Items:</strong> " +
    card.parsed.length +
    " productos (" +
    t.totalCajas +
    " cajas)</div>" +
    (card.invalid.length
      ? '<div style="color:var(--warning)"><strong>Omitidos:</strong> ' +
        card.invalid.length +
        " ítems con código no reconocido (" +
        card.invalid
          .map(function (x) {
            return x.cod;
          })
          .join(", ") +
        ")</div>"
      : "") +
    '<div style="padding-top:8px;border-top:1px solid var(--border);font-weight:700">Total: $' +
    formatMoney(t.finalTotal) +
    " + IVA</div>" +
    "</div>";

  cpShowConfirm(bodyHtml, function () {
    cpTrySubmitFromModal(card);
  });
  cpSetupDeliveryField(card);
}

function cpRenderDeliveryOptions(card) {
  var sel = document.getElementById("cpDeliverySelect");
  var opts = '<option value="">— Elegí una sucursal —</option>';
  (card.deliveryAddresses || []).forEach(function (d, i) {
    opts +=
      '<option value="' + i + '">' + (d.label || "(sin label)") + "</option>";
  });
  opts += '<option value="_new_">+ Agregar nueva sucursal</option>';
  sel.innerHTML = opts;
  sel.disabled = false;
}

function cpSetupDeliveryField(card) {
  var sel = document.getElementById("cpDeliverySelect");
  var fromEx = document.getElementById("cpDeliveryFromExcel");
  var err = document.getElementById("cpDeliveryError");
  var newForm = document.getElementById("cpDeliveryNewForm");
  var newErr = document.getElementById("cpNewSucError");

  err.style.display = "none";
  err.textContent = "";
  newErr.style.display = "none";
  newErr.textContent = "";
  newForm.style.display = "none";
  document.getElementById("cpNewSucLabel").value = card.delivery || "";
  document.getElementById("cpNewSucDir").value = "";
  document.getElementById("cpNewSucZona").value = "";

  if (card.delivery) {
    fromEx.innerHTML =
      'Escrita por el cliente en el cotizador (D9): <strong style="color:var(--text2)">' +
      card.delivery +
      "</strong>";
  } else {
    fromEx.innerHTML = "<em>El cotizador no trae sucursal (D9 vacío).</em>";
  }

  cpRenderDeliveryOptions(card);

  if (
    card.delivery &&
    card.deliveryAddresses &&
    card.deliveryAddresses.length
  ) {
    var deliveryNorm = String(card.delivery).trim().toLowerCase();
    var matchIdx = card.deliveryAddresses.findIndex(function (d) {
      return (
        String(d.label || "")
          .trim()
          .toLowerCase() === deliveryNorm
      );
    });
    if (matchIdx >= 0) sel.value = String(matchIdx);
  }

  sel.onchange = function () {
    if (sel.value === "_new_") {
      newForm.style.display = "flex";
      setTimeout(function () {
        document.getElementById("cpNewSucLabel").focus();
      }, 50);
    } else {
      newForm.style.display = "none";
    }
  };
  document.getElementById("cpNewSucCancel").onclick = function () {
    newForm.style.display = "none";
    sel.value = "";
    newErr.style.display = "none";
  };
  document.getElementById("cpNewSucSave").onclick = function () {
    cpSaveNewSucursal(card);
  };

  setTimeout(function () {
    sel.focus();
  }, 80);
}

async function cpSaveNewSucursal(card) {
  var btn = document.getElementById("cpNewSucSave");
  var newErr = document.getElementById("cpNewSucError");
  var label = document.getElementById("cpNewSucLabel").value.trim();
  var dir = document.getElementById("cpNewSucDir").value.trim();
  var zona = document.getElementById("cpNewSucZona").value.trim();
  newErr.style.display = "none";
  newErr.textContent = "";

  if (!label) {
    newErr.textContent = "Ingresá el nombre / label de la sucursal.";
    newErr.style.display = "block";
    return;
  }
  if (!dir) {
    newErr.textContent = "Ingresá la dirección real de entrega.";
    newErr.style.display = "block";
    return;
  }
  if (!zona) {
    newErr.textContent = "Ingresá la zona expreso.";
    newErr.style.display = "block";
    return;
  }

  var existing = card.deliveryAddresses || [];
  var dupNorm = label.toLowerCase();
  if (
    existing.some(function (d) {
      return (
        String(d.label || "")
          .trim()
          .toLowerCase() === dupNorm
      );
    })
  ) {
    newErr.textContent =
      "Ya existe una sucursal con ese label para este cliente.";
    newErr.style.display = "block";
    return;
  }
  var nextSlot =
    existing.reduce(function (m, d) {
      return Math.max(m, Number(d.slot || 0));
    }, 0) + 1;

  btn.disabled = true;
  btn.textContent = "Guardando...";
  try {
    var payload = {
      customer_id: card.customer.id,
      slot: nextSlot,
      label: label,
      direccion_entrega: dir,
      zona_expreso: zona,
    };
    var r = await sb
      .from("customer_delivery_addresses")
      .insert(payload)
      .select()
      .single();
    if (r.error)
      throw new Error(r.error.message || "Error al insertar sucursal");

    card.deliveryAddresses = existing.concat([r.data]).sort(function (a, b) {
      return Number(a.slot) - Number(b.slot);
    });
    var newIdx = card.deliveryAddresses.findIndex(function (d) {
      return d.slot === r.data.slot;
    });
    cpRenderDeliveryOptions(card);
    var sel = document.getElementById("cpDeliverySelect");
    sel.value = String(newIdx);
    document.getElementById("cpDeliveryNewForm").style.display = "none";
    toast("Sucursal agregada", "success");
  } catch (e) {
    newErr.textContent = "Error: " + (e.message || e);
    newErr.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar sucursal";
  }
}

function cpTrySubmitFromModal(card) {
  var sel = document.getElementById("cpDeliverySelect");
  var err = document.getElementById("cpDeliveryError");
  if (sel.value === "_new_") {
    err.textContent =
      "Completá y guardá la nueva sucursal antes de subir el pedido (o elegí una existente).";
    err.style.display = "block";
    return;
  }
  var idx = parseInt(sel.value, 10);
  if (isNaN(idx) || idx < 0 || idx >= (card.deliveryAddresses || []).length) {
    err.textContent = "Elegí una sucursal antes de subir el pedido.";
    err.style.display = "block";
    sel.focus();
    return;
  }
  var match = card.deliveryAddresses[idx];
  card.finalDelivery = match.label; // usar label exacto de la DB
  card.finalDeliveryDireccion = match.direccion_entrega || "";
  card.finalDeliveryZona = match.zona_expreso || "";
  cpHideConfirm();
  cpCardDoSubmit(card);
}

async function cpCardDoSubmit(card) {
  var sucBtns = card.actionsWrap.querySelectorAll(
    ".cp-suc-btn, .cp-new-suc-save, .cp-new-suc-cancel, .cp-btn-confirm",
  );
  sucBtns.forEach(function (b) {
    b.disabled = true;
  });
  var confirmBtn = card.actionsWrap.querySelector(".cp-btn-confirm");
  if (confirmBtn) confirmBtn.textContent = "Subiendo pedido...";
  cpCardSetStatus(
    card,
    "Subiendo pedido a " + (card.finalDelivery || "—") + "...",
  );

  try {
    var sessionResult = await sb.auth.getSession();
    if (
      sessionResult.error ||
      !sessionResult.data ||
      !sessionResult.data.session
    ) {
      throw new Error("Sesión expirada. Recargá la página.");
    }
    var session = sessionResult.data.session;
    var token = session.access_token;

    var dtoVol = card.isGM ? 0 : Number(card.customer.dto_vol || 0);
    var payDisc = card.isGM ? 0 : Number(card.payment.discount || 0);
    var webDiscount = card.isGM ? 0 : CP_WEB_DISCOUNT;

    // Build items payload
    var itemsPayload = card.parsed
      .map(function (it) {
        var p = it.product;
        // GM: uxb y precio vienen del Excel; normal: del producto Supabase
        var uxb = card.isGM ? Number(it.uxb || 0) : Number(p.uxb || 0);
        var unidades = Number(it.cajas || 0) * uxb;
        var unitYourPrice = card.isGM
          ? Number(it.pricePerUnit || 0)
          : Number(p.list_price || 0) * (1 - dtoVol) * (1 - webDiscount);
        return {
          product_id: p.id,
          cod_art: String(p.cod || "").trim(),
          cod_original: it.cod_original || null,
          cajas: Number(it.cajas || 0),
          uxb: uxb,
          unidades: unidades,
          unit_price: unitYourPrice,
          list_price: card.isGM ? Number(it.pricePerUnit || 0) : Number(p.list_price || 0),
          description: String(p.description || ""),
          is_loke: false,
        };
      })
      .sort(function (a, b) {
        return String(a.cod_art || "").localeCompare(
          String(b.cod_art || ""),
          undefined,
          { numeric: true },
        );
      });

    var subtotal = 0;
    itemsPayload.forEach(function (it) {
      subtotal += Number(it.unit_price || 0) * Number(it.unidades || 0);
    });
    var finalTotal = subtotal * (1 - payDisc);

    // RPC
    var rpcItems = itemsPayload.map(function (it) {
      return {
        product_id: it.product_id,
        cajas: it.cajas,
        uxb: it.uxb,
        is_loke: false,
      };
    });

    var rpcResult = await cpWithTimeout(
      sb.rpc("submit_order_fast", {
        p_auth_user_id: session.user.id,
        p_customer_id: card.customer.id,
        p_status: "pendiente",
        p_payment_method: card.payment.text,
        p_payment_discount: payDisc,
        p_web_discount: webDiscount,
        p_subtotal: subtotal,
        p_total: finalTotal,
        p_items: rpcItems,
      }),
      15000,
      "submit_order_fast",
    );

    if (rpcResult.error || !rpcResult.data) {
      throw new Error(
        (rpcResult.error &&
          (rpcResult.error.message || rpcResult.error.details)) ||
          "RPC falló",
      );
    }
    var orderId = rpcResult.data;

    // Sheets payload (usar label exacto de la DB, no lo tipeado)
    var sheetsPayload = {
      order_number: String(orderId || "").trim(),
      cod_cliente: String(card.customer.cod_cliente || "").trim(),
      vend: String(card.customer.vend || "").trim(),
      condicion_pago: card.payment.text,
      condicion_pago_code: card.payment.code,
      sucursal_entrega: card.finalDelivery || "",
      cliente_nuevo: "",
      is_promo: false,
      extra_discount: 0,
      deuda: Number(card.customer.debt || 0),
      payment_term: card.customer.payment_term == null ? null : Number(card.customer.payment_term),
      credit_limit: card.customer.credit_limit == null ? null : Number(card.customer.credit_limit),
      source: "Cotizador",
      items: itemsPayload.map(function (it) {
        return {
          cod_art: it.cod_art,
          cod_original: it.cod_original || null,
          cajas: it.cajas,
          uxb: it.uxb,
        };
      }),
    };

    // Guardar payload para retry + marcar origen.
    // placed_by_auth_user_id es lo que alimenta el módulo "Origen de pedidos":
    // sin él la vista v_orders_origen clasifica el pedido como "desconocido".
    // El Cotizador era la única vía de carga que no lo seteaba.
    sb.from("orders")
      .update({
        sheets_payload: sheetsPayload,
        is_promo: false,
        extra_discount: 0,
        placed_by_auth_user_id: session.user.id,
      })
      .eq("id", orderId)
      .then(function () {});

    // Enviar a sheets-proxy con retry (background)
    cpSendToSheetsWithRetry(sheetsPayload, token, 3)
      .then(function () {
        sb.from("orders")
          .update({ sheets_sent: true })
          .eq("id", orderId)
          .then(function () {});
      })
      .catch(function (e) {
        console.warn("cp sheets error (order " + orderId + "):", e);
      });

    // Entregas-sheet (background) — dirección y zona reales de la sucursal elegida
    var entregasPayload = {
      order_number: orderId,
      fecha: new Date().toLocaleDateString("es-AR"),
      cod_cliente: card.customer.cod_cliente,
      cliente: card.customer.business_name,
      vendedor: card.customer.vend || "",
      direccion_entrega:
        card.finalDeliveryDireccion || card.finalDelivery || "",
      barrio_entrega: card.finalDeliveryZona || "",
      empresa: "LK",
      is_promo: false,
      extra_discount: 0,
      items: itemsPayload.map(function (it) {
        return {
          cod_art: it.cod_art,
          description: it.description || "",
          cajas: it.cajas,
          uxb: it.uxb,
        };
      }),
    };
    cpSendToEntregas(entregasPayload, token);

    card.submitted = true;
    card.orderId = orderId;
    cpCardRenderActions(card);
    cpCardSetStatus(card, "Pedido " + orderId + " subido.", "ok");
    toast(
      "Pedido " + orderId + " subido (Cotizador " + (card.idx + 1) + ")",
      "success",
    );
  } catch (e) {
    console.error("cp submit error:", e);
    cpCardSetStatus(card, "Error: " + (e.message || String(e)), "err");
    toast("Error subiendo pedido: " + (e.message || e), "error");
    sucBtns.forEach(function (b) {
      b.disabled = false;
    });
    if (confirmBtn) {
      var addrsR = card.deliveryAddresses || [];
      var selR = card.selectedDeliveryIdx;
      var labelR = selR != null && addrsR[selR] ? addrsR[selR].label : "";
      confirmBtn.textContent = labelR
        ? "Confirmar envío a " + labelR
        : "Elegí sucursal";
    }
  }
}

// =====================================================
// ---- REPORTE DEUDA (cli_fichavto) --------------------
// =====================================================
var deudaParsed = [];
var deudaDbAll = [];

// Normaliza header: strip diacritics, upper, trim
function _normHeader(k) {
  return String(k || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

function parseDeudaSheet(sheet) {
  // Reporte cli_fichavto. Estructura real:
  //   R1:  headers detalle (Vto., Emisión, Días, ..., Pendiente=col11, Acumulado=col12)
  //   R2:  [1]["Division Unica"][vacio]... (encabezado de división, skip)
  //   Header cliente: [cod_num][razon_str][direccion_str][localidad_str][tel_str][vacio]...
  //   Factura:        [num_doc][num_doc][dias_num][div][tipo][...][pendiente_num en col11][acum_num en col12]
  //   Subtotal cliente: [acum_num en col0][vacios...]
  //   Cierre: ["Division Unica" en col0][total_num] / ["Total General" en col0][total_num]
  var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  var out = [];
  var current = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || [];
    var c0 = r[0],
      c1 = r[1],
      c2 = r[2],
      c11 = r[11];

    // Cierre del reporte
    if (typeof c0 === "string") {
      var s = c0.trim();
      if (s === "Total General" || s === "Division Unica") {
        if (current) {
          out.push(current);
          current = null;
        }
        continue;
      }
    }

    var c0Num = typeof c0 === "number";
    var c1Num = typeof c1 === "number";
    var c1Str = typeof c1 === "string" && c1.trim().length > 0;
    var c2Str = typeof c2 === "string" && c2.trim().length > 0;
    var c11Num = typeof c11 === "number";

    // Header de cliente: cod (string numerica o number) + razon string + direccion string non-empty
    var c0AsCod = null;
    if (c0Num) c0AsCod = String(c0);
    else if (typeof c0 === "string" && /^\d+$/.test(c0.trim()))
      c0AsCod = c0.trim();
    if (c0AsCod && c1Str && c2Str) {
      if (current) out.push(current);
      current = { cod: c0AsCod, razon: c1.trim(), total: 0 };
      continue;
    }

    // Factura: col0 num, col1 num (num doc repetido), col11 num (Pendiente)
    if (current && c0Num && c1Num && c11Num) {
      current.total += c11;
      continue;
    }

    // Subtotal cliente: col0 num, col1 vacio → cierra el bloque
    if (current && c0Num && (c1 === "" || c1 === null || c1 === undefined)) {
      if (current.total === 0) current.total = c0;
      out.push(current);
      current = null;
      continue;
    }
  }
  if (current) out.push(current);
  return out
    .filter(function (c) {
      return c.total !== 0;
    })
    .map(function (c) {
      return {
        cod: c.cod,
        razon: c.razon,
        total: Math.round(c.total * 100) / 100,
      };
    });
}

function renderDeudaPreview() {
  var preview = document.getElementById("deudaPreview");
  var body = document.getElementById("deudaPreviewBody");
  var count = document.getElementById("deudaPreviewCount");
  if (!deudaParsed.length) {
    preview.style.display = "none";
    body.innerHTML = "";
    return;
  }
  preview.style.display = "block";
  count.textContent = deudaParsed.length + " clientes con deuda";
  body.innerHTML = deudaParsed
    .map(function (c) {
      return (
        "<tr><td>" +
        c.cod +
        "</td><td>" +
        escapeHtml(c.razon) +
        '</td><td style="text-align:right">' +
        fmtMoney(c.total) +
        "</td></tr>"
      );
    })
    .join("");
}

function fmtMoney(n) {
  var v = Number(n || 0);
  return (
    "$ " +
    v.toLocaleString("es-AR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, function (ch) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch];
  });
}

async function _runDeudaUpload() {
  if (!deudaParsed.length) return;
  var btn = document.getElementById("deudaUploadBtn");
  var fi = document.getElementById("deudaFileInput");
  if (btn) btn.disabled = true;
  showUploadProgress("deuda", deudaParsed.length);
  try {
    var resetRes = await sb
      .from(TABLE_CUSTOMERS)
      .update({ debt: 0 })
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (resetRes.error) throw new Error("Reset: " + resetRes.error.message);
    var okCount = 0,
      skipCount = 0;
    for (var i = 0; i < deudaParsed.length; i++) {
      var row = deudaParsed[i];
      updateUploadProgress("deuda", i + 1, deudaParsed.length, "Procesando cliente: " + row.cod);
      if (row.total < 0) {
        console.warn("cod " + row.cod + ": deuda negativa, no cargada (plata a favor)");
        skipCount++;
        continue;
      }
      var upd = await sb
        .from(TABLE_CUSTOMERS)
        .update({ debt: row.total })
        .eq("cod_cliente", row.cod);
      if (upd.error) {
        console.warn("cod " + row.cod + ": " + upd.error.message);
        skipCount++;
      } else okCount++;
    }
    var msg = "Deuda: " +
        okCount +
        " clientes actualizados" +
        (skipCount ? " (" + skipCount + " sin match)" : "");
    updateUploadProgress("deuda", deudaParsed.length, deudaParsed.length, msg);
    toast(msg);
    setTimeout(function() { hideUploadProgress("deuda"); }, 2000);
    if (typeof setLastImportDate === "function") setLastImportDate("deuda");
    deudaParsed = [];
    if (fi) fi.value = "";
    if (typeof loadCondicionesDb === "function") loadCondicionesDb();
  } catch (err) {
    var errMsg = "Error Deuda: " + err.message;
    updateUploadProgress("deuda", deudaParsed.length, deudaParsed.length, errMsg);
    toast(errMsg, "error");
    setTimeout(function() { hideUploadProgress("deuda"); }, 3000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleDeudaFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var wb = XLSX.read(e.target.result, { type: "array" });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) {
        toast("No se encontro ninguna hoja en el archivo", "error");
        return;
      }
      deudaParsed = parseDeudaSheet(sheet);
      if (!deudaParsed.length) {
        toast("No se detectaron clientes con deuda en el archivo", "warning");
        return;
      }
      _runDeudaUpload();
    } catch (err) {
      console.error(err);
      toast("Error leyendo archivo: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

(function wireDeudaUI() {
  var dz = document.getElementById("deudaDropZone");
  var fi = document.getElementById("deudaFileInput");
  if (!dz || !fi) return;

  fi.addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (f) handleDeudaFile(f);
  });
  dz.addEventListener("dragover", function (e) {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", function () {
    dz.classList.remove("drag");
  });
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    dz.classList.remove("drag");
    var f = e.dataTransfer.files[0];
    if (f) handleDeudaFile(f);
  });
})();

// Deprecated: use loadCondicionesDb() instead
// async function loadDeudaDb() { ... }

// =====================================================
// ---- LIMITE CREDITO (LC) --------------------
// =====================================================
var lcParsed = [];
var lcDbAll = [];

function parseLcSheet(sheet) {
  // Acepta headers con/sin tildes: "COD"/"Código", "RAZON SOCIAL"/"Razón Social",
  // "LIMITE"/"Lim.Crédito"/"Limite Credito"/"LC". Acepta valores >= 0.
  var rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  var out = [];
  rows.forEach(function (r) {
    var cod = "",
      razon = "",
      limit = null;
    Object.keys(r).forEach(function (key) {
      var nk = _normHeader(key);
      if (nk === "COD" || nk === "CODIGO") {
        cod = String(r[key] || "").trim();
      } else if (
        nk === "RAZON SOCIAL" ||
        nk === "RAZON_SOCIAL" ||
        nk === "RAZON"
      ) {
        razon = String(r[key] || "").trim();
      } else if (
        nk.indexOf("LIM") !== -1 ||
        nk.indexOf("CREDITO") !== -1 ||
        nk === "LC"
      ) {
        var val = parseFloat(r[key]);
        if (!isNaN(val) && val >= 0) limit = val;
      }
    });
    if (cod && razon && limit !== null) {
      out.push({ cod: cod, razon: razon, limite: limit });
    }
  });
  return out;
}

function renderLcPreview() {
  var preview = document.getElementById("lcPreview");
  var body = document.getElementById("lcPreviewBody");
  var count = document.getElementById("lcPreviewCount");
  if (!lcParsed.length) {
    preview.style.display = "none";
    body.innerHTML = "";
    return;
  }
  preview.style.display = "block";
  count.textContent = lcParsed.length + " registros";
  body.innerHTML = lcParsed
    .map(function (c) {
      return (
        "<tr><td>" +
        c.cod +
        "</td><td>" +
        escapeHtml(c.razon) +
        '</td><td style="text-align:right">' +
        fmtMoney(c.limite) +
        "</td></tr>"
      );
    })
    .join("");
}

async function _runLcUpload() {
  if (!lcParsed.length) return;
  var btn = document.getElementById("lcUploadBtn");
  var fi = document.getElementById("lcFileInput");
  if (btn) btn.disabled = true;
  showUploadProgress("lc", lcParsed.length);
  try {
    var resetRes = await sb
      .from(TABLE_CUSTOMERS)
      .update({ credit_limit: null })
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (resetRes.error) throw new Error("Reset: " + resetRes.error.message);
    var okCount = 0,
      skipCount = 0;
    for (var i = 0; i < lcParsed.length; i++) {
      var row = lcParsed[i];
      updateUploadProgress("lc", i + 1, lcParsed.length, "Procesando cliente: " + row.cod);
      var upd = await sb
        .from(TABLE_CUSTOMERS)
        .update({ credit_limit: row.limite })
        .eq("cod_cliente", row.cod);
      if (upd.error) {
        console.warn("cod " + row.cod + ": " + upd.error.message);
        skipCount++;
      } else okCount++;
    }
    var msg = "Lim. Crédito: " +
        okCount +
        " clientes actualizados" +
        (skipCount ? " (" + skipCount + " sin match)" : "");
    updateUploadProgress("lc", lcParsed.length, lcParsed.length, msg);
    toast(msg);
    setTimeout(function() { hideUploadProgress("lc"); }, 2000);
    if (typeof setLastImportDate === "function") setLastImportDate("lc");
    lcParsed = [];
    if (fi) fi.value = "";
    if (typeof loadCondicionesDb === "function") loadCondicionesDb();
  } catch (err) {
    var errMsg = "Error LC: " + err.message;
    updateUploadProgress("lc", lcParsed.length, lcParsed.length, errMsg);
    toast(errMsg, "error");
    setTimeout(function() { hideUploadProgress("lc"); }, 3000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleLcFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var wb = XLSX.read(e.target.result, { type: "array" });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) {
        toast("No se encontro ninguna hoja en el archivo", "error");
        return;
      }
      lcParsed = parseLcSheet(sheet);
      if (!lcParsed.length) {
        toast("No se detectaron limites de credito en el archivo", "warning");
        return;
      }
      _runLcUpload();
    } catch (err) {
      console.error(err);
      toast("Error leyendo archivo: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

(function wireLcUI() {
  var dz = document.getElementById("lcDropZone");
  var fi = document.getElementById("lcFileInput");
  if (!dz || !fi) return;

  fi.addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (f) handleLcFile(f);
  });
  dz.addEventListener("dragover", function (e) {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", function () {
    dz.classList.remove("drag");
  });
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    dz.classList.remove("drag");
    var f = e.dataTransfer.files[0];
    if (f) handleLcFile(f);
  });
})();

// =====================================================
// ---- PLAZO PAGO (PP) --------------------
// =====================================================
var ppParsed = [];
var ppDbAll = [];

function parsePpSheet(sheet) {
  // Headers: "COD"/"Código", "RAZON SOCIAL"/"Razón Social", y plazo:
  // prioriza "Plazo Real de Venta" > otra col PLAZO/DIAS > "Plazo Real de Cobro".
  // Devuelve plazo como entero (Math.round).
  var rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  var out = [];
  rows.forEach(function (r) {
    var cod = "",
      razon = "";
    var ventaKey = null,
      cobroKey = null,
      otherKey = null;
    Object.keys(r).forEach(function (key) {
      var nk = _normHeader(key);
      if (nk === "COD" || nk === "CODIGO") {
        cod = String(r[key] || "").trim();
      } else if (
        nk === "RAZON SOCIAL" ||
        nk === "RAZON_SOCIAL" ||
        nk === "RAZON"
      ) {
        razon = String(r[key] || "").trim();
      } else if (nk.indexOf("PLAZO") !== -1 && nk.indexOf("VENTA") !== -1) {
        ventaKey = key;
      } else if (nk.indexOf("PLAZO") !== -1 && nk.indexOf("COBRO") !== -1) {
        cobroKey = key;
      } else if (
        nk.indexOf("PLAZO") !== -1 ||
        nk === "PP" ||
        nk.indexOf("DIAS") !== -1
      ) {
        otherKey = key;
      }
    });

    var src = ventaKey || otherKey || cobroKey;
    var plazo = null;
    if (src) {
      var val = parseFloat(r[src]);
      if (!isNaN(val) && val > 0) plazo = Math.round(val);
    }

    if (cod && razon && plazo !== null) {
      out.push({ cod: cod, razon: razon, plazo: plazo });
    }
  });
  return out;
}

function renderPpPreview() {
  var preview = document.getElementById("ppPreview");
  var body = document.getElementById("ppPreviewBody");
  var count = document.getElementById("ppPreviewCount");
  if (!ppParsed.length) {
    preview.style.display = "none";
    body.innerHTML = "";
    return;
  }
  preview.style.display = "block";
  count.textContent = ppParsed.length + " registros";
  body.innerHTML = ppParsed
    .map(function (c) {
      return (
        "<tr><td>" +
        c.cod +
        "</td><td>" +
        escapeHtml(c.razon) +
        '</td><td style="text-align:right">' +
        c.plazo +
        "</td></tr>"
      );
    })
    .join("");
}

async function _runPpUpload() {
  if (!ppParsed.length) return;
  var btn = document.getElementById("ppUploadBtn");
  var fi = document.getElementById("ppFileInput");
  if (btn) btn.disabled = true;
  showUploadProgress("pp", ppParsed.length);
  try {
    var resetRes = await sb
      .from(TABLE_CUSTOMERS)
      .update({ payment_term: null })
      .neq("id", "00000000-0000-0000-0000-000000000000");
    if (resetRes.error) throw new Error("Reset: " + resetRes.error.message);
    var okCount = 0,
      skipCount = 0;
    for (var i = 0; i < ppParsed.length; i++) {
      var row = ppParsed[i];
      updateUploadProgress("pp", i + 1, ppParsed.length, "Procesando cliente: " + row.cod);
      var upd = await sb
        .from(TABLE_CUSTOMERS)
        .update({ payment_term: row.plazo })
        .eq("cod_cliente", row.cod);
      if (upd.error) {
        console.warn("cod " + row.cod + ": " + upd.error.message);
        skipCount++;
      } else okCount++;
    }
    var msg = "Plazo Pago: " +
        okCount +
        " clientes actualizados" +
        (skipCount ? " (" + skipCount + " sin match)" : "");
    updateUploadProgress("pp", ppParsed.length, ppParsed.length, msg);
    toast(msg);
    setTimeout(function() { hideUploadProgress("pp"); }, 2000);
    if (typeof setLastImportDate === "function") setLastImportDate("pp");
    ppParsed = [];
    if (fi) fi.value = "";
    if (typeof loadCondicionesDb === "function") loadCondicionesDb();
  } catch (err) {
    var errMsg = "Error PP: " + err.message;
    updateUploadProgress("pp", ppParsed.length, ppParsed.length, errMsg);
    toast(errMsg, "error");
    setTimeout(function() { hideUploadProgress("pp"); }, 3000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handlePpFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var wb = XLSX.read(e.target.result, { type: "array" });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) {
        toast("No se encontro ninguna hoja en el archivo", "error");
        return;
      }
      ppParsed = parsePpSheet(sheet);
      if (!ppParsed.length) {
        toast("No se detectaron plazos de pago en el archivo", "warning");
        return;
      }
      _runPpUpload();
    } catch (err) {
      console.error(err);
      toast("Error leyendo archivo: " + err.message, "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

(function wirePpUI() {
  var dz = document.getElementById("ppDropZone");
  var fi = document.getElementById("ppFileInput");
  if (!dz || !fi) return;

  fi.addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (f) handlePpFile(f);
  });
  dz.addEventListener("dragover", function (e) {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", function () {
    dz.classList.remove("drag");
  });
  dz.addEventListener("drop", function (e) {
    e.preventDefault();
    dz.classList.remove("drag");
    var f = e.dataTransfer.files[0];
    if (f) handlePpFile(f);
  });
})();

// =====================================================
// ---- VISTA UNIFICADA DB: LC + PP + DEUDA
// =====================================================
var condicionesDbAll = [];

async function loadCondicionesDb() {
  var body = document.getElementById("condicionesDbBody");
  var count = document.getElementById("condicionesDbCount");
  body.innerHTML =
    '<tr><td colspan="5"><span class="spinner"></span> Cargando...</td></tr>';
  try {
    var data = await sbSelectAll(TABLE_CUSTOMERS, "order=cod_cliente.asc");
    condicionesDbAll = data || [];
    count.textContent = condicionesDbAll.length + " clientes";
    renderCondicionesDb();
  } catch (err) {
    body.innerHTML =
      '<tr><td colspan="5">Error: ' + escapeHtml(err.message) + "</td></tr>";
  }
}

function renderCondicionesDb() {
  var body = document.getElementById("condicionesDbBody");
  var q = (document.getElementById("condicionesFilter").value || "")
    .trim()
    .toLowerCase();
  var filtered = q
    ? condicionesDbAll.filter(function (c) {
        return (
          String(c.cod_cliente || "")
            .toLowerCase()
            .includes(q) ||
          String(c.business_name || "")
            .toLowerCase()
            .includes(q)
        );
      })
    : condicionesDbAll;
  if (!filtered.length) {
    body.innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px">Sin resultados</td></tr>';
    return;
  }
  body.innerHTML = filtered
    .map(function (c) {
      return (
        "<tr>" +
        "<td>" + (c.cod_cliente || "-") + "</td>" +
        "<td>" + escapeHtml(c.business_name || "-") + "</td>" +
        '<td style="text-align:right">' + (c.credit_limit ? fmtMoney(c.credit_limit) : "-") + "</td>" +
        '<td style="text-align:right">' + (c.payment_term ? c.payment_term + " días" : "-") + "</td>" +
        '<td style="text-align:right;font-weight:600">' + fmtMoney(c.debt || 0) + "</td>" +
        "</tr>"
      );
    })
    .join("");
}

(function wireCondicionesUI() {
  var filterInput = document.getElementById("condicionesFilter");
  if (filterInput) {
    filterInput.addEventListener("input", renderCondicionesDb);
  }

  var refreshBtn = document.getElementById("condicionesRefreshDb");
  if (refreshBtn) refreshBtn.addEventListener("click", loadCondicionesDb);

  var resetBtn = document.getElementById("condicionesResetAllBtn");
  if (resetBtn)
    resetBtn.addEventListener("click", async function () {
      if (!confirm("¿RESETEAR Límite Crédito, Plazo Pago y Deuda de TODOS los clientes?")) return;
      this.disabled = true;
      try {
        var res = await sb
          .from(TABLE_CUSTOMERS)
          .update({ credit_limit: null, payment_term: null, debt: 0 })
          .neq("id", "00000000-0000-0000-0000-000000000000");
        if (res.error) throw new Error(res.error.message);
        toast("Condiciones reseteadas para todos los clientes");
        loadCondicionesDb();
      } catch (err) {
        toast("Error: " + err.message, "error");
      } finally {
        this.disabled = false;
      }
    });
})();

// ---- INIT ----
document.addEventListener("DOMContentLoaded", async function () {
  var ok = await checkAuth();
  if (ok) {
    watchSession();
    loadClientes();
    if (isPPPAdmin) loadTrackingDb();
    if (isPPPAdmin) loadCondicionesDb();
    cpLoadProducts();
    cpLoadItemGroups();
    cpInitCards();

    // Auto-navigate to tab from URL hash (e.g. #estado-pedidos)
    var hash = location.hash.replace("#", "");
    if (
      hash &&
      !((hash === "estado-pedidos" || hash === "reporte-deuda") && !isPPPAdmin)
    ) {
      var targetBtn = document.querySelector(
        '.nav-item[data-page="' + hash + '"]',
      );
      if (targetBtn) targetBtn.click();
    }

    // Refrescar badge de sucursales pendientes al inicio
    if (typeof actualizarBadgeSucursalesPend === "function") {
      actualizarBadgeSucursalesPend();
    }
  }
});

// =============================
// SUCURSALES PENDIENTES ISIS
// =============================
async function actualizarBadgeSucursalesPend() {
  try {
    var r = await sb
      .from("customer_delivery_addresses")
      .select("slot", { count: "exact", head: true })
      .eq("pending_isis", true);
    var n = r.count || 0;
    var badge = document.getElementById("badgeSucursalesPend");
    if (!badge) return;
    if (n > 0) {
      badge.textContent = String(n);
      badge.style.display = "inline-block";
    } else {
      badge.textContent = "";
      badge.style.display = "none";
    }
  } catch (e) {
    console.error("actualizarBadgeSucursalesPend error", e);
  }
}

async function cargarSucursalesPendientes() {
  var listEl = document.getElementById("sucursalesPendList");
  var statusEl = document.getElementById("sucursalesPendStatus");
  if (!listEl) return;

  if (statusEl) statusEl.textContent = "Cargando…";
  listEl.innerHTML = "";

  try {
    var r = await sb
      .from("customer_delivery_addresses")
      .select(
        "slot,label,calle,altura,cp,localidad,provincia,zona_expreso,nombre_expreso,direccion_expreso,observaciones,direccion_entrega,created_at,customer_id,customers!inner(cod_cliente,business_name)",
      )
      .eq("pending_isis", true)
      .order("created_at", { ascending: true });

    if (r.error) throw new Error(r.error.message || "Error al consultar.");

    var rows = r.data || [];
    if (!rows.length) {
      if (statusEl)
        statusEl.textContent = "No hay sucursales pendientes de cargar en ISIS.";
      actualizarBadgeSucursalesPend();
      return;
    }

    if (statusEl)
      statusEl.textContent =
        rows.length +
        " sucursal" +
        (rows.length === 1 ? "" : "es") +
        " pendiente" +
        (rows.length === 1 ? "" : "s") +
        ".";

    var html = rows
      .map(function (row) {
        var c = row.customers || {};
        var cod = c.cod_cliente || "";
        var razon = c.business_name || "";
        var nombre = row.label || "";
        var calle = row.calle || "";
        var altura = row.altura || "";
        var cp = row.cp || "";
        var localidad = row.localidad || "";
        var provincia = row.provincia || "";
        var pais = "ARG";
        var expreso = row.nombre_expreso || row.zona_expreso || "";
        var dirExpreso = row.direccion_expreso || "";
        var obs = row.observaciones || "";
        var fecha = row.created_at
          ? new Date(row.created_at).toLocaleString("es-AR")
          : "";

        function fld(label, value) {
          var safeVal = String(value || "").replace(/"/g, "&quot;");
          var btn =
            '<button type="button" class="btn-copiar-isis" data-copy="' +
            safeVal +
            '" onclick="copiarTextoISIS(this)" style="margin-left:8px; padding:4px 10px; background:#f3f3f3; border:1px solid #d0d0d0; border-radius:6px; cursor:pointer; font-size:12px;">📋 Copiar</button>';
          return (
            '<div style="display:flex; align-items:center; padding:6px 0; border-bottom:1px dashed #eee;">' +
            '<div style="width:110px; font-weight:600; color:#555; font-size:13px;">' +
            label +
            "</div>" +
            '<div style="flex:1; font-size:13px;">' +
            (value || "<em style=\"color:#999\">(vacío)</em>") +
            "</div>" +
            btn +
            "</div>"
          );
        }

        return (
          '<div class="card" style="margin-bottom:14px; padding:14px;">' +
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">' +
          '<div><strong>Cliente: ' +
          razon +
          " (cod. " +
          cod +
          ")</strong>" +
          '<div style="font-size:12px; color:#888;">Cargada el ' +
          fecha +
          " — slot " +
          row.slot +
          "</div></div>" +
          // customer_id puede ser UUID (string) o int — comillar siempre como string
          // para que el onclick inline no rompa el parser JS si tiene guiones.
          '<button type="button" onclick="marcarSucursalCargada(\'' +
          String(row.customer_id).replace(/'/g, "\\'") +
          "'," +
          row.slot +
          ')" style="padding:8px 14px; background:#2c7a2c; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:13px;">✓ Marcar cargada en ISIS</button>' +
          "</div>" +
          fld("Nombre", nombre) +
          fld("Calle", calle) +
          fld("Nro", altura) +
          fld("C.P.", cp) +
          fld("Localidad", localidad) +
          fld("Provincia", provincia) +
          fld("País", pais) +
          fld("Expreso", expreso) +
          fld("Dir. Expreso", dirExpreso) +
          (obs
            ? '<div style="margin-top:10px; padding:10px; background:#fff8e0; border:1px solid #f0d28a; border-radius:6px; font-size:13px;"><strong>Observaciones del cliente:</strong><br>' +
              String(obs).replace(/</g, "&lt;").replace(/\n/g, "<br>") +
              "</div>"
            : "") +
          "</div>"
        );
      })
      .join("");

    listEl.innerHTML = html;
    actualizarBadgeSucursalesPend();
  } catch (e) {
    console.error("cargarSucursalesPendientes error", e);
    if (statusEl) statusEl.textContent = "Error al cargar: " + (e.message || e);
  }
}

function copiarTextoISIS(btn) {
  var txt = btn.getAttribute("data-copy") || "";
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(
      function () {
        var orig = btn.innerHTML;
        btn.innerHTML = "✓ Copiado";
        btn.style.background = "#dff6df";
        btn.style.borderColor = "#2c7a2c";
        setTimeout(function () {
          btn.innerHTML = orig;
          btn.style.background = "#f3f3f3";
          btn.style.borderColor = "#d0d0d0";
        }, 1500);
      },
      function (err) {
        console.error("copiarTextoISIS error", err);
        alert("No se pudo copiar al portapapeles.");
      },
    );
  } else {
    // Fallback navegadores antiguos
    var ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
  }
}

async function marcarSucursalCargada(customerId, slot) {
  if (!customerId || slot == null) return;
  if (!confirm("¿Marcar esta sucursal como cargada en ISIS?")) return;
  try {
    var r = await sb
      .from("customer_delivery_addresses")
      .update({ pending_isis: false })
      .eq("customer_id", customerId)
      .eq("slot", slot);
    if (r.error) throw new Error(r.error.message || "Error al actualizar.");
    cargarSucursalesPendientes();
  } catch (e) {
    console.error("marcarSucursalCargada error", e);
    alert("Error: " + (e.message || e));
  }
}

/* =========================================================
   ORIGEN DE PEDIDOS
   - Cuenta pedidos por origen_pedido (v_orders_origen) con filtro opcional
     de rango de fechas (sobre created_at).
   ========================================================= */
async function cargarOrigenPedidos() {
  var statusEl = document.getElementById("origenPedidosStatus");
  var els = {
    cliente: document.getElementById("origenPedidosCliente"),
    vendedor: document.getElementById("origenPedidosVendedor"),
    admin: document.getElementById("origenPedidosAdmin"),
    desconocido: document.getElementById("origenPedidosDesconocido"),
    previo_tracking: document.getElementById("origenPedidosPrevioTracking"),
  };
  if (!els.cliente) return;

  var desdeVal = document.getElementById("origenPedidosDesde")?.value || "";
  var hastaVal = document.getElementById("origenPedidosHasta")?.value || "";

  if (statusEl) statusEl.textContent = "Cargando…";

  try {
    // Una sola llamada: la RPC devuelve una fila por (origen, herramienta).
    // Antes eran N consultas .eq() y el front tenía que conocer de antemano
    // las herramientas posibles; así descubre las que realmente existen.
    var resp = await sb.rpc("get_origen_pedidos_resumen", {
      p_desde: desdeVal || null,
      p_hasta: hastaVal || null,
    });
    if (resp.error) throw resp.error;
    var filas = resp.data || [];

    var keys = ["cliente", "vendedor", "admin", "desconocido", "previo_tracking"];
    var counts = {};
    keys.forEach(function (k) { counts[k] = 0; });
    filas.forEach(function (f) {
      var k = f.origen_pedido;
      counts[k] = (counts[k] || 0) + Number(f.pedidos || 0);
    });

    els.cliente.textContent = counts.cliente;
    els.vendedor.textContent = counts.vendedor;
    els.admin.textContent = counts.admin;
    els.desconocido.textContent = counts.desconocido;
    if (els.previo_tracking) {
      els.previo_tracking.textContent = counts.previo_tracking;
    }

    _renderOrigenPedidosDetalle(filas, keys);

    var total = 0;
    Object.keys(counts).forEach(function (k) { total += counts[k]; });
    var inferidos = 0;
    var dePrueba = 0;
    filas.forEach(function (f) {
      inferidos += Number(f.inferidos || 0);
      dePrueba += Number(f.de_prueba || 0);
    });

    var rangoTxt =
      desdeVal || hastaVal
        ? " (" + (desdeVal || "…") + " a " + (hastaVal || "…") + ")"
        : "";
    // El conteo de inferidos es la señal de salud del tracking: si sube, alguna
    // vía de carga dejó de guardar placed_by_auth_user_id y se está atribuyendo
    // por el respaldo de auth_user_id.
    var inferidosTxt = inferidos
      ? " " + inferidos + " atribuidos por respaldo (sin registro directo del origen)."
      : "";
    var pruebaTxt = dePrueba
      ? " " + dePrueba + " son de clientes internos (prueba): " +
        (total - dePrueba) + " reales."
      : "";
    if (statusEl) {
      statusEl.textContent =
        "Total: " + total + " pedidos." + rangoTxt + pruebaTxt + inferidosTxt;
    }
  } catch (e) {
    console.error("cargarOrigenPedidos error:", e);
    if (statusEl) {
      statusEl.textContent =
        "No se pudo cargar (¿corriste add_order_source_tracking.sql en Supabase?): " +
        (e.message || String(e));
    }
  }
}

// Desglose por herramienta dentro de cada origen. Agrupa visualmente: el
// nombre del origen se escribe solo en su primera fila.
// Las etiquetas van adentro y no en un `var` de módulo: las funciones se
// hoistean, pero si algo falla antes en el script las asignaciones `var` no
// llegan a correr y quedarían undefined acá.
function _renderOrigenPedidosDetalle(filas, keys) {
  var labels = {
    cliente: "Cliente",
    vendedor: "Vendedor",
    admin: "Admin",
    desconocido: "Desconocido",
    previo_tracking: "Previo al tracking",
  };
  var tbody = document.querySelector("#origenPedidosDetalleTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!filas.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="est-empty">Sin pedidos en el período.</td></tr>';
    return;
  }

  keys.forEach(function (k) {
    var delOrigen = filas.filter(function (f) { return f.origen_pedido === k; });
    if (!delOrigen.length) return;

    delOrigen.forEach(function (f, idx) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td style="font-weight:600">' +
        (idx === 0 ? escHtml(labels[k] || k) : "") +
        "</td>" +
        "<td>" + escHtml(f.herramienta || "—") +
        (Number(f.inferidos || 0)
          ? ' <span style="color:#e67e22; font-size:11px" title="Atribuidos por el respaldo de auth_user_id, porque no registraron placed_by_auth_user_id">· ' +
            f.inferidos + " inferidos</span>"
          : "") +
        "</td>" +
        '<td class="est-days">' + Number(f.pedidos || 0) + "</td>" +
        // Los de prueba están incluidos en la columna Pedidos; se muestran al
        // lado para poder descontarlos de un vistazo.
        '<td class="est-days">' +
        (Number(f.de_prueba || 0)
          ? '<span style="color:#e67e22; font-weight:700">' + f.de_prueba + "</span>"
          : '<span style="color:#94a3b8">—</span>') +
        "</td>";
      tbody.appendChild(tr);
    });
  });
}

/* =========================================================
   USO DE MÓDULOS
   - cart_add_events: clics de "agregar" por módulo (source)
   - v_order_items_source: líneas que terminaron en pedido confirmado
   - novedades_impressions: veces que se mostró el carrusel de Novedades
   ========================================================= */
var USO_MODULOS_SOURCES = [
  { key: "catalogo", label: "Catálogo normal" },
  { key: "novedades", label: "Novedades (carrusel)" },
  { key: "surtido_faltante", label: '"No te falta esto de tu surtido"' },
  { key: "upsell_popup", label: "Popup upsell (antes de confirmar)" },
  { key: "loke", label: "Línea Loke" },
  { key: "sugerencia_vendedor", label: "Sugerir productos (vendedor)" },
  { key: "sugerencias", label: "Página Sugerencias (IA)" },
  { key: "historial", label: 'Historial ("Volver a pedir")' },
];

// Fecha local en formato YYYY-MM-DD. A propósito NO usa toISOString(): eso
// convierte a UTC, y en Argentina (UTC-3) después de las 21:00 devolvería el
// día siguiente, así que el "Hasta" quedaría un día adelantado.
function _fechaLocalISO(d) {
  var mes = String(d.getMonth() + 1);
  var dia = String(d.getDate());
  if (mes.length < 2) mes = "0" + mes;
  if (dia.length < 2) dia = "0" + dia;
  return d.getFullYear() + "-" + mes + "-" + dia;
}

// Deja el filtro en el mes corriente: del día 1 hasta hoy.
// Asignar .value no dispara el evento "change" de los inputs, así que esto no
// provoca una carga extra: la carga la hace quien llama.
function setRangoMesActualUsoModulos() {
  var hoy = new Date();
  var desde = document.getElementById("usoModulosDesde");
  var hasta = document.getElementById("usoModulosHasta");
  if (desde) {
    desde.value = _fechaLocalISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  }
  if (hasta) hasta.value = _fechaLocalISO(hoy);
}
window.setRangoMesActualUsoModulos = setRangoMesActualUsoModulos;

async function cargarUsoModulos() {
  var tbody = document.getElementById("usoModulosTableBody");
  var statusEl = document.getElementById("usoModulosStatus");
  if (!tbody) return;

  var desdeVal = document.getElementById("usoModulosDesde")?.value || "";
  var hastaVal = document.getElementById("usoModulosHasta")?.value || "";
  var desdeISO = desdeVal ? desdeVal + "T00:00:00" : null;
  var hastaISO = hastaVal ? hastaVal + "T23:59:59.999" : null;

  function withRange(q) {
    if (desdeISO) q = q.gte("created_at", desdeISO);
    if (hastaISO) q = q.lte("created_at", hastaISO);
    return q;
  }

  if (statusEl) statusEl.textContent = "Cargando…";
  tbody.innerHTML = "";

  try {
    var imprPromise = withRange(
      sb.from("novedades_impressions").select("id", { count: "exact", head: true }),
    );
    var clickPromises = USO_MODULOS_SOURCES.map(function (s) {
      return withRange(
        sb
          .from("cart_add_events")
          .select("id", { count: "exact", head: true })
          .eq("source", s.key),
      );
    });
    var lineasPromises = USO_MODULOS_SOURCES.map(function (s) {
      return withRange(
        sb
          .from("v_order_items_source")
          .select("order_item_id", { count: "exact", head: true })
          .eq("source", s.key),
      );
    });

    var all = await Promise.all(
      [imprPromise].concat(clickPromises).concat(lineasPromises),
    );

    var imprResult = all[0];
    if (imprResult.error) throw imprResult.error;
    var vistas = imprResult.count || 0;

    var clickResults = all.slice(1, 1 + USO_MODULOS_SOURCES.length);
    var lineasResults = all.slice(1 + USO_MODULOS_SOURCES.length);

    var rows = USO_MODULOS_SOURCES.map(function (s, i) {
      if (clickResults[i].error) throw clickResults[i].error;
      if (lineasResults[i].error) throw lineasResults[i].error;
      return {
        key: s.key,
        label: s.label,
        clicks: clickResults[i].count || 0,
        lineas: lineasResults[i].count || 0,
      };
    });

    var novRow = rows.filter(function (r) {
      return r.key === "novedades";
    })[0];
    var novAgregados = novRow ? novRow.clicks : 0;
    var conversion =
      vistas > 0 ? ((novAgregados / vistas) * 100).toFixed(1) + "%" : "–";

    document.getElementById("usoModulosNovVistas").textContent = vistas;
    document.getElementById("usoModulosNovAgregados").textContent =
      novAgregados;
    document.getElementById("usoModulosNovConversion").textContent =
      conversion;

    tbody.innerHTML = rows
      .map(function (r) {
        return (
          "<tr><td>" +
          r.label +
          "</td><td>" +
          r.clicks +
          "</td><td>" +
          r.lineas +
          "</td></tr>"
        );
      })
      .join("");

    if (statusEl) statusEl.textContent = "Actualizado.";
  } catch (e) {
    console.error("cargarUsoModulos error:", e);
    if (statusEl) {
      statusEl.textContent =
        "No se pudo cargar (¿corriste add_module_usage_tracking.sql en Supabase?): " +
        (e.message || String(e));
    }
  }
}

/* =========================================================
   ESTADÍSTICA CLIENTES
   - Trae todas las orders confirmadas + customers
   - Para cada cliente: calcula intervalo promedio entre pedidos (frecuencia)
   - Calcula días desde el último pedido
   - "Próximos a comprar": el día esperado de próxima compra cae en ±15 días
   - "De baja": no hace pedidos hace más de 730 días (2 años)
   ========================================================= */
var _estCacheLoaded = false;
async function cargarEstadisticaClientes() {
  var statusEl = document.getElementById("estClientesStatus");
  var proxBody = document.querySelector("#estProximosTable tbody");
  var proxCount = document.getElementById("estProximosCount");
  if (!proxBody) return;

  if (statusEl) statusEl.innerHTML = '<span style="color:#666">Cargando datos…</span>';
  proxBody.innerHTML = "";

  // Clientes a ignorar en el análisis (internos / no relevantes)
  var EST_IGNORED_CODS = new Set(["1", "3878"]);

  try {
    // 1) Customers — select * para detectar dinámicamente cuál columna
    // guarda el teléfono (phone / telefono / celular / cel / whatsapp / etc).
    // Paginado con .range(): el REST de Supabase corta en 1000 filas sin dar
    // error, y customers ya pasa ese número — sin paginar, los clientes que
    // quedan afuera desaparecen del análisis en silencio.
    var customers = [];
    var custPage = 0;
    while (true) {
      var custResp = await sb
        .from("customers")
        .select("*")
        .order("id", { ascending: true })
        .range(custPage * 1000, (custPage + 1) * 1000 - 1);
      if (custResp.error) throw custResp.error;
      var custBatch = custResp.data || [];
      custBatch.forEach(function (c) {
        if (!EST_IGNORED_CODS.has(String(c.cod_cliente || "").trim())) {
          customers.push(c);
        }
      });
      if (custBatch.length < 1000) break;
      custPage++;
      if (custPage > 50) break; // safety
    }

    // Detectar nombre de columna de teléfono (primer match)
    var phoneColCandidates = [
      "phone", "telefono", "celular", "cel", "whatsapp", "mobile",
      "movil", "tel", "numero", "phone_number", "telephone",
    ];
    var phoneCol = null;
    if (customers.length > 0) {
      var keys = Object.keys(customers[0]);
      for (var pk = 0; pk < phoneColCandidates.length; pk++) {
        if (keys.indexOf(phoneColCandidates[pk]) !== -1) {
          phoneCol = phoneColCandidates[pk];
          break;
        }
      }
    }
    if (phoneCol) console.log("[estadistica] phone column detected:", phoneCol);
    else console.warn("[estadistica] No phone column found in customers");

    // Map cod → phone (id→cod ya no hace falta — la RPC agrega server-side)
    var codToPhone = new Map();
    customers.forEach(function (c) {
      var codT = String(c.cod_cliente || "").trim();
      if (phoneCol && c[phoneCol]) {
        codToPhone.set(codT, String(c[phoneCol]).trim());
      }
    });

    // 2) RPC agregada — UNA query devuelve last_date, count y avg_interval por cliente.
    // Reemplaza la paginación de orders + sales_lines (antes ~1500 round-trips).
    // Paginado en lotes de 1000 para superar el límite default de PostgREST.
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#666">Cargando agregados…</span>';
    }
    var statsByCust = new Map();
    var totalDates = 0;
    var aggPage = 0;
    while (true) {
      var aggResp = await sb
        .rpc("get_estadistica_clientes_agg")
        .range(aggPage * 1000, (aggPage + 1) * 1000 - 1);
      if (aggResp.error) throw aggResp.error;
      var aggBatch = aggResp.data || [];
      aggBatch.forEach(function (row) {
        var cod = String(row.cod_cliente || "").trim();
        if (!cod || EST_IGNORED_CODS.has(cod)) return;
        var lastDate = row.last_purchase_date ? new Date(row.last_purchase_date) : null;
        if (!lastDate || isNaN(lastDate.getTime())) return;
        statsByCust.set(cod, {
          lastDate: lastDate,
          count: Number(row.purchase_count || 0),
          freq: row.avg_interval_days != null ? Math.round(Number(row.avg_interval_days)) : null,
        });
        totalDates += Number(row.purchase_count || 0);
      });
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#666">Cargando agregados… ' + statsByCust.size + ' clientes</span>';
      }
      if (aggBatch.length < 1000) break;
      aggPage++;
      if (aggPage > 50) break; // safety
    }

    // 4) Para cada cliente: calcular días desde último + categoría usando stats agregados
    var now = new Date();
    var proximos = [];

    customers.forEach(function (c) {
      var cod = String(c.cod_cliente || "").trim();
      var stats = statsByCust.get(cod);
      if (!stats) return; // sin pedidos

      var lastDate = stats.lastDate;
      var daysSinceLast = Math.floor((now - lastDate) / 86400000);
      var freq = stats.freq;
      var orderCount = stats.count;

      var lastDateStr = lastDate.toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      // Sin pedidos hace > 365 días: no es "próximo a comprar". Estos clientes
      // los cubre Ranking Inactivos, que sale de una RPC aparte. Antes acá se
      // llenaba también la tabla "De baja"; el return queda porque es lo que
      // los excluye de `proximos`.
      if (daysSinceLast > 365) return;

      // Próximos a comprar: SOLO clientes con 3+ pedidos (frecuencia confiable)
      if (freq != null && freq > 0 && orderCount >= 3) {
        var diasParaProximo = freq - daysSinceLast;
        var nextDate = new Date(lastDate.getTime() + freq * 86400000);
        var nextDateStr = nextDate.toLocaleDateString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        var cat = "atrasado";
        if (diasParaProximo >= 0 && diasParaProximo <= 20) cat = "1-20";
        else if (diasParaProximo > 20) cat = "+20";
        // Flag "muy atrasado": atrasado más de 2.5x su frecuencia histórica.
        // No es baja todavía (< 12 meses), pero merece atención visual.
        var critico = daysSinceLast > freq * 2.5;
        proximos.push({
          cod: cod,
          rs: c.business_name || "—",
          lastDate: lastDateStr,
          freq: freq,
          nextDate: nextDateStr,
          daysSince: daysSinceLast,
          diasParaProximo: diasParaProximo,
          orderCount: orderCount,
          cat: cat,
          critico: critico,
          phone: codToPhone.get(cod) || "",
        });
      }
    });

    // Próximos: ASC por diasParaProximo (más atrasados arriba, esperados abajo)
    proximos.sort(function (a, b) { return a.diasParaProximo - b.diasParaProximo; });

    // Render
    if (proxCount) proxCount.textContent = String(proximos.length);

    // Counts por categoría para los chips
    var cntAtr = 0, cnt120 = 0, cntMas20 = 0;
    proximos.forEach(function (p) {
      if (p.cat === "atrasado") cntAtr++;
      else if (p.cat === "1-20") cnt120++;
      else if (p.cat === "+20") cntMas20++;
    });
    var cntAllEl = document.getElementById("estCntAll");
    var cntAtrEl = document.getElementById("estCntAtrasado");
    var cnt120El = document.getElementById("estCnt120");
    var cntMas20El = document.getElementById("estCntMas20");
    if (cntAllEl) cntAllEl.textContent = proximos.length;
    if (cntAtrEl) cntAtrEl.textContent = cntAtr;
    if (cnt120El) cnt120El.textContent = cnt120;
    if (cntMas20El) cntMas20El.textContent = cntMas20;

    if (proximos.length === 0) {
      proxBody.innerHTML = '<tr><td colspan="7" class="est-empty">Ningún cliente próximo a comprar en este momento.</td></tr>';
    } else {
      proxBody.innerHTML = proximos
        .map(function (p) {
          var diasClass = p.diasParaProximo < 0 ? "danger" : p.diasParaProximo <= 5 ? "warn" : "good";
          var diasLabel = p.diasParaProximo < 0
            ? "Atrasado " + Math.abs(p.diasParaProximo) + "d"
            : "En " + p.diasParaProximo + "d";
          // Whatsapp: limpiar el número (solo dígitos), default +54 si falta prefijo
          var waBtn;
          if (p.phone) {
            var clean = String(p.phone).replace(/\D+/g, "");
            // Si no empieza con 54 (Argentina), prefijar
            if (clean.length > 0 && clean.indexOf("54") !== 0) clean = "54" + clean;
            if (clean.length >= 10) {
              waBtn =
                '<a class="est-wa-btn" target="_blank" rel="noopener" href="https://wa.me/' +
                clean + '">' +
                '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.2-1.8-.9-2.1-1-.3-.1-.5-.2-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5-.2 0-.4 0-.6 0s-.5.1-.8.4c-.3.3-1 1-1 2.4 0 1.4 1 2.8 1.2 3 .2.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.3.2 1.8.1.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.3-.6-.4zM12 2C6.5 2 2 6.5 2 12c0 1.7.4 3.4 1.3 4.9L2 22l5.2-1.3c1.4.8 3.1 1.3 4.8 1.3 5.5 0 10-4.5 10-10S17.5 2 12 2z"/></svg>' +
                'Escribir</a>';
            } else {
              waBtn = '<button class="est-wa-btn disabled" disabled title="Número incompleto">Sin teléfono</button>';
            }
          } else {
            waBtn = '<button class="est-wa-btn disabled" disabled title="Cliente sin número registrado">Sin teléfono</button>';
          }
          var criticoBadge = p.critico
            ? ' <span title="Atrasado más de 2.5x su frecuencia habitual" style="display:inline-block;background:#fdecea;color:#c0392b;border:1px solid #e74c3c;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px;letter-spacing:0.3px">⚠ MUY ATRASADO</span>'
            : "";
          return (
            '<tr data-cat="' + p.cat + '">' +
            '<td><span class="est-cod">' + escHtml(p.cod) + "</span></td>" +
            '<td class="est-rs">' + escHtml(p.rs) + criticoBadge + "</td>" +
            "<td>" + escHtml(p.lastDate) + "</td>" +
            '<td class="est-days">' + (Math.round((p.freq / 30) * 10) / 10) + "</td>" +
            "<td>" + escHtml(p.nextDate) + ' <span class="est-days ' + diasClass + '" style="font-size:11px;margin-left:4px">(' + diasLabel + ")</span></td>" +
            '<td class="est-days">' + (Math.round((p.daysSince / 30) * 10) / 10) + " meses</td>" +
            '<td class="est-wa-cell">' + waBtn + "</td>" +
            "</tr>"
          );
        })
        .join("");
    }
    // Wire de los chips (idempotente — re-bindea cada vez)
    _wireEstFilters();

    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#666;font-size:12px">' +
        customers.length + " clientes analizados · " +
        totalDates + " fechas de compra agregadas · " +
        "actualizado " + new Date().toLocaleTimeString("es-AR") +
        "</span>";
    }

    _estCacheLoaded = true;
  } catch (e) {
    console.error("cargarEstadisticaClientes error", e);
    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#c0392b;font-weight:600">Error cargando estadística: ' +
        escHtml(e.message || String(e)) +
        "</span>";
    }
  }
}
window.cargarEstadisticaClientes = cargarEstadisticaClientes;

// Helper escape (por si no está disponible en este scope)
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Filter chips de "Próximos a comprar" — toggle visibilidad de rows por data-cat
function _wireEstFilters() {
  // SOLO chips con data-filter (filtros de Próximos a comprar).
  var chips = document.querySelectorAll(".est-filter-chip[data-filter]");
  chips.forEach(function (chip) {
    if (chip.__wired) return;
    chip.__wired = true;
    chip.addEventListener("click", function () {
      var filter = chip.dataset.filter;
      // Toggle active state SOLO entre chips de filtro de Próximos (no tocar
      // los chips de sort de Bajas que también tienen la clase est-filter-chip).
      chips.forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      // Filter rows
      var rows = document.querySelectorAll("#estProximosTable tbody tr");
      rows.forEach(function (row) {
        if (!row.dataset.cat) return;
        if (filter === "all") {
          row.style.display = "";
        } else {
          row.style.display = row.dataset.cat === filter ? "" : "none";
        }
      });
    });
  });
}

/* =========================================================
   ADMIN — Clientes agrupados
   "Estos códigos, con razones sociales distintas, son la misma persona o
   empresa." Se elige una principal y se le vinculan las demás, estén activas o
   no. La principal absorbe el histórico en Ranking Inactivos.
   SOLO clientes de Loekemeyer: el filtro está en las RPC (buscar_clientes_para_grupo
   y sugerir_customer_grupos), no acá.
   ========================================================= */

// Slot de la principal: {cod, nombre, ult, valor, empresas, yaAgrupado} o null
var _slotPrincipal = null;
// Slots de vinculados: [{id, cliente}] — cliente null mientras no se eligió.
// Se modela con slots y no con una lista plana para que el (+) pueda dejar un
// cuadro vacío esperando, que es lo que hace evidente que falta completarlo.
var _slotsExtra = [];
var _slotSeq = 0;
// Principal elegido por cluster sugerido, cuando se cambia el default
// Empresa activa de cada módulo. Un grupo vive dentro de UNA empresa: el cruce
// entre Loekemeyer y Chef es un vínculo, no un grupo, y va en Clientes vinculados.
var _empresaGrupo = "lk";
var _empresaSug = "lk";
var _empresaArmados = "lk";

// Cambiar de empresa vacía los slots: un grupo no puede mezclar códigos de las
// dos, y dejar cargado un cliente de Loekemeyer mientras se elige Chef sería
// una trampa. El grupo armado se sigue viendo igual, solo cambia el buscador.
function cambiarEmpresaGrupo(emp) {
  if (_empresaGrupo === emp) return;
  _empresaGrupo = emp;
  _slotPrincipal = null;
  _slotsExtra = [];
  _marcarEmpresa("[data-emp-grupo]", emp);
  _renderSlots();
}
window.cambiarEmpresaGrupo = cambiarEmpresaGrupo;

function cambiarEmpresaSug(emp) {
  if (_empresaSug === emp) return;
  _empresaSug = emp;
  _sugPrincipal = {};
  _sugQuitados = {};
  _marcarEmpresa("[data-emp-sug]", emp);
  var cont = document.getElementById("gruposSugeridosLista");
  if (cont) cont.innerHTML = '<div class="grupo-sel-vacio">Cargando…</div>';
  _cargarSugerencias();
}
window.cambiarEmpresaSug = cambiarEmpresaSug;

// Grupos armados filtra en memoria: get_customer_grupos() ya trae las dos
// empresas y son pocas filas, así que no vale la pena otra ida a la base.
var _gruposArmadosCache = [];

function cambiarEmpresaArmados(emp) {
  if (_empresaArmados === emp) return;
  _empresaArmados = emp;
  _marcarEmpresa("[data-emp-armados]", emp);
  _renderGruposArmados(_gruposArmadosCache);
}
window.cambiarEmpresaArmados = cambiarEmpresaArmados;

function _marcarEmpresa(sel, emp) {
  document.querySelectorAll(sel).forEach(function (b) {
    b.classList.toggle(
      "activa",
      b.dataset.empGrupo === emp || b.dataset.empSug === emp || b.dataset.empArmados === emp
    );
  });
}

var _sugPrincipal = {};
// Miembros que la persona sacó de una sugerencia antes de aceptarla, por clave
// de cluster. Vive solo en memoria: la sugerencia se recalcula en cada carga y
// no tiene sentido persistir un descarte de algo que quizá ya no se propone.
var _sugQuitados = {};

function _escGrupo(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _fmtPesosGrupo(n) {
  var v = Math.round(Number(n) || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("es-AR");
}

function _fmtFechaGrupo(d) {
  if (!d) return "—";
  // T00:00:00 fuerza hora local: sin eso, en UTC-3 la fecha se corre un día.
  return new Date(String(d) + "T00:00:00").toLocaleDateString("es-AR");
}

// Badge lk / chef. El buscador ya excluye los que son solo de Chef, pero 69
// códigos operan en las dos y conviene verlo antes de agrupar.
function _badgeEmpresas(e) {
  var t = String(e || "").trim();
  if (!t) return "";
  return '<span class="grupo-emp">' + _escGrupo(t.toUpperCase()) + "</span>";
}

function _clienteDesdeFila(c) {
  return {
    cod: c.cod_cliente,
    nombre: c.business_name || "",
    ult: c.last_date,
    valor: Number(c.valor_historico) || 0,
    empresas: c.empresas || "",
    yaAgrupado: !!c.ya_agrupado,
  };
}

async function cargarGruposClientes() {
  var statusEl = document.getElementById("gruposStatus");
  if (statusEl) statusEl.innerHTML = '<span style="color:#666">Cargando…</span>';

  try {
    _renderSlots();
    _renderSlotsLkCh();

    var res = await Promise.all([
      sb.rpc("get_customer_grupos"),
      sb.rpc("sugerir_customer_grupos", {
        p_meses: 12, p_min_sim: 0.62, p_limit: 200,
        p_max_dir: 3, p_max_tok: 3, p_max_grupo: 5, p_empresa: _empresaSug,
      }),
      sb.rpc("get_clientes_lk_ch", { p_meses: 12 }),
    ]);
    if (res[0].error) throw res[0].error;
    if (res[1].error) throw res[1].error;
    if (res[2].error) throw res[2].error;

    _renderGruposArmados(res[0].data || []);
    _renderGruposSugeridos(res[1].data || []);
    _renderClientesLkCh(res[2].data || []);

    if (statusEl) statusEl.innerHTML = "";
  } catch (err) {
    console.error("cargarGruposClientes error", err);
    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#c0392b">Error: ' + _escGrupo(err.message || err) + "</span>";
    }
  }
}
window.cargarGruposClientes = cargarGruposClientes;

// Recarga SOLO las sugerencias. Cambiar de empresa, rechazar una sugerencia o
// refrescar la lista no tocan ni los grupos armados ni los clientes vinculados,
// así que volver a pedir esas dos RPC son ~1,1 s de trabajo de base y dos
// viajes al servidor al pedo. ACEPTAR una sugerencia sí recarga todo: eso crea
// un grupo, y un grupo cambia las otras dos tablas.
async function _cargarSugerencias() {
  var statusEl = document.getElementById("gruposStatus");
  try {
    var resp = await sb.rpc("sugerir_customer_grupos", {
      p_meses: 12, p_min_sim: 0.62, p_limit: 200,
      p_max_dir: 3, p_max_tok: 3, p_max_grupo: 5, p_empresa: _empresaSug,
    });
    if (resp.error) throw resp.error;
    _renderGruposSugeridos(resp.data || []);
    if (statusEl) statusEl.innerHTML = "";
  } catch (err) {
    console.error("_cargarSugerencias error", err);
    if (statusEl) {
      statusEl.innerHTML =
        '<span style="color:#c0392b">Error: ' + _escGrupo(err.message || err) + "</span>";
    }
  }
}

/* ---------- 1. Alta manual: principal + vinculados ---------- */

function agregarSlotVinculado() {
  _slotsExtra.push({ id: "x" + (++_slotSeq), cliente: null });
  _renderSlots();
  // Foco en el cuadro recién agregado, para poder tipear sin buscar el mouse
  var inputs = document.querySelectorAll("#grupoSlotsExtra .grupo-input");
  if (inputs.length) inputs[inputs.length - 1].focus();
}
window.agregarSlotVinculado = agregarSlotVinculado;

// Cuadro de un slot: buscador si está vacío, ficha del cliente si ya se eligió.
function _htmlSlot(slotId, cliente, esPrincipal) {
  if (cliente) {
    return (
      '<div class="grupo-slot elegido' + (esPrincipal ? " principal" : "") + '">' +
      '<span class="est-cod">' + _escGrupo(cliente.cod) + "</span>" +
      '<span class="grupo-slot-nom">' + _escGrupo(cliente.nombre || "(sin razón social)") +
        _badgeEmpresas(cliente.empresas) +
        (cliente.yaAgrupado ? ' <span class="grupo-warn">ya agrupado</span>' : "") +
      "</span>" +
      '<span class="grupo-slot-fecha">' + _fmtFechaGrupo(cliente.ult) + "</span>" +
      '<span class="grupo-slot-valor">' + _fmtPesosGrupo(cliente.valor) + "</span>" +
      '<button type="button" class="grupo-mini quitar" data-limpiar="' + _escGrupo(slotId) + '">✕</button>' +
      "</div>"
    );
  }
  return (
    '<div class="grupo-slot vacio" data-slot="' + _escGrupo(slotId) + '">' +
    '<input type="text" class="grupo-input" autocomplete="off" ' +
      'placeholder="' + (esPrincipal ? "Código o razón social de la principal…" : "Código o razón social a vincular…") + '">' +
    '<div class="grupo-resultados"></div>' +
    (esPrincipal ? "" :
      '<button type="button" class="grupo-mini quitar" data-quitar-slot="' + _escGrupo(slotId) + '">✕</button>') +
    "</div>"
  );
}

function _renderSlots() {
  var cp = document.getElementById("grupoSlotPrincipal");
  var ce = document.getElementById("grupoSlotsExtra");
  if (!cp || !ce) return;

  cp.innerHTML = _htmlSlot("principal", _slotPrincipal, true);
  ce.innerHTML = _slotsExtra.length
    ? _slotsExtra.map(function (s) { return _htmlSlot(s.id, s.cliente, false); }).join("")
    : '<div class="grupo-sel-vacio">Tocá + para vincular una razón social.</div>';

  [cp, ce].forEach(function (cont) {
    cont.querySelectorAll(".grupo-slot.vacio").forEach(function (box) {
      _wireSlot(box, box.dataset.slot);
    });
    cont.querySelectorAll("[data-limpiar]").forEach(function (b) {
      b.addEventListener("click", function () { _limpiarSlot(b.dataset.limpiar); });
    });
    cont.querySelectorAll("[data-quitar-slot]").forEach(function (b) {
      b.addEventListener("click", function () {
        _slotsExtra = _slotsExtra.filter(function (s) { return s.id !== b.dataset.quitarSlot; });
        _renderSlots();
      });
    });
  });

  _renderResumen();
}

function _wireSlot(box, slotId) {
  var input = box.querySelector(".grupo-input");
  var cont = box.querySelector(".grupo-resultados");
  if (!input || !cont) return;
  var timer = null;

  input.addEventListener("input", function () {
    clearTimeout(timer);
    var q = input.value;
    if (String(q).trim().length < 2) { cont.innerHTML = ""; return; }
    // Debounce: cada tecla dispararía una consulta contra sales_lines.
    timer = setTimeout(function () { _buscarEnSlot(cont, q, slotId); }, 220);
  });

  input.addEventListener("blur", function () {
    // Timeout: sin él, el blur limpia los resultados antes de que el click
    // sobre uno de ellos llegue a dispararse.
    setTimeout(function () { cont.innerHTML = ""; }, 180);
  });
}

function _buscarEnSlot(cont, q, slotId) {
  cont.innerHTML = '<div class="grupo-res-vacio">Buscando…</div>';
  sb.rpc("buscar_clientes_para_grupo", { p_q: q, p_limit: 25, p_empresa: _empresaGrupo })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var yaEn = _codsElegidos();
      var hits = (resp.data || []).filter(function (c) {
        return yaEn.indexOf(c.cod_cliente) === -1;
      });

      if (hits.length === 0) {
        cont.innerHTML = '<div class="grupo-res-vacio">Sin resultados</div>';
        return;
      }

      cont.innerHTML = hits
        .map(function (c) {
          return (
            '<button type="button" class="grupo-res" data-cod="' + _escGrupo(c.cod_cliente) + '">' +
            '<span class="est-cod">' + _escGrupo(c.cod_cliente) + "</span>" +
            '<span class="grupo-res-nom">' +
            _escGrupo(c.business_name || "(sin razón social)") +
            _badgeEmpresas(c.empresas) +
            (c.ya_agrupado ? ' <span class="grupo-warn">ya agrupado</span>' : "") +
            "</span>" +
            '<span class="grupo-res-meta">' + _fmtFechaGrupo(c.last_date) + "</span>" +
            '<span class="grupo-res-val">' + _fmtPesosGrupo(c.valor_historico) + "</span>" +
            "</button>"
          );
        })
        .join("");

      // addEventListener y no onclick inline: la razón social puede traer
      // apóstrofes y el navegador decodifica las entidades del atributo ANTES
      // de parsear el JS, así que un onclick interpolado se rompe.
      cont.querySelectorAll(".grupo-res").forEach(function (b) {
        b.addEventListener("mousedown", function (ev) {
          // mousedown y no click: el blur del input corre antes que el click.
          ev.preventDefault();
          var c = hits.find(function (x) { return x.cod_cliente === b.dataset.cod; });
          if (c) _elegirEnSlot(slotId, _clienteDesdeFila(c));
        });
      });
    })
    .catch(function (err) {
      console.error("_buscarEnSlot error", err);
      cont.innerHTML =
        '<div class="grupo-res-vacio">Error: ' + _escGrupo(err.message || err) + "</div>";
    });
}

function _codsElegidos() {
  var out = [];
  if (_slotPrincipal) out.push(_slotPrincipal.cod);
  _slotsExtra.forEach(function (s) { if (s.cliente) out.push(s.cliente.cod); });
  return out;
}

function _elegirEnSlot(slotId, cliente) {
  if (slotId === "principal") _slotPrincipal = cliente;
  else {
    var s = _slotsExtra.find(function (x) { return x.id === slotId; });
    if (s) s.cliente = cliente;
  }
  _renderSlots();
}

function _limpiarSlot(slotId) {
  if (slotId === "principal") _slotPrincipal = null;
  else {
    var s = _slotsExtra.find(function (x) { return x.id === slotId; });
    if (s) s.cliente = null;
  }
  _renderSlots();
}

function _renderResumen() {
  var resumen = document.getElementById("grupoResumen");
  var btn = document.getElementById("grupoGuardarBtn");
  var extras = _slotsExtra.filter(function (s) { return s.cliente; });
  var listo = !!_slotPrincipal && extras.length >= 1;

  if (btn) btn.disabled = !listo;
  if (!resumen) return;

  if (!_slotPrincipal) {
    resumen.innerHTML = '<span class="grupo-warn">Falta elegir la razón social principal.</span>';
    return;
  }
  if (extras.length === 0) {
    resumen.innerHTML = '<span class="grupo-warn">Falta vincular al menos una razón social.</span>';
    return;
  }
  var total = extras.reduce(function (a, s) { return a + (s.cliente.valor || 0); },
                            _slotPrincipal.valor || 0);
  resumen.innerHTML =
    "Se vinculan <strong>" + extras.length + "</strong> razón(es) social(es) a " +
    "<strong>" + _escGrupo(_slotPrincipal.cod) + " — " +
    _escGrupo(_slotPrincipal.nombre || "(sin razón social)") + "</strong>. " +
    "Histórico consolidado: <strong>" + _fmtPesosGrupo(total) + "</strong>.";
}

function guardarGrupoClientes() {
  var extras = _slotsExtra.filter(function (s) { return s.cliente; });
  if (!_slotPrincipal || extras.length === 0) return;

  var cods = [_slotPrincipal.cod].concat(extras.map(function (s) { return s.cliente.cod; }));

  if (!confirm(
    "Agrupar " + cods.length + " razones sociales:\n\n" +
    "  " + _slotPrincipal.cod + " — " + (_slotPrincipal.nombre || "(sin razón social)") + "   ← principal\n" +
    extras.map(function (s) {
      return "  " + s.cliente.cod + " — " + (s.cliente.nombre || "(sin razón social)");
    }).join("\n") +
    "\n\nEl histórico de todas pasa a la principal, y las demás dejan de figurar " +
    "por separado en Ranking Inactivos.\n\n¿Confirmás?"
  )) return;

  var btn = document.getElementById("grupoGuardarBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

  sb.rpc("guardar_customer_grupo", {
      p_cods: cods,
      p_cod_vigente: _slotPrincipal.cod,
      p_nota: null,
      p_empresa: _empresaGrupo,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _slotPrincipal = null;
      _slotsExtra = [];
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("guardarGrupoClientes error", err);
      alert("No se pudo guardar el grupo: " + (err.message || err));
    })
    .then(function () {
      if (btn) btn.textContent = "Agrupar";
      _renderResumen();
    });
}
window.guardarGrupoClientes = guardarGrupoClientes;

/* ---------- 2. Sugerencias (clusters de N) ---------- */

function _renderGruposSugeridos(clusters) {
  var cont = document.getElementById("gruposSugeridosLista");
  var countEl = document.getElementById("gruposSugeridosCount");
  if (!cont) return;
  if (countEl) countEl.textContent = clusters.length;

  if (clusters.length === 0) {
    cont.innerHTML = '<div class="grupo-sel-vacio">No hay sugerencias sin agrupar.</div>';
    return;
  }

  cont.innerHTML = clusters
    .map(function (c, idx) {
      var miembros = _miembrosVivos(c);
      var quitados = (c.miembros || []).length - miembros.length;
      var principal = _principalSug(c);

      return (
        '<div class="grupo-sug" data-clave="' + _escGrupo(c.clave) + '">' +
        '<div class="grupo-sug-head">' +
        "<strong>" + miembros.length + " razones sociales</strong>" +
        (quitados
          ? '<button type="button" class="grupo-mini grupo-sug-restaurar">↺ restaurar ' +
            quitados + "</button>"
          : "") +
        '<span class="grupo-sug-valor">' + _fmtPesosGrupo(_enJuegoVivos(c)) +
        " mal atribuidos hoy</span>" +
        "</div>" +
        '<div class="grupo-lista">' +
        miembros
          .map(function (m) {
            var esP = m.cod === principal;
            return (
              '<label class="grupo-fila' + (esP ? " principal" : "") + '">' +
              '<input type="radio" name="sug' + idx + '"' + (esP ? " checked" : "") +
                ' data-pick="' + _escGrupo(m.cod) + '">' +
              '<span class="est-cod">' + _escGrupo(m.cod) + "</span>" +
              '<span class="grupo-fila-nom">' + _escGrupo(m.nombre || "(sin razón social)") +
                _badgeEmpresas(m.empresas) +
                // El CUIT es el dato duro para confirmar si son el mismo
                // cliente: dos códigos que lo comparten son la misma persona
                // jurídica, sin importar cómo esté escrito el nombre.
                (m.cuit ? '<span class="grupo-cuit">CUIT ' + _escGrupo(m.cuit) + "</span>" : "") +
                // La dirección se muestra siempre, no solo cuando es el motivo
                // del cluster: sirve igual para confirmar un match por nombre.
                (m.direccion
                  ? '<span class="grupo-dir">📍 ' + _escGrupo(m.direccion) + "</span>"
                  : "") +
              "</span>" +
              '<span class="grupo-fila-fecha">' + _fmtFechaGrupo(m.last_date) + "</span>" +
              '<span class="grupo-fila-valor">' + _fmtPesosGrupo(m.valor) + "</span>" +
              (esP ? '<span class="grupo-badge">actual</span>'
                   : '<span class="grupo-fila-hint">marcar actual</span>') +
              (m.activo ? '<span class="grupo-activo">activo</span>'
                        : '<span class="grupo-inactivo">inactivo</span>') +
              // Sacar a este de la sugerencia. Las señales automáticas a veces
              // encadenan a alguien que no corresponde (un apellido común, un
              // domicilio compartido), y sin esto había que descartar la
              // sugerencia entera y rehacerla a mano.
              '<button type="button" class="grupo-sug-quitar" data-quitar-mie="' +
                _escGrupo(m.cod) + '" title="Sacar de esta sugerencia">Sacar</button>' +
              "</label>"
            );
          })
          .join("") +
        "</div>" +
        '<button type="button" class="btn-primary grupo-sug-btn"' +
          (miembros.length < 2 ? " disabled" : "") + ">Agrupar</button>" +
        // Rechazar descarta la propuesta ENTERA y la guarda para no volver a
        // mostrarla. Se descarta la sugerencia original completa, no la que
        // quedó después de sacar miembros a mano: si el usuario sacó a alguien
        // y después rechaza, lo que no quiere ver es la propuesta tal como se
        // la ofreció.
        '<button type="button" class="grupo-sug-rechazar">Rechazar</button>' +
        (miembros.length < 2
          ? '<span class="grupo-sug-aviso">Un grupo necesita al menos 2 razones sociales.</span>'
          : "") +
        "</div>"
      );
    })
    .join("");

  cont.querySelectorAll(".grupo-sug").forEach(function (box) {
    var clave = box.dataset.clave;
    var cluster = clusters.find(function (x) { return x.clave === clave; });
    box.querySelectorAll("[data-pick]").forEach(function (r) {
      r.addEventListener("change", function () {
        _sugPrincipal[clave] = r.dataset.pick;
        _renderGruposSugeridos(clusters);
      });
    });
    box.querySelectorAll("[data-quitar-mie]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        // El botón vive dentro de un <label> con un radio: sin esto, tocarlo
        // marcaría también esa fila como principal.
        ev.preventDefault();
        ev.stopPropagation();
        if (!_sugQuitados[clave]) _sugQuitados[clave] = [];
        _sugQuitados[clave].push(b.dataset.quitarMie);
        // Si el que se saca era el principal, se elige otro para no quedar sin.
        if (_sugPrincipal[clave] === b.dataset.quitarMie) delete _sugPrincipal[clave];
        _renderGruposSugeridos(clusters);
      });
    });
    var rest = box.querySelector(".grupo-sug-restaurar");
    if (rest) {
      rest.addEventListener("click", function () {
        delete _sugQuitados[clave];
        _renderGruposSugeridos(clusters);
      });
    }
    box.querySelector(".grupo-sug-btn").addEventListener("click", function (ev) {
      _agruparCluster(cluster, _principalSug(cluster), ev.target);
    });
    box.querySelector(".grupo-sug-rechazar").addEventListener("click", function (ev) {
      _rechazarSugerencia(cluster, ev.target);
    });
  });
}

// Miembros que siguen en la sugerencia después de sacar los que se descartaron.
function _miembrosVivos(c) {
  var fuera = _sugQuitados[c.clave] || [];
  return (c.miembros || []).filter(function (m) { return fuera.indexOf(m.cod) === -1; });
}

function _enJuegoVivos(c) {
  return _miembrosVivos(c).reduce(function (a, m) {
    return a + (m.activo ? 0 : Number(m.valor) || 0);
  }, 0);
}

// El principal elegido a mano, si sigue en la sugerencia; si no, el sugerido, y
// si ese también se sacó, el primero que quede.
function _principalSug(c) {
  var vivos = _miembrosVivos(c).map(function (m) { return m.cod; });
  var elegido = _sugPrincipal[c.clave];
  if (elegido && vivos.indexOf(elegido) !== -1) return elegido;
  if (vivos.indexOf(c.sugerido_vigente) !== -1) return c.sugerido_vigente;
  return vivos[0];
}

// El origen puede venir combinado ("apellido+direccion") cuando el grupo se
// armó por más de una señal a la vez.
function _etiquetaOrigen(origen) {
  var nombres = {
    cuit: "mismo CUIT",
    nombre: "misma razón social",
    direccion: "misma dirección de entrega",
    apellido: "apellido en común",
    similitud: "nombres parecidos",
  };
  return String(origen || "")
    .split("+")
    .map(function (o) { return nombres[o] || o; })
    .join(" · ");
}

function _rechazarSugerencia(cluster, btn) {
  var cods = (cluster.miembros || []).map(function (m) { return m.cod; });
  if (cods.length < 2) return;

  btn.disabled = true;
  btn.textContent = "…";
  sb.rpc("rechazar_sugerencia_grupo", {
      p_cods: cods,
      p_empresa: cluster.empresa || _empresaSug,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return _cargarSugerencias();
    })
    .catch(function (err) {
      console.error("_rechazarSugerencia error", err);
      alert("No se pudo rechazar: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = "Rechazar";
    });
}

// Vuelve a proponer lo descartado de la empresa activa. No recalcula nada por
// su cuenta: las sugerencias se computan en cada carga, así que alcanza con
// borrar los rechazos y volver a pedirlas.
function refrescarSugerencias() {
  var btn = document.getElementById("sugRefrescarBtn");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  sb.rpc("limpiar_sugerencias_rechazadas", { p_empresa: _empresaSug })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _sugPrincipal = {};
      _sugQuitados = {};
      return _cargarSugerencias();
    })
    .catch(function (err) {
      console.error("refrescarSugerencias error", err);
      alert("No se pudo refrescar: " + (err.message || err));
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = "↻ Refrescar"; }
    });
}
window.refrescarSugerencias = refrescarSugerencias;

function _agruparCluster(cluster, principal, btn) {
  var miembros = _miembrosVivos(cluster);
  var cods = miembros.map(function (m) { return m.cod; });
  var p = miembros.find(function (m) { return m.cod === principal; });

  if (cods.length < 2) return;

  if (!confirm(
    "Agrupar " + cods.length + " razones sociales:\n\n" +
    miembros.map(function (m) {
      return "  " + m.cod + " — " + (m.nombre || "(sin razón social)") +
        (m.cod === principal ? "   ← principal" : "");
    }).join("\n") +
    "\n\nEl histórico pasa a " + principal + " — " +
    ((p && p.nombre) || "(sin razón social)") + ".\n\n¿Confirmás?"
  )) return;

  btn.disabled = true;
  btn.textContent = "…";
  sb.rpc("guardar_customer_grupo", {
      p_cods: cods,
      p_cod_vigente: principal,
      p_nota: "Sugerido: " + _etiquetaOrigen(cluster.origen),
      p_empresa: cluster.empresa || _empresaSug,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_agruparCluster error", err);
      alert("No se pudo agrupar: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = "Agrupar";
    });
}

/* ---------- 3. Clientes LK + CH ---------- */

// Clientes con operaciones en las dos empresas. El switch los saca de Ranking
// Inactivos (tabla clientes_chef_excluidos), pensado para los que dejaron de
// comprarle a Loekemeyer pero le siguen comprando a Chef: no están perdidos.
// Cada fila es un CLIENTE REAL, no un código: el mismo cliente suele tener un
// código en Loekemeyer y otro distinto en Chef. El código que se muestra es
// siempre el de Loekemeyer, que es con el que se lo busca en el ranking.
// Clientes vinculados filtra en memoria: get_clientes_lk_ch() trae las 165
// filas de una sola vez y la tabla no está paginada, así que el filtro puede
// mirarlas todas sin volver a la base.
var _lkchCache = [];
var _lkchQuery = "";
var _lkchBuscarTimer = null;

function _renderClientesLkCh(filas) {
  _lkchCache = filas || [];
  _pintarClientesLkCh();
}

// Normaliza para comparar: sin acentos, sin mayúsculas y sin los guiones del
// CUIT, así "30-71234567-9" encuentra al que está cargado como "30712345679".
function _normLkCh(s) {
  return String(s == null ? "" : s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function _filtrarLkCh(filas, q) {
  var t = _normLkCh(q);
  if (!t) return filas;
  return filas.filter(function (f) {
    var campos = [f.business_name, f.nombre_chef, f.cuit, f.cod_lk]
      .concat(f.cods_lk || [], f.cods_chef || []);
    return campos.some(function (c) { return _normLkCh(c).indexOf(t) !== -1; });
  });
}

function onInputBuscarLkCh(el) {
  clearTimeout(_lkchBuscarTimer);
  var v = el.value;
  _lkchBuscarTimer = setTimeout(function () {
    _lkchQuery = String(v).trim();
    _pintarClientesLkCh();
  }, 200);
}
window.onInputBuscarLkCh = onInputBuscarLkCh;

function limpiarBusquedaLkCh() {
  var el = document.getElementById("lkchBuscar");
  if (el) el.value = "";
  clearTimeout(_lkchBuscarTimer);
  _lkchQuery = "";
  _pintarClientesLkCh();
}
window.limpiarBusquedaLkCh = limpiarBusquedaLkCh;

function _pintarClientesLkCh() {
  var todas = _lkchCache;
  var filas = _filtrarLkCh(todas, _lkchQuery);
  var tbody = document.querySelector("#lkchTable tbody");
  var countEl = document.getElementById("lkchCount");
  var statusEl = document.getElementById("lkchStatus");
  if (!tbody) return;
  if (countEl) countEl.textContent = todas.length;

  // El resumen cuenta SIEMPRE sobre el total: son los números del módulo, no
  // del filtro. La búsqueda se informa aparte.
  var candidatos = todas.filter(function (f) { return f.lk_frio_chef_activo; }).length;
  var fuera = todas.filter(function (f) { return f.excluido; }).length;
  var tocados = todas.filter(function (f) { return f.decision_manual; }).length;
  if (statusEl) {
    statusEl.textContent = todas.length === 0
      ? "Ningún cliente opera en las dos empresas."
      : todas.length + " clientes operan en las dos. " + candidatos +
        " dejaron de comprarle a Loekemeyer pero le compraron a Chef en el período " +
        "y vienen marcados solos · " + fuera + " fuera del ranking" +
        (tocados ? " (" + tocados + " decidido a mano)" : "") +
        (_lkchQuery ? " · " + filas.length + " coinciden con la búsqueda." : ".");
    statusEl.style.color = "#64748b";
  }

  if (filas.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="est-empty">' +
      (_lkchQuery
        ? "Ningún cliente coincide con “" + _escGrupo(_lkchQuery) + "”."
        : "Sin clientes en las dos empresas.") + "</td></tr>";
    return;
  }

  tbody.innerHTML = "";
  filas.forEach(function (f) {
    var codsLk = f.cods_lk || [];
    var codsCh = f.cods_chef || [];
    var tr = document.createElement("tr");
    // Se resalta el caso que motiva el módulo para que no haya que leer las
    // dos fechas de cada fila para encontrarlo.
    if (f.lk_frio_chef_activo) tr.className = "lkch-candidato";

    // Se muestra CÓMO se llama el cliente del otro lado y con qué código, porque
    // las dos numeraciones son independientes: el mismo número es otro cliente
    // en cada empresa. Sin el nombre de Chef no hay forma de controlar el
    // vínculo desde la pantalla.
    var detalle = [];
    if (f.cuit) detalle.push("CUIT " + f.cuit);
    if (codsLk.length > 1) {
      detalle.push("otros LK: " + codsLk.filter(function (c) { return c !== f.cod_lk; }).join(", "));
    }
    if (codsCh.length) {
      detalle.push(
        "Código Chef " + codsCh.join(", ") +
        (f.nombre_chef ? " — " + f.nombre_chef : "")
      );
    }

    tr.innerHTML =
      '<td><span class="est-cod">' + _escGrupo(f.cod_lk) + "</span></td>" +
      '<td class="est-rs">' + _escGrupo(f.business_name || "(sin razón social)") +
        (f.lk_frio_chef_activo
          ? ' <span class="lkch-badge" title="Sin compras en Loekemeyer en el período, pero comprando en Chef">solo Chef hoy</span>'
          : "") +
        (f.vinculado_manual
          ? ' <span class="lkch-badge manual" title="Vinculado a mano">vínculo manual</span>'
          : "") +
        (detalle.length ? '<span class="lkch-cods">' + _escGrupo(detalle.join(" · ")) + "</span>" : "") +
      "</td>" +
      "<td style='font-size:12px'>" + _fmtFechaGrupo(f.ult_lk) + "</td>" +
      "<td style='font-weight:700'>" + _fmtPesosGrupo(f.valor_lk) + "</td>" +
      "<td style='font-size:12px'>" + _fmtFechaGrupo(f.ult_chef) + "</td>" +
      "<td style='font-weight:700'>" + _fmtPesosGrupo(f.valor_chef) + "</td>" +
      // El switch va en una línea y las acciones en otra: juntos no entraban en
      // la columna y los botones quedaban cortados.
      '<td><label class="est-switch-wrap" style="cursor:pointer">' +
        '<span class="est-switch"><input type="checkbox" data-lkch="' + _escGrupo(f.cod_lk) + '"' +
          (f.excluido ? " checked" : "") + '><span class="est-switch-slider"></span></span>' +
        '<span class="est-switch-state" data-lkch-estado="' + _escGrupo(f.cod_lk) + '">' +
        (f.excluido ? "Fuera" : "En el ranking") + "</span>" +
      "</label>" +
      (f.decision_manual || f.vinculado_manual
        ? '<div class="lkch-acciones">' +
          // Volver al automático solo se ofrece si hay algo que revertir.
          (f.decision_manual
            ? '<button type="button" class="lkch-auto" data-lkch-reset="' + _escGrupo(f.cod_lk) +
              '" title="Volver a decidirlo solo según las fechas de compra">volver a auto</button>'
            : "") +
          (f.vinculado_manual
            ? '<button type="button" class="lkch-auto" data-lkch-desvincular="' +
              _escGrupo(f.cod_lk) + '">✕ desvincular</button>'
            : "") +
          "</div>"
        : "") +
      "</td>";

    var chk = tr.querySelector("[data-lkch]");
    chk.addEventListener("change", function () {
      _toggleLkCh(f.cod_lk, chk.checked, chk);
    });
    var reset = tr.querySelector("[data-lkch-reset]");
    if (reset) reset.addEventListener("click", function () { _resetLkCh(f.cod_lk); });
    var des = tr.querySelector("[data-lkch-desvincular]");
    if (des) des.addEventListener("click", function () { _desvincularLkCh(f); });
    tbody.appendChild(tr);
  });
}

function _toggleLkCh(codLk, excluir, chk) {
  chk.disabled = true;
  sb.rpc("set_lk_ch_excluido", { p_cod_lk: codLk, p_excluir: !!excluir, p_meses: 12 })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var est = document.querySelector('[data-lkch-estado="' + codLk + '"]');
      if (est) est.textContent = excluir ? "Fuera" : "En el ranking";
      // No se recarga la vista entera: el switch tiene que responder al toque
      // sin que la tabla salte. El ranking lo toma en su próxima carga.
      chk.disabled = false;
    })
    .catch(function (err) {
      console.error("_toggleLkCh error", err);
      alert("No se pudo cambiar: " + (err.message || err));
      chk.checked = !excluir;
      chk.disabled = false;
    });
}

// Borra la decisión manual: el switch vuelve a valer lo que digan las fechas.
function _resetLkCh(codLk) {
  sb.rpc("reset_lk_ch_excluido", { p_cod_lk: codLk, p_meses: 12 })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_resetLkCh error", err);
      alert("No se pudo volver al automático: " + (err.message || err));
    });
}

function _desvincularLkCh(f) {
  if (!confirm(
    "Deshacer el vínculo manual de " + (f.business_name || f.cod_lk) + ".\n\n" +
    "Los códigos vuelven a agruparse solos por razón social, así que si no se " +
    "parecen entre sí van a quedar separados y el de Loekemeyer puede volver a " +
    "Ranking Inactivos.\n\n¿Confirmás?"
  )) return;

  sb.rpc("desvincular_lk_ch", { p_cod_lk: f.cod_lk })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_desvincularLkCh error", err);
      alert("No se pudo desvincular: " + (err.message || err));
    });
}

/* ---------- Vínculo manual LK <-> Chef ---------- */
// Mismo patrón de slots que "Agrupar manualmente", pero con un buscador que SÍ
// incluye códigos de Chef: acá el objetivo es justamente cruzar las empresas.
// Exactamente dos slots, uno por empresa. No es una lista variable: las dos
// numeraciones son independientes, así que un vínculo siempre es "este código
// de Loekemeyer es el mismo cliente que este código de Chef".
var _slotsLkCh = [
  { id: "lkchLk", empresa: "lk", cod: null, nombre: "", ult: null },
  { id: "lkchCh", empresa: "chef", cod: null, nombre: "", ult: null },
];

// Mismo markup y mismas clases que los slots de "Agrupar manualmente": los dos
// bloques hacen lo mismo (elegir clientes de a uno) y tienen que verse igual.
function _renderSlotsLkCh() {
  var cont = document.getElementById("lkchSlots");
  if (!cont) return;

  cont.innerHTML = _slotsLkCh
    .map(function (s, i) {
      var tit =
        '<div class="grupo-slot-tit">' +
        (s.empresa === "lk" ? "Código de Loekemeyer" : "Código de Chef") +
        "</div>";
      if (s.cod) {
        return (
          tit +
          '<div class="grupo-slot elegido">' +
          '<span class="est-cod">' + _escGrupo(s.cod) + "</span>" +
          '<span class="grupo-slot-nom">' + _escGrupo(s.nombre || "(sin razón social)") +
            _badgeEmpresas(s.empresa) +
            (s.yaVinculado ? ' <span class="grupo-warn">ya vinculado</span>' : "") +
          "</span>" +
          '<span class="grupo-slot-fecha">' + _fmtFechaGrupo(s.ult) + "</span>" +
          '<span class="grupo-slot-valor"></span>' +
          '<button type="button" class="grupo-mini quitar" data-lkch-limpiar="' +
            _escGrupo(s.id) + '">✕</button>' +
          "</div>"
        );
      }
      return (
        tit +
        '<div class="grupo-slot vacio" data-lkch-slot="' + _escGrupo(s.id) + '">' +
        '<input type="text" class="grupo-input" autocomplete="off" ' +
          'placeholder="Código o razón social en ' +
          (s.empresa === "lk" ? "Loekemeyer" : "Chef") + '…">' +
        '<div class="grupo-resultados"></div>' +
        "</div>"
      );
    })
    .join("");

  cont.querySelectorAll("[data-lkch-slot]").forEach(function (box) {
    _wireSlotLkCh(box, box.dataset.lkchSlot);
  });
  cont.querySelectorAll("[data-lkch-limpiar]").forEach(function (b) {
    b.addEventListener("click", function () {
      var s = _slotsLkCh.find(function (x) { return x.id === b.dataset.lkchLimpiar; });
      if (s) { s.cod = null; s.nombre = ""; s.ult = null; s.yaVinculado = false; }
      _renderSlotsLkCh();
    });
  });
}

function _wireSlotLkCh(box, slotId) {
  var inp = box.querySelector(".grupo-input");
  var cont = box.querySelector(".grupo-resultados");
  if (!inp || !cont) return;
  var timer = null;

  inp.addEventListener("input", function () {
    clearTimeout(timer);
    var q = inp.value.trim();
    if (q.length < 2) { cont.innerHTML = ""; return; }
    timer = setTimeout(function () { _buscarEnSlotLkCh(cont, q, slotId); }, 220);
  });
  inp.addEventListener("blur", function () {
    setTimeout(function () { cont.innerHTML = ""; }, 120);
  });
}

function _buscarEnSlotLkCh(cont, q, slotId) {
  cont.innerHTML = '<div class="grupo-res-vacio">Buscando…</div>';
  var slot = _slotsLkCh.find(function (x) { return x.id === slotId; });
  if (!slot) return;

  // La empresa va en la búsqueda, no como filtro visual: el mismo número es un
  // cliente distinto en cada una, así que buscar "2502" tiene dos respuestas.
  sb.rpc("buscar_clientes_lk_ch", { p_q: q, p_empresa: slot.empresa, p_limit: 25 })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var hits = resp.data || [];

      if (hits.length === 0) {
        cont.innerHTML = '<div class="grupo-res-vacio">Sin resultados</div>';
        return;
      }

      cont.innerHTML = hits
        .map(function (c) {
          return (
            '<button type="button" class="grupo-res" data-cod="' + _escGrupo(c.cod_cliente) + '">' +
            '<span class="est-cod">' + _escGrupo(c.cod_cliente) + "</span>" +
            '<span class="grupo-res-nom">' +
            _escGrupo(c.business_name || "(sin razón social)") +
            _badgeEmpresas(slot.empresa) +
            (c.ya_vinculado ? ' <span class="grupo-warn">ya vinculado</span>' : "") +
            "</span>" +
            '<span class="grupo-res-meta">' + _fmtFechaGrupo(c.last_date) + "</span>" +
            '<span class="grupo-res-val"></span>' +
            "</button>"
          );
        })
        .join("");

      cont.querySelectorAll(".grupo-res").forEach(function (b) {
        // mousedown y no click: el blur del input corre antes que el click.
        b.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          var c = hits.find(function (x) { return x.cod_cliente === b.dataset.cod; });
          if (c) {
            slot.cod = c.cod_cliente;
            slot.nombre = c.business_name;
            slot.ult = c.last_date;
            slot.yaVinculado = c.ya_vinculado;
          }
          _renderSlotsLkCh();
        });
      });
    })
    .catch(function (err) {
      console.error("_buscarEnSlotLkCh error", err);
      cont.innerHTML =
        '<div class="grupo-res-vacio">Error: ' + _escGrupo(err.message || err) + "</div>";
    });
}

function vincularLkCh() {
  var st = document.getElementById("lkchVincularStatus");
  var lk = _slotsLkCh.find(function (s) { return s.empresa === "lk"; });
  var ch = _slotsLkCh.find(function (s) { return s.empresa === "chef"; });

  if (!lk || !ch || !lk.cod || !ch.cod) {
    if (st) {
      st.innerHTML =
        '<span style="color:#c2410c">Elegí un código de Loekemeyer y uno de Chef.</span>';
    }
    return;
  }

  var btn = document.getElementById("lkchVincularBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Vinculando…"; }

  sb.rpc("vincular_lk_ch", { p_cod_lk: lk.cod, p_cod_chef: ch.cod })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _slotsLkCh = [
        { id: "lkchLk", empresa: "lk", cod: null, nombre: "", ult: null },
        { id: "lkchCh", empresa: "chef", cod: null, nombre: "", ult: null },
      ];
      _renderSlotsLkCh();
      if (st) st.innerHTML = '<span style="color:#1f7a3a">Vinculado.</span>';
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("vincularLkCh error", err);
      if (st) st.innerHTML = '<span style="color:#c0392b">' + _escGrupo(err.message || err) + "</span>";
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = "Vincular"; }
    });
}
window.vincularLkCh = vincularLkCh;

/* ---------- 3. Grupos armados ---------- */

function _renderGruposArmados(filas) {
  var cont = document.getElementById("gruposArmadosLista");
  var countEl = document.getElementById("gruposArmadosCount");
  if (!cont) return;

  _gruposArmadosCache = filas || [];

  // La RPC devuelve una fila por miembro; se juntan por grupo_id, y solo se
  // muestran los de la empresa elegida.
  var porGrupo = {};
  _gruposArmadosCache
    .filter(function (f) { return (f.empresa || "lk") === _empresaArmados; })
    .forEach(function (f) {
    if (!porGrupo[f.grupo_id]) porGrupo[f.grupo_id] = [];
    porGrupo[f.grupo_id].push(f);
  });
  var ids = Object.keys(porGrupo);
  if (countEl) countEl.textContent = ids.length;

  if (ids.length === 0) {
    cont.innerHTML =
      '<div class="grupo-sel-vacio">Todavía no hay grupos en ' +
      (_empresaArmados === "lk" ? "Loekemeyer" : "Chef") +
      '. Armá uno arriba o aceptá una sugerencia.</div>';
    return;
  }

  cont.innerHTML = ids
    .map(function (id) {
      var miembros = porGrupo[id];
      var total = miembros.reduce(function (a, m) {
        return a + (Number(m.valor_historico) || 0);
      }, 0);
      var vig = miembros.find(function (m) { return m.es_vigente; });
      return (
        '<div class="grupo-box">' +
        '<div class="grupo-box-head">' +
        "<strong>" + _escGrupo(vig ? (vig.business_name || vig.cod_cliente) : "(sin principal)") + "</strong>" +
        '<span class="grupo-box-meta">' + miembros.length + " razones sociales · histórico consolidado " +
        _fmtPesosGrupo(total) + "</span>" +
        '<button type="button" class="grupo-mini grupo-box-agregar" data-agregar="' +
          _escGrupo(id) + '">+ agregar cliente</button>' +
        '<button type="button" class="grupo-deshacer" data-deshacer="' + _escGrupo(id) + '">' +
        "Deshacer grupo</button>" +
        "</div>" +
        // Buscador para sumar una razón social al grupo ya armado. Arranca
        // oculto para no llenar la vista: se despliega con "+ agregar cliente".
        '<div class="grupo-box-alta" data-alta="' + _escGrupo(id) + '" style="display:none">' +
        '<div class="grupo-slot vacio">' +
        '<input type="text" class="grupo-input" autocomplete="off" ' +
          'placeholder="Código o razón social a sumar al grupo…">' +
        '<div class="grupo-resultados"></div>' +
        "</div></div>" +
        miembros
          .map(function (m) {
            return (
              '<div class="grupo-row' + (m.es_vigente ? " vigente" : "") + '">' +
              '<span class="est-cod">' + _escGrupo(m.cod_cliente) + "</span>" +
              '<span class="grupo-row-nom">' + _escGrupo(m.business_name || "(sin razón social)") +
                // La dirección de entrega va acá también, no solo en sugerencias:
                // cuando dos razones sociales comparten domicilio es la prueba
                // de que el grupo está bien armado.
                (m.direccion
                  ? '<span class="grupo-dir">📍 ' + _escGrupo(m.direccion) + "</span>"
                  : "") +
              "</span>" +
              '<span class="grupo-row-fecha">' + _fmtFechaGrupo(m.last_date) + "</span>" +
              '<span class="grupo-row-valor">' + _fmtPesosGrupo(m.valor_historico) + "</span>" +
              (m.es_vigente
                ? '<span class="grupo-badge">principal</span>'
                : '<button type="button" class="grupo-mini" data-vig-grupo="' + _escGrupo(id) +
                  '" data-vig-cod="' + _escGrupo(m.cod_cliente) + '">marcar principal</button>') +
              '<button type="button" class="grupo-mini quitar" data-sacar="' + _escGrupo(m.cod_cliente) +
                '" data-sacar-emp="' + _escGrupo(m.empresa || "lk") + '">✕ sacar</button>' +
              "</div>"
            );
          })
          .join("") +
        "</div>"
      );
    })
    .join("");

  cont.querySelectorAll("[data-vig-grupo]").forEach(function (b) {
    b.addEventListener("click", function () {
      var id = b.dataset.vigGrupo;
      var cods = porGrupo[id].map(function (m) { return m.cod_cliente; });
      _cambiarVigente(cods, b.dataset.vigCod, porGrupo[id][0].empresa);
    });
  });
  cont.querySelectorAll("[data-agregar]").forEach(function (b) {
    b.addEventListener("click", function () {
      var caja = cont.querySelector('[data-alta="' + b.dataset.agregar + '"]');
      if (!caja) return;
      var abierto = caja.style.display !== "none";
      caja.style.display = abierto ? "none" : "block";
      b.textContent = abierto ? "+ agregar cliente" : "cancelar";
      if (!abierto) {
        var inp = caja.querySelector(".grupo-input");
        if (inp) { inp.value = ""; inp.focus(); }
        _wireAltaGrupo(caja, porGrupo[b.dataset.agregar]);
      }
    });
  });
  cont.querySelectorAll("[data-sacar]").forEach(function (b) {
    b.addEventListener("click", function () {
      _sacarDeGrupo(b.dataset.sacar, b.dataset.sacarEmp);
    });
  });
  cont.querySelectorAll("[data-deshacer]").forEach(function (b) {
    b.addEventListener("click", function () {
      _deshacerGrupo(b.dataset.deshacer, porGrupo[b.dataset.deshacer]);
    });
  });
}

// Buscador para sumar una razón social a un grupo ya armado. Reusa
// guardar_customer_grupo, que ya sabe fusionar: si el código elegido pertenecía
// a otro grupo, los dos grupos quedan en uno solo en vez de pisarse.
function _wireAltaGrupo(caja, miembros) {
  var inp = caja.querySelector(".grupo-input");
  var res = caja.querySelector(".grupo-resultados");
  if (!inp || !res || inp.dataset.wired) return;
  inp.dataset.wired = "1";

  var timer = null;
  var yaEstan = miembros.map(function (m) { return m.cod_cliente; });
  var empGrupo = (miembros[0] && miembros[0].empresa) || "lk";
  var vig = miembros.find(function (m) { return m.es_vigente; });

  inp.addEventListener("blur", function () {
    setTimeout(function () { res.innerHTML = ""; }, 120);
  });
  inp.addEventListener("input", function () {
    clearTimeout(timer);
    var q = inp.value.trim();
    if (q.length < 2) { res.innerHTML = ""; return; }
    timer = setTimeout(function () {
      res.innerHTML = '<div class="grupo-res-vacio">Buscando…</div>';
      sb.rpc("buscar_clientes_para_grupo", { p_q: q, p_limit: 25, p_empresa: empGrupo })
        .then(function (resp) {
          if (resp.error) throw resp.error;
          var hits = (resp.data || []).filter(function (r) {
            return yaEstan.indexOf(r.cod_cliente) === -1;
          });
          if (hits.length === 0) {
            res.innerHTML = '<div class="grupo-res-vacio">Sin resultados</div>';
            return;
          }
          res.innerHTML = hits
            .map(function (c) {
              return (
                '<button type="button" class="grupo-res" data-cod="' + _escGrupo(c.cod_cliente) + '">' +
                '<span class="est-cod">' + _escGrupo(c.cod_cliente) + "</span>" +
                '<span class="grupo-res-nom">' +
                _escGrupo(c.business_name || "(sin razón social)") +
                _badgeEmpresas(c.empresas) +
                (c.ya_agrupado ? ' <span class="grupo-warn">ya agrupado</span>' : "") +
                "</span>" +
                '<span class="grupo-res-meta">' + _fmtFechaGrupo(c.last_date) + "</span>" +
                '<span class="grupo-res-val">' + _fmtPesosGrupo(c.valor_historico) + "</span>" +
                "</button>"
              );
            })
            .join("");

          res.querySelectorAll(".grupo-res").forEach(function (b) {
            // mousedown y no click: el blur del input corre antes que el click.
            b.addEventListener("mousedown", function (ev) {
              ev.preventDefault();
              var c = hits.find(function (x) { return x.cod_cliente === b.dataset.cod; });
              if (c) _agregarAGrupo(miembros, c);
            });
          });
        })
        .catch(function (err) {
          console.error("_wireAltaGrupo error", err);
          res.innerHTML =
            '<div class="grupo-res-vacio">Error: ' + _escGrupo(err.message || err) + "</div>";
        });
    }, 220);
  });

  // se guarda para el confirm
  caja._vigente = vig ? vig.cod_cliente : (miembros[0] || {}).cod_cliente;
}

function _agregarAGrupo(miembros, cliente) {
  var vig = miembros.find(function (m) { return m.es_vigente; });
  var principal = vig ? vig.cod_cliente : miembros[0].cod_cliente;
  var cods = miembros.map(function (m) { return m.cod_cliente; }).concat([cliente.cod_cliente]);

  if (!confirm(
    "Sumar " + cliente.cod_cliente + " — " +
    (cliente.business_name || "(sin razón social)") + " al grupo de " +
    (vig ? (vig.business_name || vig.cod_cliente) : principal) + ".\n\n" +
    (cliente.ya_agrupado
      ? "OJO: ya pertenece a otro grupo. Los dos grupos se fusionan en uno solo.\n\n"
      : "") +
    "La principal sigue siendo " + principal + ".\n\n¿Confirmás?"
  )) return;

  sb.rpc("guardar_customer_grupo", {
      p_cods: cods,
      p_cod_vigente: principal,
      p_nota: "Agregado a mano",
      p_empresa: (miembros[0] && miembros[0].empresa) || _empresaGrupo,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_agregarAGrupo error", err);
      alert("No se pudo agregar: " + (err.message || err));
    });
}

function _deshacerGrupo(grupoId, miembros) {
  if (!confirm(
    "Deshacer el grupo de " + miembros.length + " razones sociales:\n\n" +
    miembros.map(function (m) {
      return "  " + m.cod_cliente + " — " + (m.business_name || "(sin razón social)");
    }).join("\n") +
    "\n\nCada una vuelve a contar por separado y, si está inactiva, reaparece " +
    "en Ranking Inactivos con su propio histórico. No se toca ningún dato de " +
    "venta: es reversible volviendo a agruparlas.\n\n¿Confirmás?"
  )) return;

  sb.rpc("deshacer_customer_grupo", { p_grupo_id: grupoId })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_deshacerGrupo error", err);
      alert("No se pudo deshacer el grupo: " + (err.message || err));
    });
}

function _cambiarVigente(cods, codPrincipal, empresa) {
  if (!confirm("El histórico del grupo va a pasar a " + codPrincipal + ".\n¿Confirmás?")) return;
  sb.rpc("guardar_customer_grupo", {
      p_cods: cods,
      p_cod_vigente: codPrincipal,
      p_nota: null,
      p_empresa: empresa || _empresaGrupo,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_cambiarVigente error", err);
      alert("No se pudo cambiar la principal: " + (err.message || err));
    });
}

function _sacarDeGrupo(cod, empresa) {
  if (!confirm(
    "Sacar " + cod + " del grupo.\n\n" +
    "Vuelve a contar por separado y, si estaba inactivo, reaparece en Ranking " +
    "Inactivos con su propio histórico.\n\n¿Confirmás?"
  )) return;
  sb.rpc("quitar_de_customer_grupo", { p_cod: cod, p_empresa: empresa || _empresaGrupo })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      return cargarGruposClientes();
    })
    .catch(function (err) {
      console.error("_sacarDeGrupo error", err);
      alert("No se pudo sacar del grupo: " + (err.message || err));
    });
}

/* =========================================================
   ADMIN — Historial de Cliente (embed via iframe)
   ========================================================= */
// Helper: oculta la card de búsqueda y agrega un mini topbar dentro del
// embed-card con el botón "Cambiar cliente" — sin overlap del iframe.
function _renderCompactBar(card, cod, closeFn) {
  card.style.display = "none";
  var section = card.closest("section.page");
  if (!section) return;
  var embed = section.querySelector(".cliente-embed-card");
  if (!embed) return;
  var existing = embed.querySelector(".cliente-embed-topbar");
  if (existing) existing.remove();
  var bar = document.createElement("div");
  bar.className = "cliente-embed-topbar";
  bar.innerHTML =
    '<button type="button" class="cliente-embed-change-btn" onclick="' + closeFn + '">' +
    '<span aria-hidden="true">←</span> Cambiar cliente' +
    '</button>';
  embed.insertBefore(bar, embed.firstChild);
}
// Helper: restaurar la card de búsqueda + remover botón flotante
function _restoreLookupForm(card, inputId, btnFn) {
  card.style.display = "";
  card.classList.remove("compact");
  card.innerHTML =
    '<div class="cliente-lookup-field">' +
    '<label for="' + inputId + '">Código de cliente</label>' +
    '<div class="cliente-lookup-row">' +
    '<input type="text" id="' + inputId + '" placeholder="Ej: 4234" inputmode="numeric" autocomplete="off">' +
    '<button type="button" class="cliente-lookup-btn" onclick="' + btnFn + '">Buscar</button>' +
    '</div>' +
    '</div>' +
    '<div id="' + inputId.replace("CodInput", "Status") + '" class="cliente-lookup-status"></div>';
  // Remover topbar del embed-card si existe
  var section = card.closest("section.page");
  if (section) {
    var embed = section.querySelector(".cliente-embed-card");
    if (embed) {
      var topbar = embed.querySelector(".cliente-embed-topbar");
      if (topbar) topbar.remove();
    }
  }
  setTimeout(function () {
    var inp = document.getElementById(inputId);
    if (inp) inp.focus();
  }, 50);
}

function cargarHistorialClienteAdmin() {
  var input = document.getElementById("histClienteCodInput");
  var embed = document.getElementById("histClienteEmbedCard");
  var iframe = document.getElementById("histClienteIframe");
  var card = document.querySelector("#historial-cliente .cliente-lookup-card");
  if (!input || !iframe) return;
  var cod = String(input.value || "").trim();
  if (!cod) {
    var status = document.getElementById("histClienteStatus");
    if (status) {
      status.textContent = "Ingresá un código de cliente.";
      status.className = "cliente-lookup-status err";
    }
    return;
  }
  // Ruta relativa y CON extensión, igual que el resto de la app: no hay regla
  // de reescritura de URLs sin extensión en IIS, así que "/historial" daba 404.
  iframe.src = "historial.html?cod=" + encodeURIComponent(cod);
  if (embed) embed.style.display = "";
  if (card) _renderCompactBar(card, cod, "cerrarHistorialClienteAdmin()");
}
function cerrarHistorialClienteAdmin() {
  var embed = document.getElementById("histClienteEmbedCard");
  var iframe = document.getElementById("histClienteIframe");
  var card = document.querySelector("#historial-cliente .cliente-lookup-card");
  if (iframe) iframe.src = "";
  if (embed) embed.style.display = "none";
  if (card) _restoreLookupForm(card, "histClienteCodInput", "cargarHistorialClienteAdmin()");
}
window.cargarHistorialClienteAdmin = cargarHistorialClienteAdmin;
window.cerrarHistorialClienteAdmin = cerrarHistorialClienteAdmin;

/* =========================================================
   ADMIN — Sugerencias x IA (embed via iframe)
   ========================================================= */
function cargarSugerenciasClienteAdmin() {
  var input = document.getElementById("sugClienteCodInput");
  var embed = document.getElementById("sugClienteEmbedCard");
  var iframe = document.getElementById("sugClienteIframe");
  var card = document.querySelector("#sugerencias-cliente .cliente-lookup-card");
  if (!input || !iframe) return;
  var cod = String(input.value || "").trim();
  if (!cod) {
    var status = document.getElementById("sugClienteStatus");
    if (status) {
      status.textContent = "Ingresá un código de cliente.";
      status.className = "cliente-lookup-status err";
    }
    return;
  }
  // Mismo caso que en Historial de Cliente: ruta relativa y con extensión.
  iframe.src = "sugerencias.html?cod=" + encodeURIComponent(cod);
  if (embed) embed.style.display = "";
  if (card) _renderCompactBar(card, cod, "cerrarSugerenciasClienteAdmin()");
}
function cerrarSugerenciasClienteAdmin() {
  var embed = document.getElementById("sugClienteEmbedCard");
  var iframe = document.getElementById("sugClienteIframe");
  var card = document.querySelector("#sugerencias-cliente .cliente-lookup-card");
  if (iframe) iframe.src = "";
  if (embed) embed.style.display = "none";
  if (card) _restoreLookupForm(card, "sugClienteCodInput", "cargarSugerenciasClienteAdmin()");
}
window.cargarSugerenciasClienteAdmin = cargarSugerenciasClienteAdmin;
window.cerrarSugerenciasClienteAdmin = cerrarSugerenciasClienteAdmin;

// Enter en los inputs ejecuta búsqueda
document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  if (e.target.id === "histClienteCodInput") {
    cargarHistorialClienteAdmin();
  } else if (e.target.id === "sugClienteCodInput") {
    cargarSugerenciasClienteAdmin();
  }
});

/* =========================================================
   ESTADÍSTICA MADRE — unidades x mes por artículo
   - Trae v_customer_item_month (cod_cliente, ym, item_code, boxes)
   - Cruza con products para uxb por código
   - Agrupa por (item_code, ym) sumando boxes × uxb = unidades
   - Renderiza tabla cod / desc / total / mes1...mesN
   ========================================================= */
// Parámetros del cálculo de proyección. Tunear acá sin tocar la lógica.
var EM_PROY_WINDOW = 24;        // Meses hacia atrás para calcular proyección
var EM_DISRUPT_RATIO = 1.5;     // Mes con units > ratio × promedio crudo = candidato disruptivo
var EM_RECURRING_SIM = 0.8;     // Si otro mes tiene ≥ ratio × monto del candidato → es recurrente, no disruptivo
var EM_PROGRESSIVE_THR = 0.5;   // Si el mes previo tiene ≥ ratio × monto del candidato → es crecimiento progresivo, no disruptivo
// Clientes a EXCLUIR de todos los cálculos: cuentas internas / de prueba
// (1 = Loekemeyer SRL, 3878 = Tierra Nativa SA — usadas para tests en la web).
// Se aplica a TODAS las fuentes en addRow para consistencia.
var EM_EXCLUDED_CUSTOMERS = ["1", "3878"];

var _estMadreData = null; // [{ cod, desc, totalUnits, byYm: { "YYYY-MM": units } }] — vista actual (recortada por dropdown)
var _estMadreYms = [];    // array de ym de la vista actual (desc, mes reciente primero)
var _estMadreFullByCod = null; // cache: data completa indexada por item_code (todos los meses)
var _estMadreFullYms = null;   // cache: lista completa de ym ordenada asc
var _estMadreFullProjByItem = null; // cache: proyección por item calculada server-side cliente-a-cliente. null = no data por cliente, fallback a fórmula vieja.
var _estMadreSource = "";      // último dataSource exitoso (para mostrar en status)
var _estMadreSourceHasCustomer = false; // true si la fuente que respondió incluyó cod_cliente
var _estMadreLoadedAt = null;  // timestamp del último fetch exitoso
// Sort actual del display. col: 'rank' | 'cod' | 'familia'. dir: 'asc' | 'desc'.
// Default rank ASC = mejor ranking primero (mayor proy).
var _estMadreSort = { col: "rank", dir: "asc" };

// Trae TODOS los cod_cliente paginando con .range(): el REST de Supabase corta
// en 1000 filas sin dar error, y customers ya pasa ese número. Excluye los
// códigos internos ("1" y "3878").
async function fetchAllCustomerCods() {
  var cods = [];
  var page = 0;
  while (true) {
    var resp = await sb
      .from("customers")
      .select("cod_cliente")
      .order("id", { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (resp.error) throw resp.error;
    var batch = resp.data || [];
    batch.forEach(function (c) {
      var cc = String(c.cod_cliente || "").trim();
      if (cc && cc !== "1" && cc !== "3878") cods.push({ cod_cliente: cc });
    });
    if (batch.length < 1000) break;
    page++;
    if (page > 50) break; // safety
  }
  return cods;
}

async function cargarEstadisticaMadre(forceReload) {
  var status = document.getElementById("estMadreStatus");

  // Cache hit → solo re-renderizar con el rango actual, sin refetch.
  // El dropdown de meses dispara esta función, no necesita re-bajar todo.
  // Cache vacío ({}) NO cuenta como hit — permite que "Reintentar" refetchee tras un load fallido.
  if (!forceReload && _estMadreFullByCod && _estMadreFullYms &&
      Object.keys(_estMadreFullByCod).length > 0) {
    aplicarRangoEstadisticaMadre();
    return;
  }

  if (status) {
    status.textContent = "Cargando datos…";
    status.className = "cliente-lookup-status";
    // Ocultar el status de arriba mientras carga — el loader del medio ya
    // muestra el progreso (evita duplicar mensaje)
    status.style.display = "none";
  }
  // Loader independiente fuera de la tabla (la tabla tiene width:max-content
  // que evita que un td colspan ocupe todo el ancho del wrapper)
  var tableWrap = document.querySelector(".est-madre-table-wrap");
  var tableEl = document.getElementById("estMadreTable");
  var existingLoader = document.getElementById("estMadreLoader");
  if (existingLoader) existingLoader.remove();
  if (tableWrap) {
    if (tableEl) tableEl.style.display = "none";
    var loaderDiv = document.createElement("div");
    loaderDiv.id = "estMadreLoader";
    loaderDiv.innerHTML =
      '<div class="em-loader">' +
      '<div class="em-spinner"></div>' +
      '<div class="em-loader-text" id="emLoaderText">Cargando datos…</div>' +
      '</div>';
    tableWrap.appendChild(loaderDiv);
  }

  // Sincronizar el texto del loader con cualquier actualización del status,
  // así "Cargando... X filas" se refleja también al lado del spinner.
  if (status && !status.__emObserverWired) {
    status.__emObserverWired = true;
    var emObserver = new MutationObserver(function () {
      var lt = document.getElementById("emLoaderText");
      if (lt && status.textContent) lt.textContent = status.textContent;
    });
    emObserver.observe(status, { childList: true, characterData: true, subtree: true });
  }

  try {
    // 1) Productos para uxb + descripcion + categoría (familia)
    var prodResp = await sb
      .from("products")
      .select("cod, description, uxb, active, category");
    if (prodResp.error) throw prodResp.error;
    var productByCod = {};
    (prodResp.data || []).forEach(function (p) {
      var k = String(p.cod || "").trim().toUpperCase();
      if (!k) return;
      productByCod[k] = {
        cod: p.cod,
        desc: p.description || k,
        uxb: Number(p.uxb) || 1,
        active: p.active !== false,
        familia: p.category || "—",
      };
    });

    // 1.b) Línea Loke: completar códigos que no están en products (familia "Loke").
    var lokeResp = await sb.from("loke_products").select("cod, description, uxb");
    (lokeResp.data || []).forEach(function (p) {
      var k = String(p.cod || "").trim().toUpperCase();
      if (!k || productByCod[k]) return; // products tiene prioridad
      productByCod[k] = { cod: p.cod, desc: p.description || k, uxb: Number(p.uxb) || 1, active: true, familia: "Loke" };
    });

    // 1.c) Remaps y exclusiones — mismas reglas (tablas) que el RPC fn_proyeccion_madre,
    //      para que el módulo y el RPC nunca se desincronicen.
    var remapMap = {};
    var remapResp = await sb.from("sales_item_remap").select("from_code, to_code");
    (remapResp.data || []).forEach(function (r) {
      var f = String(r.from_code || "").trim().toUpperCase();
      if (f) remapMap[f] = String(r.to_code || "").trim().toUpperCase();
    });
    var excludedSet = {};
    var exclResp = await sb.from("sales_excluded_items").select("item_code");
    (exclResp.data || []).forEach(function (e) {
      var c = String(e.item_code || "").trim().toUpperCase();
      if (c) excludedSet[c] = true;
    });

    // 1.d) CAMINO RÁPIDO: caché materializada (proyección + agregado mensual
    //      precomputados server-side por cron — ver sql/estadistica_madre_cache.sql).
    //      Si el RPC existe y trae filas, salteamos TODA la descarga por-cliente y
    //      el cálculo de proyección en JS (que es lo que hace lento el módulo).
    //      La proyección viene de fn_proyeccion_madre (misma lógica, una sola fuente
    //      de verdad). Si el RPC no existe / está vacío, caemos al cascade de abajo
    //      sin cambiar nada del comportamiento actual.
    try {
      if (status) status.textContent = "Cargando caché de estadística…";
      var cacheResp = await sb.rpc("get_estadistica_madre_cache");
      if (!cacheResp.error && Array.isArray(cacheResp.data) && cacheResp.data.length > 0) {
        var cByCod = {};
        var cProj = {};
        var cYms = {};
        var cCalcAt = null;
        cacheResp.data.forEach(function (r) {
          var k = String(r.cod || "").trim().toUpperCase();
          if (!k) return;
          var prod = productByCod[k];
          var meses = r.meses || {}; // jsonb { "2025-01": unidades, ... }
          var byYm = {};
          var total = 0;
          Object.keys(meses).forEach(function (ym) {
            if (!/^\d{4}-\d{2}$/.test(ym)) return;
            var u = Number(meses[ym]) || 0;
            byYm[ym] = u;
            total += u;
            cYms[ym] = true;
          });
          cByCod[k] = {
            cod: prod ? prod.cod : (r.cod || k),
            desc: prod ? prod.desc : (r.descripcion || k),
            familia: prod ? prod.familia : (r.familia || "—"),
            totalUnits: total,
            byYm: byYm,
          };
          cProj[k] = Number(r.proy_uni_mes) || 0;
          if (!cCalcAt && r.calculado_at) cCalcAt = r.calculado_at;
        });
        if (Object.keys(cByCod).length > 0) {
          _estMadreFullByCod = cByCod;
          _estMadreFullYms = Object.keys(cYms).sort(); // asc
          _estMadreFullProjByItem = cProj;
          _estMadreSource = "caché materializada";
          _estMadreSourceHasCustomer = true;
          _estMadreLoadedAt = cCalcAt ? new Date(cCalcAt) : new Date();
          console.log("[estMadre] caché materializada:", Object.keys(cByCod).length, "artículos");
          aplicarRangoEstadisticaMadre();
          return; // listo — no bajamos por-cliente ni recalculamos en JS
        }
      }
    } catch (cacheErr) {
      console.warn("[estMadre] caché no disponible, uso cascade en vivo:", cacheErr.message);
    }

    // 2) Cargar TODAS las fuentes en cascada — primer éxito gana.
    // Orden: customer-aware primero (necesario para proyección por cliente).
    // Si solo responde una fuente customer-blind, la proyección degrada a la fórmula vieja.
    var allRows = [];
    var dataSource = "none";
    var hasCustomer = false; // true si la fuente que respondió incluye cod_cliente por fila

    // 2.a) PRIMARIA: RPC get_all_sales_lines_admin_with_customer
    // SECURITY DEFINER en Supabase — bypasea RLS de sales_lines.
    // Pre-agrega por (customer_code, item_code, ym) → poco volumen, rápido.
    // Si la función no existe / no sos admin, falla y cae al N+1.
    try {
      if (status) status.textContent = "Cargando datos (RPC admin con cliente)…";
      var rpcRows = [];
      var rpcPage = 0;
      while (true) {
        var rpcResp = await sb
          .rpc("get_all_sales_lines_admin_with_customer")
          .range(rpcPage * 1000, (rpcPage + 1) * 1000 - 1);
        if (rpcResp.error) throw rpcResp.error;
        var rpcBatch = rpcResp.data || [];
        rpcBatch.forEach(function (row) {
          var item = String(row.item_code || "").trim().toUpperCase();
          var prod = productByCod[item];
          var uxb = prod ? prod.uxb : 1;
          rpcRows.push({
            item_code: row.item_code,
            ym: String(row.ym || ""),
            unidades: (Number(row.boxes) || 0) * uxb,
            customer_code: row.customer_code != null ? String(row.customer_code) : null,
          });
        });
        if (status) status.textContent = "Cargando datos… " + rpcRows.length + " filas agregadas";
        if (rpcBatch.length < 1000) break;
        rpcPage++;
        if (rpcPage > 500) break;
      }
      console.log("[estMadre] get_all_sales_lines_admin_with_customer rows:", rpcRows.length);
      if (rpcRows.length > 0) {
        allRows = rpcRows;
        dataSource = "RPC admin con cliente";
        hasCustomer = true;
      }
    } catch (rpcWcErr) {
      console.warn("[estMadre] get_all_sales_lines_admin_with_customer failed:", rpcWcErr.message);
    }

    // 2.b) FALLBACK customer-aware: get_customer_history RPC per-customer (N+1, lento)
    if (allRows.length === 0) {
      if (status) status.textContent = "Cargando vía get_customer_history…";
      try {
        var customers2 = await fetchAllCustomerCods();
        console.log("[estMadre] customers count for get_customer_history:", customers2.length);
        var ghRows = [];
        var BATCH2 = 16;
        for (var i2 = 0; i2 < customers2.length; i2 += BATCH2) {
          var slice2 = customers2.slice(i2, i2 + BATCH2);
          var results2 = await Promise.all(
            slice2.map(function (c) {
              return sb.rpc("get_customer_history", {
                p_cod_cliente: String(c.cod_cliente),
              }).then(function (rr) {
                if (rr.error) return [];
                return (rr.data || []).map(function (row) {
                  var item = String(row.item_code || "").trim().toUpperCase();
                  var prod = productByCod[item];
                  var uxb = prod ? prod.uxb : 1;
                  return {
                    item_code: row.item_code,
                    ym: String(row.ym || ""),
                    unidades: (Number(row.boxes) || 0) * uxb,
                    customer_code: String(c.cod_cliente),
                  };
                });
              });
            })
          );
          results2.forEach(function (rows) { ghRows = ghRows.concat(rows); });
          if (status) {
            var pct2 = Math.round(((i2 + BATCH2) / customers2.length) * 100);
            if (pct2 > 100) pct2 = 100;
            status.textContent = "Cargando vía get_customer_history… " + pct2 + "%";
          }
        }
        console.log("[estMadre] get_customer_history rows:", ghRows.length);
        if (ghRows.length > 0) {
          allRows = ghRows;
          dataSource = "get_customer_history (RPC con cliente)";
          hasCustomer = true;
        }
      } catch (ghErr) {
        console.warn("[estMadre] get_customer_history failed:", ghErr.message);
      }
    }

    // 2.c) FALLBACK customer-aware: get_customer_sales_history RPC per-customer (N+1, lento)
    if (allRows.length === 0) {
      try {
        if (status) status.textContent = "Cargando vía get_customer_sales_history…";
        var customers = await fetchAllCustomerCods();
        console.log("[estMadre] customers count for RPC:", customers.length);
        var rpcRows = [];
        var BATCH = 16;
        for (var i = 0; i < customers.length; i += BATCH) {
          var slice = customers.slice(i, i + BATCH);
          var results = await Promise.all(
            slice.map(function (c) {
              return sb.rpc("get_customer_sales_history", {
                p_customer_code: String(c.cod_cliente),
              }).then(function (rr) {
                if (rr.error) return [];
                return (rr.data || []).map(function (sl) {
                  var fecha = sl.fecha || sl.date || sl.invoice_date || sl.fecha_venta;
                  if (!fecha) return null;
                  var d = new Date(fecha);
                  if (isNaN(d.getTime())) return null;
                  var ym = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
                  return {
                    item_code: sl.item_code || sl.cod || sl.codigo || sl.product_code,
                    ym: ym,
                    unidades: Number(sl.unidades) || Number(sl.qty) || Number(sl.cantidad) || Number(sl.quantity) || 0,
                    customer_code: String(c.cod_cliente),
                  };
                }).filter(Boolean);
              });
            })
          );
          results.forEach(function (rows) { rpcRows = rpcRows.concat(rows); });
          if (status) {
            var pct = Math.round(((i + BATCH) / customers.length) * 100);
            if (pct > 100) pct = 100;
            status.textContent = "Cargando vía get_customer_sales_history… " + pct + "%";
          }
        }
        console.log("[estMadre] sales_history RPC rows:", rpcRows.length);
        if (rpcRows.length > 0) {
          allRows = rpcRows;
          dataSource = "get_customer_sales_history (RPC con cliente)";
          hasCustomer = true;
        }
      } catch (rpcErr) {
        console.warn("[estMadre] sales_history RPC failed:", rpcErr.message);
      }
    }

    // 2.d) FALLBACK PROFUNDO customer-blind: get_all_sales_lines_admin (proyección degrada)
    if (allRows.length === 0) {
      try {
        if (status) status.textContent = "Cargando get_all_sales_lines_admin… (sin data por cliente)";
        var adminRows = [];
        var adminPage = 0;
        while (true) {
          var adminRpcResp = await sb
            .rpc("get_all_sales_lines_admin")
            .range(adminPage * 1000, (adminPage + 1) * 1000 - 1);
          if (adminRpcResp.error) throw adminRpcResp.error;
          var adminBatch = adminRpcResp.data || [];
          adminBatch.forEach(function (row) {
            var ym = String(row.ym || "").trim();
            if (!/^\d{4}-\d{2}$/.test(ym)) return;
            var iCod = String(row.item_code || "").trim().toUpperCase();
            var prod = productByCod[iCod];
            adminRows.push({
              item_code: row.item_code,
              ym: ym,
              unidades: (Number(row.boxes) || 0) * (prod ? prod.uxb : 1),
              customer_code: null,
            });
          });
          if (status) status.textContent = "Cargando get_all_sales_lines_admin… " + adminRows.length + " reg";
          if (adminBatch.length < 1000) break;
          adminPage++;
          if (adminPage > 100) break;
        }
        console.log("[estMadre] get_all_sales_lines_admin rows:", adminRows.length);
        if (adminRows.length > 0) {
          allRows = adminRows;
          dataSource = "sales_lines admin RPC (sin cliente)";
        }
      } catch (adminRpcErr) {
        console.warn("[estMadre] get_all_sales_lines_admin failed:", adminRpcErr.message);
      }
    }

    if (allRows.length === 0) {
      console.warn("[estMadre] TODAS las fuentes devolvieron 0 rows");
    } else {
      console.log("[estMadre] Fuente final:", dataSource, "·", allRows.length, "rows");
    }

    // 3) Agregar:
    //    - byCod[item].byYm[ym] = total units (todos los clientes) — para columnas mensuales y totales.
    //    - byCustItem[item][customer].byYm[ym] = units por cliente — para proyección por cliente.
    var allYms = {};
    var byCod = {};
    var byCustItem = {}; // { item: { customer: { ym: units } } }
    function addRow(item, ym, units, customer) {
      if (!item || !ym || units <= 0) return;
      // Excluir cuentas internas/de prueba (Loekemeyer SRL, Tierra Nativa SA).
      // Se aplica acá para ser consistente entre fuentes.
      if (customer && EM_EXCLUDED_CUSTOMERS.indexOf(String(customer).trim()) !== -1) return;
      var prod = productByCod[item];
      allYms[ym] = true;
      if (!byCod[item]) {
        byCod[item] = {
          cod: prod ? prod.cod : item,
          desc: prod ? prod.desc : item,
          familia: prod ? prod.familia : "—",
          totalUnits: 0,
          byYm: {},
        };
      }
      var b = byCod[item];
      b.totalUnits += units;
      b.byYm[ym] = (b.byYm[ym] || 0) + units;

      if (customer) {
        if (!byCustItem[item]) byCustItem[item] = {};
        if (!byCustItem[item][customer]) byCustItem[item][customer] = {};
        byCustItem[item][customer][ym] = (byCustItem[item][customer][ym] || 0) + units;
      }
    }
    allRows.forEach(function (row) {
      var item = String(row.item_code || "").trim().toUpperCase();
      if (excludedSet[item]) return;             // descuentos / no-productos
      if (remapMap[item]) item = remapMap[item];  // consolidar ventas mal-codeadas
      var cust = row.customer_code ? String(row.customer_code).trim() : null;
      addRow(item, String(row.ym || ""), Number(row.unidades) || 0, cust);
    });

    // 4) Guardar cache completo (todos los meses, sin recortar).
    //    El recorte por dropdown y el render se hacen en aplicarRangoEstadisticaMadre.
    _estMadreFullByCod = byCod;
    _estMadreFullYms = Object.keys(allYms).sort(); // asc
    _estMadreSource = dataSource;
    _estMadreSourceHasCustomer = hasCustomer;
    _estMadreLoadedAt = new Date();

    // Precomputar proyección por item — una sola vez por fetch.
    // Si la fuente tiene cliente, usa algoritmo nuevo (24 meses, disruptivos excluidos).
    // Si no, deja null y aplicarRangoEstadisticaMadre cae a la fórmula vieja.
    if (hasCustomer) {
      _estMadreFullProjByItem = _computeEstMadreProjections(byCustItem, _estMadreFullYms);
    } else {
      _estMadreFullProjByItem = null;
    }

    aplicarRangoEstadisticaMadre();
  } catch (e) {
    console.error("cargarEstadisticaMadre error", e);
    // Restaurar UI en caso de error: ocultar loader, mostrar status
    var loErr = document.getElementById("estMadreLoader");
    if (loErr) loErr.remove();
    var tElErr = document.getElementById("estMadreTable");
    if (tElErr) tElErr.style.display = "";
    if (status) {
      status.textContent = "Error: " + (e.message || e);
      status.className = "cliente-lookup-status err";
      status.style.display = "";
    }
  }
}
window.cargarEstadisticaMadre = cargarEstadisticaMadre;

// Re-aplica el rango del dropdown y re-renderiza usando _estMadreFullByCod
// (cache poblado por cargarEstadisticaMadre). NO hace fetch.
function aplicarRangoEstadisticaMadre() {
  if (!_estMadreFullByCod || !_estMadreFullYms) return;

  var status = document.getElementById("estMadreStatus");
  var monthsSel = document.getElementById("estMadreMonths");
  var monthsRange = monthsSel ? Number(monthsSel.value) : 24;

  // Slice de ym según rango — orden DESC (mes más reciente primero)
  var sortedYms = _estMadreFullYms.slice();
  if (monthsRange > 0 && sortedYms.length > monthsRange) {
    sortedYms = sortedYms.slice(-monthsRange);
  }
  sortedYms.reverse();

  // Array de items
  var items = Object.values(_estMadreFullByCod);

  // Proyección: usar la cacheada (algoritmo por cliente, ventana fija de 24 meses) si está.
  // Si no (fuente customer-blind), fallback a fórmula vieja: avg de últimos 3 meses visibles.
  if (_estMadreFullProjByItem) {
    items.forEach(function (it) {
      var key = String(it.cod || "").trim().toUpperCase();
      it._proy = Number(_estMadreFullProjByItem[key]) || 0;
    });
  } else {
    var last3 = sortedYms.slice(0, 3);
    items.forEach(function (it) {
      var sum = 0;
      last3.forEach(function (ym) { sum += Number(it.byYm[ym] || 0); });
      it._proy = last3.length > 0 ? sum / last3.length : 0;
    });
  }

  // Ranking estable basado en proy DESC — se computa siempre, no depende del sort del display.
  // Ranking 1 = el que más vende (mayor proyección).
  var ranked = items.slice().sort(function (a, b) { return b._proy - a._proy; });
  ranked.forEach(function (it, idx) { it._rank = idx + 1; });

  // Sort de display según _estMadreSort
  _applyEstMadreSort(items);

  _estMadreData = items;
  _estMadreYms = sortedYms;

  _renderEstMadreTable(items, sortedYms);

  // Ocultar loader + restaurar tabla y status al terminar la carga
  var lo = document.getElementById("estMadreLoader");
  if (lo) lo.remove();
  var tEl = document.getElementById("estMadreTable");
  if (tEl) tEl.style.display = "";

  if (status) {
    var srcSuffix = _estMadreSource && _estMadreSource !== "none" ? " · fuente: " + _estMadreSource : "";
    var when = _estMadreLoadedAt ? _estMadreLoadedAt.toLocaleTimeString("es-AR") : new Date().toLocaleTimeString("es-AR");
    status.textContent =
      items.length + " artículos · " +
      sortedYms.length + " meses · " +
      "actualizado " + when +
      srcSuffix;
    status.className = "cliente-lookup-status";
    status.style.display = "";
  }

  // Rellenar dropdown de meses para descargar disruptivas
  _actualizarSelectorMesesDisruptivas();
}
window.aplicarRangoEstadisticaMadre = aplicarRangoEstadisticaMadre;

// Rellena el dropdown de meses disponibles para descargar
function _actualizarSelectorMesesDisruptivas() {
  var select = document.getElementById("estMadreDisruptivasMonth");
  if (!select || !_estMadreYms) return;

  select.innerHTML = '<option value="">Seleccionar mes...</option>';
  _estMadreYms.forEach(function(ym) {
    var option = document.createElement("option");
    option.value = ym;
    option.textContent = ym;
    select.appendChild(option);
  });
}

// Aplica _estMadreSort.col/_estMadreSort.dir al array de items in-place.
// Sortable: rank (= proy), cod, familia.
function _applyEstMadreSort(items) {
  var col = _estMadreSort.col;
  var dir = _estMadreSort.dir === "asc" ? 1 : -1;
  if (col === "cod") {
    items.sort(function (a, b) {
      var ca = String(a.cod || "");
      var cb = String(b.cod || "");
      return ca.localeCompare(cb, "es", { numeric: true }) * dir;
    });
  } else if (col === "familia") {
    items.sort(function (a, b) {
      var fa = String(a.familia || "").toLowerCase();
      var fb = String(b.familia || "").toLowerCase();
      var c = fa.localeCompare(fb, "es");
      if (c !== 0) return c * dir;
      return (a._rank || 0) - (b._rank || 0); // tiebreak: mejor ranking primero
    });
  } else {
    // rank — dir asc = mejor primero (rank 1, 2, 3)
    items.sort(function (a, b) {
      return ((a._rank || 0) - (b._rank || 0)) * dir;
    });
  }
}

// Click en header → toggle dir si misma col, o cambiar col con dir default 'asc'.
function setEstMadreSort(col) {
  if (_estMadreSort.col === col) {
    _estMadreSort.dir = _estMadreSort.dir === "asc" ? "desc" : "asc";
  } else {
    _estMadreSort.col = col;
    _estMadreSort.dir = "asc";
  }
  // Re-aplicar — usa cache, no refetch
  aplicarRangoEstadisticaMadre();
}
window.setEstMadreSort = setEstMadreSort;

// Calcula proyección mensual por item usando la ventana de EM_PROY_WINDOW meses
// hacia atrás, por cliente, restando meses disruptivos del numerador
// (denominador = N = meses desde primera compra de ese cliente).
//
// Per cada (cliente, item):
//   1. Toma ventana de últimos EM_PROY_WINDOW meses (con ceros para meses sin compra).
//   2. Encuentra primer mes con actividad. Si no hay, no aporta.
//   3. N = meses desde primera actividad hasta el último mes de la ventana.
//   4. raw_avg = sum(active) / N.
//   5. Detecta meses disruptivos (units > 1.5*raw_avg) y los marca como tales,
//      excepto si: (a) algún otro mes tiene ≥ EM_RECURRING_SIM × este monto (recurrente)
//                  o (b) el mes anterior tiene ≥ EM_PROGRESSIVE_THR × este monto (crecimiento progresivo).
//   6. per_customer_proj = (sum(active) - sum(disruptivos)) / N.
//
// Proyección del item = suma de per_customer_proj de todos sus clientes.
//
// Retorna: { itemKey: projection }. itemKey = item_code uppercase.
function _computeEstMadreProjections(byCustItem, allYmsAsc) {
  if (!byCustItem || !allYmsAsc || allYmsAsc.length === 0) return {};

  // Ventana de meses (los últimos EM_PROY_WINDOW de la lista asc, padded si hay menos).
  var ymsWindow = allYmsAsc.slice(-EM_PROY_WINDOW);
  var W = ymsWindow.length;

  var projByItem = {};

  Object.keys(byCustItem).forEach(function (item) {
    var perCustomer = byCustItem[item];
    var itemProj = 0;

    Object.keys(perCustomer).forEach(function (customer) {
      var byYm = perCustomer[customer];

      // Build series para la ventana (oldest to newest)
      var series = new Array(W);
      for (var i = 0; i < W; i++) {
        series[i] = Number(byYm[ymsWindow[i]] || 0);
      }

      // Encontrar primer índice con actividad
      var firstIdx = -1;
      for (var k = 0; k < W; k++) {
        if (series[k] > 0) { firstIdx = k; break; }
      }
      if (firstIdx < 0) return; // sin compras en la ventana — no aporta

      var active = series.slice(firstIdx);
      var N = active.length;
      var sumActive = 0;
      for (var s = 0; s < N; s++) sumActive += active[s];
      if (sumActive <= 0) return;

      var rawAvg = sumActive / N;
      var disruptThr = rawAvg * EM_DISRUPT_RATIO;

      // Detectar meses disruptivos
      var disruptiveSum = 0;
      for (var idx = 0; idx < N; idx++) {
        var val = active[idx];
        if (val <= disruptThr) continue;

        // Recurrente? otro mes con ≥ EM_RECURRING_SIM × val
        var recurring = false;
        var simThr = val * EM_RECURRING_SIM;
        for (var j = 0; j < N; j++) {
          if (j === idx) continue;
          if (active[j] >= simThr) { recurring = true; break; }
        }
        if (recurring) continue;

        // Progresivo? mes previo con ≥ EM_PROGRESSIVE_THR × val
        if (idx > 0 && active[idx - 1] >= val * EM_PROGRESSIVE_THR) continue;

        // Disruptivo real
        disruptiveSum += val;
      }

      // Promedio crudo limpio (numerador sin disruptivos, denominador = N)
      var perCustProj = (sumActive - disruptiveSum) / N;
      itemProj += perCustProj;
    });

    projByItem[item] = itemProj;
  });

  return projByItem;
}

function _renderEstMadreTable(items, yms) {
  var table = document.getElementById("estMadreTable");
  if (!table) return;
  var thead = table.querySelector("thead");
  var tbody = table.querySelector("tbody");

  var monthFmt = function (ym) {
    var m = ym.match(/^(\d{4})-(\d{2})/);
    if (!m) return ym;
    var months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sept","Oct","Nov","Dic"];
    return months[Number(m[2]) - 1] + " " + m[1].slice(2);
  };

  // Totales por mes (suma de los items visibles)
  var totalsByYm = {};
  yms.forEach(function (ym) { totalsByYm[ym] = 0; });
  items.forEach(function (it) {
    yms.forEach(function (ym) {
      totalsByYm[ym] += Number(it.byYm[ym] || 0);
    });
  });
  // Total de proyecciones
  var totalProy = 0;
  items.forEach(function (it) { totalProy += Number(it._proy || 0); });

  // Helpers para sortable headers
  function sortArrow(col) {
    if (_estMadreSort.col !== col) return ' <span class="est-madre-sort-idle">↕</span>';
    return _estMadreSort.dir === "asc" ? ' <span class="est-madre-sort-active">↑</span>' : ' <span class="est-madre-sort-active">↓</span>';
  }
  function sortClass(col) {
    return _estMadreSort.col === col ? " est-madre-sorted" : "";
  }

  // ---- Header: 2 filas ----
  // Fila 1: títulos (sortables) + nombres de mes
  var prevYear = null;
  var thRow1 = '<tr>' +
    '<th class="est-madre-th-rank est-madre-sort-th' + sortClass("rank") + '" onclick="setEstMadreSort(\'rank\')" title="Ordenar por ranking">#' + sortArrow("rank") + '</th>' +
    '<th class="est-madre-th-cod est-madre-sort-th' + sortClass("cod") + '" onclick="setEstMadreSort(\'cod\')" title="Ordenar por código">Cod' + sortArrow("cod") + '</th>' +
    '<th class="est-madre-th-desc">Descripción</th>' +
    '<th class="est-madre-th-familia est-madre-sort-th' + sortClass("familia") + '" onclick="setEstMadreSort(\'familia\')" title="Ordenar por familia">Familia' + sortArrow("familia") + '</th>' +
    '<th class="est-madre-th-proy">Proyección</th>';
  yms.forEach(function (ym) {
    var yr = ym.slice(0, 4);
    var cls = (prevYear && yr !== prevYear) ? " year-start" : "";
    prevYear = yr;
    thRow1 += '<th class="' + cls.trim() + '">' + monthFmt(ym) + "</th>";
  });
  thRow1 += "</tr>";

  // Fila 2: totales por mes (suma de los items visibles)
  var thRow2 = '<tr class="est-madre-totals-row">' +
    '<th class="est-madre-th-rank"></th>' +
    '<th class="est-madre-th-cod"></th>' +
    '<th class="est-madre-th-desc">Total por mes →</th>' +
    '<th class="est-madre-th-familia"></th>' +
    '<th class="est-madre-th-proy">' + Math.round(totalProy).toLocaleString("es-AR") + "</th>";
  var prevYear2 = null;
  yms.forEach(function (ym) {
    var v = Math.round(totalsByYm[ym] || 0);
    var yr = ym.slice(0, 4);
    var cls = (prevYear2 && yr !== prevYear2) ? " year-start" : "";
    prevYear2 = yr;
    thRow2 += '<th class="' + cls.trim() + '">' + (v === 0 ? "—" : v.toLocaleString("es-AR")) + "</th>";
  });
  thRow2 += "</tr>";

  // Totals row PRIMERO, después la fila de headers de mes
  thead.innerHTML = thRow2 + thRow1;

  // ---- Body ----
  var colCount = 5 + yms.length;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="est-madre-empty">' +
      'No hay artículos con ventas registradas. Revisá la consola (F12) por errores. ' +
      '<button type="button" class="btn-primary" style="margin-left:10px" onclick="cargarEstadisticaMadre()">Reintentar</button>' +
      '</td></tr>';
    return;
  }
  var rowsHtml = items.map(function (it) {
    var proyeccion = Math.round(it._proy || 0);

    var prevYr = null;
    var codEsc = _escH(it.cod);
    var descEsc = _escH(it.desc);
    var cells = yms.map(function (ym) {
      var v = Math.round(it.byYm[ym] || 0);
      var yr = ym.slice(0, 4);
      var ys = (prevYr && yr !== prevYr) ? " year-start" : "";
      prevYr = yr;
      var zc = v === 0 ? " zero" : "";
      if (v === 0) {
        return '<td class="' + (ys + zc).trim() + '">—</td>';
      }
      // Celda con dato → clickeable, abre detalle de venta
      return '<td class="' + (ys + " est-madre-clickable").trim() +
             '" data-cod="' + codEsc + '" data-ym="' + ym + '" data-desc="' + descEsc +
             '" onclick="mostrarDetalleVentaMadre(this)" title="Click para ver detalle por cliente y provincia">' +
             v.toLocaleString("es-AR") + "</td>";
    }).join("");
    return "<tr>" +
      '<td class="est-madre-td-rank">' + (it._rank || "—") + "</td>" +
      '<td class="est-madre-td-cod">' + _escH(it.cod) + "</td>" +
      '<td class="est-madre-td-desc">' + _escH(it.desc) + "</td>" +
      '<td class="est-madre-td-familia">' + _escH(it.familia || "—") + "</td>" +
      '<td class="est-madre-td-proy">' + (proyeccion === 0 ? "—" : proyeccion.toLocaleString("es-AR")) + "</td>" +
      cells +
      "</tr>";
  }).join("");
  tbody.innerHTML = rowsHtml;
}

function filtrarEstadisticaMadre() {
  var tbody = document.querySelector("#estMadreTable tbody");
  if (!tbody) return;
  // Data aún no cargada → mensaje claro (no "sin datos")
  if (!_estMadreData) {
    var colCount = (_estMadreYms ? _estMadreYms.length : 0) + 3;
    tbody.innerHTML = '<tr><td colspan="' + colCount + '" class="est-madre-empty"><div class="em-loader"><div class="em-spinner"></div><div class="em-loader-text" id="emLoaderText">Cargando datos…</div></div></td></tr>';
    return;
  }
  if (_estMadreData.length === 0) {
    var colCount2 = (_estMadreYms ? _estMadreYms.length : 0) + 4;
    tbody.innerHTML = '<tr><td colspan="' + colCount2 + '" class="est-madre-empty">No hay datos. ' +
      '<button type="button" class="btn-primary" style="margin-left:10px" onclick="cargarEstadisticaMadre()">Reintentar</button>' +
      '</td></tr>';
    return;
  }
  var q = String(document.getElementById("estMadreSearch")?.value || "").trim().toLowerCase();
  if (!q) {
    _renderEstMadreTable(_estMadreData, _estMadreYms);
    return;
  }
  var filtered = _estMadreData.filter(function (it) {
    return (
      String(it.cod || "").toLowerCase().indexOf(q) >= 0 ||
      String(it.desc || "").toLowerCase().indexOf(q) >= 0 ||
      String(it.familia || "").toLowerCase().indexOf(q) >= 0
    );
  });
  if (filtered.length === 0) {
    var colCount3 = (_estMadreYms ? _estMadreYms.length : 0) + 3;
    tbody.innerHTML = '<tr><td colspan="' + colCount3 + '" class="est-madre-empty">Ningún artículo coincide con "' + _escH(q) + '". Probá con otro cod o descripción.</td></tr>';
    return;
  }
  _renderEstMadreTable(filtered, _estMadreYms);
}
window.filtrarEstadisticaMadre = filtrarEstadisticaMadre;

function _escH(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* =========================================================
   Mapa Argentina — render del SVG con colores por provincia
   y tooltip al pasar el mouse. SVG en argentina-map-data.js.
   ========================================================= */
function _renderArgentinaMap(provMap, sinProv) {
  var sinProvNote = '';
  if (sinProv && sinProv.unidades > 0) {
    sinProvNote =
      '<div style="margin-top:8px;padding:8px 12px;background:#f8f9fa;border-left:3px solid #bdc3c7;font-size:12px;color:#7f8c8d">' +
      '⚠ ' + sinProv.clientes + ' cliente' + (sinProv.clientes > 1 ? 's' : '') +
      ' sin provincia detectada (' + Math.round(sinProv.unidades).toLocaleString('es-AR') + ' unidades · ' +
      sinProv.pct.toFixed(1) + '% del total)' +
      '</div>';
  }
  return '<h4 style="margin:24px 0 10px;color:#2c3e50;font-size:15px">3. Mapa de provincias</h4>' +
    '<style>' +
    '.ar-map-container { position: relative; display: flex; justify-content: center; padding: 10px; background: #fafbfc; border-radius: 8px; }' +
    '.ar-map-svg { width: 280px; max-width: 100%; height: auto; }' +
    '.ar-map-svg polygon { transition: stroke-width 0.15s, fill 0.15s; }' +
    '.ar-map-svg polygon[data-prov]:hover { stroke: #2c3e50; stroke-width: 1.6; cursor: pointer; }' +
    '.ar-map-tooltip { position: absolute; pointer-events: none; background: #2c3e50; color: white; padding: 8px 12px; border-radius: 6px; font-size: 12px; z-index: 10; box-shadow: 0 4px 12px rgba(0,0,0,0.15); white-space: nowrap; }' +
    '.ar-map-tooltip strong { display:block; font-size:13px; margin-bottom:3px; }' +
    '.ar-map-legend { display:flex; gap:14px; align-items:center; justify-content:center; margin-top:8px; font-size:11px; color:#6b7280; }' +
    '.ar-map-legend-dot { display:inline-block; width:12px; height:12px; border-radius:2px; vertical-align:middle; margin-right:4px; }' +
    '</style>' +
    '<div class="ar-map-container">' +
      '<div id="ar-map-svg-slot" style="display:flex;justify-content:center;align-items:center;min-height:280px;color:#999;font-size:13px">Cargando mapa…</div>' +
      '<div id="ar-map-tooltip" class="ar-map-tooltip" style="display:none"></div>' +
    '</div>' +
    '<div class="ar-map-legend">' +
      '<span><span class="ar-map-legend-dot" style="background:#e2e8f0"></span>Sin ventas</span>' +
      '<span><span class="ar-map-legend-dot" style="background:rgba(108,92,231,0.3)"></span>Baja</span>' +
      '<span><span class="ar-map-legend-dot" style="background:rgba(108,92,231,0.6)"></span>Media</span>' +
      '<span><span class="ar-map-legend-dot" style="background:rgba(108,92,231,1)"></span>Alta</span>' +
    '</div>' +
    sinProvNote;
}

function _wireArgentinaMapTooltip(provMap, totalUnits) {
  var slot = document.getElementById('ar-map-svg-slot');
  if (!slot) return;

  // Cargar (o usar cache) el SVG y inyectar en el slot
  loadArgentinaMapSvg().then(function (svg) {
    if (!document.getElementById('ar-map-svg-slot')) return; // modal cerrado mientras tanto
    slot.innerHTML = svg;
    var svgEl = slot.querySelector('.ar-map-svg');
    if (!svgEl) return;
    _attachArMapHandlers(svgEl, provMap);
  }).catch(function (e) {
    slot.innerHTML = '<div style="color:#999;padding:20px">No se pudo cargar el mapa.</div>';
  });
}

function _attachArMapHandlers(svg, provMap) {
  var tooltip = document.getElementById('ar-map-tooltip');
  if (!tooltip) return;
  var container = svg.closest('.ar-map-container') || svg.parentElement;

  var paths = svg.querySelectorAll('[data-prov]');
  paths.forEach(function (p) {
    var prov = p.getAttribute('data-prov');
    var data = provMap[prov];
    // Color por intensidad: 0% → gris, >0% → púrpura con opacity por pct (cap 30%)
    if (data && data.unidades > 0) {
      var intensity = Math.min(1, Math.max(0.2, data.pct / 30));
      p.setAttribute('fill', 'rgba(108, 92, 231, ' + intensity.toFixed(2) + ')');
    } else {
      p.setAttribute('fill', '#e2e8f0');
    }

    p.addEventListener('mouseenter', function () {
      var d = provMap[prov];
      var content = '<strong>' + _escH(prov) + '</strong>';
      if (d && d.unidades > 0) {
        content += Math.round(d.unidades).toLocaleString('es-AR') + ' unidades · ' +
                   d.pct.toFixed(1) + '%<br>' +
                   d.clientes + ' cliente' + (d.clientes > 1 ? 's' : '');
      } else {
        content += '<span style="opacity:0.7">Sin ventas este mes</span>';
      }
      tooltip.innerHTML = content;
      tooltip.style.display = 'block';
    });
    p.addEventListener('mousemove', function (e) {
      var rect = container.getBoundingClientRect();
      var x = e.clientX - rect.left + 14;
      var y = e.clientY - rect.top + 14;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });
    p.addEventListener('mouseleave', function () {
      tooltip.style.display = 'none';
    });
  });
}

/* =========================================================
   ESTADÍSTICA MADRE — Modal detalle de venta por celda
   Click en celda con dato → muestra:
     1. Ventas disruptivas (ratio ≥ 1.5x del prom. habitual del cliente)
     2. Ventas por cliente (cod, razón, provincia, uni, prom. histórico, ratio)
     3. Mapa de provincias (heatmap)
   ========================================================= */
async function mostrarDetalleVentaMadre(cellEl) {
  var cod = cellEl.dataset.cod;
  var ym = cellEl.dataset.ym;
  var desc = cellEl.dataset.desc || "";
  if (!cod || !ym) return;

  var modal = document.getElementById("estMadreModal");
  var title = document.getElementById("estMadreModalTitle");
  var body = document.getElementById("estMadreModalBody");
  if (!modal || !body) return;

  // Formato del mes/año (ej "Ago 25")
  var months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  var m = ym.match(/^(\d{4})-(\d{2})/);
  var ymFmt = m ? months[Number(m[2]) - 1] + " " + m[1].slice(2) : ym;

  title.innerHTML = "Detalle ventas — <strong>" + _escH(cod) + "</strong> " +
                    _escH(desc) + " · <strong>" + _escH(ymFmt) + "</strong>";
  body.innerHTML = '<div style="text-align:center;padding:40px;color:#999">Cargando detalle…</div>';
  modal.style.display = "flex";

  // ESC para cerrar
  if (!modal.__escWired) {
    modal.__escWired = true;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal.style.display !== "none") {
        cerrarDetalleVentaMadre();
      }
    });
  }

  try {
    var resp = await sb.rpc("get_estadistica_madre_detail", {
      p_item_code: String(cod),
      p_ym: String(ym),
    });
    if (resp.error) throw resp.error;
    var rows = resp.data || [];

    if (rows.length === 0) {
      body.innerHTML = '<div style="padding:30px;color:#999;text-align:center">No hay ventas registradas para este artículo en este mes.</div>';
      return;
    }

    var totalUnits = rows.reduce(function (s, r) { return s + Number(r.unidades || 0); }, 0);

    // Helpers para diferenciar Loke direct vs vía Chef
    function _isChef(r) { return r && r.via === 'chef'; }
    var totalLoke = rows.filter(function (r) { return !_isChef(r); }).reduce(function (s, r) { return s + Number(r.unidades || 0); }, 0);
    var totalChef = rows.filter(_isChef).reduce(function (s, r) { return s + Number(r.unidades || 0); }, 0);
    var clientesLoke = rows.filter(function (r) { return !_isChef(r); }).length;
    var clientesChef = rows.filter(_isChef).length;

    // Badge "L" (vía Chef) — se inserta al lado del cod_cliente de cada fila Chef
    var CHEF_BADGE = '<span title="Vía Chef (artículo Loekemeyer revendido)" style="background:#f39c12;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;margin-left:5px;font-weight:700;letter-spacing:0.5px;vertical-align:middle">L</span>';

    // ---- Header summary ----
    var summary =
      '<div style="background:#f0f4f8;padding:14px 18px;border-radius:8px;margin-bottom:20px;display:flex;gap:30px;flex-wrap:wrap;align-items:center">' +
      '<div><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Total unidades</div>' +
      '<div style="font-size:24px;font-weight:700;color:#2c3e50">' + Math.round(totalUnits).toLocaleString("es-AR") + '</div></div>' +
      '<div><div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Clientes</div>' +
      '<div style="font-size:24px;font-weight:700;color:#2c3e50">' + rows.length + '</div></div>';

    // Breakdown Loke direct + vía Chef (solo si hay algún Chef)
    if (totalChef > 0) {
      summary +=
        '<div style="border-left:1px solid #d1d8e0;padding-left:24px">' +
        '<div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Loke direct</div>' +
        '<div style="font-size:16px;font-weight:700;color:#2c3e50">' + Math.round(totalLoke).toLocaleString("es-AR") + '</div>' +
        '<div style="font-size:11px;color:#999">' + clientesLoke + ' clientes</div>' +
        '</div>' +
        '<div>' +
        '<div style="font-size:11px;color:#f39c12;text-transform:uppercase;letter-spacing:0.5px;font-weight:700">Vía Chef <span style="background:#f39c12;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700">L</span></div>' +
        '<div style="font-size:16px;font-weight:700;color:#d35400">' + Math.round(totalChef).toLocaleString("es-AR") + '</div>' +
        '<div style="font-size:11px;color:#999">' + clientesChef + ' clientes</div>' +
        '</div>';
    }
    summary += '</div>';

    // ---- 2. Ventas por cliente ----
    // Provincia ahora se ve en el mapa (sección 3); columna comentada acá.
    // Si hay más de 20 filas, el wrapper hace scroll vertical (max-height ~720px ≈ 20 filas + header sticky).
    var clientTableScrollStyle =
      rows.length > 20
        ? "overflow-x:auto;max-height:720px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:6px;scrollbar-gutter:stable"
        : "overflow-x:auto";
    var clientTable =
      '<h4 style="margin:24px 0 10px;color:#2c3e50;font-size:15px">2. Ventas por cliente' +
      (rows.length > 20 ? ' <span style="font-size:12px;color:#888;font-weight:400">(' + rows.length + ' filas — scroll)</span>' : '') +
      '</h4>' +
      '<div style="' + clientTableScrollStyle + '"><table class="em-detail-tbl em-detail-tbl-sticky">' +
      '<thead><tr>' +
      '<th>Cod</th><th>Razón Social</th>' +
      // '<th>Provincia</th>' +  // ← provincia oculta (se ve en el mapa)
      '<th style="text-align:right">Unidades</th>' +
      '<th style="text-align:right">Prom. histórico</th>' +
      '<th style="text-align:right">Ratio</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var ratio = r.ratio != null ? Number(r.ratio).toFixed(2) + "x" : "—";
        var isDisrupt = r.ratio != null && Number(r.ratio) >= 1.5;
        var isChef = _isChef(r);
        var ratioColor = isDisrupt ? "#e74c3c" : "#27ae60";
        var avg = r.avg_monthly_units != null ? Math.round(Number(r.avg_monthly_units)).toLocaleString("es-AR") : "—";
        // Bg: disruptivo > chef > default
        var rowBg = isDisrupt ? "background:#fff5f5" : (isChef ? "background:#fff8e8" : "");
        return '<tr' + (rowBg ? ' style="' + rowBg + '"' : '') + '>' +
          '<td style="font-weight:600;color:#c0392b">' + _escH(r.cod_cliente) + (isChef ? CHEF_BADGE : '') + '</td>' +
          '<td>' + _escH(r.business_name) + '</td>' +
          // '<td>' + _escH(r.provincia) + '</td>' +  // ← provincia oculta
          '<td style="text-align:right;font-weight:600">' + Math.round(Number(r.unidades)).toLocaleString("es-AR") + '</td>' +
          '<td style="text-align:right;color:#666">' + avg + '</td>' +
          '<td style="text-align:right;color:' + ratioColor + ';font-weight:700">' + ratio + '</td>' +
          '</tr>';
      }).join("") +
      '</tbody></table></div>';

    // ---- Mapa de Argentina (reemplaza la tabla de provincias) ----
    var provMap = {};
    rows.forEach(function (r) {
      var prov = r.provincia || "Sin provincia";
      if (!provMap[prov]) provMap[prov] = { unidades: 0, clientes: 0 };
      provMap[prov].unidades += Number(r.unidades || 0);
      provMap[prov].clientes += 1;
    });
    // Anotar % sobre el total
    Object.keys(provMap).forEach(function (p) {
      provMap[p].pct = totalUnits > 0 ? (provMap[p].unidades / totalUnits) * 100 : 0;
    });
    // "Sin provincia" se muestra como nota aparte
    var sinProv = provMap["Sin provincia"];
    var mapBlock = _renderArgentinaMap(provMap, sinProv);

    // ---- 3. Ventas disruptivas (ratio ≥ 1.5x) ----
    var disruptive = rows.filter(function (r) {
      return r.ratio != null && Number(r.ratio) >= 1.5;
    }).sort(function (a, b) { return Number(b.ratio) - Number(a.ratio); });

    var disruptiveBlock;
    if (disruptive.length === 0) {
      disruptiveBlock =
        '<details class="em-card-collapse em-card-disruptive em-card-ok" style="margin-bottom:18px">' +
        '<summary>' +
        '<span class="em-card-title">1. Ventas disruptivas (ratio ≥ 1.5x)</span>' +
        '<span class="em-card-badge em-card-badge-ok">✓ Demanda normal</span>' +
        '<span class="em-card-chevron" aria-hidden="true">▾</span>' +
        '</summary>' +
        '<div class="em-card-content">' +
        '<div style="padding:16px;color:#27ae60;background:#eafaf1;border:1px solid #27ae60;border-radius:6px;font-weight:500">' +
        '✓ Ningún cliente compró más de 1.5x su promedio habitual este mes. Demanda normal.' +
        '</div>' +
        '</div>' +
        '</details>';
    } else {
      var disruptUnits = disruptive.reduce(function (s, r) { return s + Number(r.unidades || 0); }, 0);
      var disruptPct = totalUnits > 0 ? (disruptUnits / totalUnits) * 100 : 0;
      disruptiveBlock =
        '<details class="em-card-collapse em-card-disruptive em-card-warn" style="margin-bottom:18px">' +
        '<summary>' +
        '<span class="em-card-title">1. Ventas disruptivas (ratio ≥ 1.5x)</span>' +
        '<span class="em-card-badge em-card-badge-warn">⚠ ' + disruptive.length + ' cliente' + (disruptive.length > 1 ? 's' : '') +
        ' · ' + disruptPct.toFixed(1) + '% del mes</span>' +
        '<span class="em-card-chevron" aria-hidden="true">▾</span>' +
        '</summary>' +
        '<div class="em-card-content">' +
        '<div style="background:#fdecea;border:1px solid #e74c3c;padding:10px 14px;border-radius:6px;margin-bottom:10px;font-size:13px">' +
        '<strong>' + disruptive.length + '</strong> cliente' + (disruptive.length > 1 ? 's' : '') +
        ' con compra disruptiva · <strong>' + Math.round(disruptUnits).toLocaleString("es-AR") + '</strong> unidades · ' +
        '<strong>' + disruptPct.toFixed(1) + '%</strong> del total del mes' +
        '</div>' +
        '<div style="overflow-x:auto"><table class="em-detail-tbl">' +
        '<thead><tr>' +
        '<th>Cod</th><th>Razón Social</th>' +
        // '<th>Provincia</th>' +  // ← provincia oculta (se ve en el mapa)
        '<th style="text-align:right">Unidades este mes</th>' +
        '<th style="text-align:right">Prom. histórico</th>' +
        '<th style="text-align:right">Ratio</th>' +
        '<th style="text-align:right">Exceso</th>' +
        '</tr></thead><tbody>' +
        disruptive.map(function (r) {
          var exceso = Math.round(Number(r.unidades) - Number(r.avg_monthly_units));
          var isChef = _isChef(r);
          return '<tr style="background:#fff5f5">' +
            '<td style="font-weight:600;color:#c0392b">' + _escH(r.cod_cliente) + (isChef ? CHEF_BADGE : '') + '</td>' +
            '<td>' + _escH(r.business_name) + '</td>' +
            // '<td>' + _escH(r.provincia) + '</td>' +  // ← provincia oculta
            '<td style="text-align:right;font-weight:700">' + Math.round(Number(r.unidades)).toLocaleString("es-AR") + '</td>' +
            '<td style="text-align:right;color:#666">' + Math.round(Number(r.avg_monthly_units)).toLocaleString("es-AR") + '</td>' +
            '<td style="text-align:right;color:#e74c3c;font-weight:700">' + Number(r.ratio).toFixed(2) + 'x</td>' +
            '<td style="text-align:right;color:#e74c3c">+' + exceso.toLocaleString("es-AR") + '</td>' +
            '</tr>';
        }).join("") +
        '</tbody></table></div>' +
        '</div>' +
        '</details>';
    }

    // Orden nuevo: disruptivas arriba → [cliente + mapa side-by-side]
    // El bloque inferior usa grid 2-cols: tabla izq + mapa der.
    // En pantallas chicas (< 900px) se apila vertical.
    var sideBySide =
      '<div class="em-cliente-mapa-grid" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:56px;align-items:start">' +
      '<div style="min-width:0">' + clientTable + '</div>' +
      '<div style="min-width:0;padding-left:8px">' + mapBlock + '</div>' +
      '</div>' +
      '<style>@media (max-width:900px){.em-cliente-mapa-grid{grid-template-columns:1fr !important;gap:24px !important}}</style>';
    body.innerHTML = summary + disruptiveBlock + sideBySide;
    // Cablear hover/tooltip del mapa (después de inyectar HTML)
    _wireArgentinaMapTooltip(provMap, totalUnits);
  } catch (e) {
    console.error("mostrarDetalleVentaMadre error", e);
    body.innerHTML =
      '<div style="padding:20px;color:#c0392b;background:#fdecea;border:1px solid #e74c3c;border-radius:8px">' +
      '<strong>Error:</strong> ' + _escH(e.message || String(e)) + '<br><br>' +
      'Verificá que la función <code>get_estadistica_madre_detail</code> esté creada en Supabase.' +
      '</div>';
  }
}
window.mostrarDetalleVentaMadre = mostrarDetalleVentaMadre;

function cerrarDetalleVentaMadre() {
  var modal = document.getElementById("estMadreModal");
  if (modal) modal.style.display = "none";
}
window.cerrarDetalleVentaMadre = cerrarDetalleVentaMadre;

/* =========================================================
   REGISTRO ENVIOS CORREO — stats de la edge function
   procesar-pedidos-web (procesa batches y manda Excel por mail)
   ========================================================= */
async function cargarRegistroEnvios() {
  var rangeSel = document.getElementById("reEnvRange");
  var statusEl = document.getElementById("reEnvStatus");
  var gridEl = document.getElementById("reEnvStatsGrid");
  var recentEl = document.getElementById("reEnvRecent");
  if (!gridEl) return;

  var days = rangeSel ? Number(rangeSel.value || 30) : 30;
  if (statusEl) statusEl.innerHTML = '<span style="color:#666">Cargando…</span>';
  gridEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:#999">Cargando datos…</div>';
  if (recentEl) recentEl.innerHTML = "";

  try {
    var resp = await sb.rpc("get_procesar_pedidos_stats", { p_days: days });
    if (resp.error) throw resp.error;
    var d = (resp.data && resp.data[0]) || {};

    var totalRuns = Number(d.total_runs || 0);
    var okRuns = Number(d.ok_runs || 0);
    var errRuns = Number(d.error_runs || 0);
    var noOrdersRuns = Number(d.no_orders_runs || 0);
    var ordersProcessed = Number(d.total_orders_processed || 0);
    var pedidosGenerated = Number(d.total_pedidos_generated || 0);
    var successRate = Number(d.success_rate || 0);
    var lastRunAt = d.last_run_at ? new Date(d.last_run_at) : null;
    var lastRunStatus = d.last_run_status || "—";

    function statCard(label, value, sublabel, color) {
      // Layout flex column con altura fija para el label (2 líneas siempre
      // reservadas) y sublabel (2 líneas). Esto alinea verticalmente los
      // valores a la misma altura aunque el título sea 1 o 2 líneas.
      return (
        '<div style="background:white;border:1px solid #e0e0e0;border-radius:10px;padding:12px 10px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04);min-width:0;display:flex;flex-direction:column">' +
        '<div style="font-size:9.5px;color:#888;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;line-height:1.25;height:28px;display:flex;align-items:center;justify-content:center;overflow:hidden">' + _escH(label) + '</div>' +
        '<div style="font-size:22px;font-weight:700;color:' + (color || '#2c3e50') + ';line-height:1;word-break:break-word;margin:8px 0">' + _escH(String(value)) + '</div>' +
        '<div style="font-size:10px;color:#999;line-height:1.25;height:26px;display:flex;align-items:center;justify-content:center;overflow:hidden">' + _escH(sublabel || '') + '</div>' +
        '</div>'
      );
    }

    var rateColor = successRate >= 95 ? '#27ae60' : successRate >= 80 ? '#f39c12' : '#e74c3c';
    var errColor = errRuns > 0 ? '#e74c3c' : '#888';
    var lastRunSublabel = "—";
    var lastRunColor = "#888";
    if (lastRunAt) {
      lastRunSublabel = lastRunAt.toLocaleString("es-AR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
      if (lastRunStatus === "ok") lastRunColor = "#27ae60";
      else if (lastRunStatus === "error") lastRunColor = "#e74c3c";
      else if (lastRunStatus === "no_orders") lastRunColor = "#f39c12";
    }

    gridEl.innerHTML =
      statCard('Total ejecuciones', totalRuns, 'Últimos ' + days + ' días') +
      statCard('Mails enviados OK', okRuns, '', '#27ae60') +
      statCard('Con error', errRuns, '', errColor) +
      statCard('Sin pedidos', noOrdersRuns, 'Corrió pero sheet vacía', '#888') +
      statCard('Tasa de éxito', successRate + '%', 'Mails efectivos', rateColor) +
      statCard('Filas de sheet procesadas', ordersProcessed.toLocaleString("es-AR"), 'Items enviados') +
      statCard('N° Pedido generados', pedidosGenerated.toLocaleString("es-AR"), 'Pedidos únicos enviados') +
      statCard('Última ejecución', lastRunStatus.toUpperCase(), lastRunSublabel, lastRunColor);

    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#666;font-size:12px">Actualizado ' + new Date().toLocaleTimeString("es-AR") + '</span>';
    }

    // Cargar últimas ejecuciones (últimas 20)
    if (recentEl) {
      try {
        var rResp = await sb.rpc("get_procesar_pedidos_recent", { p_limit: 20 });
        if (rResp.error) throw rResp.error;
        var rows = rResp.data || [];
        if (rows.length === 0) {
          recentEl.innerHTML = '<div style="padding:14px;color:#999;text-align:center">No hay ejecuciones todavía.</div>';
        } else {
          var statusBadge = function (s) {
            var bg = s === "ok" ? "#27ae60" : s === "error" ? "#e74c3c" : "#f39c12";
            var lbl = s === "ok" ? "OK" : s === "error" ? "ERROR" : "SIN PED";
            return '<span style="background:' + bg + ';color:white;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">' + lbl + '</span>';
          };
          recentEl.innerHTML =
            '<h3 style="margin:0 0 10px;font-size:14px;color:#2c3e50">Últimas 20 ejecuciones</h3>' +
            '<div style="overflow-x:auto"><table style="width:auto;max-width:100%;border-collapse:collapse;font-size:12.5px;margin:0 auto">' +
            '<thead><tr style="background:#2c3e50;color:white">' +
            '<th style="padding:6px 10px;text-align:left;white-space:nowrap">Fecha</th>' +
            '<th style="padding:6px 10px;text-align:center;white-space:nowrap">Empresa</th>' +
            '<th style="padding:6px 10px;text-align:center;white-space:nowrap">Estado</th>' +
            '<th style="padding:6px 10px;text-align:right;white-space:nowrap">Items</th>' +
            '<th style="padding:6px 10px;text-align:right;white-space:nowrap">N° Ped.</th>' +
            '<th style="padding:6px 10px;text-align:right;white-space:nowrap">Duración</th>' +
            '<th style="padding:6px 10px;text-align:left;white-space:nowrap">Error</th>' +
            '</tr></thead><tbody>' +
            rows.map(function (r) {
              var dt = new Date(r.ran_at);
              return '<tr style="border-bottom:1px solid #eee">' +
                '<td style="padding:5px 10px;white-space:nowrap">' + dt.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) + '</td>' +
                '<td style="padding:5px 10px;text-align:center">' + _escH(r.company || "—") + '</td>' +
                '<td style="padding:5px 10px;text-align:center">' + statusBadge(r.status) + '</td>' +
                '<td style="padding:5px 10px;text-align:right">' + Number(r.orders_count || 0).toLocaleString("es-AR") + '</td>' +
                '<td style="padding:5px 10px;text-align:right">' + Number(r.pedidos_generated || 0).toLocaleString("es-AR") + '</td>' +
                '<td style="padding:5px 10px;text-align:right;color:#888;white-space:nowrap">' + (r.duration_ms ? (r.duration_ms + " ms") : "—") + '</td>' +
                '<td style="padding:5px 10px;color:#c0392b;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _escH(r.error_message || "") + '</td>' +
                '</tr>';
            }).join("") +
            '</tbody></table></div>';
        }
      } catch (re) {
        console.warn("recent runs load failed:", re);
        recentEl.innerHTML = '';
      }
    }
  } catch (e) {
    console.error("cargarRegistroEnvios error", e);
    gridEl.innerHTML =
      '<div style="grid-column:1/-1;padding:20px;color:#c0392b;background:#fdecea;border:1px solid #e74c3c;border-radius:8px">' +
      '<strong>Error:</strong> ' + _escH(e.message || String(e)) + '<br><br>' +
      'Verificá que la tabla <code>procesar_pedidos_log</code> y la función <code>get_procesar_pedidos_stats</code> estén creadas en Supabase.' +
      '</div>';
    if (statusEl) statusEl.innerHTML = '<span style="color:#c0392b">Error</span>';
  }
}
window.cargarRegistroEnvios = cargarRegistroEnvios;

// Piso de volumen del reporte de disruptivas, en CAJAS. Por debajo de esto la
// compra no se lista aunque el ratio la marque como disruptiva: un cliente que
// pasa de 1 a 2 cajas da x2,00 y no dice nada del negocio.
// El piso queda en CAJAS aunque el reporte se lea en unidades: es la magnitud
// con la que se compra y se despacha, y no cambia si se corrige un uxb.
var DISRUPTIVAS_MIN_CAJAS = 10;

// Umbral del reporte: se lista la compra cuando supera al promedio personal del
// cliente por este porcentaje. 0.30 = compró un 30% más que su promedio
// (ratio > 1,30). Antes era 0.50 (1,50) y dejaba afuera desvíos que sí importan.
var DISRUPTIVAS_EXCESO_MIN = 0.30;

// Clientes internos: los mismos que ya excluyen las RPC de estadística
// (get_ranking_inactivos, get_estadistica_madre_detail, …). Sus pedidos son
// pruebas y no representan demanda real.
var DISRUPTIVAS_CODS_PRUEBA = ["1", "3878"];

// Generar y descargar reporte de ventas disruptivas por cliente
async function descargarReporteVentasDisruptivas() {
  if (!_estMadreData || !_estMadreYms || _estMadreData.length === 0) {
    alert('No hay datos cargados. Cargá la Est. Madre primero.');
    return;
  }

  var select = document.getElementById("estMadreDisruptivasMonth");
  var mesMasReciente = select ? select.value : '';

  if (!mesMasReciente) {
    alert('Seleccioná un mes para descargar.');
    return;
  }

  if (!_estMadreYms.includes(mesMasReciente)) {
    alert('El mes seleccionado no está disponible en los datos.');
    return;
  }

  // Parsear el mes (YYYY-MM) para obtener fecha
  var parts = mesMasReciente.split('-');
  var year = parseInt(parts[0]), month = parseInt(parts[1]);

  // Corte superior EXCLUSIVO en el primer día del mes siguiente.
  // Antes era new Date(year, month, 0), que es el último día del mes a las
  // 00:00, y con un filtro <= se perdía ese día entero: para 2026-06 eran 6
  // pedidos y 91 líneas que no entraban al reporte sin ninguna señal.
  var finExclusivo = new Date(year, month, 1);

  // Rango de 12 meses anteriores (excluye el mes actual)
  var hace12Meses = new Date(year, month - 13, 1);

  var statusEl = document.getElementById("estMadreStatus");
  var btnEl = event.target;
  var textoOriginal = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = "Generando...";

  // Query a Supabase para obtener las líneas de pedido del período.
  //
  // PAGINADO a propósito: el REST de Supabase corta en 1000 filas y NO avisa
  // (no devuelve error). Los últimos 12 meses tienen ~13.200 líneas, así que
  // sin paginar el reporte se calculaba sobre el 8% de los datos y salía igual,
  // sin ninguna señal de que faltaba el resto.
  var PAGINA = 1000;
  var data = [];

  try {
    for (var desde = 0; ; desde += PAGINA) {
      var resp = await sb
        .from("order_items")
        .select(
          "cajas, uxb, products(cod, uxb), orders!inner(created_at, customers(business_name, cod_cliente))"
        )
        .gte("orders.created_at", hace12Meses.toISOString())
        .lt("orders.created_at", finExclusivo.toISOString())
        .range(desde, desde + PAGINA - 1);

      if (resp.error) throw resp.error;
      var lote = resp.data || [];
      data = data.concat(lote);
      if (lote.length < PAGINA) break;
    }

    var disruptivasPorProducto = {};

    // Agrupar por producto. El código de artículo sale de products vía
    // product_id: order_items no guarda item_code. Las líneas de la línea Loke
    // van por loke_product_id y quedan sin ficha en products, así que no traen
    // cod y las saltea el guard de abajo.
    data.forEach(function(oi) {
      var prod = oi.products || {};
      var cod = String(prod.cod || "").trim().toUpperCase();
      var qty = Number(oi.cajas || 0);
      // uxb de la línea (el vigente cuando se cargó el pedido), con respaldo al
      // del producto. El reporte se expresa en UNIDADES, pero el piso de abajo
      // se mide en CAJAS, así que hacen falta las dos magnitudes.
      var uxb = Number(oi.uxb || 0) || Number(prod.uxb || 0) || 0;
      var order = oi.orders || {};
      var cli = order.customers || {};
      var cliente = String(cli.cod_cliente || "").trim();
      var clienteNombre = cli.business_name || "Desconocido";
      var fechaOrden = new Date(order.created_at || "");

      if (!cod || !cliente || qty === 0) return;
      if (DISRUPTIVAS_CODS_PRUEBA.indexOf(cliente) !== -1) return;

      // Determinar mes-año de la orden (YYYY-MM)
      var ym = fechaOrden.getFullYear() + "-" + String(fechaOrden.getMonth() + 1).padStart(2, "0");

      if (!disruptivasPorProducto[cod]) {
        disruptivasPorProducto[cod] = { compras: {} };
      }

      if (!disruptivasPorProducto[cod].compras[cliente]) {
        disruptivasPorProducto[cod].compras[cliente] = {
          nombre: clienteNombre,
          porMes: {}
        };
      }

      if (!disruptivasPorProducto[cod].compras[cliente].porMes[ym]) {
        disruptivasPorProducto[cod].compras[cliente].porMes[ym] = { cjs: 0, uni: 0 };
      }

      disruptivasPorProducto[cod].compras[cliente].porMes[ym].cjs += qty;
      disruptivasPorProducto[cod].compras[cliente].porMes[ym].uni += qty * uxb;
    });

    // Procesar datos: calcular promedios y detectar disruptivas
    var reportePorProducto = [];

    Object.keys(disruptivasPorProducto).forEach(function(cod) {
      var comprasPorCliente = disruptivasPorProducto[cod].compras;
      var clientesDisruptivos = [];

      Object.keys(comprasPorCliente).forEach(function(cliente) {
        var clienteData = comprasPorCliente[cliente];
        var porMes = clienteData.porMes;

        var mes = porMes[mesMasReciente];
        if (!mes || mes.cjs === 0) return; // Cliente no compró ese mes

        // Piso de volumen: una compra puede ser disruptiva para el cliente y
        // aun así ser irrelevante en volumen (2 cajas contra un promedio de 1).
        // El piso va en CAJAS aunque el reporte se lea en unidades, porque es
        // la magnitud con la que se compra y se despacha.
        if (mes.cjs <= DISRUPTIVAS_MIN_CAJAS) return;

        // Calcular promedio de 12 meses (excluyendo el mes actual).
        // Se promedia sobre UNIDADES para que el ratio sea el mismo que se lee
        // en el reporte. Con uxb constante da idéntico a promediar cajas; donde
        // el uxb cambió, unidades es lo correcto.
        var ventasAnteriores = [];
        Object.keys(porMes).forEach(function(ym) {
          if (ym !== mesMasReciente) {
            var v = (porMes[ym] && porMes[ym].uni) || 0;
            if (v > 0) ventasAnteriores.push(v);
          }
        });

        // Sin historial = primera compra del artículo por ese cliente. Antes se
        // descartaba; ahora entra marcada como INCORPORACIÓN, que es
        // justamente el caso más disruptivo (pasó de 0 a comprar).
        if (ventasAnteriores.length === 0) {
          clientesDisruptivos.push({
            cliente: cliente,
            nombre: clienteData.nombre,
            unidades: Math.round(mes.uni),
            promedio: 0,
            multiplicador: null,   // sin promedio previo no hay ratio
            incorporacion: true
          });
          return;
        }

        var promedio = ventasAnteriores.reduce(function(a, b) { return a + b; }) / ventasAnteriores.length;
        var multiplicador = mes.uni / promedio;

        if (multiplicador > 1 + DISRUPTIVAS_EXCESO_MIN) {
          clientesDisruptivos.push({
            cliente: cliente,
            nombre: clienteData.nombre,
            unidades: Math.round(mes.uni),
            promedio: Math.round(promedio),
            multiplicador: multiplicador,
            incorporacion: false
          });
        }
      });

      // Incorporaciones primero, después el resto por desvío descendente.
      clientesDisruptivos.sort(function(a, b) {
        if (a.incorporacion !== b.incorporacion) return a.incorporacion ? -1 : 1;
        if (a.incorporacion) return b.unidades - a.unidades;
        return b.multiplicador - a.multiplicador;
      });

      if (clientesDisruptivos.length > 0) {
        reportePorProducto.push({
          cod: cod,
          clientes: clientesDisruptivos
        });
      }
    });

    // Generar reporte
    var report = [];
    report.push("REPORTE DE VENTAS DISRUPTIVAS POR CLIENTE");
    report.push("Mes: " + mesMasReciente);
    report.push("Generado: " + new Date().toLocaleString("es-AR"));
    report.push("");
    report.push("=".repeat(100));
    report.push("");

    if (reportePorProducto.length === 0) {
      report.push("SIN ANOMALÍAS DETECTADAS");
    } else {
      reportePorProducto.forEach(function(prod, idx) {
        report.push((idx + 1) + ". ARTÍCULO " + prod.cod);
        // Solo el total de unidades del mes. El ratio y el promedio no se
        // imprimen: si el cliente está en la lista es porque ya superó el
        // umbral, así que el número no agrega nada a la lectura.
        prod.clientes.forEach(function(c) {
          report.push(
            "  " + c.nombre + " " + c.unidades.toLocaleString("es-AR") + " uni." +
            (c.incorporacion ? " INCORPORACIÓN" : "")
          );
        });
        report.push("");
      });
    }

    var totalIncorp = 0, totalDisrup = 0;
    reportePorProducto.forEach(function(prod) {
      prod.clientes.forEach(function(c) { c.incorporacion ? totalIncorp++ : totalDisrup++; });
    });

    report.push("=".repeat(100));
    report.push(
      "Total: " + totalDisrup + " compra(s) por encima del promedio · " +
      totalIncorp + " incorporación(es), en " + reportePorProducto.length + " artículo(s)."
    );
    report.push(
      "Definición: se lista la compra que supera en más de " +
      Math.round(DISRUPTIVAS_EXCESO_MIN * 100) + "% el promedio personal del cliente " +
      "(ratio > " + (1 + DISRUPTIVAS_EXCESO_MIN).toFixed(2) + "x), calculado sobre los 12 meses previos."
    );
    report.push(
      "INCORPORACIÓN = el cliente compró ese artículo por primera vez (sin historial en los 12 meses previos)."
    );
    report.push(
      "Piso de volumen: solo se listan las compras de más de " + DISRUPTIVAS_MIN_CAJAS + " cajas en el mes."
    );
    report.push("Las cantidades están en UNIDADES (cajas x unidades por caja).");

    var contenido = report.join("\n");

    // Descargar
    var blob = new Blob([contenido], { type: "text/plain;charset=utf-8" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "disruptivas_clientes_" + mesMasReciente + ".txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    btnEl.disabled = false;
    btnEl.textContent = textoOriginal;
  } catch (err) {
    console.error("Error generando reporte:", err);
    alert("Error: " + (err.message || "No se pudieron obtener los datos"));
    btnEl.disabled = false;
    btnEl.textContent = textoOriginal;
  }
}
window.descargarReporteVentasDisruptivas = descargarReporteVentasDisruptivas;

// Descargar el Ranking Inactivos como Excel.
//
// Reemplazó a "Descargar con Mensajes", que generaba un .txt narrativo leyendo
// las filas del DOM de la tabla "De baja" (ya eliminada). Ahora sale todo de
// get_ranking_inactivos, la misma RPC que pinta la tabla, así el archivo y la
// pantalla no pueden discrepar.
//
// Dos diferencias con lo que se ve en pantalla, a propósito:
//   - Trae TODOS los inactivos del período, no la hoja de 25.
//   - El desglose por año va en una columna por año en vez de apilado, que es
//     lo que sirve para filtrar y hacer tablas dinámicas en Excel.
//
// Los años son los mismos que muestra la tabla (_aniosDesglose): 2020 hasta el
// año en curso, más cualquier año suelto que aparezca en los datos. Los años
// sin compras van en 0, no vacíos, para que las fórmulas de Excel no fallen.
//
// Los importes van como NÚMERO, no como texto con "$": si se exportan
// formateados, Excel los toma como string y no se pueden sumar ni ordenar. El
// formato de miles se aplica con z (numFmt) sobre la celda.
function descargarRankingInactivosExcel() {
  var btnEl = (typeof event !== "undefined" && event && event.target) || null;
  var textoOriginal = btnEl ? btnEl.textContent : "";
  function restaurarBtn() {
    if (!btnEl) return;
    btnEl.disabled = false;
    btnEl.textContent = textoOriginal;
  }
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Generando…";
  }

  if (typeof XLSX === "undefined") {
    alert("No se pudo cargar la librería de Excel (xlsx). Recargá la página e intentá de nuevo.");
    restaurarBtn();
    return;
  }

  // El período CARGADO y no el del selector: desde que el menú dejó de aplicarse
  // solo, el selector puede mostrar uno que la tabla todavía no cargó, y el
  // archivo tiene que ser copia de lo que el usuario está mirando.
  var periodMeses = parseInt(_rankingPeriodoCargado, 10) || 12;

  // RPC aparte de la de pantalla: el archivo lleva el ranking COMPLETO, y
  // pedirle las 531 filas a get_ranking_inactivos hacía correr sobre todo el
  // ranking sus CTEs caras (frecuencia entre pedidos, artículos distintos,
  // detalle de miembros), que están pensadas para la hoja visible de 25 —
  // 23 s medidos contra un statement_timeout de ~8 s. get_ranking_inactivos_export
  // calcula solo las columnas que van al archivo: 740 ms, y devuelve los mismos
  // números (verificado fila por fila sobre las 531).
  sb.rpc("get_ranking_inactivos_export", {
      p_meses: periodMeses,
      p_solo_excluidos: false,
    })
    .then(function (resp) {
      if (resp.error) throw resp.error;

      var filas = resp.data || [];
      if (filas.length === 0) {
        alert("No hay clientes inactivos para descargar.");
        restaurarBtn();
        return;
      }

      // Misma ventana móvil que la pantalla, en el mismo orden: el año en curso
      // primero y hacia atrás.
      var años = _aniosDesglose();

      // Si algún cliente tiene plata en años que ya salieron de la ventana, se
      // agrega una columna "Anteriores" para que las columnas de año sigan
      // sumando el valor histórico total. Hoy no aparece (el dato más viejo es
      // 2020 y la ventana llega hasta ahí); desde 2027 empieza a hacer falta.
      var hayAnteriores = filas.some(function (r) {
        return _montoFueraDeVentana(r.desglose_por_anio) > 0;
      });

      var encabezados = [
        "Ranking",
        "Código",
        "Razón social",
        "Valor histórico total",
        "Valor último pedido",
        "Fecha último pedido",
      ].concat(años, hayAnteriores ? ["Anteriores"] : []);

      var aoa = [encabezados];

      filas.forEach(function (r) {
        var desglose = r.desglose_por_anio || {};
        var fila = [
          Number(r.ranking) || 0,
          String(r.cod_cliente || ""),
          r.business_name || "(sin razón social)",
          Math.round(Number(r.total_historico) || 0),
          Math.round(Number(r.valor_ultimo_pedido) || 0),
          // Fecha como Date real (no texto) para que Excel la ordene bien.
          // T00:00:00 fuerza el parseo en hora local: sin eso, en UTC-3 el día
          // se corre uno para atrás.
          r.last_date ? new Date(String(r.last_date) + "T00:00:00") : "",
        ];
        años.forEach(function (a) {
          fila.push(Math.round(Number(desglose[a]) || 0));
        });
        if (hayAnteriores) fila.push(_montoFueraDeVentana(desglose));
        aoa.push(fila);
      });

      // cellDates: sin esto aoa_to_sheet convierte los Date a número y les
      // clava el formato m/d/yy, y después no hay forma de distinguirlos de
      // un monto para reformatearlos.
      var ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

      // Anchos: los fijos primero, después una columna por año.
      ws["!cols"] = [
        { wch: 8 },   // Ranking
        { wch: 9 },   // Código
        { wch: 34 },  // Razón social
        { wch: 20 },  // Valor histórico total
        { wch: 20 },  // Valor último pedido
        { wch: 17 },  // Fecha último pedido
      ].concat(
        años.map(function () { return { wch: 15 }; }),
        hayAnteriores ? [{ wch: 15 }] : []
      );

      ws["!autofilter"] = {
        ref: XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: aoa.length - 1, c: encabezados.length - 1 },
        }),
      };

      // Formatos y estilos. Se recorre celda por celda porque xlsx-js-style
      // guarda el estilo EN la celda, no hay forma de aplicarlo por columna.
      var ultimaCol = encabezados.length - 1;
      for (var c = 0; c <= ultimaCol; c++) {
        var refHead = XLSX.utils.encode_cell({ r: 0, c: c });
        if (ws[refHead]) {
          ws[refHead].s = {
            font: { bold: true, color: { rgb: "FFFFFF" } },
            fill: { fgColor: { rgb: "19222F" } },
            alignment: { horizontal: "center", vertical: "center", wrapText: true },
          };
        }
      }
      for (var f = 1; f < aoa.length; f++) {
        // Montos: columnas 3 y 4, más todas las de año (de la 6 en adelante)
        for (var cc = 0; cc <= ultimaCol; cc++) {
          var ref = XLSX.utils.encode_cell({ r: f, c: cc });
          var cell = ws[ref];
          if (!cell) continue;
          var esMonto = cc === 3 || cc === 4 || cc >= 6;
          if (esMonto) {
            cell.z = '#,##0';
            cell.s = { alignment: { horizontal: "right" } };
          } else if (cc === 5 && cell.t !== "s") {
            // dd/mm/yyyy explícito: el default de la librería es m/d/yy (US) y
            // 03/08 se lee como 8 de marzo en vez de 3 de agosto.
            cell.z = "dd/mm/yyyy";
            cell.s = { alignment: { horizontal: "center" } };
          }
        }
      }

      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Ranking Inactivos");

      var hoy = new Date();
      var stamp =
        hoy.getFullYear() +
        String(hoy.getMonth() + 1).padStart(2, "0") +
        String(hoy.getDate()).padStart(2, "0");
      XLSX.writeFile(wb, "ranking_inactivos_" + periodMeses + "m_" + stamp + ".xlsx");

      restaurarBtn();
    })
    .catch(function (err) {
      console.error("descargarRankingInactivosExcel error", err);
      alert("Error al generar el Excel: " + (err.message || err));
      restaurarBtn();
    });
}
window.descargarRankingInactivosExcel = descargarRankingInactivosExcel;

// Cargar ranking de clientes inactivos.
// Usa la RPC get_ranking_inactivos: une pedidos web (orders) con el histórico
// del ERP (sales_lines) y valoriza a precios de hoy NETOS: precio de lista por
// (1 - customers.dto_vol) por (1 - app_settings.web_order_discount), la misma
// cadena multiplicativa que aplica script.js al armar un pedido. Rankea por
// valor histórico total (todos los pedidos). El cálculo va server-side porque
// sales_lines tiene ~260k filas (el límite del REST de Supabase es 1000).
var RANKING_INACTIVOS_LIMIT = 25;

// Años que se muestran SIEMPRE en el desglose, aunque el cliente no haya
// comprado (van en 0).
// Ventana del desglose: los últimos RANKING_ANIOS años, del más nuevo al más
// viejo. Es una ventana MÓVIL: el 1/1/2027 pasa sola a mostrar 2021–2027.
var RANKING_ANIOS = 7;
function _aniosDesglose() {
  var hasta = new Date().getFullYear();
  var años = [];
  for (var a = hasta; a > hasta - RANKING_ANIOS; a--) años.push(String(a));
  return años; // ya vienen descendentes: el año en curso primero
}

// Plata que quedó FUERA de la ventana. Hoy da 0 en todos los clientes (los
// datos arrancan en 2020 y la ventana es 2020-2026), pero desde 2027 los años
// viejos empiezan a salir del desglose sin salir del total. Se muestra aparte
// para que lo que se ve siga sumando lo que dice el total.
function _montoFueraDeVentana(desglose) {
  var dentro = _aniosDesglose();
  var fuera = 0;
  Object.keys(desglose || {}).forEach(function (a) {
    if (dentro.indexOf(a) === -1) fuera += Number(desglose[a]) || 0;
  });
  return Math.round(fuera);
}

// true = la tabla está mostrando los clientes ocultados a mano, no el ranking
var _rankingInactivosVerOcultos = false;

// Hoja actual del ranking, 1-based
var _rankingInactivosPagina = 1;

// Texto del buscador del ranking. Se manda a la RPC como p_q; "" = sin filtro.
var _rankingInactivosQuery = "";
var _rankingBuscarTimer = null;

// Filtro por vendedor, desde el menú del encabezado de la columna.
// Arreglo VACÍO = todos, que es distinto de "ninguno seleccionado": el menú
// nunca deja llegar a cero: "Ninguno" en realidad limpia el filtro.
var _rankingVendedores = [];
// Lista de vendedores para el menú. Sale de get_vendedores_ranking acotada al
// MISMO conjunto que muestra la tabla (período + switch de ocultos), así que
// cambia cuando cambia ese conjunto: la invalida cargarRankingInactivosDesdeCero.
var _rankVendLista = null;

// Renombres SOLO de pantalla. La clave es el vendor_label tal cual está en
// customer_commissions —que es lo que viaja a la RPC como p_vendedores— y el
// valor es cómo se muestra. Renombrar en la base rompería el cruce con el ERP
// y con cualquier otro consumidor de esa columna.
var RANK_VEND_ALIAS = {
  "Fabrica P": "Pablo B"
};
function _vendNombreVisible(nombre) {
  return RANK_VEND_ALIAS[nombre] || nombre;
}

function toggleMenuVendedores(ev) {
  if (ev) ev.stopPropagation();
  var menu = document.getElementById("rankVendMenu");
  if (!menu) return;
  var abierto = menu.classList.contains("abierto");
  if (abierto) {
    menu.classList.remove("abierto");
    return;
  }
  _ubicarMenuVendedores();
  menu.classList.add("abierto");
  if (_rankVendLista) {
    _renderMenuVendedores();
    return;
  }
  menu.innerHTML = '<div class="rank-vend-cargando">Cargando…</div>';
  // Los mismos parámetros con los que se cargó la tabla: el menú tiene que
  // ofrecer los vendedores QUE APARECEN EN EL RANKING, no el padrón entero de
  // customer_commissions. Hay vendedores con clientes en la tabla de comisiones
  // y cero clientes inactivos, y ofrecerlos era ofrecer un filtro vacío.
  sb.rpc("get_vendedores_ranking", {
    p_meses: parseInt(_rankingPeriodoCargado, 10) || 12,
    p_solo_excluidos: _rankingInactivosVerOcultos
  })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _rankVendLista = (resp.data || []).map(function (v) { return v.vendedor_nombre; });
      // La RPC ordena por el nombre de la base; el menú se lee por el nombre
      // visible, así que con un alias de por medio hay que reordenar acá.
      _rankVendLista.sort(function (a, b) {
        return _vendNombreVisible(a).localeCompare(_vendNombreVisible(b), "es");
      });
      // Una selección hecha con otro período puede nombrar vendedores que ya no
      // están en la lista: se descartan para que el contador del chip no cuente
      // filtros que no filtran nada.
      _rankingVendedores = _rankingVendedores.filter(function (n) {
        return _rankVendLista.indexOf(n) !== -1;
      });
      _refrescarChipVendedores();
      _renderMenuVendedores();
    })
    .catch(function (err) {
      console.error("get_vendedores_ranking error", err);
      menu.innerHTML = '<div class="rank-vend-cargando">No se pudo cargar la lista.</div>';
    });
}
window.toggleMenuVendedores = toggleMenuVendedores;

// El menú es position:fixed para no quedar recortado por el overflow de
// .est-table-wrap, así que las coordenadas se calculan a mano contra el botón.
// Si no entra a la derecha, se alinea por el borde derecho de la ventana.
//
// Y además se MUEVE a <body>. Los th de .est-table son position:sticky con
// z-index 2, o sea que cada uno abre su propio contexto de apilado: dejando el
// menú adentro del th, su z-index se resuelve DENTRO de ese contexto y el th
// de al lado —que viene después en el DOM— lo tapa, por más alto que sea el
// z-index. Colgándolo de body el problema desaparece de raíz.
function _ubicarMenuVendedores() {
  var menu = document.getElementById("rankVendMenu");
  var btn = document.getElementById("rankVendBtn");
  if (!menu || !btn) return;
  if (menu.parentNode !== document.body) document.body.appendChild(menu);
  var r = btn.getBoundingClientRect();
  var ancho = 200;
  menu.style.top = Math.round(r.bottom + 4) + "px";
  menu.style.left = Math.round(Math.min(r.left, window.innerWidth - ancho - 12)) + "px";
}

// Al scrollear la tabla o la página, el menú se quedaría flotando en su
// posición vieja porque es fixed. Cerrarlo es más simple que reubicarlo.
//
// El listener va en CAPTURA para enterarse del scroll de cualquier contenedor,
// y por eso mismo recibe también el de la propia lista del menú (que tiene
// overflow-y: auto). Sin este guard, mover la rueda sobre el menú o arrastrar
// su barra lo cerraba en el acto.
document.addEventListener("scroll", function (ev) {
  var menu = document.getElementById("rankVendMenu");
  if (!menu || !menu.classList.contains("abierto")) return;
  if (ev.target === menu || (ev.target && ev.target.nodeType && menu.contains(ev.target))) return;
  menu.classList.remove("abierto");
}, true);

function _renderMenuVendedores() {
  var menu = document.getElementById("rankVendMenu");
  if (!menu || !_rankVendLista) return;

  var html =
    '<div class="rank-vend-acciones">' +
    '<button type="button" data-vend-todos>Todos</button>' +
    '<button type="button" data-vend-ninguno>Limpiar</button>' +
    "</div>";

  html += (_rankVendLista.length === 0)
    ? '<div class="rank-vend-cargando">Sin vendedores cargados.</div>'
    : _rankVendLista.map(function (nombre) {
        var sel = _rankingVendedores.indexOf(nombre) !== -1;
        // data-vend lleva el nombre CRUDO: es el que se manda a la RPC. El
        // <span> lleva el visible, que puede tener alias.
        return (
          '<label class="rank-vend-item">' +
          '<input type="checkbox" data-vend="' + escHtml(nombre) + '"' +
          (sel ? " checked" : "") + ">" +
          "<span>" + escHtml(_vendNombreVisible(nombre)) + "</span>" +
          "</label>"
        );
      }).join("");

  menu.innerHTML = html;

  menu.querySelectorAll("[data-vend]").forEach(function (chk) {
    chk.addEventListener("change", function () {
      var nombre = chk.dataset.vend;
      var i = _rankingVendedores.indexOf(nombre);
      if (chk.checked && i === -1) _rankingVendedores.push(nombre);
      if (!chk.checked && i !== -1) _rankingVendedores.splice(i, 1);
      _aplicarFiltroVendedores();
    });
  });
  var btnTodos = menu.querySelector("[data-vend-todos]");
  if (btnTodos) btnTodos.addEventListener("click", function () {
    _rankingVendedores = _rankVendLista.slice();
    _renderMenuVendedores();
    _aplicarFiltroVendedores();
  });
  var btnNinguno = menu.querySelector("[data-vend-ninguno]");
  if (btnNinguno) btnNinguno.addEventListener("click", function () {
    _rankingVendedores = [];
    _renderMenuVendedores();
    _aplicarFiltroVendedores();
  });
}

// Seleccionar TODOS equivale a no filtrar, así que se manda null y la RPC se
// ahorra el = ANY sobre las 368 filas.
function _vendedoresParaRpc() {
  if (!_rankingVendedores.length) return null;
  if (_rankVendLista && _rankingVendedores.length === _rankVendLista.length) return null;
  return _rankingVendedores;
}

function _aplicarFiltroVendedores() {
  _rankingInactivosPagina = 1;
  _refrescarChipVendedores();
  cargarRankingInactivos();
}

function _refrescarChipVendedores() {
  var chip = document.getElementById("rankVendChip");
  if (!chip) return;
  var n = _vendedoresParaRpc() ? _rankingVendedores.length : 0;
  chip.textContent = n ? String(n) : "";
  chip.style.display = n ? "" : "none";
}

// Cerrar el menú al hacer clic afuera. Va en captura sobre document para que
// funcione aunque el clic caiga en otra parte de la tabla.
document.addEventListener("click", function (ev) {
  var menu = document.getElementById("rankVendMenu");
  if (!menu || !menu.classList.contains("abierto")) return;
  if (menu.contains(ev.target)) return;
  var btn = document.getElementById("rankVendBtn");
  if (btn && btn.contains(ev.target)) return;
  menu.classList.remove("abierto");
});

// Buscar dentro del ranking por código o razón social. Vuelve a la hoja 1:
// quedarse en la 7 de un resultado que ahora tiene 1 hoja daría vacío.
function buscarEnRankingInactivos(q) {
  _rankingInactivosQuery = String(q == null ? "" : q).trim();
  _rankingInactivosPagina = 1;
  cargarRankingInactivos();
}
window.buscarEnRankingInactivos = buscarEnRankingInactivos;

// Debounce del input: cada tecla dispararía una consulta sobre sales_lines.
function onInputBuscarRanking(el) {
  clearTimeout(_rankingBuscarTimer);
  var v = el.value;
  _rankingBuscarTimer = setTimeout(function () {
    if (String(v).trim() !== _rankingInactivosQuery) buscarEnRankingInactivos(v);
  }, 300);
}
window.onInputBuscarRanking = onInputBuscarRanking;

function limpiarBusquedaRanking() {
  var el = document.getElementById("rankingInactivosBuscar");
  if (el) el.value = "";
  buscarEnRankingInactivos("");
}
window.limpiarBusquedaRanking = limpiarBusquedaRanking;

/* ============================ ESTADO EN ARCA ============================
   Lee arca_padron a través de get_arca_estado_clientes. El panel NO consulta
   ARCA: eso lo hace un worker externo, porque el web service exige un
   certificado con clave privada y desde el navegador sería regalarla.
   Mientras el worker no exista, todo figura "Sin consultar" y el módulo ya
   sirve para ver qué CUITs son consultables y cuáles no. */

var ARCA_LIMIT = 25;
var _arcaPagina = 1;
var _arcaQuery = "";
var _arcaEstados = [];
// Filtro por situación del BCRA. Los valores son "1".."6" y el centinela
// "sin_dato" para los que todavía no tienen respuesta.
var _arcaBcra = [];
var _arcaBuscarTimer = null;

// Etiqueta y color de cada estado. El orden es el de la tabla: primero lo que
// pide acción.
var ARCA_ESTADOS = [
  { id: "fallecido",       label: "Fallecido",          color: "#b91c1c" },
  { id: "baja",            label: "De baja",            color: "#c2410c" },
  { id: "error",           label: "No encontrado",      color: "#a16207" },
  { id: "sin_consultar",   label: "Sin consultar",      color: "#64748b" },
  { id: "sin_cuit",        label: "Sin CUIT válido",    color: "#94a3b8" },
  { id: "activo_probable", label: "Posiblemente activo", color: "#15803d" },
];

/* ---------- Central de Deudores del BCRA ----------
   La API es pública, sin autenticación y manda CORS, así que la consulta la
   hace el propio navegador. El resultado se guarda en bcra_situacion para no
   volver a pedirlo en cada carga: el dato del BCRA es MENSUAL y se publica con
   rezago, reconsultar seguido no aporta nada. */

var BCRA_URL = "https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/";
// Días antes de volver a consultar un CUIT ya cacheado.
var BCRA_VIGENCIA_DIAS = 20;
// De a cuántos CUIT en paralelo. Bajo a propósito: son 25 filas por hoja y no
// hay ninguna razón para golpear al BCRA con 25 pedidos simultáneos.
var BCRA_CONCURRENCIA = 3;

// Los estados del lado BCRA, en el mismo orden en que se leen: la escala de
// riesgo, después el resultado "no debe nada", y al final los dos huecos.
// `blanca: true` = burbuja blanca con borde en vez de fondo de color, porque
// "sin deuda informada" es un resultado pero NO un nivel de riesgo.
// `hueco: true`  = no hay dato: va como texto discreto, sin burbuja, para que
//                  no se lea como si supiéramos algo.
var BCRA_ESTADOS = [
  { id: "1", label: "1 · Normal",        color: "#15803d" },
  { id: "2", label: "2 · Riesgo bajo",   color: "#65a30d" },
  { id: "3", label: "3 · Riesgo medio",  color: "#ca8a04" },
  { id: "4", label: "4 · Riesgo alto",   color: "#ea580c" },
  { id: "5", label: "5 · Irrecuperable", color: "#b91c1c" },
  { id: "6", label: "6 · Irrec. téc.",   color: "#7f1d1d" },
  { id: "sin_deuda",     label: "0 · s/Deuda Inf",   color: "#475569", blanca: true,
    tip: "El BCRA respondió y no informa deuda para este CUIT" },
  { id: "error",         label: "No se pudo consultar", color: "#94a3b8", hueco: true },
  { id: "sin_consultar", label: "Sin consultar",        color: "#94a3b8", hueco: true },
];

function _bcraMeta(id) {
  for (var i = 0; i < BCRA_ESTADOS.length; i++) {
    if (BCRA_ESTADOS[i].id === String(id)) return BCRA_ESTADOS[i];
  }
  return null;
}

// PARSEO DEFENSIVO. Al 3/8/2026 la forma de la respuesta no está verificada
// contra un llamado real, así que se navega con optional chaining y se prueban
// las variantes plausibles de cada nombre. La respuesta cruda se guarda entera
// en bcra_situacion.raw: si el mapeo está mal, se corrige sin reconsultar.
function _bcraParsear(json) {
  var r = (json && (json.results || json.Results || json.result)) || json || {};
  var periodos = r.periodos || r.Periodos || [];
  var per = Array.isArray(periodos) && periodos.length ? periodos[0] : null;
  var ents = (per && (per.entidades || per.Entidades)) || r.entidades || [];
  if (!Array.isArray(ents)) ents = [];

  // La situación del cliente es la PEOR entre las entidades que informaron.
  var peor = null;
  ents.forEach(function (e) {
    var v = Number(e.situacion != null ? e.situacion : e.Situacion);
    if (!isNaN(v) && v > 0 && (peor === null || v > peor)) peor = v;
  });

  return {
    situacion: peor,
    denominacion: r.denominacion || r.Denominacion || null,
    periodo: (per && (per.periodo || per.Periodo)) || null,
    entidades: ents,
  };
}

// Consulta un CUIT y guarda el resultado. Devuelve lo parseado, o null.
async function _bcraConsultar(cuit) {
  try {
    var resp = await fetch(BCRA_URL + cuit);

    // 404 no es una falla: significa que el CUIT no tiene deudas informadas,
    // que es una respuesta buena y hay que cachearla igual para no repreguntar.
    if (resp.status === 404) {
      await sb.rpc("bcra_registrar", { p_cuit: cuit, p_error: BCRA_SIN_REGISTROS });
      return { situacion: null, error: BCRA_SIN_REGISTROS };
    }
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    var json = await resp.json();
    var d = _bcraParsear(json);
    await sb.rpc("bcra_registrar", {
      p_cuit: cuit,
      p_situacion: d.situacion,
      p_denominacion: d.denominacion,
      p_periodo: d.periodo,
      p_entidades: d.entidades,
      p_raw: json,
      p_error: null,
    });
    return d;
  } catch (err) {
    console.warn("BCRA " + cuit + ":", err.message);
    try {
      await sb.rpc("bcra_registrar", { p_cuit: cuit, p_error: String(err.message || err) });
    } catch (e2) { /* si tampoco se puede guardar el error, se deja pasar */ }
    return { situacion: null, error: String(err.message || err) };
  }
}

/* Recorre TODO el padrón, no solo la hoja visible.
   Sin esto llenar los 1.229 clientes exige pasar por 50 pantallas, que es la
   razón por la que después de un rato de uso solo había 115 consultados.
   Se puede cortar a mitad de camino: lo consultado queda guardado y al volver
   a apretar sigue donde quedó, porque la cola se calcula contra la base. */
var _bcraCancelar = false;
var _bcraCorriendo = false;

async function bcraConsultarTodos() {
  var btn = document.getElementById("bcraTodosBtn");
  var statusEl = document.getElementById("arcaStatus");

  if (_bcraCorriendo) {          // segundo clic = cortar
    _bcraCancelar = true;
    if (btn) btn.textContent = "Cortando…";
    return;
  }

  var resp = await sb.rpc("bcra_pendientes", { p_dias: BCRA_VIGENCIA_DIAS, p_limit: 5000 });
  if (resp.error) {
    alert("No se pudo armar la lista: " + resp.error.message);
    return;
  }
  var cuits = (resp.data || []).map(function (r) { return r.cuit; });
  if (!cuits.length) {
    if (statusEl) {
      statusEl.textContent = "Todos los clientes ya tienen consulta del BCRA al día.";
      statusEl.style.color = "#15803d";
    }
    return;
  }

  _bcraCorriendo = true;
  _bcraCancelar = false;
  if (btn) btn.textContent = "■ Cortar";

  var hechos = 0;
  var i = 0;
  function pintarProgreso() {
    if (!statusEl) return;
    statusEl.textContent = "Consultando al BCRA… " + hechos + " de " + cuits.length +
      " · se puede cortar cuando quieras, lo consultado queda guardado.";
    statusEl.style.color = "#666";
  }
  pintarProgreso();

  async function trabajador() {
    while (i < cuits.length && !_bcraCancelar) {
      var cuit = cuits[i++];
      var d = await _bcraConsultar(cuit);
      // La celda solo existe si ese cliente está en la hoja visible.
      _bcraPintarCelda(cuit, d);
      hechos++;
      if (hechos % 5 === 0) pintarProgreso();
      // Pausa deliberada: sin ella son ~10 pedidos por segundo contra una API
      // pública y gratuita. Con esto quedan ~6, y la tanda entera son minutos.
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }
  var hilos = [];
  for (var k = 0; k < Math.min(BCRA_CONCURRENCIA, cuits.length); k++) hilos.push(trabajador());
  await Promise.all(hilos);

  _bcraCorriendo = false;
  if (btn) btn.textContent = "⇊ Consultar todos en el BCRA";
  if (statusEl) {
    statusEl.textContent = (_bcraCancelar ? "Cortado. " : "Listo. ") + hechos +
      " de " + cuits.length + " consultados.";
    statusEl.style.color = _bcraCancelar ? "#e67e22" : "#15803d";
  }
  // Recarga para que el resumen y los filtros reflejen lo nuevo.
  cargarArcaEstado();
}
window.bcraConsultarTodos = bcraConsultarTodos;

// Completa las celdas de la hoja visible que no tengan dato fresco.
async function _bcraCompletarFilas(filas) {
  // Si está corriendo la tanda completa, no se duplican pedidos por la hoja.
  if (_bcraCorriendo) return;
  var corte = Date.now() - BCRA_VIGENCIA_DIAS * 24 * 3600 * 1000;
  var pend = filas.filter(function (f) {
    if (!f.cuit) return false;
    if (!f.bcra_consultado_at) return true;
    // Un error se reintenta SIEMPRE en la próxima vista. Casi todos son fallas
    // pasajeras de red ("Failed to fetch") y sin esto quedaban congelados 20
    // días, que es la vigencia pensada para un dato bueno, no para un hueco.
    if (f.bcra_estado === "error") return true;
    return new Date(f.bcra_consultado_at).getTime() < corte;
  });
  if (!pend.length) return;

  var i = 0;
  async function trabajador() {
    while (i < pend.length) {
      var f = pend[i++];
      var d = await _bcraConsultar(f.cuit);
      _bcraPintarCelda(f.cuit, d);
    }
  }
  var hilos = [];
  for (var k = 0; k < Math.min(BCRA_CONCURRENCIA, pend.length); k++) hilos.push(trabajador());
  await Promise.all(hilos);
}

// El centinela que escribe _bcraConsultar cuando el BCRA responde 404, que NO
// es una falla: significa que el CUIT no tiene deuda informada.
var BCRA_SIN_REGISTROS = "sin registros";

// Mismo criterio que el CASE de bcra_estado en la vista v_clientes_arca. Se
// duplica acá porque después de consultar hay que pintar la celda sin volver a
// pedirle la fila al servidor; si se cambia uno, cambiar el otro.
function _bcraEstadoDe(sit, error) {
  if (sit) return String(sit);
  if (error && error !== BCRA_SIN_REGISTROS) return "error";
  return "sin_deuda";
}

function _bcraCelda(estado, detalle) {
  var m = _bcraMeta(estado);
  if (!m) return '<span class="bcra-vacio">consultando…</span>';

  var tip = detalle || m.tip || "";
  var t = tip ? ' title="' + escHtml(tip) + '"' : "";

  if (m.hueco) {
    // Todavía sin consultar: el módulo las pide solas al abrirse, así que
    // mostrar "consultando…" describe lo que efectivamente está pasando.
    var txt = m.id === "sin_consultar" ? "consultando…" : m.label;
    return '<span class="bcra-vacio"' + t + ">" + escHtml(txt) + "</span>";
  }
  if (m.blanca) {
    return '<span class="bcra-badge-cero"' + t + ">" + escHtml(m.label) + "</span>";
  }
  return '<span class="arca-badge" style="background:' + m.color + '"' + t + ">" +
         escHtml(m.label) + "</span>";
}

function _bcraPintarCelda(cuit, d) {
  var td = document.querySelector('[data-bcra-cuit="' + cuit + '"]');
  if (!td) return;
  var est = _bcraEstadoDe(d && d.situacion, d && d.error);
  td.innerHTML = _bcraCelda(est, est === "error" ? (d && d.error) : null);
}

/* ---------- Menú de filtro colgado del encabezado de una columna ----------
   Mismo patrón que el filtro de Vendedor del Ranking Inactivos, con las tres
   correcciones que costó encontrar allá:
     1. position:fixed, porque .est-table-wrap tiene overflow y max-height y un
        desplegable absolute queda recortado por el scroll de la tabla.
     2. colgado de <body>, porque los th son position:sticky con z-index y cada
        uno abre su propio contexto de apilado: adentro del th, el th de al lado
        lo tapa por más alto que sea el z-index.
     3. el scroll DENTRO del menú no lo cierra (el listener va en captura y si
        no se filtra recibe también el de la propia lista).
   El de Vendedor tiene su propia copia de esto; no lo migré para no tocar algo
   que ya está validado en pantalla. */

var _filtroMenus = {};

// cfg: { menuId, btnId, chipId, opciones: [{id,label,color}], seleccion: []
//        (se muta in situ), onCambio: fn }
function registrarFiltroMenu(cfg) {
  _filtroMenus[cfg.menuId] = cfg;
}

function toggleFiltroMenu(menuId, ev) {
  if (ev) ev.stopPropagation();
  var menu = document.getElementById(menuId);
  if (!menu) return;
  if (menu.classList.contains("abierto")) {
    menu.classList.remove("abierto");
    return;
  }
  _cerrarFiltroMenus();
  _ubicarFiltroMenu(menuId);
  _renderFiltroMenu(menuId);
  menu.classList.add("abierto");
}
window.toggleFiltroMenu = toggleFiltroMenu;

function _cerrarFiltroMenus() {
  Object.keys(_filtroMenus).forEach(function (id) {
    var m = document.getElementById(id);
    if (m) m.classList.remove("abierto");
  });
}

function _ubicarFiltroMenu(menuId) {
  var cfg = _filtroMenus[menuId];
  var menu = document.getElementById(menuId);
  var btn = cfg && document.getElementById(cfg.btnId);
  if (!menu || !btn) return;
  if (menu.parentNode !== document.body) document.body.appendChild(menu);
  var r = btn.getBoundingClientRect();
  var ancho = 210;
  menu.style.top = Math.round(r.bottom + 4) + "px";
  menu.style.left = Math.round(Math.min(r.left, window.innerWidth - ancho - 12)) + "px";
}

function _renderFiltroMenu(menuId) {
  var cfg = _filtroMenus[menuId];
  var menu = document.getElementById(menuId);
  if (!cfg || !menu) return;

  menu.innerHTML =
    '<div class="filtro-acciones">' +
    '<button type="button" data-f-todos>Todos</button>' +
    '<button type="button" data-f-limpiar>Limpiar</button>' +
    "</div>" +
    cfg.opciones.map(function (o) {
      var on = cfg.seleccion.indexOf(o.id) !== -1;
      return (
        '<label class="filtro-item">' +
        '<input type="checkbox" data-f-op="' + escHtml(o.id) + '"' + (on ? " checked" : "") + ">" +
        '<span' + (o.color ? ' style="color:' + o.color + '"' : "") + ">" +
        escHtml(o.label) + "</span></label>"
      );
    }).join("");

  menu.querySelectorAll("[data-f-op]").forEach(function (chk) {
    chk.addEventListener("change", function () {
      var id = chk.dataset.fOp;
      var i = cfg.seleccion.indexOf(id);
      if (chk.checked && i === -1) cfg.seleccion.push(id);
      if (!chk.checked && i !== -1) cfg.seleccion.splice(i, 1);
      _pintarChipFiltro(menuId);
      cfg.onCambio();
    });
  });
  var todos = menu.querySelector("[data-f-todos]");
  if (todos) todos.addEventListener("click", function () {
    cfg.seleccion.length = 0;
    cfg.opciones.forEach(function (o) { cfg.seleccion.push(o.id); });
    _renderFiltroMenu(menuId);
    _pintarChipFiltro(menuId);
    cfg.onCambio();
  });
  var limpiar = menu.querySelector("[data-f-limpiar]");
  if (limpiar) limpiar.addEventListener("click", function () {
    cfg.seleccion.length = 0;
    _renderFiltroMenu(menuId);
    _pintarChipFiltro(menuId);
    cfg.onCambio();
  });
}

// Seleccionar TODAS las opciones equivale a no filtrar, así que el chip no
// muestra nada: si no, "6" al lado del título haría pensar que hay un filtro
// puesto cuando en realidad se está viendo todo.
function _pintarChipFiltro(menuId) {
  var cfg = _filtroMenus[menuId];
  if (!cfg) return;
  var chip = document.getElementById(cfg.chipId);
  if (!chip) return;
  var n = cfg.seleccion.length;
  if (n === 0 || n === cfg.opciones.length) n = 0;
  chip.textContent = n ? String(n) : "";
  chip.style.display = n ? "" : "none";
}

document.addEventListener("click", function (ev) {
  Object.keys(_filtroMenus).forEach(function (id) {
    var menu = document.getElementById(id);
    if (!menu || !menu.classList.contains("abierto")) return;
    if (menu.contains(ev.target)) return;
    var btn = document.getElementById(_filtroMenus[id].btnId);
    if (btn && btn.contains(ev.target)) return;
    menu.classList.remove("abierto");
  });
});

// El listener va en captura para enterarse del scroll de cualquier contenedor,
// y por eso mismo recibe el de la propia lista: sin el guard, mover la rueda
// sobre el menú lo cerraba en el acto.
document.addEventListener("scroll", function (ev) {
  Object.keys(_filtroMenus).forEach(function (id) {
    var menu = document.getElementById(id);
    if (!menu || !menu.classList.contains("abierto")) return;
    if (ev.target === menu || (ev.target && ev.target.nodeType && menu.contains(ev.target))) return;
    menu.classList.remove("abierto");
  });
}, true);

function _arcaMeta(id) {
  for (var i = 0; i < ARCA_ESTADOS.length; i++) {
    if (ARCA_ESTADOS[i].id === id) return ARCA_ESTADOS[i];
  }
  return { id: id, label: id || "—", color: "#64748b" };
}

registrarFiltroMenu({
  menuId: "arcaEstadoMenu",
  btnId: "arcaEstadoBtn",
  chipId: "arcaEstadoChip",
  opciones: ARCA_ESTADOS,
  seleccion: _arcaEstados,
  onCambio: function () { _arcaPagina = 1; cargarArcaEstado(); },
});

registrarFiltroMenu({
  menuId: "arcaBcraMenu",
  btnId: "arcaBcraBtn",
  chipId: "arcaBcraChip",
  opciones: BCRA_ESTADOS,
  seleccion: _arcaBcra,
  onCambio: function () { _arcaPagina = 1; cargarArcaEstado(); },
});

async function cargarArcaEstado() {
  var statusEl = document.getElementById("arcaStatus");
  var tbody = document.querySelector("#arcaTable tbody");
  if (!tbody) return;
  if (statusEl) {
    statusEl.textContent = "Cargando…";
    statusEl.style.color = "#666";
  }

  try {
    var res = await Promise.all([
      sb.rpc("get_arca_resumen"),
      sb.rpc("get_arca_estado_clientes", {
        p_limit: ARCA_LIMIT,
        p_offset: (_arcaPagina - 1) * ARCA_LIMIT,
        p_q: _arcaQuery || null,
        p_estados: _arcaEstados.length ? _arcaEstados : null,
        p_bcra: _arcaBcra.length ? _arcaBcra : null,
      }),
    ]);
    if (res[0].error) throw res[0].error;
    if (res[1].error) throw res[1].error;

    _renderArcaResumen(res[0].data || []);
    _renderArcaTabla(res[1].data || []);
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    console.error("cargarArcaEstado error", err);
    if (statusEl) {
      statusEl.textContent = "Error: " + (err.message || err);
      statusEl.style.color = "#c0392b";
    }
  }
}
window.cargarArcaEstado = cargarArcaEstado;

function _renderArcaResumen(filas) {
  var cont = document.getElementById("arcaResumen");
  var chips = document.getElementById("arcaEstadoChips");
  var countEl = document.getElementById("arcaCount");
  var porEstado = {};
  var total = 0;
  filas.forEach(function (f) {
    porEstado[f.estado_arca] = Number(f.clientes) || 0;
    total += Number(f.clientes) || 0;
  });
  if (countEl) countEl.textContent = total;

  if (cont) {
    cont.innerHTML = ARCA_ESTADOS.map(function (e) {
      var n = porEstado[e.id] || 0;
      return (
        '<div class="arca-card"' + (n === 0 ? ' style="opacity:.45"' : "") + ">" +
        '<div class="arca-card-n" style="color:' + e.color + '">' + n + "</div>" +
        '<div class="arca-card-l">' + escHtml(e.label) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  _pintarChipFiltro("arcaEstadoMenu");
  _pintarChipFiltro("arcaBcraMenu");
}

function _renderArcaTabla(filas) {
  var tbody = document.querySelector("#arcaTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  var totalFilas = filas.length ? Number(filas[0].total_filas || 0) : 0;

  if (filas.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="est-empty">' +
      (_arcaQuery || _arcaEstados.length || _arcaBcra.length
        ? "Ningún cliente coincide con el filtro."
        : "Sin clientes.") +
      "</td></tr>";
    _renderArcaPager(0);
    return;
  }

  filas.forEach(function (f) {
    var meta = _arcaMeta(f.estado_arca);
    var det = [];
    if (f.fecha_fallecimiento) det.push("Fallecimiento " + _fmtFechaGrupo(f.fecha_fallecimiento));
    if (f.fecha_baja) det.push("Baja " + _fmtFechaGrupo(f.fecha_baja));
    if (f.error) det.push(f.error);
    // La razón social de ARCA solo se muestra si difiere de la nuestra: si son
    // iguales es ruido, y si difieren es un dato que conviene ver.
    if (f.razon_social_arca &&
        f.razon_social_arca.trim().toUpperCase() !== String(f.business_name || "").trim().toUpperCase()) {
      det.push("En ARCA: " + f.razon_social_arca);
    }

    var puedeRevisar = f.estado_arca !== "sin_cuit";
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><span class="est-cod">' + escHtml(f.cod_cliente) + "</span></td>" +
      '<td class="est-rs">' + escHtml(f.business_name || "(sin razón social)") +
        (det.length ? '<span class="rank-cuit">' + escHtml(det.join(" · ")) + "</span>" : "") +
      "</td>" +
      '<td style="font-size:12px; font-variant-numeric:tabular-nums">' +
        (f.cuit ? escHtml(f.cuit) : "—") + "</td>" +
      '<td><span class="arca-badge" style="background:' + meta.color + '">' +
        escHtml(meta.label) + "</span></td>" +
      // La celda se pinta con lo cacheado y, si está vencido o no existe, la
      // completa _bcraCompletarFilas cuando llega la respuesta del BCRA.
      '<td data-bcra-cuit="' + escHtml(f.cuit || "") + '">' +
        (f.cuit
          ? _bcraCelda(f.bcra_estado, f.bcra_estado === "error" ? f.bcra_error : null)
          : "—") + "</td>" +
      '<td style="font-size:12px">' +
        (f.consultado_at
          ? new Date(f.consultado_at).toLocaleDateString("es-AR")
          : "—") + "</td>" +
      "<td>" +
        (puedeRevisar
          ? '<button type="button" class="est-rank-btn" data-arca-revisar="' +
            escHtml(f.cuit) +
            '" title="Consulta el BCRA ahora y encola la revisión de ARCA">⟳</button>'
          : "") +
      "</td>";

    var btn = tr.querySelector("[data-arca-revisar]");
    if (btn) btn.addEventListener("click", function () { revisarCliente(f.cuit, btn); });
    tbody.appendChild(tr);
  });

  _renderArcaPager(totalFilas);

  // Se dispara DESPUÉS de dibujar: la tabla aparece completa al instante con lo
  // que haya cacheado y las celdas del BCRA se van llenando solas.
  _bcraCompletarFilas(filas);
}

function _renderArcaPager(totalFilas) {
  var pager = document.getElementById("arcaPager");
  if (!pager) return;
  var totalPaginas = Math.max(1, Math.ceil(totalFilas / ARCA_LIMIT));
  pager.innerHTML = "";

  if (totalPaginas <= 1) {
    if (totalFilas > 0) {
      var solo = document.createElement("span");
      solo.className = "est-pager-info";
      solo.style.marginLeft = "0";
      solo.textContent = totalFilas + " cliente" + (totalFilas === 1 ? "" : "s");
      pager.appendChild(solo);
    }
    return;
  }

  function btnPag(txt, pag, opts) {
    opts = opts || {};
    var b = document.createElement("button");
    b.type = "button";
    b.className = "est-pager-btn" + (opts.activa ? " active" : "");
    b.textContent = txt;
    b.disabled = !!opts.deshabilitada;
    if (!opts.deshabilitada && !opts.activa) {
      b.addEventListener("click", function () {
        _arcaPagina = pag;
        cargarArcaEstado();
      });
    }
    return b;
  }

  pager.appendChild(btnPag("‹", _arcaPagina - 1, { deshabilitada: _arcaPagina <= 1 }));
  var desde = Math.max(1, _arcaPagina - 2);
  var hasta = Math.min(totalPaginas, desde + 4);
  for (var i = desde; i <= hasta; i++) {
    pager.appendChild(btnPag(String(i), i, { activa: i === _arcaPagina }));
  }
  pager.appendChild(btnPag("›", _arcaPagina + 1, { deshabilitada: _arcaPagina >= totalPaginas }));

  var info = document.createElement("span");
  info.className = "est-pager-info";
  info.textContent = totalFilas + " clientes";
  pager.appendChild(info);
}

function onInputBuscarArca(el) {
  clearTimeout(_arcaBuscarTimer);
  var v = el.value;
  _arcaBuscarTimer = setTimeout(function () {
    if (String(v).trim() === _arcaQuery) return;
    _arcaQuery = String(v).trim();
    _arcaPagina = 1;
    cargarArcaEstado();
  }, 300);
}
window.onInputBuscarArca = onInputBuscarArca;

function limpiarBusquedaArca() {
  var el = document.getElementById("arcaBuscar");
  if (el) el.value = "";
  clearTimeout(_arcaBuscarTimer);
  _arcaQuery = "";
  _arcaPagina = 1;
  cargarArcaEstado();
}
window.limpiarBusquedaArca = limpiarBusquedaArca;

// "Revisar" toca LAS DOS fuentes, pero no puede hacer lo mismo con cada una:
//   BCRA -> se consulta acá nomás y la celda se actualiza al toque, porque la
//           API es pública y la llama el navegador.
//   ARCA -> solo se adelanta el CUIT en la cola: la consulta la hace un worker
//           externo con certificado, así que el dato llega en su corrida.
// Las dos salen en paralelo; que falle una no cancela la otra.
async function revisarCliente(cuit, btn) {
  if (!cuit) return;
  btn.disabled = true;
  btn.textContent = "…";

  var res = await Promise.allSettled([
    sb.rpc("arca_marcar_para_revision", { p_cuit: cuit }),
    _bcraConsultar(cuit),
  ]);

  // El BCRA siempre deja algo que mostrar, aunque sea el error.
  if (res[1].status === "fulfilled") _bcraPintarCelda(cuit, res[1].value);

  var arcaOk = res[0].status === "fulfilled" && !res[0].value.error;
  if (!arcaOk) {
    var e = res[0].status === "rejected" ? res[0].reason : res[0].value.error;
    console.error("revisarCliente ARCA", e);
    alert("El BCRA se actualizó, pero no se pudo encolar la revisión de ARCA: " +
          ((e && e.message) || e));
    btn.disabled = false;
    btn.textContent = "⟳";
    return;
  }

  btn.textContent = "✓";
  btn.title = "BCRA actualizado · ARCA en cola para la próxima corrida del worker";
}
window.revisarCliente = revisarCliente;

// Formatea pesos con el signo ANTES del $ (-$6.294.600, no $-6.294.600).
function fmtPesosRanking(n) {
  var v = Math.round(Number(n) || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("es-AR");
}

// Deja las tres tarjetas colapsadas. Es el estado por defecto al entrar al
// módulo: el HTML ya arranca así, y esto lo reaplica al volver a la sección
// para que la vista sea siempre la misma. Colapsar es solo visual — las tablas
// se llenan igual, así que "Descargar con Mensajes", que lee el DOM de la
// tabla "De baja", sigue funcionando con las tarjetas cerradas.
// La lista va adentro y no en un `var` de módulo a propósito: las funciones se
// hoistean, pero si algo falla antes en el script las asignaciones `var` no
// llegan a correr y quedarían undefined acá.
function colapsarTarjetasEstadistica() {
  ["estCardProximosBody", "estCardRankingBody"].forEach(function (id) {
    var body = document.getElementById(id);
    if (!body) return;
    body.style.display = "none";
    var head = body.previousElementSibling;
    if (head && head.classList.contains("est-card-head")) {
      head.classList.add("collapsed");
      var caret = head.querySelector(".est-card-caret");
      if (caret) caret.textContent = "▸";
    }
  });
}
window.colapsarTarjetasEstadistica = colapsarTarjetasEstadistica;

// Colapsa / expande una tarjeta de Estadística Clientes
var _arcaCargado = false;

function toggleEstCard(bodyId, headEl) {
  var body = document.getElementById(bodyId);
  if (!body) return;
  var estabaOculto = body.style.display === "none";
  body.style.display = estabaOculto ? "" : "none";
  if (headEl) {
    headEl.classList.toggle("collapsed", !estabaOculto);
    var caret = headEl.querySelector(".est-card-caret");
    if (caret) caret.textContent = estabaOculto ? "▾" : "▸";
  }
  // Estado en ARCA se carga al abrirlo por primera vez, no con la página: son
  // dos consultas que no hacen falta si nadie despliega la tarjeta.
  if (estabaOculto && bodyId === "estCardArcaBody" && !_arcaCargado) {
    _arcaCargado = true;
    cargarArcaEstado();
  }
  // Las tres tarjetas pesadas de Gerente de ventas, por lo mismo: el mapa y la
  // cobertura por localidad son consultas caras que no hacen falta si nadie
  // despliega la tarjeta.
  if (estabaOculto && bodyId === "gvMapaBody") cargarMapaGerente();
  if (estabaOculto && bodyId === "gvRatioBody") cargarRatioGerente();
  if (estabaOculto && bodyId === "gvRindeBody") cargarRindeGerente();
  if (estabaOculto && bodyId === "gvSenalesBody") cargarSenalesGerente();
}
window.toggleEstCard = toggleEstCard;

// Carga inicial del Ranking Inactivos al abrir Estadística Clientes.
// Fija el período en 12 meses y apaga el switch de ocultos, para que entrar al
// módulo siempre muestre lo mismo aunque en la visita anterior se hubiera
// dejado otro período o la vista de ocultos prendida.
function cargaInicialRankingInactivos() {
  var sel = document.getElementById("rankingInactivosPeriod");
  if (sel) sel.value = "12";
  _rankingPeriodoCargado = "12";

  var sw = document.getElementById("rankingInactivosOcultosSwitch");
  if (sw) sw.checked = false;
  _rankingInactivosVerOcultos = false;
  _pintarSwitchOcultos();

  // La búsqueda no sobrevive al cambio de pestaña: volver y encontrarse con
  // una lista filtrada por algo que se tipeó hace rato se lee como si el
  // ranking hubiera perdido clientes.
  var buscar = document.getElementById("rankingInactivosBuscar");
  if (buscar) buscar.value = "";
  _rankingInactivosQuery = "";
  clearTimeout(_rankingBuscarTimer);

  // Por lo mismo que la búsqueda: volver al módulo y encontrar la tabla
  // filtrada por un vendedor elegido hace rato se lee como si el ranking
  // hubiera perdido clientes.
  _rankingVendedores = [];
  _refrescarChipVendedores();

  cargarRankingInactivosDesdeCero();
}
window.cargaInicialRankingInactivos = cargaInicialRankingInactivos;

// Dibuja el paginador. Muestra la primera, la última y una ventana de ±2
// alrededor de la actual, con "…" en los saltos, para que no se desborde
// cuando hay muchas hojas.
function _renderPagerRanking(totalFilas, totalPaginas) {
  var pager = document.getElementById("rankingInactivosPager");
  if (!pager) return;
  pager.innerHTML = "";

  if (totalPaginas <= 1) {
    if (totalFilas > 0) {
      var solo = document.createElement("span");
      solo.className = "est-pager-info";
      solo.style.marginLeft = "0";
      solo.textContent = totalFilas + " cliente" + (totalFilas === 1 ? "" : "s");
      pager.appendChild(solo);
    }
    return;
  }

  var actual = _rankingInactivosPagina;

  function crearBtn(texto, pagina, opts) {
    opts = opts || {};
    var b = document.createElement("button");
    b.type = "button";
    b.className = "est-pager-btn" + (opts.activa ? " active" : "");
    b.textContent = texto;
    if (opts.titulo) b.title = opts.titulo;
    if (opts.deshabilitada || opts.activa) {
      b.disabled = !!opts.deshabilitada;
      if (opts.activa) b.setAttribute("aria-current", "page");
    }
    if (!opts.deshabilitada && !opts.activa) {
      b.addEventListener("click", function () { irAPaginaRanking(pagina); });
    }
    return b;
  }

  pager.appendChild(crearBtn("‹", actual - 1, {
    deshabilitada: actual <= 1,
    titulo: "Hoja anterior"
  }));

  // Números a mostrar: 1, la última, y ±2 alrededor de la actual
  var nums = [1, totalPaginas];
  for (var i = actual - 2; i <= actual + 2; i++) {
    if (i >= 1 && i <= totalPaginas) nums.push(i);
  }
  nums = nums
    .filter(function (v, idx, arr) { return arr.indexOf(v) === idx; })
    .sort(function (a, b) { return a - b; });

  var previo = 0;
  nums.forEach(function (n) {
    if (n - previo > 1) {
      var dots = document.createElement("span");
      dots.className = "est-pager-dots";
      dots.textContent = "…";
      pager.appendChild(dots);
    }
    pager.appendChild(crearBtn(String(n), n, {
      activa: n === actual,
      titulo: "Hoja " + n
    }));
    previo = n;
  });

  pager.appendChild(crearBtn("›", actual + 1, {
    deshabilitada: actual >= totalPaginas,
    titulo: "Hoja siguiente"
  }));

  var info = document.createElement("span");
  info.className = "est-pager-info";
  info.textContent =
    "Hoja " + actual + " de " + totalPaginas + " · " + totalFilas + " clientes";
  pager.appendChild(info);
}

// Período que está EFECTIVAMENTE cargado en la tabla, que puede diferir del
// que muestra el menú: elegir en el menú ya no recarga nada, hay que confirmar
// con "Cargar período".
var _rankingPeriodoCargado = "12";

// Vuelve a la hoja 1 y recarga. Es lo que corresponde cuando cambia el
// conjunto de datos (período, switch de ocultos): quedarse en la hoja 7 de un
// resultado que ahora tiene 2 hojas no tiene sentido.
function cargarRankingInactivosDesdeCero() {
  var sel = document.getElementById("rankingInactivosPeriod");
  _rankingPeriodoCargado = sel ? sel.value : "12";
  _marcarPeriodoPendiente();
  _rankingInactivosPagina = 1;
  // La lista del menú de vendedores está acotada al conjunto que muestra la
  // tabla, así que cambiar de período o entrar a los ocultos la deja vieja. Se
  // vuelve a pedir la próxima vez que se abra el menú.
  _rankVendLista = null;
  cargarRankingInactivos();
}
window.cargarRankingInactivosDesdeCero = cargarRankingInactivosDesdeCero;

// El menú no aplica el período: solo lo elige. Sin alguna señal, cambiarlo y no
// apretar el botón deja la tabla mostrando otro período sin que se note, así
// que el botón se resalta mientras haya diferencia.
function onCambioPeriodoRanking() {
  _marcarPeriodoPendiente();
}
window.onCambioPeriodoRanking = onCambioPeriodoRanking;

function _marcarPeriodoPendiente() {
  var sel = document.getElementById("rankingInactivosPeriod");
  var btn = document.getElementById("rankingPeriodoBtn");
  if (!sel || !btn) return;
  var pendiente = sel.value !== _rankingPeriodoCargado;
  btn.classList.toggle("pendiente", pendiente);
  btn.title = pendiente
    ? "La tabla todavía muestra " + _rankingPeriodoCargado + " meses"
    : "La tabla ya muestra este período";
}

// Salta a una hoja del ranking
function irAPaginaRanking(pagina) {
  _rankingInactivosPagina = Math.max(1, pagina);
  cargarRankingInactivos();
}
window.irAPaginaRanking = irAPaginaRanking;

// Alterna entre el ranking y la lista de clientes ocultados a mano.
// El estado real lo tiene el checkbox del switch, no una variable suelta:
// así el DOM y la vista no pueden quedar desincronizados.
function toggleRankingInactivosOcultos() {
  var sw = document.getElementById("rankingInactivosOcultosSwitch");
  _rankingInactivosVerOcultos = sw ? sw.checked : !_rankingInactivosVerOcultos;
  _pintarSwitchOcultos();
  cargarRankingInactivosDesdeCero();
}
window.toggleRankingInactivosOcultos = toggleRankingInactivosOcultos;

// Refleja el estado del switch en el rótulo On/Off
function _pintarSwitchOcultos() {
  var estado = document.getElementById("rankingInactivosOcultosEstado");
  if (estado) estado.textContent = _rankingInactivosVerOcultos ? "On" : "Off";
  var wrap = document.querySelector(".est-switch-wrap");
  if (wrap) wrap.classList.toggle("on", _rankingInactivosVerOcultos);
}

// Refresca el contador de ocultos del switch
function _refrescarContadorOcultos() {
  sb.from("ranking_inactivos_excluidos")
    .select("cod_cliente", { count: "exact", head: true })
    .then(function (resp) {
      var el = document.getElementById("rankingInactivosOcultosCount");
      if (el && !resp.error) el.textContent = resp.count || 0;
    });
}

// Saca un cliente del ranking (persistente y compartido entre admins)
function ocultarDelRankingInactivos(cod, razon, btnEl) {
  if (!confirm('¿Ocultar a "' + razon + '" (cod ' + cod + ') del Ranking Inactivos?\n\nSe puede restaurar con el switch "Ver ocultos".')) return;
  btnEl.disabled = true;
  btnEl.textContent = "…";
  sb.from("ranking_inactivos_excluidos")
    .insert({ cod_cliente: String(cod) })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _refrescarContadorOcultos();
      cargarRankingInactivos();
    })
    .catch(function (err) {
      console.error("ocultarDelRankingInactivos error", err);
      alert("No se pudo ocultar: " + (err.message || err));
      btnEl.disabled = false;
      btnEl.textContent = "✕ Ocultar";
    });
}
window.ocultarDelRankingInactivos = ocultarDelRankingInactivos;

// Devuelve un cliente al ranking
function restaurarEnRankingInactivos(cod, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "…";
  sb.from("ranking_inactivos_excluidos")
    .delete()
    .eq("cod_cliente", String(cod))
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _refrescarContadorOcultos();
      cargarRankingInactivos();
    })
    .catch(function (err) {
      console.error("restaurarEnRankingInactivos error", err);
      alert("No se pudo restaurar: " + (err.message || err));
      btnEl.disabled = false;
      btnEl.textContent = "↩ Restaurar";
    });
}
window.restaurarEnRankingInactivos = restaurarEnRankingInactivos;

function cargarRankingInactivos() {
  // El período CARGADO, no el del menú. Elegir en el menú ya no aplica nada, así
  // que leerlo acá haría que paginar o esconder un cliente cambien el período
  // sin que nadie lo haya confirmado.
  var periodMeses = parseInt(_rankingPeriodoCargado, 10) || 12;
  var statusEl = document.getElementById("rankingInactivosStatus");
  var tableBody = document.querySelector("#rankingInactivosTable tbody");
  var countEl = document.getElementById("rankingInactivosCount");

  statusEl.textContent = "Cargando datos…";
  statusEl.style.color = "#666";
  tableBody.innerHTML = "";
  _refrescarContadorOcultos();

  sb.rpc("get_ranking_inactivos", {
    p_meses: periodMeses,
    p_limit: RANKING_INACTIVOS_LIMIT,
    p_solo_excluidos: _rankingInactivosVerOcultos,
    p_offset: (_rankingInactivosPagina - 1) * RANKING_INACTIVOS_LIMIT,
    // La búsqueda va server-side: la tabla está paginada de a 25 sobre 532, así
    // que filtrar en el navegador solo miraría las 25 visibles.
    p_q: _rankingInactivosQuery || null,
    p_vendedores: _vendedoresParaRpc()
  })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];

      // total_filas viene repetido en cada fila (COUNT(*) OVER () en la RPC)
      var totalFilas = filas.length ? Number(filas[0].total_filas || 0) : 0;
      var totalPaginas = Math.max(1, Math.ceil(totalFilas / RANKING_INACTIVOS_LIMIT));

      // Si la hoja quedó vacía por ocultar clientes, retroceder una y recargar
      if (filas.length === 0 && _rankingInactivosPagina > 1) {
        _rankingInactivosPagina--;
        cargarRankingInactivos();
        return;
      }

      if (countEl) countEl.textContent = totalFilas;

      if (filas.length === 0) {
        _renderPagerRanking(0, 1);
        // Con un filtro de vendedor activo el mensaje tiene que decirlo: si no,
        // "no hay clientes inactivos" se lee como que el período está limpio.
        var filtroVend = _vendedoresParaRpc();
        statusEl.textContent = _rankingInactivosQuery
          ? 'Ningún cliente del ranking coincide con "' + _rankingInactivosQuery + '"' +
            (filtroVend ? " y los vendedores seleccionados." : ".")
          : filtroVend
            ? "Ningún cliente inactivo para " +
              (filtroVend.length === 1 ? filtroVend[0] : filtroVend.length + " vendedores") + "."
            : _rankingInactivosVerOcultos
              ? "No hay clientes ocultados. Usá ✕ Ocultar en el ranking para esconder alguno."
              : "No hay clientes sin compras hace más de " + periodMeses + " meses.";
        statusEl.style.color = "#e67e22";
        return;
      }

      filas.forEach(function (r, idx) {
        var razon = r.business_name || "(sin razón social)";
        var fecha = r.last_date
          ? new Date(r.last_date + "T00:00:00").toLocaleDateString("es-AR")
          : "—";
        var totalHist = Math.round(Number(r.total_historico || 0));
        var valorUlt = Math.round(Number(r.valor_ultimo_pedido || 0));

        // El valor del último pedido puede ser negativo o cero por motivos
        // distintos; se muestra el número tal cual y se aclara el porqué para
        // que no se lea como un error de cálculo.
        //   < 0  -> el último movimiento fue una devolución / nota de crédito
        //           (sales_lines guarda boxes en negativo).
        //   = 0  -> el pedido existe pero todos sus artículos están
        //           discontinuados y hoy no tienen precio en products.
        var ultHtml = fmtPesosRanking(valorUlt);
        if (valorUlt < 0) {
          ultHtml +=
            ' <span style="color:#c0392b; font-weight:600" ' +
            'title="El último movimiento del cliente fue una devolución o nota de crédito">' +
            "(devolución)</span>";
        } else if (valorUlt === 0 && r.ultimo_solo_discontinuados) {
          ultHtml +=
            ' <span style="color:#e67e22; font-weight:600; font-size:11px" ' +
            'title="El pedido existe, pero todos sus artículos están discontinuados y hoy no tienen precio de lista">' +
            "(solo productos discontinuados)</span>";
        }

        // Desglose por año: {"2023": 123, "2024": 456}.
        // Los años van en grilla de 2 columnas (.est-desglose-anios): apilados
        // uno por línea, un cliente con 5 años de historia estiraba la fila a
        // ~9 líneas de alto y hacía la tabla ilegible.
        var desglose = r.desglose_por_anio || {};
        var años = _aniosDesglose();
        var chips = años.map(function (a) {
          var monto = Math.round(Number(desglose[a]) || 0);
          // Los años en cero se atenúan: están para que la grilla sea
          // comparable entre filas, no para leerlos.
          return (
            '<span' + (monto === 0 ? ' class="cero"' : "") + "><i>" + a + "</i> $" +
            monto.toLocaleString("es-AR") +
            "</span>"
          );
        });
        // Lo que quedó atrás de la ventana se muestra junto, así los chips
        // siguen sumando el valor histórico total de la columna de al lado.
        var fueraVentana = _montoFueraDeVentana(desglose);
        if (fueraVentana > 0) {
          chips.push(
            '<span title="Compras anteriores a ' + años[años.length - 1] + '">' +
            "<i>Antes</i> $" + fueraVentana.toLocaleString("es-AR") + "</span>"
          );
        }
        var desgloseHtml =
          '<div class="est-desglose-anios">' + chips.join("") + "</div>";
        var frec = r.frecuencia_meses != null ? Number(r.frecuencia_meses) : null;

        // Pie del desglose: pedidos y frecuencia en UNA línea, separados por
        // punto medio. Antes iban en dos y sumaban alto sin aportar nada.
        desgloseHtml +=
          '<div class="est-desglose-pie">' +
          "Pedidos: <strong>" + (r.total_pedidos != null ? r.total_pedidos : "—") + "</strong>" +
          ' <span class="est-sep">·</span> ' +
          "Frecuencia: <strong>" + (frec != null ? frec + " m" : "—") + "</strong>" +
          "</div>";

        // Ocultar del ranking, o restaurar si estamos viendo los ocultos.
        // El handler se engancha con addEventListener más abajo, NO con un
        // onclick inline: la razón social va interpolada y el navegador decodifica
        // las entidades HTML del atributo ANTES de parsear el JS, así que un
        // apóstrofo en el nombre (D'Angelo) rompería la llamada.
        var accionBtn = _rankingInactivosVerOcultos
          ? '<button type="button" class="est-rank-btn restore" ' +
            'title="Devolver este cliente al ranking">↩ Restaurar</button>'
          : '<button type="button" class="est-rank-btn" ' +
            'title="Ocultar este cliente del ranking (se puede restaurar)">✕ Ocultar</button>';

        // El puesto lo da la RPC (ROW_NUMBER sobre TODOS los inactivos), no el
        // índice dentro de la hoja: en la hoja 2 tiene que arrancar en 101.
        var puesto = r.ranking != null ? r.ranking : idx + 1;

        // Grupos de razones sociales: cuando la fila representa a más de un
        // código (customer_grupos), la RPC devuelve `miembros` con el detalle.
        // La fila se vuelve colapsable en vez de mostrar los códigos sueltos,
        // que es lo que se quiso evitar al agruparlos.
        var miembros = Array.isArray(r.miembros) ? r.miembros : null;
        var esGrupo = !!(miembros && miembros.length > 1);
        var caretHtml = esGrupo
          ? '<span class="rank-caret" aria-hidden="true">▸</span>'
          : "";
        // El CUIT va debajo del nombre porque el buscador filtra por él:
        // buscar por un campo invisible no deja controlar el resultado.
        // 236 de los 1233 códigos del ERP no tienen ficha en customers, así
        // que puede venir vacío; en ese caso no se muestra la línea.
        var cuitHtml = r.cuit
          ? '<span class="rank-cuit">CUIT ' + escHtml(r.cuit) + "</span>"
          : "";
        var grupoBadge = esGrupo
          ? ' <span class="rank-grupo-badge" title="' + miembros.length +
            ' razones sociales agrupadas. Clic en la fila para ver el detalle.">' +
            miembros.length + " r. sociales</span>"
          : "";

        var tr = document.createElement("tr");
        if (esGrupo) tr.className = "rank-fila-grupo";
        tr.innerHTML =
          "<td>" + puesto + "</td>" +
          '<td><span class="est-cod">' + escHtml(r.cod_cliente) + "</span></td>" +
          '<td class="est-rs">' + caretHtml + escHtml(razon) + grupoBadge + cuitHtml + "</td>" +
          // Vendedor asignado. Se muestra el nombre (customer_commissions) y el
          // código del ERP (customers.vend) queda en el tooltip: el nombre es
          // lo que se lee, el código es con lo que se cruza contra el ERP.
          '<td class="rank-vend"' +
            (r.vendedor ? ' title="Código de vendedor ' + escHtml(r.vendedor) + '"' : "") +
            ">" + escHtml(_vendNombreVisible(r.vendedor_nombre) || r.vendedor || "—") + "</td>" +
          "<td style='font-weight:700; color:#2c3e50'>" + fmtPesosRanking(totalHist) + "</td>" +
          "<td style='font-size:12px'>" + ultHtml + "</td>" +
          "<td style='font-size:12px'>" + fecha + "</td>" +
          "<td>" + accionBtn + "</td>" +
          '<td class="est-desglose">' + desgloseHtml + "</td>";

        var btnAccion = tr.querySelector(".est-rank-btn");
        if (btnAccion) {
          btnAccion.addEventListener("click", function () {
            if (_rankingInactivosVerOcultos) {
              restaurarEnRankingInactivos(r.cod_cliente, btnAccion);
            } else {
              ocultarDelRankingInactivos(r.cod_cliente, razon, btnAccion);
            }
          });
        }

        tableBody.appendChild(tr);

        // Fila de detalle del grupo, oculta hasta que se hace clic. Va como
        // <tr> aparte y no dentro de la celda para que las columnas del
        // detalle se alineen con el ancho completo de la tabla.
        if (esGrupo) {
          var trDet = document.createElement("tr");
          trDet.className = "rank-detalle";
          trDet.style.display = "none";
          trDet.innerHTML =
            '<td colspan="9">' +
            '<div class="rank-detalle-tit">Razones sociales del grupo</div>' +
            miembros
              .map(function (m) {
                var f = m.last_date
                  ? new Date(String(m.last_date) + "T00:00:00").toLocaleDateString("es-AR")
                  : "—";
                return (
                  '<div class="rank-detalle-row">' +
                  '<span class="est-cod">' + escHtml(m.cod) + "</span>" +
                  '<span class="rank-detalle-nom">' +
                  escHtml(m.nombre || "(sin razón social)") +
                  (m.vigente ? ' <span class="grupo-badge">vigente</span>' : "") +
                  "</span>" +
                  '<span class="rank-detalle-fecha">última compra ' + f + "</span>" +
                  '<span class="rank-detalle-valor">' +
                  fmtPesosRanking(Math.round(Number(m.valor) || 0)) + "</span>" +
                  "</div>"
                );
              })
              .join("") +
            "</td>";
          tableBody.appendChild(trDet);

          // El clic en la fila alterna el detalle, salvo cuando se hizo sobre
          // un botón: si no, "✕ Ocultar" abriría el detalle además de ocultar.
          tr.addEventListener("click", function (ev) {
            if (ev.target.closest("button, a")) return;
            var abierto = trDet.style.display !== "none";
            trDet.style.display = abierto ? "none" : "";
            tr.classList.toggle("abierta", !abierto);
            var caret = tr.querySelector(".rank-caret");
            if (caret) caret.textContent = abierto ? "▸" : "▾";
          });
        }
      });

      _renderPagerRanking(totalFilas, totalPaginas);

      statusEl.textContent = _rankingInactivosQuery
        // Con filtro NO se dice "los puestos X a Y": los resultados no son
        // correlativos. El puesto de cada fila sigue siendo el del ranking
        // completo, que es justamente lo que se quiere ver al buscar uno.
        ? "\u2713 " + totalFilas + " coincidencia(s) con \u201C" + _rankingInactivosQuery +
          "\u201D. El puesto de cada fila es el del ranking completo. " +
          "Todos los importes son SIN IVA."
        : _rankingInactivosVerOcultos
          ? "\u2713 " + totalFilas + " cliente(s) ocultados a mano del ranking. Usá ↩ Restaurar para devolverlos."
          : "\u2713 " + totalFilas + " clientes sin compras hace más de " + periodMeses +
            " meses, rankeados por valor histórico total neto a precios de hoy. Mostrando los puestos " +
            filas[0].ranking + " a " + filas[filas.length - 1].ranking + ". " +
            "Todos los importes son SIN IVA.";
      statusEl.style.color = "#27ae60";
    })
    .catch(function (err) {
      console.error("cargarRankingInactivos error", err);
      statusEl.textContent = "Error: " + (err.message || err);
      statusEl.style.color = "#c0392b";
    });
}
window.cargarRankingInactivos = cargarRankingInactivos;

// =============================
// GERENTE DE VENTAS
// =============================
// Módulo de acciones comerciales. Tres piezas que se apoyan en el mismo backend:
// la agenda diaria (gv_agenda), la cobertura geográfica (gv_cobertura*) y el
// estado del aprendizaje (gv_estado_senales).
//
// El agente NO decide nada en el navegador: las 5 acciones del día las arma
// gv_generar_dia en Postgres y las deja guardadas, así el cron de las 07:30 y el
// botón "Regenerar" producen exactamente lo mismo.

// Cache de la cobertura para no repedirla al alternar provincia/localidad.
var _gvCobertura = { prov: null, loc: null };
var _gvNivel = "prov";
var _gvGeoCorriendo = false;

// Fecha de HOY en horario local. new Date().toISOString() da la fecha UTC, que
// en Argentina (UTC-3) ya es la de mañana a partir de las 21:00 y haría que la
// agenda apareciera vacía las últimas tres horas del día.
function _gvHoy() {
  var d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function _gvNum(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("es-AR");
}

function _gvStatus(msg, tipo) {
  var el = document.getElementById("gvStatus");
  if (!el) return;
  if (!msg) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    '<div class="gv-status gv-status-' + (tipo || "info") + '">' + escHtml(msg) + "</div>";
}

// Carga de entrada al módulo. Solo trae la agenda: el mapa, el ratio y las
// señales están en tarjetas colapsadas y se piden cuando se abren, igual que en
// Estadística Clientes.
function cargarGerenteVentas() {
  var f = document.getElementById("gvFecha");
  if (f && !f.value) f.value = _gvHoy();
  _gvCobertura = { prov: null, loc: null };
  cargarAgendaGerente();
  cargarPreguntasGerente();
  cargarDashboardGerente();
}
window.cargarGerenteVentas = cargarGerenteVentas;

// ---- AGENDA DEL DÍA ----------------------------------------------------

// Filas de la vista actual, para poder filtrar por vendedor en el navegador sin
// volver a pedir nada: son 5 filas por día y 35 en la semana.
var _gvAgendaFilas = [];

function cargarAgendaGerente() {
  var cont = document.getElementById("gvAgendaLista");
  if (!cont) return;
  var fecha = (document.getElementById("gvFecha") || {}).value || _gvHoy();
  var vista = (document.getElementById("gvVista") || {}).value || "dia";
  cont.innerHTML = '<div class="gv-cargando">Cargando acciones…</div>';
  _gvStatus("");

  var desde = fecha;
  if (vista === "semana") {
    var d = new Date(fecha + "T12:00:00");
    d.setDate(d.getDate() - 6);
    desde =
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  sb.rpc("gv_agenda_rango", { p_desde: desde, p_hasta: fecha })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _gvAgendaFilas = resp.data || [];
      _gvLlenarFiltroVend();
      _gvPintarAgenda();
    })
    .catch(function (err) {
      cont.innerHTML = "";
      _gvStatus("No se pudo cargar la agenda: " + err.message, "error");
    });
}
window.cargarAgendaGerente = cargarAgendaGerente;

function _gvLlenarFiltroVend() {
  var sel = document.getElementById("gvFiltroVend");
  if (!sel) return;
  var prev = sel.value;
  var vends = [];
  _gvAgendaFilas.forEach(function (f) {
    if (f.vendedor && vends.indexOf(f.vendedor) === -1) vends.push(f.vendedor);
  });
  // Se muestra el alias de pantalla (Pablo B), pero el value es el nombre crudo.
  vends.sort(function (a, b) {
    return _vendNombreVisible(a).localeCompare(_vendNombreVisible(b), "es");
  });
  sel.innerHTML =
    '<option value="">Todos los vendedores</option>' +
    vends
      .map(function (v) {
        return '<option value="' + escHtml(v) + '">' + escHtml(_vendNombreVisible(v)) + "</option>";
      })
      .join("");
  if (vends.indexOf(prev) !== -1) sel.value = prev;
}

function _gvPintarAgenda() {
  var cont = document.getElementById("gvAgendaLista");
  if (!cont) return;
  var vend = (document.getElementById("gvFiltroVend") || {}).value || "";
  var filas = vend
    ? _gvAgendaFilas.filter(function (f) { return f.vendedor === vend; })
    : _gvAgendaFilas;

  if (!filas.length) {
    cont.innerHTML =
      '<div class="gv-vacio">' +
      (_gvAgendaFilas.length
        ? "Ninguna acción de este vendedor en el período."
        : 'No hay acciones para este día. Apretá "Regenerar el día" para armarlas ahora.') +
      "</div>";
    _gvPintarResumenAgenda(filas);
    return;
  }

  // En la vista semanal se agrupa por fecha para que se vea qué quedó sin trabajar.
  var vista = (document.getElementById("gvVista") || {}).value || "dia";
  if (vista !== "semana") {
    cont.innerHTML = filas.map(_gvItemHtml).join("");
  } else {
    var html = "", ult = null;
    filas.forEach(function (f) {
      if (f.fecha !== ult) {
        ult = f.fecha;
        var p = String(f.fecha).split("-");
        var pend = filas.filter(function (x) {
          return x.fecha === f.fecha && x.resultado === "pendiente";
        }).length;
        html +=
          '<div class="gv-dia-sep">' + p[2] + "/" + p[1] +
          (pend ? ' <span class="gv-dia-pend">' + pend + " sin trabajar</span>" : "") +
          "</div>";
      }
      html += _gvItemHtml(f);
    });
    cont.innerHTML = html;
  }
  _gvPintarResumenAgenda(filas);
}
window._gvPintarAgenda = _gvPintarAgenda;

function _gvPintarResumenAgenda(filas) {
  var el = document.getElementById("gvAgendaResumen");
  if (!el) return;
  var resueltas = filas.filter(function (f) {
    return f.resultado !== "pendiente";
  }).length;
  el.textContent = filas.length
    ? filas.length + " acciones · " + resueltas + " resueltas"
    : "sin acciones";
}

// Las dos preguntas de cada sugerencia son DISTINTAS y por eso van separadas:
//   RESULTADO  -> qué pasó con el cliente. Mide cuánto rinde el módulo.
//   UTILIDAD   -> si querés seguir viendo esta clase de sugerencia. Es lo ÚNICO
//                 que mueve el peso de la señal, o sea lo que el agente aprende.
// Mezcladas, una venta perdida bajaba el peso de una señal que estaba bien
// pensada, y una venta ganada lo subía aunque la sugerencia fuera obvia.
var GV_RESULTADOS = [
  { v: "en_curso", t: "La estoy trabajando", c: "gv-btn-curso" },
  { v: "gano", t: "Se concretó", c: "gv-btn-si" },
  { v: "perdio", t: "No salió", c: "gv-btn-no" },
  { v: "no_aplica", t: "No se pudo", c: "gv-btn-x" }
];
var GV_UTILIDADES = [
  { v: "util", t: "Buena sugerencia", c: "gv-btn-si" },
  { v: "no_util", t: "No me sirve", c: "gv-btn-no" }
];

function _gvItemHtml(r) {
  var wa = "";
  if (r.whatsapp) {
    // Se manda solo el número: el texto lo escribe quien llama, que sabe el
    // contexto mejor que nosotros.
    var num = String(r.whatsapp).replace(/[^0-9]/g, "");
    if (num) {
      wa =
        '<a class="gv-wa" target="_blank" rel="noopener" href="https://wa.me/' +
        escHtml(num) +
        '">WhatsApp</a>';
    }
  }

  var botones = function (lista, fn, actual) {
    return lista
      .map(function (o) {
        var sel = actual === o.v ? " gv-btn-on" : "";
        // Volver a apretar la opción ya elegida la deshace: es más directo que
        // un botón "deshacer" aparte.
        var destino = actual === o.v ? (fn === "gvResultado" ? "pendiente" : "sin_opinion") : o.v;
        return (
          '<button type="button" class="gv-btn ' + o.c + sel + '" onclick="' +
          fn + "(" + r.id + ", '" + destino + "')\">" + escHtml(o.t) + "</button>"
        );
      })
      .join("");
  };

  var acciones =
    '<div class="gv-eje">' +
    '<span class="gv-eje-tit">¿Qué pasó con el cliente?</span>' +
    '<div class="gv-acciones">' + botones(GV_RESULTADOS, "gvResultado", r.resultado) + wa + "</div>" +
    "</div>" +
    '<div class="gv-eje gv-eje-aprende">' +
    '<span class="gv-eje-tit">¿Te sirve que te proponga esto? ' +
    '<em>— esto es lo que aprendo</em></span>' +
    '<div class="gv-acciones">' + botones(GV_UTILIDADES, "gvUtilidad", r.utilidad) +
    (r.cod_cliente
      ? '<button type="button" class="gv-btn gv-btn-x" onclick="gvUtilidad(' + r.id +
        ", 'no_util', true)\">No me sirve y sacá a este cliente</button>"
      : "") +
    "</div></div>";

  var rotRes = { en_curso: "En curso", gano: "Se concretó", perdio: "No salió",
                 no_aplica: "No se pudo" };
  var rotUti = { util: "Buena sugerencia", no_util: "No me sirve" };
  var chip =
    (rotRes[r.resultado]
      ? '<span class="gv-chip gv-chip-' + escHtml(r.resultado) + '">' +
        escHtml(rotRes[r.resultado]) + "</span>"
      : "") +
    (rotUti[r.utilidad]
      ? '<span class="gv-chip gv-chip-' + escHtml(r.utilidad) + '">' +
        escHtml(rotUti[r.utilidad]) + "</span>"
      : "");

  // Los números crudos que dispararon la sugerencia. Sin esto el motivo es una
  // frase que hay que creer; con esto se puede discutir.
  var ev = "";
  var lista = (r.payload && r.payload.evidencia) || [];
  if (lista.length) {
    ev =
      '<div class="gv-evidencia">' +
      lista
        .map(function (e) {
          return (
            '<span class="gv-ev"><span class="gv-ev-k">' + escHtml(e.k) +
            '</span><span class="gv-ev-v">' + escHtml(e.v) + "</span></span>"
          );
        })
        .join("") +
      "</div>";
  }

  var vend = r.vendedor
    ? '<span class="gv-vend">' + escHtml(_vendNombreVisible(r.vendedor)) + "</span>"
    : "";

  return (
    '<div class="gv-item gv-item-' + escHtml(r.resultado) + '">' +
    '<div class="gv-item-top">' +
    '<span class="gv-senal">' + escHtml(r.etiqueta) + "</span>" +
    vend +
    chip +
    "</div>" +
    '<div class="gv-titulo">' + escHtml(r.titulo) + "</div>" +
    '<div class="gv-motivo">' + escHtml(r.motivo) + "</div>" +
    ev +
    '<div class="gv-accion">' + escHtml(r.accion) + "</div>" +
    acciones +
    "</div>"
  );
}

// Eje 1: qué pasó con el cliente. No toca el aprendizaje.
function gvResultado(id, valor) {
  sb.rpc("gv_marcar_resultado", { p_id: id, p_resultado: valor })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var sen = document.getElementById("gvSenalesBody");
      if (sen && sen.style.display !== "none") cargarSenalesGerente();
      cargarAgendaGerente();
    })
    .catch(function (err) {
      _gvStatus("No se pudo registrar: " + err.message, "error");
    });
}
window.gvResultado = gvResultado;

// Eje 2: si la sugerencia vale la pena. ESTO es lo que mueve el peso.
function gvUtilidad(id, valor, silenciar) {
  sb.rpc("gv_marcar_utilidad", {
    p_id: id,
    p_utilidad: valor,
    p_silenciar_cliente: !!silenciar
  })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var sen = document.getElementById("gvSenalesBody");
      if (sen && sen.style.display !== "none") cargarSenalesGerente();
      // Una opinión nueva puede hacer aparecer una pregunta del agente.
      cargarPreguntasGerente();
      cargarAgendaGerente();
    })
    .catch(function (err) {
      _gvStatus("No se pudo registrar: " + err.message, "error");
    });
}
window.gvUtilidad = gvUtilidad;

// ---- PREGUNTAS DEL AGENTE ----------------------------------------------
//
// Canal separado de la agenda: acá el agente no propone una acción comercial,
// pregunta sobre su propio comportamiento. Responder tiene efecto real
// (apagar una señal, subir su tope, sacar un cliente del radar), no queda
// solo como registro.

function cargarPreguntasGerente() {
  var cont = document.getElementById("gvPreguntasLista");
  if (!cont) return;

  sb.rpc("gv_preguntas_abiertas")
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      var res = document.getElementById("gvPreguntasResumen");
      if (res) {
        res.textContent = filas.length
          ? filas.length + (filas.length === 1 ? " pregunta" : " preguntas")
          : "nada para preguntarte por ahora";
      }
      if (!filas.length) {
        cont.innerHTML =
          '<div class="gv-vacio">No tengo nada que preguntarte. A medida que ' +
          "marques sugerencias como útiles o no, van a aparecer acá.</div>";
        return;
      }
      cont.innerHTML = filas
        .map(function (p) {
          var ops = (p.opciones || [])
            .map(function (o) {
              return (
                '<button type="button" class="gv-btn" onclick="gvResponder(' +
                p.id + ", '" + String(o.valor).replace(/'/g, "") + "')\">" +
                escHtml(o.texto) + "</button>"
              );
            })
            .join("");
          return (
            '<div class="gv-item gv-item-pregunta">' +
            '<div class="gv-titulo">' + escHtml(p.pregunta) + "</div>" +
            '<div class="gv-motivo">' + escHtml(p.detalle || "") + "</div>" +
            '<div class="gv-acciones">' + ops + "</div>" +
            "</div>"
          );
        })
        .join("");
    })
    .catch(function (err) {
      cont.innerHTML =
        '<div class="gv-vacio">No se pudieron cargar: ' + escHtml(err.message) + "</div>";
    });
}
window.cargarPreguntasGerente = cargarPreguntasGerente;

function gvResponder(id, valor) {
  sb.rpc("gv_responder_pregunta", { p_id: id, p_respuesta: valor })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      cargarPreguntasGerente();
      var sen = document.getElementById("gvSenalesBody");
      if (sen && sen.style.display !== "none") cargarSenalesGerente();
    })
    .catch(function (err) {
      _gvStatus("No se pudo responder: " + err.message, "error");
    });
}
window.gvResponder = gvResponder;

function regenerarAgendaGerente() {
  var fecha = (document.getElementById("gvFecha") || {}).value || _gvHoy();
  _gvStatus("Analizando la clientela…", "info");
  sb.rpc("gv_generar_dia", { p_fecha: fecha, p_meses: 12, p_forzar: true })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      _gvStatus("Listo: " + (resp.data || 0) + " acciones nuevas.", "ok");
      cargarAgendaGerente();
      // Regenerar puede destapar patrones nuevos sobre los que preguntar.
      sb.rpc("gv_generar_preguntas").then(cargarPreguntasGerente);
    })
    .catch(function (err) {
      _gvStatus("No se pudo regenerar: " + err.message, "error");
    });
}
window.regenerarAgendaGerente = regenerarAgendaGerente;

// Arma el mensaje del día en texto plano, para pegarlo en WhatsApp o mail.
function copiarAgendaGerente() {
  var fecha = (document.getElementById("gvFecha") || {}).value || _gvHoy();
  sb.rpc("gv_agenda", { p_fecha: fecha })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      if (!filas.length) {
        _gvStatus("No hay acciones para copiar.", "error");
        return;
      }
      var partes = fecha.split("-");
      var txt =
        "Gerente de ventas — " + partes[2] + "/" + partes[1] + "/" + partes[0] + "\n\n";
      filas.forEach(function (r, i) {
        txt +=
          i + 1 + ") " + r.titulo + "\n" +
          "   " + r.motivo + "\n" +
          "   → " + r.accion + "\n\n";
      });
      var listo = function () {
        _gvStatus("Mensaje copiado al portapapeles.", "ok");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(listo, function () {
          _gvFallbackCopia(txt, listo);
        });
      } else {
        _gvFallbackCopia(txt, listo);
      }
    })
    .catch(function (err) {
      _gvStatus("No se pudo copiar: " + err.message, "error");
    });
}
window.copiarAgendaGerente = copiarAgendaGerente;

// navigator.clipboard no existe fuera de contextos seguros ni en navegadores
// viejos; ahí se cae al textarea + execCommand de siempre.
function _gvFallbackCopia(txt, ok) {
  var ta = document.createElement("textarea");
  ta.value = txt;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    ok();
  } catch (e) {
    _gvStatus("El navegador no dejó copiar. Copialo a mano.", "error");
  }
  document.body.removeChild(ta);
}

// ---- RATIO HABITANTES / PUNTO DE VENTA ---------------------------------

function gvCambiarNivel(nivel) {
  _gvNivel = nivel;
  document.querySelectorAll("[data-gv-nivel]").forEach(function (b) {
    b.classList.toggle("activa", b.dataset.gvNivel === nivel);
  });
  cargarRatioGerente();
}
window.gvCambiarNivel = gvCambiarNivel;

function _gvPedirCobertura(nivel) {
  if (_gvCobertura[nivel]) return Promise.resolve(_gvCobertura[nivel]);
  var rpc = nivel === "prov" ? "gv_cobertura_provincia" : "gv_cobertura";
  return sb.rpc(rpc, { p_meses: 12 }).then(function (resp) {
    if (resp.error) throw resp.error;
    _gvCobertura[nivel] = resp.data || [];
    return _gvCobertura[nivel];
  });
}

function cargarRatioGerente() {
  var tabla = document.getElementById("gvRatioTabla");
  if (!tabla) return;
  var thead = tabla.querySelector("thead");
  var tbody = tabla.querySelector("tbody");
  tbody.innerHTML = '<tr><td colspan="7" class="gv-cargando">Cargando…</td></tr>';

  _gvPedirCobertura(_gvNivel)
    .then(function (filas) {
      var esProv = _gvNivel === "prov";
      var conRatio = filas.filter(function (f) {
        return f.hab_por_punto != null;
      });
      var mediana = _gvMediana(
        conRatio.map(function (f) {
          return Number(f.hab_por_punto);
        }),
      );

      thead.innerHTML =
        "<tr>" +
        (esProv ? "<th>PROVINCIA</th>" : "<th>LOCALIDAD</th><th>PROVINCIA</th>") +
        "<th>SUCURSALES</th><th>CLIENTES</th><th>ACTIVOS 12M</th>" +
        "<th>POBLACIÓN</th><th>HAB. POR PUNTO</th><th>VS MEDIANA</th>" +
        "</tr>";

      // Ordena de más frío a más caliente: lo primero que hay que mirar es
      // dónde falta cobertura, no dónde sobra.
      var orden = filas.slice().sort(function (a, b) {
        if (a.hab_por_punto == null) return 1;
        if (b.hab_por_punto == null) return -1;
        return Number(b.hab_por_punto) - Number(a.hab_por_punto);
      });

      tbody.innerHTML = orden
        .map(function (f) {
          var ratio = f.hab_por_punto == null ? null : Number(f.hab_por_punto);
          var rel = ratio && mediana ? ratio / mediana : null;
          var cls = _gvClaseTemp(rel);
          var relTxt =
            rel == null
              ? '<span class="gv-sin-dato">sin población</span>'
              : '<span class="gv-rel ' + cls + '">' +
                (rel >= 1 ? rel.toFixed(1) + "× más flojo" : (1 / rel).toFixed(1) + "× mejor") +
                "</span>";
          return (
            "<tr>" +
            (esProv
              ? "<td>" + escHtml(f.provincia) + "</td>"
              : "<td>" + escHtml(f.localidad) + "</td><td>" + escHtml(f.provincia) + "</td>") +
            "<td>" + _gvNum(f.sucursales) + "</td>" +
            "<td>" + _gvNum(f.clientes) + "</td>" +
            "<td>" + _gvNum(f.activos) + "</td>" +
            "<td>" + (f.poblacion == null ? "—" : _gvNum(f.poblacion)) + "</td>" +
            "<td>" + (ratio == null ? "—" : _gvNum(ratio)) + "</td>" +
            "<td>" + relTxt + "</td>" +
            "</tr>"
          );
        })
        .join("");

      var res = document.getElementById("gvRatioResumen");
      if (res) {
        res.textContent =
          "mediana " + _gvNum(Math.round(mediana || 0)) + " hab. por punto · " +
          conRatio.length + " con población cargada de " + filas.length;
      }
    })
    .catch(function (err) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="gv-cargando">Error: ' + escHtml(err.message) + "</td></tr>";
    });
}
window.cargarRatioGerente = cargarRatioGerente;

function _gvMediana(arr) {
  var a = arr.slice().sort(function (x, y) {
    return x - y;
  });
  if (!a.length) return null;
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Frío = muchos habitantes por punto (nos falta cobertura). Caliente = pocos.
function _gvClaseTemp(rel) {
  if (rel == null) return "";
  if (rel >= 1.5) return "gv-frio";
  if (rel <= 0.67) return "gv-caliente";
  return "gv-medio";
}

// ---- MAPA ---------------------------------------------------------------

function cargarMapaGerente() {
  var slot = document.getElementById("gvMapaSlot");
  if (!slot) return;
  slot.textContent = "Cargando mapa…";

  Promise.all([loadArgentinaMapSvg(), _gvPedirCobertura("loc")])
    .then(function (res) {
      var svg = res[0];
      var filas = res[1];
      slot.innerHTML = svg;
      var svgEl = slot.querySelector(".ar-map-svg");
      if (!svgEl) return;

      var conCoord = filas.filter(function (f) {
        return f.lat != null && f.lon != null;
      });
      var resumen = document.getElementById("gvMapaResumen");

      // Sin proyección el SVG que se dibujó es el fallback simplificado, que
      // tiene coordenadas inventadas: poner pines encima los ubicaría mal.
      if (typeof ARGENTINA_MAP_PROJECTION === "undefined" || !ARGENTINA_MAP_PROJECTION) {
        if (resumen) {
          resumen.textContent =
            "mapa de respaldo, sin pines (no se pudo cargar el contorno real)";
        }
        return;
      }

      // Dos lecturas del mismo mapa. "ratio" necesita población cargada;
      // "activos" funciona ya, porque sale de datos que siempre tenemos.
      var modo = (document.getElementById("gvMapaColor") || {}).value || "ratio";
      var valorDe = function (f) {
        if (modo === "activos") {
          // Invertido a propósito: pocos activos = zona fría, igual que muchos
          // habitantes por punto. Así el rojo significa lo mismo en los dos modos.
          if (!f.clientes) return null;
          return 1 - Number(f.activos) / Number(f.clientes);
        }
        return f.hab_por_punto == null ? null : Number(f.hab_por_punto);
      };
      var mediana = _gvMediana(
        filas
          .map(valorDe)
          .filter(function (v) {
            return v != null && !isNaN(v);
          }),
      );
      var maxSuc = Math.max.apply(
        null,
        conCoord.map(function (f) {
          return Number(f.sucursales) || 1;
        }).concat([1]),
      );

      var ns = "http://www.w3.org/2000/svg";
      var g = document.createElementNS(ns, "g");
      g.setAttribute("class", "gv-pines");

      conCoord.forEach(function (f) {
        var p = arMapProject(Number(f.lon), Number(f.lat));
        if (!p) return;
        var val = valorDe(f);
        var rel = val != null && mediana ? val / mediana : null;
        // Radio por raíz de sucursales: el área del círculo queda proporcional
        // a la cantidad, que es como se lee un mapa de burbujas.
        var r = 1.2 + 4.5 * Math.sqrt((Number(f.sucursales) || 1) / maxSuc);
        var c = document.createElementNS(ns, "circle");
        c.setAttribute("cx", p.x.toFixed(2));
        c.setAttribute("cy", p.y.toFixed(2));
        c.setAttribute("r", r.toFixed(2));
        // El radio base queda guardado porque al acercarse a una provincia hay
        // que reescalarlo: si no, el viewBox agranda los círculos junto con el
        // mapa y a nivel CABA quedan manchones que tapan todo.
        c.dataset.r = r.toFixed(3);
        c.setAttribute("class", "gv-pin " + (_gvClaseTemp(rel) || "gv-sin"));
        c.dataset.loc = f.localidad;
        // pprov y NO prov: el atributo data-prov es el que identifica a los
        // path de las provincias, y ponérselo también a los círculos los hacía
        // caer bajo `.ar-map-svg [data-prov]` —que pinta el mapa y gana por
        // especificidad (0,3,0 contra 0,2,0 de .gv-pin.gv-sin)—, además de
        // recibir las clases de resaltado del zoom. Resultado: los pines salían
        // del color del mapa en vez del suyo.
        c.dataset.pprov = f.provincia;
        c.dataset.suc = f.sucursales;
        c.dataset.act = f.activos;
        c.dataset.cli = f.clientes;
        c.dataset.ratio = f.hab_por_punto == null ? "" : f.hab_por_punto;
        g.appendChild(c);
      });
      svgEl.appendChild(g);
      _gvWireTipMapa(svgEl);
      _gvWireZoomMapa(svgEl);

      if (resumen) {
        resumen.textContent =
          conCoord.length + " localidades ubicadas de " + filas.length;
      }
    })
    .catch(function (err) {
      slot.innerHTML =
        '<div class="gv-cargando">No se pudo cargar el mapa: ' + escHtml(err.message) + "</div>";
    });
}
window.cargarMapaGerente = cargarMapaGerente;

function _gvWireTipMapa(svgEl) {
  var tip = document.getElementById("gvMapaTip");
  var wrap = svgEl.closest(".gv-mapa-wrap");
  if (!tip || !wrap) return;

  svgEl.querySelectorAll(".gv-pin").forEach(function (c) {
    c.addEventListener("mouseenter", function () {
      var html =
        "<strong>" + escHtml(c.dataset.loc) + "</strong>" +
        escHtml(c.dataset.pprov) + "<br>" +
        c.dataset.suc + " sucursales · " + c.dataset.act + " activos";
      if (c.dataset.ratio) {
        html += "<br>1 punto cada " + _gvNum(Number(c.dataset.ratio)) + " hab.";
      }
      if (c.dataset.act && c.dataset.cli) {
        html += "<br>" +
          Math.round((100 * Number(c.dataset.act)) / Number(c.dataset.cli)) +
          "% de clientes activos";
      }
      tip.innerHTML = html;
      tip.style.display = "block";
    });
    c.addEventListener("mousemove", function (ev) {
      var r = wrap.getBoundingClientRect();
      tip.style.left = ev.clientX - r.left + 14 + "px";
      tip.style.top = ev.clientY - r.top + 14 + "px";
    });
    c.addEventListener("mouseleave", function () {
      tip.style.display = "none";
    });
  });
}

// ---- ZOOM POR PROVINCIA -------------------------------------------------
//
// El SVG ya trae un <path data-prov="..."> por cada una de las 24, así que
// acercarse es reencuadrar el viewBox a su bounding box. No hace falta ninguna
// librería ni volver a pedir nada al servidor.
//
// getBBox() devuelve la caja en las unidades del propio SVG, que son las mismas
// en las que se proyectaron los pines, así que los dos sistemas coinciden solos.

var _gvViewBoxPais = null; // encuadre completo, para poder volver
var _gvProvZoom = "";

function _gvWireZoomMapa(svgEl) {
  _gvViewBoxPais = svgEl.getAttribute("viewBox");
  _gvProvZoom = "";

  // La lista sale de ARGENTINA_PROVINCIAS, que es la misma con la que se
  // etiquetan los path: así no puede haber una opción que no matchee ninguna.
  var sel = document.getElementById("gvZoomProv");
  if (sel && sel.options.length <= 1 && typeof ARGENTINA_PROVINCIAS !== "undefined") {
    ARGENTINA_PROVINCIAS.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      sel.appendChild(o);
    });
  }
  if (sel) sel.value = "";

  // Clic sobre una provincia = acercarse. Clic sobre la que ya está acercada
  // vuelve al país, que es más rápido que ir al menú.
  svgEl.querySelectorAll("[data-prov]:not(.gv-pin)").forEach(function (p) {
    p.style.cursor = "pointer";
    p.addEventListener("click", function () {
      var prov = p.getAttribute("data-prov");
      gvZoomProvincia(prov === _gvProvZoom ? "" : prov);
    });
  });
}

function gvZoomProvincia(prov) {
  var slot = document.getElementById("gvMapaSlot");
  var svgEl = slot && slot.querySelector(".ar-map-svg");
  if (!svgEl || !_gvViewBoxPais) return;

  var sel = document.getElementById("gvZoomProv");
  if (sel && sel.value !== (prov || "")) sel.value = prov || "";
  _gvProvZoom = prov || "";

  var base = _gvViewBoxPais.split(/\s+/).map(Number);
  var vb = base;

  if (prov) {
    var path = svgEl.querySelector('[data-prov="' + prov.replace(/"/g, '\\"') + '"]');
    if (path) {
      var b = path.getBBox();
      // 8% de aire para que la provincia no quede pegada al borde.
      var m = Math.max(b.width, b.height) * 0.08;
      vb = [b.x - m, b.y - m, b.width + 2 * m, b.height + 2 * m];
    }
  }
  svgEl.setAttribute("viewBox", vb.join(" "));

  // Todo lo que se mide en unidades del SVG —radios de pin, grosor de borde—
  // se agranda junto con el zoom. Se divide por la escala para que en pantalla
  // se siga viendo igual; si no, en CABA los pines quedan manchones que tapan
  // la provincia entera.
  var escala = base[2] / vb[2];
  svgEl.querySelectorAll(".gv-pin").forEach(function (c) {
    var r = parseFloat(c.dataset.r || "2");
    c.setAttribute("r", (r / escala).toFixed(3));
    c.style.strokeWidth = (0.35 / escala).toFixed(3);
  });
  var gProv = svgEl.querySelector("g[stroke]");
  if (gProv) gProv.setAttribute("stroke-width", (0.4 / escala).toFixed(3));

  svgEl.querySelectorAll("[data-prov]:not(.gv-pin)").forEach(function (p) {
    var esta = p.getAttribute("data-prov") === prov;
    p.classList.toggle("gv-prov-on", !!prov && esta);
    p.classList.toggle("gv-prov-off", !!prov && !esta);
  });
}
window.gvZoomProvincia = gvZoomProvincia;

// ---- GEOCODIFICACIÓN ----------------------------------------------------
//
// Contra la API Georef de datos.gob.ar, que es pública, sin autenticación y con
// CORS — el mismo caso que la del BCRA. Por eso la hace el navegador y no hace
// falta un worker como el de ARCA.
//
// Se prueban tres recursos en cascada porque no todo cae en el mismo: las
// ciudades están en /localidades, los parajes y barrios en /asentamientos y
// algunos cascos urbanos solo figuran como /municipios.
var GV_GEOREF = "https://apis.datos.gob.ar/georef/api";
var GV_GEO_RECURSOS = ["localidades", "asentamientos", "municipios"];

function _gvGeoBuscar(provincia, nombre) {
  var intento = function (i) {
    if (i >= GV_GEO_RECURSOS.length) return Promise.resolve(null);
    var url =
      GV_GEOREF + "/" + GV_GEO_RECURSOS[i] +
      "?nombre=" + encodeURIComponent(nombre) +
      "&provincia=" + encodeURIComponent(provincia) +
      "&campos=nombre,centroide&max=1";
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        var arr = j[GV_GEO_RECURSOS[i]] || [];
        if (!arr.length || !arr[0].centroide) return intento(i + 1);
        return { lat: arr[0].centroide.lat, lon: arr[0].centroide.lon };
      })
      .catch(function () {
        return intento(i + 1);
      });
  };
  return intento(0);
}

function gvGeocodificarTodo() {
  if (_gvGeoCorriendo) return;
  var est = document.getElementById("gvGeoEstado");
  _gvGeoCorriendo = true;
  if (est) est.textContent = "Armando la cola…";

  sb.rpc("gv_geo_pendientes", { p_limite: 1000 })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var cola = resp.data || [];
      if (!cola.length) {
        if (est) est.textContent = "Todas las localidades ya están ubicadas.";
        _gvGeoCorriendo = false;
        return;
      }

      var i = 0, ok = 0, fallo = 0;
      var pintar = function () {
        if (est) {
          est.textContent =
            "Ubicando " + Math.min(i, cola.length) + "/" + cola.length +
            " · " + ok + " resueltas, " + fallo + " sin resultado";
        }
      };

      // Concurrencia 3 con pausa de 200 ms, igual que la tanda del BCRA: es una
      // API pública y gratuita, no corresponde tirarle 10 pedidos por segundo.
      var worker = function () {
        if (i >= cola.length) return Promise.resolve();
        var item = cola[i++];
        pintar();
        return _gvGeoBuscar(item.provincia, item.localidad)
          .then(function (c) {
            if (!c) {
              fallo++;
              return;
            }
            return sb
              .rpc("gv_geo_registrar", {
                p_provincia: item.provincia,
                p_loc_norm: item.loc_norm,
                p_lat: c.lat,
                p_lon: c.lon,
                p_fuente: "georef",
              })
              .then(function (r) {
                if (r.error) fallo++;
                else ok++;
              });
          })
          .catch(function () {
            fallo++;
          })
          .then(function () {
            return new Promise(function (res) {
              setTimeout(res, 200);
            });
          })
          .then(worker);
      };

      return Promise.all([worker(), worker(), worker()]).then(function () {
        pintar();
        if (est) {
          est.textContent =
            "Listo: " + ok + " ubicadas, " + fallo + " sin resultado de " + cola.length + ".";
        }
        _gvGeoCorriendo = false;
        // El mapa y la tabla por localidad quedaron viejos.
        _gvCobertura.loc = null;
        cargarMapaGerente();
      });
    })
    .catch(function (err) {
      if (est) est.textContent = "Error: " + err.message;
      _gvGeoCorriendo = false;
    });
}
window.gvGeocodificarTodo = gvGeocodificarTodo;

// ---- APRENDIZAJE --------------------------------------------------------

// ---- RINDE --------------------------------------------------------------

function cargarRindeGerente() {
  var tabla = document.getElementById("gvRindeTabla");
  if (!tabla) return;
  var thead = tabla.querySelector("thead");
  var tbody = tabla.querySelector("tbody");
  tbody.innerHTML = '<tr><td colspan="7" class="gv-cargando">Cargando…</td></tr>';

  sb.rpc("gv_rendimiento", { p_dias: 90 })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      thead.innerHTML =
        "<tr><th>SEÑAL</th><th>PROPUESTAS</th><th>TRABAJADAS</th>" +
        "<th>COMPRARON<br>(trabajadas)</th><th>SIN TRABAJAR</th>" +
        "<th>COMPRARON<br>(sin trabajar)</th><th>COMPRARON $</th></tr>";

      if (!filas.length) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="gv-cargando">Todavía no hay acciones ' +
          "con 30 días cumplidos para medir.</td></tr>";
        return;
      }

      tbody.innerHTML = filas
        .map(function (f) {
          // Tasa de compra de cada grupo, que es la comparación que importa.
          var tt = f.trabajadas > 0 ? f.compraron_trab / f.trabajadas : null;
          var tn = f.no_trabajadas > 0 ? f.compraron_no_trab / f.no_trabajadas : null;
          var pct = function (x) { return x == null ? "—" : (x * 100).toFixed(0) + "%"; };
          var cls = tt != null && tn != null ? (tt > tn ? "gv-rel gv-caliente" : "gv-rel gv-frio") : "";
          return (
            "<tr>" +
            "<td>" + escHtml(f.etiqueta) + "</td>" +
            "<td>" + _gvNum(f.propuestas) + "</td>" +
            "<td>" + _gvNum(f.trabajadas) + "</td>" +
            '<td><span class="' + cls + '">' + _gvNum(f.compraron_trab) +
            " · " + pct(tt) + "</span></td>" +
            "<td>" + _gvNum(f.no_trabajadas) + "</td>" +
            "<td>" + _gvNum(f.compraron_no_trab) + " · " + pct(tn) + "</td>" +
            "<td>$" + _gvNum(Math.round(Number(f.monto_post) || 0)) + "</td>" +
            "</tr>"
          );
        })
        .join("");

      var res = document.getElementById("gvRindeResumen");
      if (res) {
        var monto = filas.reduce(function (a, f) { return a + (Number(f.monto_post) || 0); }, 0);
        var trab = filas.reduce(function (a, f) { return a + (f.trabajadas || 0); }, 0);
        res.textContent =
          trab + " acciones trabajadas · $" + _gvNum(Math.round(monto)) +
          " comprados en los 30 días siguientes";
      }
    })
    .catch(function (err) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="gv-cargando">Error: ' + escHtml(err.message) + "</td></tr>";
    });
}
window.cargarRindeGerente = cargarRindeGerente;

function cargarSenalesGerente() {
  var tabla = document.getElementById("gvSenalesTabla");
  if (!tabla) return;
  var thead = tabla.querySelector("thead");
  var tbody = tabla.querySelector("tbody");
  tbody.innerHTML = '<tr><td colspan="9" class="gv-cargando">Cargando…</td></tr>';

  sb.rpc("gv_estado_senales")
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      // Dos bloques bien separados: PESO (lo que el agente aprende, sale de tu
      // opinión) y RINDE (resultado comercial, informativo). Mezclarlos en una
      // sola columna fue el error original.
      thead.innerHTML =
        '<tr><th>SEÑAL</th><th>QUÉ MIRA</th><th>ESTADO</th>' +
        '<th colspan="3" class="gv-th-grupo">TU OPINIÓN → PESO</th>' +
        '<th colspan="3" class="gv-th-grupo">RESULTADO COMERCIAL</th></tr>' +
        "<tr><th></th><th></th><th></th>" +
        "<th>ÚTIL</th><th>NO ÚTIL</th><th>PESO</th>" +
        "<th>TRABAJADAS</th><th>GANADAS</th><th>CONVERSIÓN</th></tr>";
      tbody.innerHTML = filas
        .map(function (s) {
          var peso = Number(s.peso);
          var conv = s.conversion == null ? null : Number(s.conversion);
          return (
            "<tr>" +
            "<td>" + escHtml(s.etiqueta) + "</td>" +
            '<td class="gv-desc">' + escHtml(s.descripcion || "") + "</td>" +
            "<td>" +
            (s.activa
              ? '<span class="gv-chip gv-chip-util">Activa</span>'
              : '<span class="gv-chip gv-chip-no_util">Apagada</span>') +
            "</td>" +
            "<td>" + _gvNum(s.util_si) + "</td>" +
            "<td>" + _gvNum(s.util_no) + "</td>" +
            '<td><span class="gv-peso" style="--gv-peso:' + (peso * 100).toFixed(0) + '%">' +
            peso.toFixed(2) + "</span></td>" +
            "<td>" + _gvNum(s.acc_trab) + "</td>" +
            "<td>" + _gvNum(s.acc_ganadas) + "</td>" +
            "<td>" + (conv == null ? "—" : (conv * 100).toFixed(0) + "%") + "</td>" +
            "</tr>"
          );
        })
        .join("");

      var res = document.getElementById("gvSenalesResumen");
      if (res) {
        var op = filas.reduce(function (a, s) {
          return a + (s.util_si || 0) + (s.util_no || 0);
        }, 0);
        var tr = filas.reduce(function (a, s) {
          return a + (s.acc_trab || 0);
        }, 0);
        res.textContent = op || tr
          ? op + " opiniones tuyas · " + tr + " acciones trabajadas"
          : "todavía sin datos: todas las señales pesan igual";
      }
    })
    .catch(function (err) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="gv-cargando">Error: ' + escHtml(err.message) + "</td></tr>";
    });
}
window.cargarSenalesGerente = cargarSenalesGerente;

// ---- DASHBOARD DE VENTAS -------------------------------------------------
//
// Paneo general al entrar al módulo. Lee SIEMPRE del cache (gv_dashboard), que
// refresca el cron; recalcular a mano son ~9 s repartidos en dos llamadas, así
// que no se hace al abrir.
//
// DOS FUENTES CON SIGNIFICADOS DISTINTOS, y la pantalla lo dice:
//   FACTURADO = ERP, mes cerrado. Lo que salió.
//   PEDIDO    = portal, en vivo. La demanda.
// Un pedido del 30/6 se factura en julio, así que mes a mes nunca coinciden.

var _gvDashCharts = [];

function _gvPlata(n) {
  if (n == null) return "—";
  var v = Number(n);
  if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(2) + " MM";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(1) + " M";
  return "$" + Math.round(v).toLocaleString("es-AR");
}

// Variación en % con signo y color. null cuando no hay base con qué comparar.
function _gvVar(actual, base) {
  if (actual == null || base == null || Number(base) === 0) return "";
  var p = (Number(actual) / Number(base) - 1) * 100;
  var cls = p >= 0 ? "gv-up" : "gv-down";
  return '<span class="' + cls + '">' + (p >= 0 ? "▲" : "▼") + " " +
    Math.abs(p).toFixed(1) + "%</span>";
}

function _gvTile(rot, valor, pie) {
  return (
    '<div class="gv-tile"><div class="gv-tile-rot">' + escHtml(rot) + "</div>" +
    '<div class="gv-tile-val">' + valor + "</div>" +
    '<div class="gv-tile-pie">' + (pie || "") + "</div></div>"
  );
}

function cargarDashboardGerente() {
  var cont = document.getElementById("gvDash");
  if (!cont) return;
  cont.innerHTML = '<div class="gv-cargando">Cargando…</div>';

  sb.rpc("gv_dashboard")
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var fila = (resp.data || [])[0];
      if (!fila || !fila.data) {
        cont.innerHTML =
          '<div class="gv-vacio">Todavía no se calculó. Apretá "Recalcular ahora".</div>';
        return;
      }
      _gvPintarDashboard(fila.data, fila.generado_at);
    })
    .catch(function (err) {
      cont.innerHTML = '<div class="gv-vacio">Error: ' + escHtml(err.message) + "</div>";
    });
}
window.cargarDashboardGerente = cargarDashboardGerente;

function recalcularDashboard() {
  var est = document.getElementById("gvDashEstado");
  if (est) est.textContent = "Recalculando… (unos 10 segundos)";
  // Dos llamadas porque juntas pasarían el statement_timeout de ~8 s.
  sb.rpc("gv_dashboard_calcular")
    .then(function (r) {
      if (r.error) throw r.error;
      if (est) est.textContent = "Recalculando… (parte 2)";
      return sb.rpc("gv_dashboard_calcular2");
    })
    .then(function (r) {
      if (r.error) throw r.error;
      if (est) est.textContent = "Recalculando… (parte 3)";
      return sb.rpc("gv_dashboard_extra");
    })
    .then(function (r) {
      if (r.error) throw r.error;
      if (est) est.textContent = "Listo.";
      cargarDashboardGerente();
    })
    .catch(function (err) {
      if (est) est.textContent = "Error: " + err.message;
    });
}
window.recalcularDashboard = recalcularDashboard;

// "Descargar PDF" = impresión nativa del navegador (Guardar como PDF). Sin
// librerías: es lo más robusto para un paneo con gráficos, y en el celular sale
// por Compartir → Imprimir. El CSS @media print esconde todo menos el dashboard.
function imprimirDashboard() {
  document.body.classList.add("gv-print-mode");
  var limpiar = function () {
    document.body.classList.remove("gv-print-mode");
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  // Un respiro para que el navegador aplique el layout de impresión antes de abrir.
  setTimeout(function () {
    window.print();
    // Fallback: si afterprint no dispara (algunos móviles), limpiar igual.
    setTimeout(limpiar, 1500);
  }, 120);
}
window.imprimirDashboard = imprimirDashboard;

// ---- PPP EN CURSO (backlog de pedidos adentro) -------------------------
// Plata/m³/días de lo que está pedido y todavía no facturó. Sale del espejo de
// Virgilio (sincronizar_ppp), no del cache del dashboard.
function _gvCargarPPP() {
  var slot = document.getElementById("gvPppBanda");
  if (!slot) return;
  sb.rpc("gv_ppp_resumen")
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var p = resp.data || {};
      if (!p.nps) { slot.innerHTML = ""; return; }
      slot.innerHTML =
        '<div class="gv-ppp" onclick="gvAbrirDrillPPP()">' +
        '<div class="gv-ppp-tit">Pedido adentro (PPP en curso) ⤢</div>' +
        '<div class="gv-ppp-row">' +
        _gvPppNum("Plata", _gvPlata(p.plata)) +
        _gvPppNum("Metros cúbicos", _gvNum(p.m3) + " m³") +
        _gvPppNum("Días de PPP", (p.dias_ppp != null ? _gvNum(p.dias_ppp) + " días" : "—")) +
        _gvPppNum("Notas de pedido", _gvNum(p.nps)) +
        "</div>" +
        '<div class="gv-ppp-pie">' + _gvNum(p.con_tanda) + " con tanda · " +
        _gvNum(p.sin_tanda) + " sin asignar (" + _gvPlata(p.plata_sin_tanda) + ") · " +
        "despacho " + _gvNum(p.m3_por_dia) + " m³/día · última salida " +
        escHtml(p.ultima_salida || "—") + "</div></div>";
    })
    .catch(function (err) {
      // Silencioso: si Virgilio no sincronizó todavía, la banda no aparece.
      slot.innerHTML = "";
      console.warn("gv_ppp_resumen:", err.message);
    });
}

function _gvPppNum(rot, val) {
  return '<div><div class="gv-ppp-lbl">' + escHtml(rot) + "</div>" +
    '<div class="gv-ppp-val">' + val + "</div></div>";
}

// Drill al detalle por NP (usa el mismo modal del dashboard).
function gvAbrirDrillPPP() {
  _gvDrillPila = [{ nivel: "ppp", titulo: "Pedido adentro por NP" }];
  var m = document.getElementById("gvDrillModal"),
      b = document.getElementById("gvDrillBody"),
      mig = document.getElementById("gvDrillMigas");
  if (!m || !b) return;
  m.style.display = "flex";
  if (mig) mig.innerHTML = '<span class="gv-miga-act">Pedido adentro por NP</span>';
  b.innerHTML = '<div class="gv-cargando">Cargando…</div>';
  sb.rpc("gv_ppp_detalle")
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      var tot = filas.reduce(function (a, f) { return a + Number(f.plata || 0); }, 0);
      var m3 = filas.reduce(function (a, f) { return a + Number(f.m3 || 0); }, 0);
      b.innerHTML =
        '<div class="gv-drill-tot">' + filas.length + " NP · " + _gvNum(Math.round(m3 * 10) / 10) +
        " m³ · <strong>" + _gvPlata(tot) + "</strong></div>" +
        '<table class="est-table gv-mini"><thead><tr><th>NP</th><th>CLIENTE</th>' +
        "<th>TANDA</th><th>ETAPA</th><th>M³</th><th>ARTS</th><th>PLATA</th></tr></thead><tbody>" +
        filas.map(function (f) {
          var et = f.etapa || "Sin iniciar";
          var cls = et === "Cargado a camión" ? "gv-et-fin" :
                    et === "Sin iniciar" ? "gv-et-nada" : "gv-et-curso";
          return "<tr><td>" + escHtml(f.np) + "</td><td>" + escHtml(f.razon_social || f.cod) +
            "</td><td>" + (f.tanda ? escHtml(f.tanda) : '<span class="gv-sin-dato">sin asignar</span>') +
            '</td><td><span class="gv-et ' + cls + '">' + escHtml(et) + "</span></td><td>" +
            _gvNum(f.m3) + "</td><td>" + _gvNum(f.arts) + "</td><td>" +
            _gvPlata(f.plata) + "</td></tr>";
        }).join("") + "</tbody></table>";
    })
    .catch(function (err) {
      b.innerHTML = '<div class="gv-vacio">Error: ' + escHtml(err.message) + "</div>";
    });
}
window.gvAbrirDrillPPP = gvAbrirDrillPPP;

// Resumen ejecutivo: compone 3 líneas de lenguaje natural a partir de los datos
// del cache. Cada línea sale de números reales, no de una plantilla vacía.
function _gvResumenEjecutivo(d, mesTxt) {
  var r = d.resumen || {}, ab = d.altas_bajas || [], f = d.fuga || {},
      tv = d.top_var || {}, pr = d.proyeccion || {}, rg = d.riesgo || {};

  var pct = function (a, b) {
    if (a == null || b == null || !b) return null;
    return (a / b - 1) * 100;
  };
  var frase = function (p, subiendo, bajando) {
    if (p == null) return "";
    var v = Math.abs(p).toFixed(0) + "%";
    return (p >= 0 ? subiendo : bajando).replace("%", v);
  };

  // Línea 1: venta del mes vs año anterior + proyección de cierre.
  var l1 = "En " + mesTxt(r.mes) + " vendiste <strong>" + _gvPlata(r.facturado) + "</strong>";
  var vaa = pct(r.facturado, r.facturado_aa);
  if (vaa != null) l1 += ", " + frase(vaa, "<span class='gv-up'>% arriba</span> del mismo mes del año pasado",
                                          "<span class='gv-down'>% abajo</span> del mismo mes del año pasado");
  if (pr.proyeccion) l1 += ". Al ritmo actual cerrás el año en <strong>" + _gvPlata(pr.proyeccion) + "</strong>";
  l1 += ".";

  // Línea 2: salud de la cartera (altas vs bajas del último mes con dato).
  var ult = ab.length ? ab[ab.length - 1] : null;
  var l2 = "";
  if (ult) {
    var neto = (ult.altas || 0) - (ult.bajas || 0);
    l2 = "La cartera " + (neto > 0 ? "<span class='gv-up'>creció</span>" :
         neto < 0 ? "<span class='gv-down'>se achicó</span>" : "quedó igual") +
         ": " + ult.altas + " clientes nuevos contra " + ult.bajas + " que se enfriaron";
  }
  if (r.clientes) l2 += (l2 ? ". " : "") + r.clientes + " clientes compraron en el mes";
  if (l2) l2 += ".";

  // Línea 3: la alerta más importante que haya.
  var l3 = "";
  var peor = (tv.bajan || [])[0];
  if (f.clientes) {
    l3 = "<strong>" + f.clientes + " clientes</strong> se están retrasando de su ritmo: es el momento de llamarlos antes de perderlos";
  } else if (peor && peor.dif < 0) {
    l3 = "Ojo con <strong>" + escHtml(peor.nom) + "</strong>: cayó " + _gvPlata(Math.abs(peor.dif)) + " contra el año pasado";
  }
  if (rg.clientes) l3 += (l3 ? ". " : "") + rg.clientes + " clientes que te compran están en situación 3+ del BCRA";
  if (l3) l3 += ".";

  return (
    '<div class="gv-resumen">' +
    '<div class="gv-resumen-ico">📋</div>' +
    "<div><p>" + l1 + "</p>" +
    (l2 ? "<p>" + l2 + "</p>" : "") +
    (l3 ? "<p>" + l3 + "</p>" : "") +
    "</div></div>"
  );
}

function _gvPintarDashboard(d, generado) {
  var cont = document.getElementById("gvDash");
  var r = d.resumen || {}, c = d.curso || {}, cc = d.concentracion || {};

  var res = document.getElementById("gvDashResumen");
  if (res && generado) {
    res.textContent = "actualizado " + new Date(generado).toLocaleString("es-AR");
  }

  var mesTxt = function (m) {
    if (!m) return "";
    var p = String(m).split("-");
    return ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][+p[1]-1] +
      " " + p[0];
  };

  // --- PPP en curso (backlog: plata/m³/días pedidos adentro) --------------
  // Se pide aparte porque sale de su propio espejo (sincronizar_ppp), no del
  // cache del dashboard. Placeholder que se completa async.
  // Resumen ejecutivo: 3 líneas en prosa para el que mira 2 minutos. Se compone
  // de los datos ya cargados, sin round-trip. Determinístico, no depende de LLM.
  var html = _gvResumenEjecutivo(d, mesTxt);
  html += '<div id="gvPppBanda"></div>';
  _gvCargarPPP();

  // --- Tarjetas -----------------------------------------------------------
  html +=
    '<div class="gv-tile-fila">' +
    // Clic en la venta del mes = abrir su composición, cliente por cliente.
    '<div class="gv-clickable" onclick="gvAbrirDrill(\'clientes\',' + _gvQ(r.mes) +
      ',null,null,' + _gvQ("Venta " + mesTxt(r.mes)) + ',true)">' +
    _gvTile("Venta " + mesTxt(r.mes) + "  ⤢", _gvPlata(r.facturado),
      "vs año ant. " + _gvVar(r.facturado, r.facturado_aa) +
      " · vs mes ant. " + _gvVar(r.facturado, r.facturado_ant)) + "</div>" +
    _gvTile("Acumulado " + String(r.mes || "").slice(0, 4), _gvPlata(r.acum_anio),
      "vs mismo tramo " + _gvVar(r.acum_anio, r.acum_anio_ant)) +
    _gvTile("Clientes que compraron", _gvNum(r.clientes),
      "promedio 12m: " + _gvNum(r.clientes_prom12)) +
    _gvTile("Ticket promedio", _gvPlata(r.ticket),
      _gvNum(r.pedidos) + " pedidos · vs año ant. " + _gvVar(r.ticket, r.ticket_aa)) +
    _gvTile("Pedido en " + mesTxt(c.mes) + " (portal)", _gvPlata(c.monto),
      "al día " + c.dia + " · " + _gvNum(c.pedidos) + " pedidos · vs mismo tramo " +
      _gvVar(c.monto, c.monto_ant_mismo_tramo)) +
    "</div>" +
    '<p class="gv-dash-nota">' +
    "<strong>Venta</strong> sale del ERP por mes cerrado. <em>sales_lines</em> no guarda " +
    "precio, así que el monto se reconstruye con el precio de lista <strong>de hoy</strong> " +
    "y el descuento actual del cliente. Como todos los períodos se valorizan igual, las " +
    "comparaciones interanuales son <strong>reales</strong> (volumen y mix), no nominales: " +
    "la inflación queda afuera. Para el mes corriente la reconstrucción coincide con la " +
    "plata real dentro del 1%. " +
    "<strong>Pedido</strong> sale del portal, es plata facturada de verdad y va en vivo; " +
    "un pedido de fin de mes se factura al mes siguiente, así que los dos nunca coinciden " +
    "exacto. Nada de esto es la facturación contable. " +
    "<strong>Ojo con los supermercados:</strong> tienen lista propia y acá se los " +
    "valoriza con la lista general, así que su monto está mal. Son 8 clientes y el " +
    "14% de la venta; las listas de súper existen en <em>precios_super</em> pero no hay " +
    "forma de saber qué código de cliente corresponde a cada cadena." +
    "</p>";

  // --- Gráficos -----------------------------------------------------------
  html +=
    '<div class="gv-graf-fila">' +
    '<div class="gv-graf"><h4>Venta por mes (a precios de hoy)</h4><div class="gv-chart-box"><canvas id="gvChartSerie"></canvas></div></div>' +
    '<div class="gv-graf"><h4>Altas y bajas de clientes</h4><div class="gv-chart-box"><canvas id="gvChartAB"></canvas></div></div>' +
    "</div>" +
    '<div class="gv-graf-fila">' +
    '<div class="gv-graf"><h4>' + mesTxt(r.mes).slice(0,3) + " en los últimos años</h4>" +
    '<div class="gv-chart-box"><canvas id="gvChartEstac"></canvas></div></div>' +
    '<div class="gv-graf"><h4>Concentración de la cartera</h4>' +
    '<div class="gv-conc">' +
    '<div class="gv-conc-linea"><span>Top 10 clientes</span><strong>' +
    (cc.total ? Math.round(100 * cc.top10 / cc.total) : 0) + "%</strong></div>" +
    '<div class="gv-barra"><i style="width:' +
    (cc.total ? Math.round(100 * cc.top10 / cc.total) : 0) + '%"></i></div>' +
    '<div class="gv-conc-linea"><span>Top 20 clientes</span><strong>' +
    (cc.total ? Math.round(100 * cc.top20 / cc.total) : 0) + "%</strong></div>" +
    '<div class="gv-barra"><i style="width:' +
    (cc.total ? Math.round(100 * cc.top20 / cc.total) : 0) + '%"></i></div>' +
    '<div class="gv-conc-pie">' + _gvNum(cc.clientes) + " clientes compraron en 12 meses · " +
    _gvPlata(cc.total) + "</div></div></div>" +
    "</div>";

  // --- Proyección de cierre de año ---------------------------------------
  html += _gvProyeccion(d.proyeccion || {});

  // --- Fuga temprana (aviso antes de que se enfríen) ---------------------
  html += _gvFugaTemprana(d.fuga || {});

  // --- Tablas -------------------------------------------------------------
  html += _gvTablaVar(d.top_var || {});
  html += _gvTablaCats(d.categorias || []);
  html += _gvTablaProductos(d.productos || {});
  html += _gvTablaVend(d.vendedores || []);
  html += _gvTablaPagos(d.medios_pago || [], d.riesgo || {});

  cont.innerHTML = html;

  // Los charts viejos hay que destruirlos o Chart.js deja los canvas colgados.
  _gvDashCharts.forEach(function (ch) { try { ch.destroy(); } catch (e) {} });
  _gvDashCharts = [];
  _gvDibujarCharts(d, mesTxt);
}

function _gvDibujarCharts(d, mesTxt) {
  if (typeof Chart === "undefined") return;
  var serie = d.serie || [];
  var ab = d.altas_bajas || [];
  var es = d.estacionalidad || [];

  var c1 = document.getElementById("gvChartSerie");
  if (c1 && serie.length) {
    _gvDashCharts.push(new Chart(c1, {
      type: "line",
      data: {
        labels: serie.map(function (x) { return mesTxt(x.mes); }),
        datasets: [
          { label: "Loekemeyer", data: serie.map(function (x) { return x.lk; }),
            borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.08)", fill: true, tension: .3 },
          { label: "Chef", data: serie.map(function (x) { return x.chef; }),
            borderColor: "#f59e0b", fill: false, tension: .3 },
          { label: "Pedido web", data: serie.map(function (x) { return x.web; }),
            borderColor: "#10b981", borderDash: [4, 3], fill: false, tension: .3 }
        ]
      },
      options: _gvOpcionesChart()
    }));
  }

  var c2 = document.getElementById("gvChartAB");
  if (c2 && ab.length) {
    _gvDashCharts.push(new Chart(c2, {
      type: "bar",
      data: {
        labels: ab.map(function (x) { return mesTxt(x.mes); }),
        datasets: [
          { label: "Altas", data: ab.map(function (x) { return x.altas; }), backgroundColor: "#10b981" },
          // Las bajas van en negativo para que se lea de un vistazo si la
          // cartera crece o se achica.
          { label: "Bajas", data: ab.map(function (x) { return -x.bajas; }), backgroundColor: "#ef4444" }
        ]
      },
      options: _gvOpcionesChart(true)
    }));
  }

  var c3 = document.getElementById("gvChartEstac");
  if (c3 && es.length) {
    _gvDashCharts.push(new Chart(c3, {
      type: "bar",
      data: {
        labels: es.map(function (x) { return String(x.mes).slice(0, 4); }),
        datasets: [{ label: "Venta", data: es.map(function (x) { return x.monto; }),
                     backgroundColor: "#2563eb" }]
      },
      options: _gvOpcionesChart()
    }));
  }
}

function _gvOpcionesChart(apilado) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: function (ctx) {
            var v = ctx.parsed.y;
            return ctx.dataset.label + ": " +
              (Math.abs(v) >= 1000 ? _gvPlata(Math.abs(v)) : Math.abs(v));
          }
        }
      }
    },
    scales: {
      x: { stacked: !!apilado, ticks: { font: { size: 9 }, maxRotation: 60 } },
      y: {
        stacked: !!apilado,
        ticks: {
          font: { size: 9 },
          callback: function (v) {
            return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + "M" : v;
          }
        }
      }
    }
  };
}

function _gvProyeccion(pr) {
  if (!pr.proyeccion) return "";
  // Barra de progreso del año: cuánto del cierre proyectado ya está facturado.
  var pct = pr.proyeccion ? Math.round(100 * pr.acum / pr.proyeccion) : 0;
  var vsAnt = pr.total_anio_ant
    ? _gvVar(pr.proyeccion, pr.total_anio_ant) : "";
  return (
    '<div class="gv-graf gv-graf-full gv-proy"><h4>Proyección de cierre ' +
    escHtml(pr.anio) + "</h4>" +
    '<div class="gv-proy-row">' +
    '<div><div class="gv-proy-lbl">Va del año (' + pr.meses_cerrados + " meses)</div>" +
    '<div class="gv-proy-val">' + _gvPlata(pr.acum) + "</div></div>" +
    '<div><div class="gv-proy-lbl">Proyección de cierre</div>' +
    '<div class="gv-proy-val gv-proy-big">' + _gvPlata(pr.proyeccion) + " " + vsAnt + "</div></div>" +
    '<div><div class="gv-proy-lbl">Cerró el año pasado</div>' +
    '<div class="gv-proy-val">' + _gvPlata(pr.total_anio_ant) + "</div></div>" +
    "</div>" +
    '<div class="gv-barra" style="height:12px"><i style="width:' + pct + '%"></i></div>' +
    '<div class="gv-conc-pie">Proyección con estacionalidad: escala lo que va del año por cómo ' +
    "cerró el año pasado el mismo tramo, no linealmente.</div></div>"
  );
}

function _gvFugaTemprana(f) {
  if (!f.clientes) return "";
  var lista = (f.lista || []).map(function (x) {
    return '<tr class="gv-drill-click" onclick="gvAbrirDrill(\'pedidos\',null,' +
      _gvQ(x.cod) + ',null,' + _gvQ(x.nom) + ',true)"><td>' + escHtml(x.nom) +
      ' <span class="est-cod">' + escHtml(x.cod) + "</span></td><td>compra cada " +
      _gvNum(x.mediana) + " días</td><td>hace <strong>" + _gvNum(x.dias) +
      "</strong> que no compra</td></tr>";
  }).join("");
  return (
    '<div class="gv-graf gv-graf-full gv-alerta"><h4>⚠ Fuga temprana — ' + f.clientes +
    " clientes se están retrasando</h4>" +
    '<p class="gv-dash-nota">Se pasaron de su ritmo habitual pero todavía no están fríos. ' +
    "Es el momento de llamarlos: agarrarlos ahora es más barato que reactivarlos después.</p>" +
    '<table class="est-table gv-mini"><tbody>' + lista + "</tbody></table></div>"
  );
}

function _gvTablaProductos(pv) {
  if (!pv.suben) return "";
  var lado = function (arr, tit, signo) {
    return '<div class="gv-graf"><h4>' + tit + "</h4>" +
      '<table class="est-table gv-mini"><tbody>' +
      (arr || []).map(function (x) {
        return '<tr class="gv-drill-click" onclick="gvAbrirDrill(\'lineas_prod\',' +
          _gvQ(x.cod) + ',null,null,' + _gvQ(x["desc"]) + ',true)"><td>' + escHtml(x["desc"]) +
          ' <span class="est-cod">' + escHtml(x.cod) + "</span></td><td class=\"" + signo +
          '">' + (x.dif > 0 ? "+" : "") + _gvPlata(x.dif) + "</td><td>" +
          _gvPlata(x.antes) + " → " + _gvPlata(x.ahora) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  };
  return '<div class="gv-graf-fila">' +
    lado(pv.suben, "Productos que más crecieron (12m vs 12m)", "gv-up") +
    lado(pv.bajan, "Productos que más cayeron (12m vs 12m)", "gv-down") + "</div>";
}

function _gvTablaVar(tv) {
  var lado = function (arr, tit, signo) {
    return (
      '<div class="gv-graf"><h4>' + tit + "</h4>" +
      '<table class="est-table gv-mini"><tbody>' +
      (arr || []).map(function (x) {
        return '<tr class="gv-drill-click" onclick="gvAbrirDrill(\'pedidos\',null,' +
          _gvQ(x.cod) + ',null,' + _gvQ(x.nom) + ',true)">' +
          "<td>" + escHtml(x.nom) + ' <span class="est-cod">' + escHtml(x.cod) +
          "</span></td><td class=\"" + signo + '">' + (x.dif > 0 ? "+" : "") +
          _gvPlata(x.dif) + "</td><td>" + _gvPlata(x.antes) + " → " + _gvPlata(x.ahora) +
          "</td></tr>";
      }).join("") +
      "</tbody></table></div>"
    );
  };
  return '<div class="gv-graf-fila">' +
    lado(tv.suben, "Los que más crecieron (12m vs 12m)", "gv-up") +
    lado(tv.bajan, "Los que más cayeron (12m vs 12m)", "gv-down") +
    "</div>";
}

function _gvTablaCats(cats) {
  if (!cats.length) return "";
  return (
    '<div class="gv-graf gv-graf-full"><h4>Categorías: últimos 12 meses vs los 12 previos</h4>' +
    '<table class="est-table gv-mini"><thead><tr><th>CATEGORÍA</th><th>12M</th>' +
    "<th>12M PREVIOS</th><th>VARIACIÓN</th></tr></thead><tbody>" +
    cats.map(function (x) {
      return "<tr><td>" + escHtml(x.cat) + "</td><td>" + _gvPlata(x.ahora) + "</td><td>" +
        _gvPlata(x.antes) + "</td><td>" + _gvVar(x.ahora, x.antes) + "</td></tr>";
    }).join("") +
    "</tbody></table></div>"
  );
}

function _gvTablaVend(v) {
  if (!v.length) return "";
  return (
    '<div class="gv-graf gv-graf-full"><h4>Por vendedor</h4>' +
    '<table class="est-table gv-mini"><thead><tr><th>VENDEDOR</th><th>CLIENTES</th>' +
    "<th>ACTIVOS 12M</th><th>12M</th><th>12M PREVIOS</th><th>VARIACIÓN</th></tr></thead><tbody>" +
    v.map(function (x) {
      return "<tr><td>" + escHtml(_vendNombreVisible(x.vendedor)) + "</td><td>" +
        _gvNum(x.clientes) + "</td><td>" + _gvNum(x.activos) + "</td><td>" +
        _gvPlata(x.ahora) + "</td><td>" + _gvPlata(x.antes) + "</td><td>" +
        _gvVar(x.ahora, x.antes) + "</td></tr>";
    }).join("") +
    "</tbody></table></div>"
  );
}

function _gvTablaPagos(p, riesgo) {
  var tot = p.reduce(function (a, x) { return a + Number(x.monto || 0); }, 0);
  var dto = p.reduce(function (a, x) { return a + Number(x.dto_medio || 0); }, 0);
  return (
    '<div class="gv-graf gv-graf-full"><h4>Medio de pago (últimos 12 meses)</h4>' +
    '<p class="gv-dash-nota">Resignaste <strong>' + _gvPlata(dto) +
    "</strong> en descuento por medio de pago sobre " + _gvPlata(tot + dto) +
    " de venta bruta." +
    (riesgo.clientes
      ? " · <strong>" + riesgo.clientes + " clientes</strong> con situación BCRA 3 o peor " +
        "compraron " + _gvPlata(riesgo.monto) + " en 12 meses."
      : "") +
    "</p>" +
    '<table class="est-table gv-mini"><thead><tr><th>MEDIO</th><th>PEDIDOS</th>' +
    "<th>FACTURADO</th><th>DESCUENTO</th><th>% DEL TOTAL</th></tr></thead><tbody>" +
    p.map(function (x) {
      return "<tr><td>" + escHtml(x.medio) + "</td><td>" + _gvNum(x.pedidos) + "</td><td>" +
        _gvPlata(x.monto) + "</td><td>" + _gvPlata(x.dto_medio) + "</td><td>" +
        (tot ? Math.round(100 * x.monto / tot) : 0) + "%</td></tr>";
    }).join("") +
    "</tbody></table></div>"
  );
}

// ---- DRILL-DOWN: composición de cada número --------------------------------
//
// Un solo modal para los tres niveles (clientes -> pedidos -> líneas), con
// migas para volver. La RPC devuelve siempre la misma forma, así que hay un
// solo render.
//
// LLEGA HASTA LA LÍNEA DE ARTÍCULO CON SU VALORIZACIÓN, no hasta la NP:
// sales_lines no guarda el número de nota de pedido. Las NP del cliente se
// muestran aparte, como contexto, sin fingir que están ligadas a esas líneas.

var _gvDrillPila = [];

function gvAbrirDrill(nivel, mes, cod, fecha, titulo, reset) {
  if (reset) _gvDrillPila = [];
  _gvDrillPila.push({ nivel: nivel, mes: mes, cod: cod, fecha: fecha, titulo: titulo });
  _gvDrillRender();
}
window.gvAbrirDrill = gvAbrirDrill;

function gvVolverDrill(i) {
  _gvDrillPila = _gvDrillPila.slice(0, i + 1);
  _gvDrillRender();
}
window.gvVolverDrill = gvVolverDrill;

function gvCerrarDrill() {
  var m = document.getElementById("gvDrillModal");
  if (m) m.style.display = "none";
  _gvDrillPila = [];
}
window.gvCerrarDrill = gvCerrarDrill;

function _gvDrillRender() {
  var m = document.getElementById("gvDrillModal");
  var b = document.getElementById("gvDrillBody");
  if (!m || !b) return;
  m.style.display = "flex";

  var act = _gvDrillPila[_gvDrillPila.length - 1];
  var migas = _gvDrillPila.map(function (p, i) {
    var ult = i === _gvDrillPila.length - 1;
    return ult
      ? '<span class="gv-miga-act">' + escHtml(p.titulo) + "</span>"
      : '<a href="javascript:void(0)" onclick="gvVolverDrill(' + i + ')">' +
        escHtml(p.titulo) + "</a>";
  }).join('<span class="gv-miga-sep">›</span>');
  var mig = document.getElementById("gvDrillMigas");
  if (mig) mig.innerHTML = migas;

  b.innerHTML = '<div class="gv-cargando">Cargando…</div>';

  sb.rpc("gv_drill", {
    p_nivel: act.nivel, p_mes: act.mes || null,
    p_cod: act.cod || null, p_fecha: act.fecha || null
  })
    .then(function (resp) {
      if (resp.error) throw resp.error;
      var filas = resp.data || [];
      if (!filas.length) {
        b.innerHTML = '<div class="gv-vacio">Sin movimientos.</div>';
        return;
      }
      var total = filas.reduce(function (a, f) { return a + Number(f.monto || 0); }, 0);
      var uni = filas.reduce(function (a, f) { return a + Number(f.unidades || 0); }, 0);
      var caj = filas.reduce(function (a, f) { return a + Number(f.cajas || 0); }, 0);

      // Qué pasa al hacer clic en una fila, según el nivel actual.
      var sig = { clientes: "pedidos", pedidos: "lineas" }[act.nivel];

      var html =
        '<div class="gv-drill-tot">' + filas.length + " filas · " +
        _gvNum(caj) + " cajas · " + _gvNum(uni) + " unidades · <strong>" +
        _gvPlata(total) + "</strong></div>" +
        '<table class="est-table gv-mini"><thead><tr><th>DETALLE</th><th>CAJAS</th>' +
        "<th>UNIDADES</th><th>MONTO</th><th>%</th></tr></thead><tbody>" +
        filas.map(function (f) {
          var onclick = "";
          if (sig === "pedidos") {
            onclick = 'onclick="gvAbrirDrill(\'pedidos\',' + _gvQ(act.mes) + "," +
              _gvQ(f.clave) + ",null," + _gvQ(f.titulo) + ')"';
          } else if (sig === "lineas") {
            onclick = 'onclick="gvAbrirDrill(\'lineas\',null,' + _gvQ(act.cod) + "," +
              _gvQ(f.clave) + "," + _gvQ(f.titulo) + ')"';
          }
          return (
            '<tr class="' + (sig ? "gv-drill-click" : "") + '" ' + onclick + ">" +
            "<td><strong>" + escHtml(f.titulo) + "</strong>" +
            (f.subtitulo ? '<div class="gv-drill-sub">' + escHtml(f.subtitulo) + "</div>" : "") +
            "</td><td>" + _gvNum(f.cajas) + "</td><td>" + _gvNum(f.unidades) + "</td>" +
            "<td>" + _gvPlata(f.monto) + "</td><td>" +
            (total ? Math.round(100 * Number(f.monto || 0) / total) : 0) + "%</td></tr>"
          );
        }).join("") +
        "</tbody></table>";

      // En el nivel de pedidos se ofrecen las NP del cliente, marcadas como lo
      // que son: contexto, no la composición de estas líneas.
      if (act.nivel === "pedidos") {
        html +=
          '<button type="button" class="btn-secondary" style="margin-top:12px" ' +
          "onclick=\"gvAbrirDrill('nps',null," + _gvQ(act.cod) +
          ",null,'Notas de pedido')\">Ver las NP de este cliente</button>" +
          '<p class="gv-dash-nota" style="margin-top:8px">Las NP son contexto: ' +
          "<em>sales_lines</em> no guarda el número de nota de pedido, así que no se " +
          "pueden ligar a las líneas de arriba.</p>";
      }
      b.innerHTML = html;
    })
    .catch(function (err) {
      b.innerHTML = '<div class="gv-vacio">Error: ' + escHtml(err.message) + "</div>";
    });
}

// Comillas seguras para meter un valor dentro de un onclick inline.
function _gvQ(v) {
  if (v == null) return "null";
  return "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;") + "'";
}

/* ============================================================================
   Ranking Clientes (ACTIVOS)
   Espeja el Ranking Inactivos pero al revés: muestra a los clientes que
   compraron en el período y los ordena por facturación neta. Consume la
   RPC get_ranking_clientes.
   Pedido explícito del user (2026-08-11): "otra cosa que hay que desarrollar
   en paginalk es un modulo de ranking de clientes".
   ============================================================================ */
var _rcState = { page: 1, pageSize: 25, total: 0, loaded: false, rows: [] };

function _rcFmt(n) {
  var v = Number(n) || 0;
  return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
}
function _rcEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

async function cargarRankingClientes(page) {
  _rcState.page = Math.max(1, Number(page) || 1);
  var meses = Number(document.getElementById("rcPeriodo").value) || 12;
  var minMonto = Number(document.getElementById("rcMinMonto").value) || 0;
  var q = (document.getElementById("rcBuscar").value || "").trim() || null;
  var cont = document.getElementById("rcTabla");
  var res  = document.getElementById("rcResumen");
  var pgr  = document.getElementById("rcPager");
  cont.innerHTML = '<div style="padding:16px;color:#64748b;">Cargando…</div>';
  res.textContent = "";
  pgr.innerHTML = "";
  var offset = (_rcState.page - 1) * _rcState.pageSize;
  var r = await sb.rpc("get_ranking_clientes", {
    p_meses: meses,
    p_empresa: "lk",
    p_limit: _rcState.pageSize,
    p_offset: offset,
    p_q: q,
    p_vendedores: null,
    p_min_monto: minMonto,
  });
  if (r.error) {
    cont.innerHTML = '<div style="padding:16px;color:#b91c1c;">Error: ' + _rcEsc(r.error.message) + '</div>';
    return;
  }
  _rcState.rows = r.data || [];
  _rcState.total = _rcState.rows.length ? Number(_rcState.rows[0].total_filas) || 0 : 0;
  _rcState.loaded = true;
  _rcRender();
}

function _rcRender() {
  var cont = document.getElementById("rcTabla");
  var res  = document.getElementById("rcResumen");
  var pgr  = document.getElementById("rcPager");
  var rows = _rcState.rows;
  var tot  = _rcState.total;
  var totFact = 0;
  for (var i = 0; i < rows.length; i++) totFact += Number(rows[i].total_historico) || 0;
  res.innerHTML = "<b>" + tot.toLocaleString("es-AR") + "</b> cliente(s) en el período · Página muestra <b>" + rows.length + "</b> · Facturado (esta página) <b>" + _rcFmt(totFact) + "</b>";
  if (!rows.length) {
    cont.innerHTML = '<div style="padding:20px;color:#64748b;text-align:center;">Sin clientes que cumplan los filtros.</div>';
    return;
  }
  var h = '<div style="overflow-x:auto;"><table class="est-table" style="width:100%;border-collapse:collapse;font-size:13.5px;">' +
    '<thead><tr>' +
      '<th style="padding:8px;">Puesto</th>' +
      '<th style="padding:8px;">Código</th>' +
      '<th style="padding:8px;">Razón social</th>' +
      '<th style="padding:8px;">CUIT</th>' +
      '<th style="padding:8px;">Vendedor</th>' +
      '<th style="padding:8px;text-align:right;">Facturado</th>' +
      '<th style="padding:8px;text-align:right;">Pedidos</th>' +
      '<th style="padding:8px;text-align:right;">Arts. dist.</th>' +
      '<th style="padding:8px;">Últ. compra</th>' +
    '</tr></thead><tbody>';
  h += rows.map(function (r) {
    return '<tr>' +
      '<td style="padding:6px 8px;text-align:center;font-weight:bold;">' + r.ranking + '</td>' +
      '<td style="padding:6px 8px;"><b>' + _rcEsc(r.cod_cliente) + '</b></td>' +
      '<td style="padding:6px 8px;">' + _rcEsc(r.business_name || "—") + '</td>' +
      '<td style="padding:6px 8px;font-size:12px;color:#64748b;">' + _rcEsc(r.cuit || "—") + '</td>' +
      '<td style="padding:6px 8px;font-size:12px;">' + _rcEsc(r.vendedor_nombre || r.vendedor || "—") + '</td>' +
      '<td style="padding:6px 8px;text-align:right;font-weight:bold;">' + _rcFmt(r.total_historico) + '</td>' +
      '<td style="padding:6px 8px;text-align:right;">' + (r.total_pedidos || 0) + '</td>' +
      '<td style="padding:6px 8px;text-align:right;">' + (r.articulos_distintos || 0) + '</td>' +
      '<td style="padding:6px 8px;font-size:12px;color:#64748b;">' + _rcEsc(r.last_date || "—") + '</td>' +
    '</tr>';
  }).join("");
  h += '</tbody></table></div>';
  cont.innerHTML = h;
  // Pager
  var pages = Math.max(1, Math.ceil(tot / _rcState.pageSize));
  var cur = _rcState.page;
  var pg = '';
  pg += '<button ' + (cur <= 1 ? 'disabled' : '') + ' onclick="cargarRankingClientes(' + (cur - 1) + ')" style="padding:6px 12px;">‹ Anterior</button>';
  pg += '<span style="margin:0 8px;">Página <b>' + cur + '</b> de ' + pages + '</span>';
  pg += '<button ' + (cur >= pages ? 'disabled' : '') + ' onclick="cargarRankingClientes(' + (cur + 1) + ')" style="padding:6px 12px;">Siguiente ›</button>';
  pgr.innerHTML = pg;
}

async function descargarRankingClientesExcel() {
  // Trae todo el ranking del período (sin paginado) llamando a la RPC con
  // p_limit grande. Formato mínimo — el user ya conoce el pattern del
  // Ranking Inactivos.
  var meses = Number(document.getElementById("rcPeriodo").value) || 12;
  var minMonto = Number(document.getElementById("rcMinMonto").value) || 0;
  var q = (document.getElementById("rcBuscar").value || "").trim() || null;
  var btn = document.getElementById("rcBtnExcel");
  var txt0 = btn.textContent; btn.disabled = true; btn.textContent = "Generando…";
  try {
    var r = await sb.rpc("get_ranking_clientes", {
      p_meses: meses, p_empresa: "lk",
      p_limit: 10000, p_offset: 0, p_q: q,
      p_vendedores: null, p_min_monto: minMonto,
    });
    if (r.error) { alert("Error: " + r.error.message); return; }
    var rows = (r.data || []).map(function (x) {
      return {
        Puesto: x.ranking,
        Codigo: x.cod_cliente,
        RazonSocial: x.business_name || "",
        CUIT: x.cuit || "",
        Vendedor: x.vendedor_nombre || x.vendedor || "",
        Facturado: Number(x.total_historico) || 0,
        Pedidos: x.total_pedidos || 0,
        ArticulosDistintos: x.articulos_distintos || 0,
        UltimaCompra: x.last_date || "",
      };
    });
    if (!rows.length) { alert("Nada para exportar."); return; }
    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ranking " + meses + "m");
    var fname = "ranking_clientes_" + meses + "m_" + new Date().toISOString().slice(0, 10) + ".xlsx";
    XLSX.writeFile(wb, fname);
  } catch (e) {
    alert("Falló el Excel: " + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = txt0;
  }
}

// Wiring del module (se llama en inicRankingClientes al abrir la pestaña)
function inicRankingClientes() {
  var btn = document.getElementById("rcBtnCargar");
  var btnX = document.getElementById("rcBtnExcel");
  var inpQ = document.getElementById("rcBuscar");
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener("click", function () { cargarRankingClientes(1); });
  }
  if (btnX && !btnX._wired) {
    btnX._wired = true;
    btnX.addEventListener("click", function () { descargarRankingClientesExcel(); });
  }
  if (inpQ && !inpQ._wired) {
    inpQ._wired = true;
    inpQ.addEventListener("keydown", function (e) { if (e.key === "Enter") cargarRankingClientes(1); });
  }
  if (!_rcState.loaded) cargarRankingClientes(1);
}

window.cargarRankingClientes = cargarRankingClientes;
window.descargarRankingClientesExcel = descargarRankingClientesExcel;
window.inicRankingClientes = inicRankingClientes;

/* ============================================================================
   Panel Top-50 seguimiento clientes (dentro de Gerente de ventas)
   Dos rankings paralelos (histórico total / pedido máximo individual) para las
   dos empresas (LK y Chef). Debajo de cada fila, matriz de seguimiento mensual
   con celdas coloreadas (verde = compró, gris = no compró, rojo = alerta) más
   un badge de frecuencia habitual y meses sin comprar.
   Backend: get_top_clientes_hist, get_top_clientes_max_pedido, get_seguimiento_mensual.
   Pedido explícito 2026-08-11: "no perder pisada de si me están comprando".
   ============================================================================ */
var _gvTop = {
  tab: "hist",       // "hist" | "max"
  emp: "lk",         // "lk" | "chef"
  loadedFor: null,   // "tab-emp-mesesAct-mesesSeg" key para no re-pegar sin cambios
  rows: [],
  seguimiento: {},   // { cod: {meses[], frecuencia_meses, meses_sin_comprar, alerta} }
};

function _gvfPlata(n) {
  var v = Number(n) || 0;
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + " MM";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + " M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(0) + " k";
  return "$" + Math.round(v).toLocaleString("es-AR");
}
function _gvfEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function gvTopSetTab(t) {
  if (t !== "hist" && t !== "max") return;
  _gvTop.tab = t;
  var bH = document.getElementById("gvTopTabHist");
  var bM = document.getElementById("gvTopTabMax");
  if (bH && bM) {
    bH.style.background = t === "hist" ? "#111" : "transparent";
    bH.style.color = t === "hist" ? "#fff" : "#333";
    bM.style.background = t === "max"  ? "#111" : "transparent";
    bM.style.color = t === "max"  ? "#fff" : "#333";
  }
  gvTopCargar();
}
function gvTopSetEmp(e) {
  if (e !== "lk" && e !== "chef") return;
  _gvTop.emp = e;
  var bL = document.getElementById("gvTopEmpLk");
  var bC = document.getElementById("gvTopEmpCh");
  if (bL && bC) {
    bL.style.background = e === "lk"   ? "#1e6bd6" : "transparent";
    bL.style.color      = e === "lk"   ? "#fff"    : "#333";
    bC.style.background = e === "chef" ? "#1e6bd6" : "transparent";
    bC.style.color      = e === "chef" ? "#fff"    : "#333";
  }
  gvTopCargar();
}
window.gvTopSetTab = gvTopSetTab;
window.gvTopSetEmp = gvTopSetEmp;

async function gvTopCargar() {
  var st = document.getElementById("gvTopStatus");
  var cont = document.getElementById("gvTopTabla");
  if (!cont) return;
  var mesesSeg = Number(document.getElementById("gvTopMeses").value) || 12;
  var minActRaw = document.getElementById("gvTopMinAct").value;
  var minAct = minActRaw ? Number(minActRaw) : null;
  var key = _gvTop.tab + "-" + _gvTop.emp + "-" + (minAct||"") + "-" + mesesSeg;
  st.textContent = "Cargando…";
  cont.innerHTML = "";
  try {
    var fn = _gvTop.tab === "max" ? "get_top_clientes_max_pedido" : "get_top_clientes_hist";
    var rr = await sb.rpc(fn, { p_empresa: _gvTop.emp, p_limit: 50, p_min_periodo_meses: minAct });
    if (rr.error) throw rr.error;
    _gvTop.rows = rr.data || [];
    if (!_gvTop.rows.length) {
      st.textContent = "";
      cont.innerHTML = '<div style="padding:20px;color:#64748b;text-align:center;">Sin datos para ' + _gvTop.emp + '.</div>';
      _gvTop.loadedFor = key;
      return;
    }
    // Traigo el seguimiento de los 50
    var cods = _gvTop.rows.map(function (r) { return r.cod_cliente; });
    var sg = await sb.rpc("get_seguimiento_mensual", { p_cods: cods, p_empresa: _gvTop.emp, p_meses: mesesSeg });
    if (sg.error) throw sg.error;
    var m = {};
    (sg.data || []).forEach(function (x) { m[x.cod_cliente] = x; });
    _gvTop.seguimiento = m;
    _gvTop.loadedFor = key;
    _gvTopRender();
    var aFrec = (sg.data || []).filter(function (x) { return x.alerta_frecuencia; }).length;
    var aVol  = (sg.data || []).filter(function (x) { return x.alerta_volumen; }).length;
    var aAny  = (sg.data || []).filter(function (x) { return x.alerta_frecuencia || x.alerta_volumen; }).length;
    var partes = [];
    if (aFrec) partes.push('<span style="color:#b91c1c;font-weight:bold;">🕑 ' + aFrec + ' sin comprar</span>');
    if (aVol)  partes.push('<span style="color:#b91c1c;font-weight:bold;">📉 ' + aVol + ' menos cajas</span>');
    if (!partes.length) partes.push('<span style="color:#059669;">✓ todos al día</span>');
    st.innerHTML = '<b>' + _gvTop.rows.length + '</b> clientes · ' + partes.join(' · ') +
      (aAny ? ' · <b>' + aAny + ' con alguna alerta</b>' : '') +
      ' · empresa <b>' + (_gvTop.emp === "lk" ? "Loekemeyer" : "Chef") + '</b> · orden por <b>' + (_gvTop.tab === "hist" ? "histórico total" : "pedido máximo") + '</b>';
  } catch (e) {
    st.innerHTML = '<span style="color:#b91c1c;">Error: ' + _gvfEsc(e.message || e) + '</span>';
  }
}
window.gvTopCargar = gvTopCargar;

function _gvTopRender() {
  var cont = document.getElementById("gvTopTabla");
  if (!cont) return;
  var rows = _gvTop.rows;
  var seg  = _gvTop.seguimiento;
  var mesesSeg = Number(document.getElementById("gvTopMeses").value) || 12;
  // Header de meses (mismo orden que devuelve el seguimiento: desc)
  var mesesHdr = [];
  if (rows.length) {
    var s0 = seg[rows[0].cod_cliente];
    if (s0 && Array.isArray(s0.meses)) mesesHdr = s0.meses.map(function (x) { return x.mes; });
  }
  var h = '<div style="overflow-x:auto;"><table class="est-table" style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
    '<thead><tr>' +
      '<th style="padding:6px 8px;text-align:center;">#</th>' +
      '<th style="padding:6px 8px;text-align:left;">Cliente</th>' +
      '<th style="padding:6px 8px;text-align:right;">' + (_gvTop.tab === "max" ? "Pedido máx" : "Histórico") + '</th>' +
      '<th style="padding:6px 8px;text-align:right;">' + (_gvTop.tab === "max" ? "Histórico" : "Pedido máx") + '</th>' +
      '<th style="padding:6px 8px;text-align:center;">Freq</th>' +
      '<th style="padding:6px 8px;text-align:center;">Sin comprar</th>' +
      '<th style="padding:6px 8px;text-align:center;" title="Mediana de cajas por pedido histórico vs promedio de los últimos 3">Cajas hist→rec</th>' +
      '<th style="padding:6px 8px;text-align:center;">Alerta</th>' +
      mesesHdr.map(function (m) {
        return '<th style="padding:4px 3px;text-align:center;font-size:10px;color:#64748b;font-weight:normal;transform:rotate(-45deg);white-space:nowrap;min-width:24px;">' + m.slice(2) + '</th>';
      }).join("") +
    '</tr></thead><tbody>';
  h += rows.map(function (r) {
    var s = seg[r.cod_cliente] || {};
    var mesesArr = Array.isArray(s.meses) ? s.meses : [];
    var maxMonto = 0;
    mesesArr.forEach(function (m) { if (Number(m.monto) > maxMonto) maxMonto = Number(m.monto); });
    var cellsHtml = mesesArr.map(function (m) {
      var mm = Number(m.monto) || 0;
      var pct = maxMonto > 0 ? mm / maxMonto : 0;
      var bg = "#f1f5f9", color = "#94a3b8", txt = "·";
      if (mm > 0) {
        var g = 220 - Math.round(pct * 130);
        bg = "rgb(" + g + "," + Math.min(255, g+30) + "," + g + ")";
        color = "#065f46"; txt = _gvfPlata(mm).replace("$","");
      }
      return '<td title="' + m.mes + ' · ' + _gvfPlata(mm) + ' · ' + m.pedidos + ' pedido(s)" style="padding:2px 3px;text-align:center;background:' + bg + ';color:' + color + ';font-weight:' + (mm > 0 ? 'bold' : 'normal') + ';font-size:10px;">' + txt + '</td>';
    }).join("");
    var freq = s.frecuencia_meses != null ? Number(s.frecuencia_meses).toFixed(1) : "—";
    var sin  = s.meses_sin_comprar != null && s.meses_sin_comprar < 999 ? s.meses_sin_comprar + "m" : "—";
    // Cajas histórico vs reciente: si cayeron a la mitad o más se pinta rojo.
    var cajasHist = s.cajas_hist_median != null ? Math.round(s.cajas_hist_median) : null;
    var cajasRec  = s.cajas_recientes_avg != null ? Math.round(s.cajas_recientes_avg) : null;
    var cajasTxt = "—";
    var cajasColor = "#64748b";
    if (cajasHist != null && cajasRec != null) {
      cajasTxt = cajasHist + " → " + cajasRec;
      if (s.alerta_volumen) cajasColor = "#b91c1c";
      else if (cajasRec >= cajasHist) cajasColor = "#059669";
    }
    // Badge de alerta compuesto: 🕑 frecuencia, 📉 volumen, ambos.
    var alertaBadges = [];
    if (s.alerta_frecuencia) alertaBadges.push('<span title="Se pasó de su ciclo habitual de compra" style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">🕑 sin comprar</span>');
    if (s.alerta_volumen)    alertaBadges.push('<span title="Cajas por pedido cayeron a menos de la mitad" style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">📉 menos cajas</span>');
    var alertaHtml = alertaBadges.length ? alertaBadges.join(' ') : '<span style="color:#059669;font-size:11px;">✓ OK</span>';
    var rowBg = (s.alerta_frecuencia || s.alerta_volumen) ? 'background:#fef2f2;' : '';
    return '<tr' + (rowBg ? ' style="' + rowBg + '"' : '') + '>' +
      '<td style="padding:6px 8px;text-align:center;font-weight:bold;color:#64748b;">' + r.ranking + '</td>' +
      '<td style="padding:6px 8px;"><b>' + _gvfEsc(r.cod_cliente) + '</b> <span style="color:#64748b;">' + _gvfEsc((r.business_name || "—").slice(0, 30)) + '</span>' + (r.vendedor_nombre ? '<br><span style="font-size:10px;color:#94a3b8;">' + _gvfEsc(r.vendedor_nombre) + '</span>' : '') + '</td>' +
      '<td style="padding:6px 8px;text-align:right;font-weight:bold;">' + _gvfPlata(_gvTop.tab === "max" ? r.max_pedido_monto : r.total_historico) + '</td>' +
      '<td style="padding:6px 8px;text-align:right;color:#64748b;">' + _gvfPlata(_gvTop.tab === "max" ? r.total_historico : r.max_pedido_monto) + '</td>' +
      '<td style="padding:6px 8px;text-align:center;font-size:11px;color:#64748b;">' + freq + 'm</td>' +
      '<td style="padding:6px 8px;text-align:center;font-weight:bold;color:' + (s.alerta_frecuencia ? '#b91c1c' : '#64748b') + ';">' + sin + '</td>' +
      '<td style="padding:6px 8px;text-align:center;font-weight:bold;color:' + cajasColor + ';font-size:11px;">' + cajasTxt + '</td>' +
      '<td style="padding:6px 8px;text-align:center;white-space:nowrap;">' + alertaHtml + '</td>' +
      cellsHtml +
    '</tr>';
  }).join("");
  h += '</tbody></table></div>';
  h += '<div style="margin-top:10px;font-size:11px;color:#94a3b8;">Meses de más reciente a más viejo. Celda verde = compró (intensidad = monto). <b>🕑 sin comprar</b>: pasó su ciclo habitual (compra cada N meses y ya lleva N meses sin comprar). <b>📉 menos cajas</b>: promedio de los últimos 3 pedidos cayó a menos de la mitad de las cajas del pedido típico histórico.</div>';
  cont.innerHTML = h;
}

async function gvTopExcel() {
  if (!_gvTop.rows.length) { alert("Cargá primero el ranking."); return; }
  var rows = _gvTop.rows;
  var seg  = _gvTop.seguimiento;
  var mesesHdr = [];
  if (rows.length) {
    var s0 = seg[rows[0].cod_cliente];
    if (s0 && Array.isArray(s0.meses)) mesesHdr = s0.meses.map(function (x) { return x.mes; });
  }
  var data = rows.map(function (r) {
    var s = seg[r.cod_cliente] || { meses: [] };
    var base = {
      Puesto: r.ranking,
      Codigo: r.cod_cliente,
      RazonSocial: r.business_name || "",
      Vendedor: r.vendedor_nombre || r.vendedor || "",
      HistoricoTotal: Number(r.total_historico) || 0,
      PedidoMaximo: Number(r.max_pedido_monto) || 0,
      FechaPedidoMax: r.max_pedido_fecha || "",
      UltimaCompra: r.ultima_compra || "",
      TotalPedidos: r.total_pedidos || 0,
      FrecuenciaMeses: s.frecuencia_meses != null ? Number(s.frecuencia_meses) : "",
      MesesSinComprar: s.meses_sin_comprar != null && s.meses_sin_comprar < 999 ? s.meses_sin_comprar : "",
      CajasHistMedian: s.cajas_hist_median != null ? Math.round(s.cajas_hist_median) : "",
      CajasRecientesAvg: s.cajas_recientes_avg != null ? Math.round(s.cajas_recientes_avg) : "",
      AlertaFrecuencia: s.alerta_frecuencia ? "SI" : "no",
      AlertaVolumen: s.alerta_volumen ? "SI" : "no",
      Alerta: s.alerta ? "SI" : "no",
    };
    (s.meses || []).forEach(function (m) { base["M " + m.mes] = Number(m.monto) || 0; });
    return base;
  });
  var ws = XLSX.utils.json_to_sheet(data);
  var wb = XLSX.utils.book_new();
  var sheetName = "Top50 " + _gvTop.emp.toUpperCase() + " " + (_gvTop.tab === "max" ? "MaxPed" : "Hist");
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  var fname = "top50_" + _gvTop.emp + "_" + _gvTop.tab + "_" + new Date().toISOString().slice(0, 10) + ".xlsx";
  XLSX.writeFile(wb, fname);
}
window.gvTopExcel = gvTopExcel;

// Hook: cuando se abre la card por primera vez, cargar
function _gvTopInit() {
  if (_gvTop.loadedFor) return;
  gvTopCargar();
}

// Sobreescribo toggleEstCard para disparar la carga al abrir la card del Top-50
// solo si es la primera vez. No re-carga en cada toggle.
(function () {
  var _origToggle = typeof window.toggleEstCard === "function" ? window.toggleEstCard : null;
  if (!_origToggle) return;
  window.toggleEstCard = function (id, headEl) {
    var r = _origToggle(id, headEl);
    if (id === "gvTopBody") {
      var body = document.getElementById("gvTopBody");
      if (body && body.style.display !== "none") _gvTopInit();
    }
    return r;
  };
})();
