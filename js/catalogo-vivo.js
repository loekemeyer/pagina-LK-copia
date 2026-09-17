// catalogo-vivo.js — mantiene productos/ al día sin esperar a que nadie
// regenere nada.
//
// POR QUÉ NO ES COMO mayorista.html
// ---------------------------------
// mayorista.html pinta TODO con JavaScript: es una app para clientes que ya
// entraron. productos/ es distinto: existe para que Google la lea, y si el
// HTML llega vacío Google tiene que renderizarlo en una segunda pasada que
// puede tardar días o no pasar nunca.
//
// Por eso acá el HTML viene completo desde el generador —Google lo lee tal
// cual, sin ejecutar nada— y este script SÓLO corrige lo que haya cambiado
// desde la última generación. Si un artículo se dio de alta o se puso en
// active=false hace cinco minutos, el visitante lo ve; el buscador ve el
// HTML, que se actualiza solo con el workflow.
//
// Si Supabase no contesta, no pasa nada: queda el HTML generado, que es
// contenido válido. Nunca se borra nada de la pantalla por un error de red.
(function () {
  "use strict";

  var URL_SB = "https://kwkclwhmoygunqmlegrg.supabase.co";
  var CLAVE = "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML";
  var BUCKET = URL_SB + "/storage/v1/object/public/products-images/";
  // Se lee una VISTA, no la tabla: products tiene list_price cargado en las 199
  // filas y darle lectura a `anon` publicaría la lista de precios mayorista
  // entera. v_catalogo_publico expone sólo lo que esta página ya muestra.
  var TABLA = "v_catalogo_publico";
  var CAMPOS = "cod,description,category,subcategory,uxb,images,badge_status,orden_catalogo";

  var raiz = document.querySelector("[data-catalogo]");
  if (!raiz) return;
  var modo = raiz.getAttribute("data-catalogo");        // "indice" | "linea"
  var categoriaDeLaPagina = raiz.getAttribute("data-categoria") || "";
  var firmaEnHtml = raiz.getAttribute("data-firma") || "";
  var vFoto = raiz.getAttribute("data-vfoto") || "";
  var prefijo = modo === "indice" ? "" : "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Mismo criterio que img_url() del generador y que productImgUrls() de
  // script.js: si products.images tiene algo, manda eso; si no, se deriva del
  // código.
  function foto(p) {
    var ims = p.images || [];
    if (ims.length) {
      var n = String(ims[0]).trim();
      if (n.indexOf("http") === 0) return n;
      if (!/\.webp$/i.test(n)) n += ".webp";
      return BUCKET + encodeURIComponent(n) + vFoto;
    }
    return BUCKET + encodeURIComponent(p.cod) + ".webp" + vFoto;
  }

  function waUrl(texto) {
    return "https://wa.me/5491131181021?text=" + encodeURIComponent(texto);
  }

  // El mismo tramo derivado que arma bajada() en el generador.
  function tramoDatos(ps) {
    var n = ps.length;
    var cajas = [];
    ps.forEach(function (p) {
      if (p.uxb && cajas.indexOf(p.uxb) === -1) cajas.push(p.uxb);
    });
    cajas.sort(function (a, b) { return a - b; });
    var art = n === 1 ? "1 artículo" : n + " artículos";
    if (!cajas.length) return art + ".";
    if (cajas.length === 1) return art + ". Caja cerrada de " + cajas[0] + " unidades.";
    return art + ". Caja cerrada de " + cajas.slice(0, -1).join(", ") +
           " o " + cajas[cajas.length - 1] + " unidades.";
  }

  function firma(filas) {
    return filas.map(function (p) { return p.cod; }).join("|");
  }

  function traer() {
    var url = URL_SB + "/rest/v1/" + TABLA + "?select=" + CAMPOS +
              "&order=orden_catalogo.asc.nullslast&order=cod.asc";
    // El REST pide `apikey` además del Bearer: con la clave nueva, sin ese
    // header contesta 403 "Invalid Compact JWS".
    return fetch(url, { headers: { apikey: CLAVE, Authorization: "Bearer " + CLAVE } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  // ---------- página de una línea ----------
  function pintarLinea(filas) {
    var ps = filas.filter(function (p) { return (p.category || "").trim() === categoriaDeLaPagina; });
    if (!ps.length) return;                       // la línea entera se dio de baja: no tocamos nada
    if (firma(ps) === firmaEnHtml) return;        // sin novedades

    var grillas = document.querySelectorAll(".prod-grid");
    if (grillas.length === 1) {
      grillas[0].innerHTML = ps.map(ficha).join("");
    } else {
      // Página con subsecciones (Utensilios): cada una filtra por subcategoría.
      document.querySelectorAll(".prod-subsection").forEach(function (sec) {
        var sub = sec.getAttribute("data-sub");
        var g = sec.querySelector(".prod-grid");
        if (!g) return;
        var lista = ps.filter(function (p) {
          return sub ? (p.subcategory || "") === sub : !p.subcategory;
        });
        g.innerHTML = lista.map(ficha).join("");
        var cuenta = sec.querySelector(".prod-count");
        if (cuenta) cuenta.textContent = lista.length;
      });
    }
    actualizarBajada(ps);
  }

  function ficha(p) {
    var nuevo = p.badge_status === "NUEVO" ? '<span class="prod-nuevo">NUEVO</span>' : "";
    var uxb = p.uxb ? p.uxb + " unidades por caja" : "consultar unidades por caja";
    var sub = p.subcategory ? '<p class="prod-meta">' + esc(p.subcategory) + "</p>" : "";
    var texto = "Hola Loekemeyer, quiero consultar por el artículo " + p.cod + " " + p.description + ".";
    return '<article class="prod-card" id="p-' + esc(p.cod) + '">' +
             '<div class="prod-thumb"><img src="' + esc(foto(p)) + '" alt="' + esc(p.description) +
               ' Loekemeyer, código ' + esc(p.cod) + '" width="400" height="400" loading="lazy" ' +
               "onerror=\"this.onerror=null;this.src='../img/no-image.jpg'\" /></div>" +
             '<div class="prod-body">' +
               '<p class="prod-cod">' + esc(p.cod) + nuevo + "</p>" +
               '<h3 class="prod-name">' + esc(p.description) + "</h3>" +
               '<p class="prod-meta">' + esc(uxb) + "</p>" + sub +
               '<a class="prod-cta" href="' + esc(waUrl(texto)) + '" target="_blank" rel="noopener" data-cod="' +
                 esc(p.cod) + '">Consultar disponibilidad</a>' +
             "</div></article>";
  }

  function actualizarBajada(ps) {
    var el = document.querySelector(".prod-intro");
    if (!el) return;
    var intro = el.getAttribute("data-intro") || "";
    var cierre = el.getAttribute("data-cierre") || "";
    el.textContent = [intro, tramoDatos(ps), cierre].filter(Boolean).join(" ");
  }

  // ---------- índice de líneas ----------
  function pintarIndice(filas) {
    if (firma(filas) === firmaEnHtml) return;

    var porCat = {};
    filas.forEach(function (p) {
      var c = (p.category || "").trim();
      (porCat[c] = porCat[c] || []).push(p);
    });

    document.querySelectorAll(".cat-card").forEach(function (a) {
      var cat = a.getAttribute("data-categoria");
      var ps = porCat[cat];
      var cuenta = a.querySelector(".cat-count");
      var caja = a.querySelector(".cat-mosaico");
      if (!ps || !ps.length) { a.hidden = true; return; }   // línea sin artículos activos
      a.hidden = false;
      if (cuenta) cuenta.textContent = ps.length + (ps.length === 1 ? " artículo" : " artículos");
      if (!caja) return;
      var muestra = ps.slice(0, 4);
      var resto = ps.length > 4 ? ps.length - 3 : 0;
      caja.className = "cat-mosaico cat-mosaico--" + Math.min(ps.length, 4);
      caja.innerHTML = muestra.map(function (p, i) {
        var mas = resto && i === 3 ? '<span class="cat-mas">+' + resto + "</span>" : "";
        return '<span class="cat-celda"><img src="' + esc(foto(p)) + '" alt="" width="400" height="400" ' +
               "loading=\"lazy\" onerror=\"this.onerror=null;this.src='../img/no-image.jpg'\" />" + mas + "</span>";
      }).join("");
    });

    var el = document.querySelector(".prod-intro");
    if (el) {
      var lineas = Object.keys(porCat).filter(function (c) { return porCat[c].length; }).length;
      el.textContent = (el.getAttribute("data-intro") || "")
        .replace(/^\d+ artículos en \d+ líneas\./, filas.length + " artículos en " + lineas + " líneas.");
    }
  }

  traer()
    .then(function (filas) {
      if (!Array.isArray(filas) || !filas.length) return;   // respuesta rara: dejamos el HTML
      if (modo === "indice") pintarIndice(filas); else pintarLinea(filas);
    })
    .catch(function () { /* sin red o Supabase caído: queda el HTML generado */ });
})();
