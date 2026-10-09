// ean-descarga.js — botón «EAN» para bajar el código de barras de cada producto como imagen.
//
// SOLO EN VERCEL (pedido 09/10/2026): el botón aparece únicamente si la página corre en
// *.vercel.app (la copia de prueba). En loekemeyer.com no se dibuja nada, aunque el
// archivo se suba al IIS.
//
// Fuente: tabla `item_ean` del proyecto LK (cod, ean). Los EAN se generan solos al dar de
// alta un artículo (7795587 + código a 5 dígitos + verificador; trigger products_fill_ean).
// El dibujo es propio (EAN-13 sobre canvas): no depende de ninguna librería de barras.
//
// ⚠ Un EAN con el dígito verificador mal NO se dibuja: una lectora lo rechazaría. Se avisa
//   y en el ZIP va listado en AVISOS.txt. Lo mismo dice si dos códigos comparten EAN.
(function () {
  "use strict";

  function enVercel() {
    if (window.GV_EAN_FORZAR === true) return true; // tests
    return /\.vercel\.app$/i.test(location.hostname);
  }

  // ---------------- EAN-13 ----------------
  var L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  var G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
  var R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
  var PARIDAD = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

  function eanDv(d12) {
    var s = 0;
    for (var i = 0; i < 12; i++) s += +d12[i] * (i % 2 ? 3 : 1);
    return (10 - (s % 10)) % 10;
  }
  function eanValido(ean) {
    return /^\d{13}$/.test(ean) && eanDv(ean.slice(0, 12)) === +ean[12];
  }
  // Devuelve la tira de 95 módulos (1 = barra).
  function eanModulos(ean) {
    var p = PARIDAD[+ean[0]], m = "101";
    for (var i = 1; i <= 6; i++) m += (p[i - 1] === "L" ? L : G)[+ean[i]];
    m += "01010";
    for (var j = 7; j <= 12; j++) m += R[+ean[j]];
    return m + "101";
  }

  // Dibuja la etiqueta: código y descripción arriba, barras, dígitos abajo.
  function eanCanvas(it) {
    var mod = 4, quiet = 11 * mod, barH = 70 * mod / 2, guardaExtra = 5 * mod;
    var anchoBarras = 95 * mod;
    var W = anchoBarras + quiet * 2;
    var topTxt = 58, digH = 30, H = topTxt + barH + guardaExtra + digH + 10;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#000"; x.textAlign = "center"; x.textBaseline = "top";
    x.font = "bold 22px Arial, sans-serif";
    x.fillText("COD " + it.cod, W / 2, 6);
    x.font = "15px Arial, sans-serif";
    var desc = String(it.desc || "");
    while (desc && x.measureText(desc).width > W - 16) desc = desc.slice(0, -1);
    if (desc !== String(it.desc || "")) desc = desc.slice(0, -1) + "…";
    x.fillText(desc, W / 2, 33);
    var m = eanModulos(it.ean), y0 = topTxt;
    for (var i = 0; i < 95; i++) {
      if (m[i] !== "1") continue;
      var guarda = i < 3 || (i >= 45 && i < 50) || i >= 92;
      x.fillRect(quiet + i * mod, y0, mod, barH + (guarda ? guardaExtra : 0));
    }
    x.font = "bold 26px Arial, sans-serif";
    var yd = y0 + barH + 4;
    x.textAlign = "right"; x.fillText(it.ean[0], quiet - 4, yd);
    x.textAlign = "center";
    for (var k = 1; k <= 6; k++) x.fillText(it.ean[k], quiet + (3 + (k - 1) * 7 + 3.5) * mod, yd);
    for (var q = 7; q <= 12; q++) x.fillText(it.ean[q], quiet + (50 + (q - 7) * 7 + 3.5) * mod, yd);
    return c;
  }
  function canvasBlob(c) {
    return new Promise(function (ok) { c.toBlob(ok, "image/png"); });
  }
  function nombreArchivo(it) {
    return ("EAN_" + it.cod + "_" + it.ean).replace(/[^\w.-]+/g, "_") + ".png";
  }
  function bajar(blob, nombre) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  // ---------------- datos ----------------
  var _cache = null;
  function cliente() {
    try { if (typeof supabaseClient !== "undefined") return supabaseClient; } catch (e) {}
    return null;
  }
  async function cargar() {
    if (_cache) return _cache;
    var sb = cliente();
    if (!sb) throw new Error("sin conexión a la base");
    var r = await sb.from("item_ean").select("cod,ean").order("cod").limit(5000);
    if (r.error) throw new Error(r.error.message);
    if (!r.data || !r.data.length) throw new Error("la tabla de EAN vino vacía");
    var desc = {};
    var res = await Promise.all([
      sb.from("products").select("cod,description").limit(5000),
      sb.from("loke_products").select("cod,description").limit(5000),
    ]);
    res.forEach(function (x) {
      (x.data || []).forEach(function (p) {
        var k = String(p.cod || "").trim().toUpperCase();
        if (k && !desc[k]) desc[k] = p.description || "";
      });
    });
    var porEan = {};
    r.data.forEach(function (f) { (porEan[f.ean] = porEan[f.ean] || []).push(f.cod); });
    _cache = r.data.map(function (f) {
      var cod = String(f.cod || "").trim(), ean = String(f.ean || "").trim();
      return {
        cod: cod, ean: ean,
        desc: desc[cod.toUpperCase()] || "",
        valido: eanValido(ean),
        comparte: porEan[f.ean].filter(function (c) { return c !== f.cod; }),
      };
    });
    return _cache;
  }

  // ---------------- UI ----------------
  function css() {
    if (document.getElementById("eanDescCss")) return;
    var s = document.createElement("style");
    s.id = "eanDescCss";
    s.textContent =
      ".ean-btn{position:fixed;left:12px;bottom:12px;z-index:9000;background:#111;color:#fff;border:0;border-radius:18px;padding:8px 14px;font:bold 14px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}" +
      ".ean-ov{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}" +
      ".ean-box{background:#fff;color:#111;border-radius:10px;max-width:520px;width:100%;max-height:86vh;display:flex;flex-direction:column;font:14px Arial,sans-serif}" +
      ".ean-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ddd}" +
      ".ean-hd b{flex:1;text-align:center;font-size:16px}" +
      ".ean-x{background:none;border:0;font-size:20px;cursor:pointer;width:auto;padding:0 4px;margin:0}" +
      ".ean-bar{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap}" +
      ".ean-bar input{flex:1;min-width:120px;padding:6px 8px;border:1px solid #bbb;border-radius:6px;font-size:14px}" +
      ".ean-bar button,.ean-row button{background:#111;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:13px;width:auto;margin:0}" +
      ".ean-msg{padding:0 12px 6px;text-align:center;font-size:13px;color:#555}" +
      ".ean-list{overflow:auto;padding:0 12px 12px}" +
      ".ean-row{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:5px 0;border-top:1px solid #eee}" +
      ".ean-row .c{font-weight:bold;text-align:center;min-width:52px}" +
      ".ean-row .d{font-size:12px;line-height:1.25}" +
      ".ean-row .d i{color:#b00;font-style:normal}";
    document.head.appendChild(s);
  }

  var _items = [], _q = "";
  function filtrar() {
    var q = _q.trim().toLowerCase();
    if (!q) return _items;
    return _items.filter(function (it) {
      return (it.cod + " " + it.ean + " " + it.desc).toLowerCase().indexOf(q) >= 0;
    });
  }
  function filaHtml(it, i) {
    var aviso = !it.valido ? '<br><i>Dígito verificador mal: no se dibuja</i>'
      : it.comparte.length ? '<br><i>Mismo EAN que ' + it.comparte.join(", ") + "</i>" : "";
    return '<div class="ean-row"><span class="c">' + esc(it.cod) + '</span><span class="d">' +
      esc(it.desc || "—") + "<br>" + esc(it.ean) + aviso + "</span>" +
      (it.valido ? '<button data-i="' + i + '">PNG</button>' : "<span>—</span>") + "</div>";
  }
  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function pintar(ov, msg) {
    var lista = filtrar();
    ov.querySelector(".ean-msg").textContent = msg != null ? msg :
      lista.length + " de " + _items.length + " códigos";
    ov.querySelector(".ean-list").innerHTML = lista.map(function (it) {
      return filaHtml(it, _items.indexOf(it));
    }).join("");
  }

  async function bajarZip(ov, lista) {
    if (typeof JSZip === "undefined") { alert("No se pudo cargar el compresor ZIP."); return; }
    var zip = new JSZip(), avisos = [], n = 0;
    for (var i = 0; i < lista.length; i++) {
      var it = lista[i];
      if (!it.valido) { avisos.push(it.cod + " · " + it.ean + " · dígito verificador mal: no se dibujó"); continue; }
      if (it.comparte.length) avisos.push(it.cod + " · " + it.ean + " · mismo EAN que " + it.comparte.join(", "));
      zip.file(nombreArchivo(it), await canvasBlob(eanCanvas(it)));
      n++;
      if (n % 25 === 0) pintar(ov, "Armando imágenes… " + n + " de " + lista.length);
    }
    if (avisos.length) zip.file("AVISOS.txt", avisos.join("\r\n") + "\r\n");
    var blob = await zip.generateAsync({ type: "blob" });
    bajar(blob, "EAN_productos_" + new Date().toISOString().slice(0, 10) + ".zip");
    pintar(ov, n + " imágenes bajadas" + (avisos.length ? " · " + avisos.length + " avisos en AVISOS.txt" : ""));
  }

  async function abrir() {
    css();
    var ov = document.createElement("div");
    ov.className = "ean-ov";
    ov.innerHTML =
      '<div class="ean-box"><div class="ean-hd"><span style="width:24px"></span><b>Códigos EAN</b>' +
      '<button class="ean-x" title="Cerrar">✕</button></div>' +
      '<div class="ean-bar"><input type="search" placeholder="Buscar código, EAN o descripción">' +
      '<button class="ean-zip">⬇ Todos (ZIP)</button></div>' +
      '<div class="ean-msg">Cargando…</div><div class="ean-list"></div></div>';
    document.body.appendChild(ov);
    function cerrar() { ov.remove(); document.removeEventListener("keydown", tecla); }
    function tecla(e) { if (e.key === "Escape") cerrar(); }
    document.addEventListener("keydown", tecla);
    ov.addEventListener("click", function (e) { if (e.target === ov) cerrar(); });
    ov.querySelector(".ean-x").onclick = cerrar;
    var inp = ov.querySelector("input");
    inp.oninput = function () { _q = inp.value; pintar(ov); };
    ov.querySelector(".ean-list").addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-i]");
      if (!b) return;
      var it = _items[+b.getAttribute("data-i")];
      bajar(await canvasBlob(eanCanvas(it)), nombreArchivo(it));
    });
    var bz = ov.querySelector(".ean-zip");
    bz.onclick = async function () {
      if (!_items.length) return;
      bz.disabled = true;
      try { await bajarZip(ov, filtrar()); }
      catch (err) { pintar(ov, "No se pudo armar el ZIP: " + err.message); }
      finally { bz.disabled = false; }
    };
    try {
      _items = await cargar();
      pintar(ov);
    } catch (err) {
      // "No pude leer" no es "no hay": se dice.
      ov.querySelector(".ean-msg").textContent = "No se pudieron leer los EAN: " + err.message;
    }
  }

  function init() {
    if (!enVercel() || document.getElementById("eanDescBtn")) return;
    css();
    var b = document.createElement("button");
    b.type = "button"; b.id = "eanDescBtn"; b.className = "ean-btn";
    b.textContent = "EAN";
    b.title = "Descargar los códigos EAN de cada producto como imagen";
    b.onclick = abrir;
    document.body.appendChild(b);
  }

  window.eanDescarga = { abrir: abrir, eanValido: eanValido, eanModulos: eanModulos, init: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
