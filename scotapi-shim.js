// scotapi-shim.js
// -----------------------------------------------------------------------------
// Shim liviano de window.scotApi para reusar el loader de Excel (admin-excel-krikos.js)
// FUERA del admin — puntualmente en mayorista.html, para el módulo del vendedor
// "Importar Excels Megashops".
//
// admin-excel-krikos.js depende de window.scotApi (que en el admin lo provee
// admin-supercot.js). Acá replicamos SOLO la superficie que el loader usa:
//   parseNum, loadAllProducts, loadAllLokeProducts, getProductsCache,
//   getLokeProductsCache, codVariants, findInPool, findProductByCodLK.
// El match de productos (cod LK + loke, con variantes de sufijo/padding) queda
// idéntico al del admin. Las funciones están copiadas textualmente de
// admin-supercot.js para no divergir.
//
// Guard: si ya existe window.scotApi (ej. se cargó admin-supercot.js), no lo pisa.
// -----------------------------------------------------------------------------
(function () {
  if (window.scotApi) return;

  // --- parseNum (copiado de admin-supercot.js) ---
  function parseNum(s) {
    if (s == null) return 0;
    var t = String(s).trim();
    if (!t) return 0;
    t = t.replace(/[^0-9.,\-]/g, "");
    if (!t) return 0;
    var hasDot = t.indexOf(".") !== -1;
    var hasComma = t.indexOf(",") !== -1;
    var lastDot = t.lastIndexOf(".");
    var lastComma = t.lastIndexOf(",");
    var n;
    if (hasDot && hasComma) {
      if (lastComma > lastDot) {
        n = parseFloat(t.replace(/\./g, "").replace(",", "."));
      } else {
        n = parseFloat(t.replace(/,/g, ""));
      }
    } else if (hasComma) {
      var parts = t.split(",");
      if (parts.length === 2 && parts[1].length === 3) {
        n = parseFloat(t.replace(",", "."));
      } else if (parts.length === 2 && parts[1].length <= 2) {
        n = parseFloat(t.replace(",", "."));
      } else {
        n = parseFloat(t.replace(/,/g, ""));
      }
    } else if (hasDot) {
      var pParts = t.split(".");
      if (pParts.length === 2 && pParts[1].length === 3) {
        if (pParts[1] === "000" || pParts[0].length >= 4) {
          n = parseFloat(t);
        } else {
          n = parseFloat(t.replace(/\./g, ""));
        }
      } else {
        n = parseFloat(t);
      }
    } else {
      n = parseFloat(t);
    }
    return isNaN(n) ? 0 : n;
  }

  // --- variantes de código (copiado de admin-supercot.js) ---
  var COMMON_SUFFIXES = ["", "E", "L", "A", "T", "D"];
  function codVariants(cod) {
    var c = String(cod || "").trim().toUpperCase();
    if (!c) return [];
    var seen = {};
    var out = [];
    function add(v) {
      if (!v) return;
      if (seen[v]) return;
      seen[v] = true;
      out.push(v);
    }
    add(c);
    var sufM = c.match(/^(.+?)([A-Z])$/);
    var base = sufM && COMMON_SUFFIXES.indexOf(sufM[2]) >= 0 ? sufM[1] : c;
    COMMON_SUFFIXES.forEach(function (s) { add(base + s); });
    if (/^\d+$/.test(base)) {
      var padded = base.length < 3 ? ("000" + base).slice(-3) : base;
      var unpadded = base.replace(/^0+/, "") || base;
      COMMON_SUFFIXES.forEach(function (s) {
        add(padded + s);
        add(unpadded + s);
      });
    }
    return out;
  }
  function findInPool(pool, variants) {
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var p = pool.find(function (x) {
        return String(x.cod || "").trim().toUpperCase() === v;
      });
      if (p) return p;
    }
    return null;
  }

  // --- catálogos LK + Loke (paginado, copiado de admin-supercot.js) ---
  var allProductsCache = null;
  var allLokeProductsCache = null;

  async function loadAllProducts() {
    if (allProductsCache) return allProductsCache;
    if (!window.sb) throw new Error("Cliente Supabase no inicializado");
    var PAGE = 1000, all = [], offset = 0;
    while (true) {
      var r = await window.sb
        .from("products")
        .select("id,cod,description,list_price,uxb,active")
        .range(offset, offset + PAGE - 1);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    allProductsCache = all;
    return all;
  }

  async function loadAllLokeProducts() {
    if (allLokeProductsCache) return allLokeProductsCache;
    if (!window.sb) throw new Error("Cliente Supabase no inicializado");
    var PAGE = 1000, all = [], offset = 0;
    while (true) {
      var r = await window.sb
        .from("loke_products")
        .select("id,cod,description,list_price,uxb,active")
        .range(offset, offset + PAGE - 1);
      if (r.error) {
        console.warn("loke_products: " + r.error.message);
        allLokeProductsCache = [];
        return [];
      }
      var batch = r.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    allLokeProductsCache = all;
    return all;
  }

  window.scotApi = {
    loadAllProducts: loadAllProducts,
    loadAllLokeProducts: loadAllLokeProducts,
    codVariants: codVariants,
    findInPool: findInPool,
    parseNum: parseNum,
    findProductByCodLK: function (cod) {
      var variants = codVariants(cod);
      if (!variants.length) return null;
      var p = findInPool(allProductsCache || [], variants);
      if (p) return { product: p, isLoke: false };
      var lp = findInPool(allLokeProductsCache || [], variants);
      if (lp) return { product: lp, isLoke: true };
      return null;
    },
    getProductsCache: function () { return allProductsCache || []; },
    getLokeProductsCache: function () { return allLokeProductsCache || []; },
  };
})();
