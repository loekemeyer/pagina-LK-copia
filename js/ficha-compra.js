/* js/ficha-compra.js — «Agregar al pedido» + precio en la ficha pública del
   artículo (productos/articulo/<cod>.html). Thomas, 05/10/2026.

   La ficha es una página estática e indexable: lo que ve Google o un asistente
   no cambia. Sólo si el navegador YA tiene una sesión iniciada en el sitio (la
   misma de mayorista.html, mismo dominio y misma clave de almacenamiento) se
   reemplaza el link de WhatsApp por el botón negro y el precio del cliente.
   Sin sesión no se muestra precio ni botón de compra.

   El botón NO arma el carrito acá: lleva a mayorista.html#agregar=<cod>, que
   agrega la caja con addFirstBox y todos sus guards (sin stock, vendedor sin
   cliente elegido, login). Así hay una sola lógica de carrito.

   El precio replica la card del catálogo para el caso común:
     cliente → Tu Precio Contado = lista × (1 − dto_vol) × (1 − dto web) × 0,75
     admin, cod 5000 y vendedores (100XX y cod 1) → Precio Lista
     modo presupuesto → sin precio (el cliente cotiza, no ve precios)
   Cualquier error en el camino deja la página como estaba (link de WhatsApp). */
(function () {
  "use strict";
  var URL_SB = "https://kwkclwhmoygunqmlegrg.supabase.co";
  var KEY_SB = "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML";

  var caja = document.getElementById("artCompra");
  if (!caja || !window.supabase || !window.supabase.createClient) return;
  var cod = String(caja.getAttribute("data-cod") || "").trim();
  if (!cod) return;

  function plata(n) {
    return Math.round(Number(n || 0)).toLocaleString("es-AR");
  }

  var sb;
  try {
    sb = window.supabase.createClient(URL_SB, KEY_SB);
  } catch (e) {
    return;
  }

  sb.auth
    .getSession()
    .then(function (r) {
      var ses = r && r.data && r.data.session;
      if (!ses || !ses.user) return null;
      var uid = ses.user.id;
      return Promise.all([
        sb.from("products").select("id,cod,list_price,badge_status,active").eq("cod", cod).maybeSingle(),
        // select("*"): una columna nueva que la base todavía no tenga no tira la consulta (ver CLAUDE.md).
        sb.from("customers").select("*").eq("auth_user_id", uid).limit(1),
        sb.from("admins").select("auth_user_id").eq("auth_user_id", uid).maybeSingle(),
        sb.from("app_settings").select("value").eq("key", "web_order_discount").maybeSingle(),
      ]);
    })
    .then(function (res) {
      if (!res) return;
      var prod = res[0] && res[0].data;
      if (!prod || prod.active === false) return;
      var cli = res[1] && Array.isArray(res[1].data) ? res[1].data[0] : null;
      var esAdmin = !!(res[2] && res[2].data);
      var web = parseFloat(res[3] && res[3].data && res[3].data.value);
      if (!(web >= 0 && web < 1)) web = 0.02;

      var codCli = String((cli && cli.cod_cliente) || "");
      var vendedor = /^100\d{2}$/.test(codCli) || codCli === "1";
      var presupuesto = !!(cli && cli.modo_presupuesto);
      var lista = Number(prod.list_price || 0);

      var precio = "";
      if (!presupuesto && lista > 0) {
        if (esAdmin || codCli === "5000" || vendedor) {
          precio = "Precio Lista: <strong>$" + plata(lista) + "</strong> + IVA";
        } else if (cli) {
          var dto = Number(cli.dto_vol || 0);
          var contado = lista * (1 - dto) * (1 - web) * (1 - 0.25);
          precio = "Tu Precio Contado: <strong>$" + plata(contado) + "</strong> + IVA";
        }
      }

      var badge = String(prod.badge_status || "").trim().toUpperCase();
      var boton;
      if (badge === "SIN STOCK") {
        boton = '<span class="art-agregar art-agregar--off" aria-disabled="true">Sin stock</span>';
      } else if (badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE") {
        boton = '<span class="art-agregar art-agregar--off" aria-disabled="true">Próximamente</span>';
      } else {
        boton =
          '<a class="art-agregar" href="../../mayorista.html#agregar=' +
          encodeURIComponent(cod) +
          '">Agregar al pedido</a>';
      }
      caja.innerHTML = boton + (precio ? '<span class="art-precio">' + precio + "</span>" : "");
      caja.classList.add("art-compra--sesion");
      caja.setAttribute("data-estado", "sesion");
    })
    .catch(function () {
      /* sin sesión o sin red: queda el link de WhatsApp */
    });
})();
