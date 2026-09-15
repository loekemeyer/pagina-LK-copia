// conversiones.js — medición para Google Ads en las páginas públicas
// (historia.html y catalogo/*.html).
//
// QUÉ HACE. Carga el Google Tag y manda una conversión cuando el visitante:
//   - toca un link de WhatsApp (a[href*="wa.me"])         → evento "contacto_whatsapp"
//   - descarga el catálogo PDF (a[href$=".pdf"])          → evento "descarga_catalogo"
//   - envía un formulario marcado con data-conversion            → evento "formulario_mayorista" (hoy ninguna página lo usa)
//   - toca un mailto: (a[href^="mailto:"])                → evento "contacto_email"
//
// CÓMO SE ACTIVA. Completar LK_ADS_ID con el ID de la cuenta de Google Ads
// (Herramientas → Conversiones → Google Tag; tiene la forma "AW-XXXXXXXXXX").
// Mientras esté vacío este archivo no carga nada ni manda nada: el sitio queda
// exactamente igual que sin él.
//
// LAS ETIQUETAS DE CONVERSIÓN. Cada acción de conversión creada en Google Ads
// tiene una etiqueta ("send_to": "AW-XXXXXXXXXX/abcDEfghIJ"). Se pegan en
// LK_CONVERSIONES. Si una acción no tiene etiqueta cargada, se manda igual
// como evento con nombre (sirve para GA4 y para armar la conversión después).
(function () {
  var LK_ADS_ID = ""; // ← pegar acá "AW-XXXXXXXXXX"
  var LK_CONVERSIONES = {
    contacto_whatsapp: "",   // ← "AW-XXXXXXXXXX/etiqueta"
    descarga_catalogo: "",
    formulario_mayorista: "",
    contacto_email: "",
  };

  if (!LK_ADS_ID) return;

  // Carga del Google Tag (gtag.js), igual que el snippet oficial.
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(LK_ADS_ID);
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag("js", new Date());
  gtag("config", LK_ADS_ID);

  function conversion(nombre, extra) {
    var params = extra || {};
    var etiqueta = LK_CONVERSIONES[nombre];
    if (etiqueta) {
      gtag("event", "conversion", Object.assign({ send_to: etiqueta }, params));
    }
    gtag("event", nombre, params);
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
    if (!a || !a.href) return;
    var href = a.href;
    if (href.indexOf("wa.me") !== -1 || href.indexOf("api.whatsapp.com") !== -1) {
      conversion("contacto_whatsapp", { pagina: location.pathname, cod: a.getAttribute("data-cod") || "" });
    } else if (/\.pdf(\?|$)/i.test(href)) {
      conversion("descarga_catalogo", { pagina: location.pathname });
    } else if (href.indexOf("mailto:") === 0) {
      conversion("contacto_email", { pagina: location.pathname });
    }
  }, true);

  document.addEventListener("submit", function (ev) {
    var f = ev.target;
    if (f && f.hasAttribute && f.hasAttribute("data-conversion")) {
      conversion("formulario_mayorista", { pagina: location.pathname });
    }
  }, true);
})();
