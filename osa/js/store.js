/* ============================================================
   Pedido Automático · Capa de datos y lógica de negocio
   Fuente de verdad: Supabase (sin localStorage). El estado se hidrata desde
   las tablas osa_* al iniciar (Store.init) y cada cambio se escribe directo.
   El stock se calcula (inicial + entregas − ventas ± ajustes).
   ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://kwkclwhmoygunqmlegrg.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU';
  // Config por cliente (la setea cada página en window.__formatoCfg ANTES de cargar
  // este script). Default = OSA, para no cambiar nada de lo ya existente.
  var CFG = window.__formatoCfg || {};
  var PREFIX = CFG.prefix || 'osa';                 // prefijo de tablas: osa_* / tyl_* / …
  var COD_CLIENTE = CFG.codCliente || 2533;         // cod_cliente del cliente
  var SEED_INICIAL = CFG.seedInicial !== false;     // true: stock+ranking del seed; false: 0 (TyL)
  // Tablas unificadas multi-tenant: una sola por tipo, filtradas/selladas por cod_cliente.
  var T = {
    art: 'pa_articulos', ven: 'pa_ventas', ent: 'pa_entregas',
    aju: 'pa_ajustes', cfg: 'pa_config'
  };
  // Cliente supabase-js: misma URL/anon key/storage que el sitio → reusa la sesión
  // del cliente logueado en la página principal (misma origin).
  var sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  window.__osaSb = sb; // compartido con app.js (un solo cliente / una sola sesión)
  // Handler opcional de la UI para avisar si falla una escritura a Supabase.
  var onSaveError = null;
  function fail(e) {
    console.error('OSA · Supabase:', (e && e.message) || e);
    if (typeof onSaveError === 'function') { try { onSaveError(e); } catch (_) {} }
  }
  // Escritura best-effort: si la promesa resuelve con error, lo reporta a la UI.
  function fire(promise) {
    if (promise && typeof promise.then === 'function') {
      promise.then(function (r) { if (r && r.error) fail(r.error); }, fail);
    }
    return promise;
  }

  /* ---------- Estado base (en memoria; espejo de Supabase) ---------- */
  function blank() {
    return {
      meta: {
        empresa: CFG.empresa || 'Loekemeyer',
        cliente: CFG.cliente || 'Osa Distribuidora SRL',
        moneda: 'ARS',
        periodoMeses: 17,       // meses que abarca el total de ventas conocidas (base del promedio mensual)
        mesesPedidoDefault: 2,  // meses de cobertura deseados por defecto
        unidadVista: 'cajas',   // unidad para MOSTRAR cantidades: 'cajas' | 'unidades' (solo display)
        sucursalLK: 'Zuviria 5352- Villa Lugano', // sucursal de entrega default del pedido
        recordatorioPedido: true,   // ofrecer enviar el pedido al cumplirse el plazo programado
        pedidoIntervaloDias: 15,    // días exactos entre pedidos, contados desde el último pedido
        emailRecordatorio: ''       // mail al que se avisa 2 días antes del pedido (vacío = sin mail)
      },
      articulos: [],  // {id,codigo,nombre,descripcion,foto,precio,stockInicial,totalHistorico,uxc,stockMaximo,promedioManual,mesesPedido,activo}
      movimientos: [], // {id,dbId,tipo,articuloId,cantidad,fecha,nota,quincena}
      feriados: {},            // set ISO->true de feriados AR (para calcular "día hábil")
      enCamino: {},            // cod(MAYÚS) -> unidades ya pedidas y sin entregar (en camino)
      ultimoPedidoFecha: null, // ISO del último pedido del cliente (cualquier canal)
      authUid: null            // auth.uid() de la sesión, para consultar orders
    };
  }
  var state = blank();

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function num(v, def) {
    var n = parseFloat(v);
    if (isNaN(n)) return def === undefined ? 0 : def;
    return n;
  }
  // Override opcional: '' / null / no-numérico => null (usar el valor automático/global).
  function optNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    if (isNaN(n)) return null;
    return Math.max(0, n);
  }

  /* ---------- Mapeos fila Supabase <-> objeto en memoria ---------- */
  function rowToArt(r) {
    return {
      id: r.id, codigo: r.codigo || '', nombre: r.nombre || 'Sin nombre',
      descripcion: r.descripcion || '', foto: r.foto || '', precio: num(r.precio, 0),
      stockInicial: Math.max(0, Math.round(num(r.stock_inicial, 0))),
      totalHistorico: Math.max(0, Math.round(num(r.total_historico, 0))),
      uxc: Math.max(1, Math.round(num(r.uxc, 1))),
      stockMaximo: r.stock_maximo == null ? null : Math.round(num(r.stock_maximo, 0)),
      promedioManual: r.promedio_manual == null ? null : num(r.promedio_manual, 0),
      mesesPedido: r.meses_pedido == null ? null : num(r.meses_pedido, 0),
      activo: r.activo !== false
    };
  }
  function artToRow(a) {
    return {
      id: a.id, cod_cliente: COD_CLIENTE, codigo: a.codigo || '', nombre: a.nombre || 'Sin nombre',
      descripcion: a.descripcion || '', precio: num(a.precio, 0),
      stock_inicial: Math.max(0, Math.round(num(a.stockInicial, 0))),
      total_historico: Math.max(0, Math.round(num(a.totalHistorico, 0))),
      uxc: Math.max(1, Math.round(num(a.uxc, 1))),
      stock_maximo: a.stockMaximo == null ? null : Math.round(a.stockMaximo),
      promedio_manual: a.promedioManual == null ? null : a.promedioManual,
      meses_pedido: a.mesesPedido == null ? null : a.mesesPedido,
      activo: a.activo !== false, foto: a.foto || null,
      updated_at: new Date().toISOString()
    };
  }
  function tablaDe(tipo) { return tipo === 'venta' ? T.ven : (tipo === 'entrega' ? T.ent : T.aju); }
  function movKey(tipo, dbId) { return (tipo === 'venta' ? 'V' : tipo === 'entrega' ? 'E' : 'A') + dbId; }
  function ventaRowToMov(r) { return { id: movKey('venta', r.id), dbId: r.id, tipo: 'venta', articuloId: r.articulo_id, cantidad: Math.round(num(r.unidades, 0)), fecha: r.fecha, nota: r.nota || '', quincena: r.quincena || null, cargadaEl: r.created_at ? String(r.created_at).slice(0, 10) : null }; }
  function entregaRowToMov(r) { return { id: movKey('entrega', r.id), dbId: r.id, tipo: 'entrega', articuloId: r.articulo_id, cantidad: Math.round(num(r.unidades, 0)), fecha: r.fecha, nota: r.nota || '' }; }
  function ajusteRowToMov(r) { return { id: movKey('ajuste', r.id), dbId: r.id, tipo: 'ajuste', articuloId: r.articulo_id, cantidad: Math.round(num(r.cantidad, 0)), fecha: r.fecha, nota: r.nota || '' }; }
  // Fila a insertar para un movimiento en memoria.
  function movToRow(mov) {
    var a = getArticulo(mov.articuloId);
    var base = {
      cod_cliente: COD_CLIENTE, articulo_id: mov.articuloId,
      codigo: (a && a.codigo) || null, nombre: (a && a.nombre) || null,
      fecha: mov.fecha || hoyISO(), nota: (mov.nota || '').trim()
    };
    if (mov.tipo === 'ajuste') {
      base.cantidad = Math.round(num(mov.cantidad, 0));
    } else {
      var u = Math.round(num(mov.cantidad, 0));
      base.unidades = u;
      base.cajas = a ? Math.round(u / uxcDe(a)) : u;
      base.source = PREFIX + '-app';
      if (mov.tipo === 'venta') base.quincena = mov.quincena || null;
      else base.formato = mov._formato || null;
    }
    return base;
  }

  /* ---------- Meta ---------- */
  function getMeta() { return Object.assign({}, state.meta); }
  function metaToRow() {
    var m = state.meta;
    var n = Math.round(num(m.pedidoIntervaloDias, 15));
    return {
      cod_cliente: COD_CLIENTE, empresa: m.empresa, cliente: m.cliente, moneda: m.moneda,
      periodo_meses: m.periodoMeses, meses_pedido_default: m.mesesPedidoDefault,
      unidad_vista: m.unidadVista, sucursal_lk: m.sucursalLK,
      recordatorio_pedido: m.recordatorioPedido !== false,
      pedido_intervalo_dias: (n >= 1 && n <= 90) ? n : 15,
      email_recordatorio: (m.emailRecordatorio || '').trim() || null,
      updated_at: new Date().toISOString()
    };
  }
  // Upsert de config con fallback: si las columnas nuevas todavía no existen en
  // pa_config (falta correr programar_pedido_automatico.sql /
  // recordatorio_mail_ventas.sql), reintenta sin ellas para no perder el resto
  // de la configuración.
  function upsertConfig() {
    var row = metaToRow();
    return sb.from(T.cfg).upsert(row, { onConflict: 'cod_cliente' }).then(function (r) {
      if (r && r.error && /pedido_intervalo_dias|email_recordatorio/i.test(r.error.message || '')) {
        delete row.pedido_intervalo_dias;
        delete row.email_recordatorio;
        return sb.from(T.cfg).upsert(row, { onConflict: 'cod_cliente' });
      }
      return r;
    });
  }
  function setMeta(patch) {
    state.meta = Object.assign(state.meta, patch);
    if (sb) fire(upsertConfig());
  }

  /* ---------- Unidades de visualización (cajas / unidades) ---------- */
  // El stock se guarda siempre en UNIDADES (canónico: el stock inicial, las
  // entregas y las ventas vienen en unidades). Esto solo cambia cómo se MUESTRA.
  function getUnidadVista() { return state.meta.unidadVista === 'unidades' ? 'unidades' : 'cajas'; }
  function setUnidadVista(v) {
    state.meta.unidadVista = (v === 'unidades') ? 'unidades' : 'cajas';
    if (sb) fire(upsertConfig());
    return state.meta.unidadVista;
  }
  // Unidades por caja de un artículo (id u objeto). 1 si no se conoce.
  function uxcDe(idOrArt) {
    var a = (idOrArt && typeof idOrArt === 'object') ? idOrArt : getArticulo(idOrArt);
    var u = a && a.uxc;
    return (u && u > 0) ? u : 1;
  }
  // Convierte una cantidad canónica (UNIDADES) a la unidad de vista activa.
  function enVista(unidades, idOrArt) {
    return getUnidadVista() === 'cajas'
      ? Math.round((unidades || 0) / uxcDe(idOrArt))
      : Math.round(unidades || 0);
  }
  // Actualiza las Uni×Caja de varios artículos desde un import en cajas. Devuelve cuántas cambió.
  function actualizarUxcDesde(map) {
    var idx = idxCatalogo(), n = 0;
    Object.keys(map || {}).forEach(function (code) {
      var a = matchCodigo(code, idx), u = Math.round(map[code]);
      if (a && u > 0 && a.uxc !== u) {
        a.uxc = u; n++;
        if (sb) fire(sb.from(T.art).update({ uxc: u, updated_at: new Date().toISOString() }).eq('id', a.id).eq('cod_cliente', COD_CLIENTE));
      }
    });
    return n;
  }

  /* ---------- Artículos ---------- */
  function getArticulos(opts) {
    opts = opts || {};
    var list = state.articulos.slice();
    if (opts.soloActivos) list = list.filter(function (a) { return a.activo !== false; });
    list.sort(function (a, b) { return (a.nombre || '').localeCompare(b.nombre || '', 'es'); });
    return list;
  }
  function getArticulo(id) {
    for (var i = 0; i < state.articulos.length; i++) {
      if (state.articulos[i].id === id) return state.articulos[i];
    }
    return null;
  }
  function addArticulo(data) {
    var a = {
      id: uid(),
      codigo: (data.codigo || '').trim(),
      nombre: (data.nombre || '').trim() || 'Sin nombre',
      descripcion: (data.descripcion || '').trim(),
      foto: data.foto || '',
      precio: num(data.precio, 0),
      stockInicial: Math.max(0, Math.round(num(data.stockInicial, 0))),
      totalHistorico: Math.max(0, Math.round(num(data.totalHistorico, 0))),
      uxc: Math.max(1, Math.round(num(data.uxc, 1))),
      stockMaximo: optNum(data.stockMaximo),        // nivel objetivo (unidades); null = sin máximo
      promedioManual: optNum(data.promedioManual), // override del promedio mensual (null = automático)
      mesesPedido: optNum(data.mesesPedido),        // override de meses de cobertura (null = global)
      activo: data.activo !== false
    };
    state.articulos.push(a);
    if (sb) fire(sb.from(T.art).insert(artToRow(a)));
    return a;
  }
  function updateArticulo(id, data) {
    var a = getArticulo(id);
    if (!a) return null;
    if (data.codigo !== undefined) a.codigo = (data.codigo || '').trim();
    if (data.nombre !== undefined) a.nombre = (data.nombre || '').trim() || 'Sin nombre';
    if (data.descripcion !== undefined) a.descripcion = (data.descripcion || '').trim();
    if (data.foto !== undefined) a.foto = data.foto;
    if (data.precio !== undefined) a.precio = num(data.precio, 0);
    if (data.stockInicial !== undefined) a.stockInicial = Math.max(0, Math.round(num(data.stockInicial, 0)));
    if (data.totalHistorico !== undefined) a.totalHistorico = Math.max(0, Math.round(num(data.totalHistorico, 0)));
    if (data.uxc !== undefined) a.uxc = Math.max(1, Math.round(num(data.uxc, 1)));
    if (data.stockMaximo !== undefined) a.stockMaximo = optNum(data.stockMaximo);
    if (data.promedioManual !== undefined) a.promedioManual = optNum(data.promedioManual);
    if (data.mesesPedido !== undefined) a.mesesPedido = optNum(data.mesesPedido);
    if (data.activo !== undefined) a.activo = !!data.activo;
    if (sb) fire(sb.from(T.art).update(artToRow(a)).eq('id', a.id).eq('cod_cliente', COD_CLIENTE));
    return a;
  }
  function removeArticulo(id) {
    state.articulos = state.articulos.filter(function (a) { return a.id !== id; });
    state.movimientos = state.movimientos.filter(function (m) { return m.articuloId !== id; });
    // El FK on delete cascade borra las filas de ventas/entregas/ajustes del artículo.
    if (sb) fire(sb.from(T.art).delete().eq('id', id).eq('cod_cliente', COD_CLIENTE));
  }

  /* ---------- Movimientos ---------- */
  // tipo: 'entrega' (suma) | 'venta' (resta) | 'ajuste' (suma, puede ser negativo)
  // Cada tipo va a su tabla: osa_ventas / osa_entregas / osa_ajustes.
  function addMovimiento(m) {
    var mov = {
      id: uid(), dbId: null,
      articuloId: m.articuloId,
      tipo: (m.tipo === 'venta' || m.tipo === 'entrega') ? m.tipo : 'ajuste',
      cantidad: Math.round(num(m.cantidad, 0)),
      fecha: m.fecha || hoyISO(),
      nota: (m.nota || '').trim(),
      quincena: m.quincena || null,
      _formato: m.formato || null
    };
    state.movimientos.push(mov);
    if (sb) {
      sb.from(tablaDe(mov.tipo)).insert(movToRow(mov)).select('id').maybeSingle()
        .then(function (r) {
          if (r.error) { fail(r.error); return; }
          if (r.data) mov.dbId = r.data.id; // id en memoria queda estable; se borra por dbId
        }, fail);
    }
    return mov;
  }
  function addMovimientosBatch(arr) {
    var creados = [], grupos = { venta: [], entrega: [], ajuste: [] };
    for (var i = 0; i < arr.length; i++) {
      var c = Math.round(num(arr[i].cantidad, 0));
      if (c === 0) continue;
      var tipo = (arr[i].tipo === 'venta' || arr[i].tipo === 'entrega') ? arr[i].tipo : 'ajuste';
      var mov = {
        id: uid(), dbId: null, articuloId: arr[i].articuloId, tipo: tipo,
        cantidad: c, fecha: arr[i].fecha || hoyISO(), nota: (arr[i].nota || '').trim(),
        quincena: arr[i].quincena || null, _formato: arr[i].formato || null
      };
      state.movimientos.push(mov);
      creados.push(mov);
      grupos[tipo].push(mov);
    }
    if (sb) {
      ['venta', 'entrega', 'ajuste'].forEach(function (tipo) {
        var movs = grupos[tipo]; if (!movs.length) return;
        sb.from(tablaDe(tipo)).insert(movs.map(movToRow)).select('id')
          .then(function (r) {
            if (r.error) { fail(r.error); return; }
            (r.data || []).forEach(function (row, idx) {
              if (movs[idx]) movs[idx].dbId = row.id; // id en memoria estable; se borra por dbId
            });
          }, fail);
      });
    }
    return creados;
  }
  function getMovimientos(filter) {
    filter = filter || {};
    var list = state.movimientos.slice();
    if (filter.articuloId) list = list.filter(function (m) { return m.articuloId === filter.articuloId; });
    if (filter.tipo) list = list.filter(function (m) { return m.tipo === filter.tipo; });
    list.sort(function (a, b) {
      if (a.fecha === b.fecha) return b.id < a.id ? -1 : 1;
      return a.fecha < b.fecha ? 1 : -1;
    });
    return list;
  }
  function removeMovimiento(id) {
    var mov = null;
    for (var i = 0; i < state.movimientos.length; i++) {
      if (state.movimientos[i].id === id) { mov = state.movimientos[i]; break; }
    }
    state.movimientos = state.movimientos.filter(function (m) { return m.id !== id; });
    if (sb && mov && mov.dbId != null) fire(sb.from(tablaDe(mov.tipo)).delete().eq('id', mov.dbId));
  }

  /* ---------- Lógica de stock ---------- */
  function computeStocks() {
    var map = {};
    state.articulos.forEach(function (a) { map[a.id] = a.stockInicial || 0; });
    state.movimientos.forEach(function (m) {
      if (!(m.articuloId in map)) return;
      if (m.tipo === 'venta') map[m.articuloId] -= m.cantidad;
      else map[m.articuloId] += m.cantidad; // entrega o ajuste
    });
    return map;
  }
  function stockActual(id) {
    var s = computeStocks();
    return s[id] || 0;
  }
  function totales(id) {
    var t = { entregas: 0, ventas: 0, ajustes: 0 };
    state.movimientos.forEach(function (m) {
      if (m.articuloId !== id) return;
      if (m.tipo === 'entrega') t.entregas += m.cantidad;
      else if (m.tipo === 'venta') t.ventas += m.cantidad;
      else t.ajustes += m.cantidad;
    });
    return t;
  }
  /* ---------- Punto de pedido y reposición (Módulos 1 y 3) ----------
     Punto de pedido = stockMaximo: el nivel objetivo (en unidades) que OSA quiere
     tener de cada artículo. Pedido sugerido = punto de pedido − stock hoy (top-up,
     cuando da positivo). Sin máximo => no se repone.
     El promedio mensual (totalHistorico / periodoMeses) se conserva solo como
     referencia de consumo; ya no determina el punto de pedido. */
  function promedioMensualAuto(a) {
    return (a.totalHistorico || 0) / Math.max(1, state.meta.periodoMeses || 1);
  }
  function promedioMensual(a) {
    return (a.promedioManual != null) ? a.promedioManual : promedioMensualAuto(a);
  }
  function mesesPedido(a) {
    return (a.mesesPedido != null) ? a.mesesPedido : (state.meta.mesesPedidoDefault || 0);
  }
  // Punto de pedido = nivel objetivo de stock (stockMaximo, en unidades). Si el
  // artículo no tiene máximo definido, no se repone (0). El pedido sugerido hace
  // top-up hasta este nivel: sugerido = max(0, puntoPedido − stock).
  function puntoPedido(a) {
    return (a.stockMaximo != null) ? Math.max(0, Math.round(a.stockMaximo)) : 0;
  }
  // Pedido sugerido en UNIDADES, redondeado SIEMPRE a cajas cerradas: se compra
  // en cajas enteras, de modo que (cajas a pedir) × (Uni×Caja) = (unidades a pedir).
  // cajas a pedir = ceil(faltante / Uni×Caja); unidades = cajas × Uni×Caja.
  // Unidades del artículo YA pedidas y todavía sin entregar ("en camino"). Se
  // descuentan del sugerido para no re-pedir lo que ya viaja. Match tolerante de
  // código (exacto, +E, -E) igual que el resto del cruce con el catálogo.
  function enCaminoDe(a) {
    if (!a || !a.codigo) return 0;
    var c = String(a.codigo).toUpperCase();
    var m = state.enCamino || {};
    var v = m[c];
    if (v == null) v = m[c + 'E'];
    if (v == null) v = m[c.replace(/E$/, '')];
    return Math.max(0, Math.round(num(v, 0)));
  }
  function sugerido(a, stock) {
    if (stock === undefined) stock = stockActual(a.id);
    // máximo − stock actual − lo que ya está en camino (pedido, sin entregar).
    var faltante = puntoPedido(a) - stock - enCaminoDe(a);
    if (faltante <= 0) return 0;
    var f = uxcDe(a);
    return Math.ceil(faltante / f) * f;
  }
  function necesitaPedido(a, stock) {
    return sugerido(a, stock) > 0;
  }
  // 'sin' (stock <= 0) | 'bajo' (por debajo del punto de pedido) | 'ok'
  function estado(a, stock) {
    if (stock === undefined) stock = stockActual(a.id);
    if (stock <= 0) return 'sin';
    if (stock < puntoPedido(a)) return 'bajo';
    return 'ok';
  }
  // Lista de reposición sugerida (artículos activos con sugerido > 0)
  function pedidoSugerido() {
    var stocks = computeStocks();
    return getArticulos({ soloActivos: true })
      .filter(function (a) { return necesitaPedido(a, stocks[a.id]); })
      .map(function (a) {
        return { articulo: a, stock: stocks[a.id], punto: puntoPedido(a), sugerido: sugerido(a, stocks[a.id]), enCamino: enCaminoDe(a) };
      });
  }

  /* ---------- Movimientos con saldo corrido (Módulo 2) ----------
     Movimientos del artículo en orden cronológico, con el saldo resultante
     después de cada uno (arrancando del stock inicial). opts.desde / opts.hasta
     (ISO) filtran SOLO la ventana mostrada; el saldo se acumula desde el inicio. */
  function movimientosConSaldo(articuloId, opts) {
    opts = opts || {};
    var a = getArticulo(articuloId);
    var saldo = a ? (a.stockInicial || 0) : 0;
    var movs = state.movimientos
      .filter(function (m) { return m.articuloId === articuloId; })
      .sort(function (x, y) {
        if (x.fecha === y.fecha) return x.id < y.id ? -1 : 1;
        return x.fecha < y.fecha ? -1 : 1;
      });
    var out = [];
    movs.forEach(function (m) {
      saldo += (m.tipo === 'venta') ? -m.cantidad : m.cantidad;
      if (opts.desde && m.fecha < opts.desde) return;
      if (opts.hasta && m.fecha > opts.hasta) return;
      out.push({ mov: m, saldo: saldo });
    });
    return out;
  }

  /* ---------- Importación de Ventas OSA (Módulo 5) ----------
     Parser de los informes de OSA (texto extraído de un PDF). Dos formatos:
     1) "Ventas por artículo":
       Desde 5/06/26 hasta 30/06/26
       :L031   FILTRO P/CAFE LOEKEMEYER        12
       ...
                                               695     (total al pie)
     2) "Resumen de movimientos" (columnar de ancho fijo): header
       : Artículo: Descripción :Dp: Inicial : Compras : Ventas : ... : Saldo :
       Se toma SOLO la columna Ventas, cortando por posición (ver rama columnar).
     Los códigos del informe son "L" + código. El informe suele quitar la "E"
     final (L529 = 529E). Cruce: exacto y, si no, agregando/quitando "E". */
  function ddmmaaISO(s) {
    var p = (s || '').split('/');
    if (p.length !== 3) return null;
    var d = parseInt(p[0], 10), mo = parseInt(p[1], 10), y = parseInt(p[2], 10);
    if (isNaN(d) || isNaN(mo) || isNaN(y)) return null;
    if (y < 100) y += 2000;
    return y + '-' + pad(mo) + '-' + pad(d);
  }
  // Índice del catálogo por código (mayúsculas).
  function idxCatalogo() {
    var idx = {};
    state.articulos.forEach(function (a) { if (a.codigo) idx[String(a.codigo).toUpperCase()] = a; });
    return idx;
  }
  // Cruce de código tolerante: exacto, con "E" agregada (OSA quita la E: L529=529E)
  // y con la "E" quitada (Loeke usa 946E donde el catálogo tiene 946).
  function matchCodigo(c, idx) {
    c = String(c).toUpperCase();
    return idx[c] || idx[c + 'E'] || idx[c.replace(/E$/, '')] || null;
  }
  // Celda de fecha de Excel: Date, número de serie (1900) o texto -> ISO.
  function celdaAFecha(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    if (typeof v === 'number') {
      var d = new Date(Math.round((v - 25569) * 86400000));
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return ddmmaaISO(s);
  }
  function parseReporteVentas(text) {
    text = String(text || '');
    var lines = text.split(/\r?\n/);
    var idx = idxCatalogo();

    var periodo = { desde: null, hasta: null };
    var mp = text.match(/Desde\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+hasta\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (mp) { periodo.desde = ddmmaaISO(mp[1]); periodo.hasta = ddmmaaISO(mp[2]); }

    // ---- Formato "Resumen de movimientos" (columnar de ancho fijo) ----
    // Header tipo:  : Artículo: Descripción :Dp: Inicial : Compras : Ventas : ... : Saldo :
    // Cada fila trae varias columnas numéricas y hay que cortar POR POSICIÓN para
    // no confundir Ventas con Compras/Otros Egr. (el join simple pierde eso).
    // Requiere el texto reconstruido con posiciones reales (pdfATexto lo hace).
    var hIdx = -1;
    for (var hi = 0; hi < lines.length; hi++) {
      if (/Art[íi]culo/i.test(lines[hi]) && /Ventas/i.test(lines[hi]) && /Saldo/i.test(lines[hi])) { hIdx = hi; break; }
    }
    if (hIdx >= 0) {
      var hdr = lines[hIdx];
      var cps = [];
      for (var ci = 0; ci < hdr.length; ci++) if (hdr[ci] === ':') cps.push(ci);
      var cols = [];
      for (var s = 0; s < cps.length - 1; s++) {
        cols.push({ label: hdr.slice(cps[s] + 1, cps[s + 1]).trim(), ini: cps[s] + 1, fin: cps[s + 1] });
      }
      function colPor(re) {
        for (var x = 0; x < cols.length; x++) if (re.test(cols[x].label)) return cols[x];
        return null;
      }
      var cArt = colPor(/Art[íi]culo/i), cDesc = colPor(/Descripci/i), cVen = colPor(/Ventas/i);
      if (cArt && cVen) {
        var filasC = [], totalC = 0, totalInfC = null, noEncC = [], matchC = 0;
        for (var li = hIdx + 1; li < lines.length; li++) {
          var lc = lines[li];
          if (!lc || /^\s*[-=]{10,}/.test(lc)) continue;
          if (/TOTAL\s+GENERAL/i.test(lc)) {
            var tm = lc.slice(cVen.ini, cVen.fin).match(/-?\d+/);
            if (tm) totalInfC = parseInt(tm[0], 10);
            continue;
          }
          var am = lc.slice(cArt.ini, cArt.fin).match(/L\s*([0-9A-Za-z]+)/i);
          if (!am) continue;
          var vmc = lc.slice(cVen.ini, cVen.fin).match(/-?\d+/);
          var ven = vmc ? parseInt(vmc[0], 10) : 0;
          if (!ven) continue; // la mayoría de las filas del resumen no tiene ventas
          var codR = am[1].toUpperCase();
          var artC = matchCodigo(codR, idx);
          if (artC) matchC++; else noEncC.push(codR);
          totalC += ven;
          filasC.push({
            codigoReporte: codR, desc: (cDesc ? lc.slice(cDesc.ini, cDesc.fin) : '').trim(), ventas: ven,
            articuloId: artC ? artC.id : null, codigo: artC ? artC.codigo : null, nombre: artC ? artC.nombre : null
          });
        }
        return {
          periodo: periodo, filas: filasC, totalParseado: totalC,
          totalInforme: totalInfC, noEncontrados: noEncC, matchCount: matchC
        };
      }
    }

    var filas = [], totalParseado = 0, totalInforme = null, noEncontrados = [], matchCount = 0;
    lines.forEach(function (ln) {
      var line = ln.trim();
      if (!line) return;
      var ft = line.match(/^(\d{1,7})$/);     // total al pie: línea con solo un número
      if (ft) { totalInforme = parseInt(ft[1], 10); return; }
      var m = line.match(/^:?\s*L\s*([0-9A-Za-z]+)\b(.*)$/); // fila: (:)L + código + ...
      if (!m) return;
      var codigoReporte = m[1].toUpperCase();
      var rest = (m[2] || '').trim();
      var vm = rest.match(/(\d+)\s*$/);        // las ventas son el número al final
      var ventas = vm ? parseInt(vm[1], 10) : 0;
      var desc = vm ? rest.slice(0, vm.index).trim() : rest;
      var art = matchCodigo(codigoReporte, idx);
      if (art) matchCount++; else noEncontrados.push(codigoReporte);
      totalParseado += ventas;
      filas.push({
        codigoReporte: codigoReporte, desc: desc, ventas: ventas,
        articuloId: art ? art.id : null, codigo: art ? art.codigo : null, nombre: art ? art.nombre : null
      });
    });
    return {
      periodo: periodo, filas: filas, totalParseado: totalParseado,
      totalInforme: totalInforme, noEncontrados: noEncontrados, matchCount: matchCount
    };
  }

  /* ---------- Importación de Entregas Loeke (Módulo 4) ----------
     Recibe las filas (array 2D) de un Excel de detalle de facturación (Loeke a
     OSA). Detecta la columna de "Cód. Artículo" (la que más cruza con el
     catálogo); a su derecha van Cantidad (I), Precio (J) y Total (K).

     El reporte puede venir en UNIDADES o en CAJAS. Detección por fila:
       - en unidades: I × J = K  (cantidad × precio unitario = importe)
       - en cajas:    I × J ≠ K, y K ÷ (I×J) = unidades por caja (uxc)
     El stock se guarda siempre en CAJAS (canónico):
       - archivo en cajas    -> la cantidad ya está en cajas; además se actualiza la uxc
       - archivo en unidades -> cajas = unidades ÷ uxc (uxc del catálogo) */
  function parseEntregas(rows) {
    rows = rows || [];
    var idx = idxCatalogo();
    var ncols = 0;
    rows.forEach(function (r) { if (r && r.length > ncols) ncols = r.length; });
    // Columna de código = la que más celdas cruza con el catálogo.
    var codCol = 0, best = -1;
    for (var c = 0; c < ncols; c++) {
      var cnt = 0;
      rows.forEach(function (r) {
        var v = (r && r[c] != null) ? String(r[c]).trim() : '';
        if (/^\d{2,4}[A-Za-z]?$/.test(v) && matchCodigo(v, idx)) cnt++;
      });
      if (cnt > best) { best = cnt; codCol = c; }
    }
    var cantCol = codCol + 3, precCol = codCol + 4, totCol = codCol + 5;
    function esFila(r) { return r && /^\d{2,4}[A-Za-z]?$/.test(String(r[codCol] != null ? r[codCol] : '').trim()); }

    // Detección de formato: ¿I×J coincide con K en la mayoría de las filas?
    var ratios = [];
    rows.forEach(function (r) {
      if (!esFila(r)) return;
      var I = num(r[cantCol]), J = num(r[precCol]), K = num(r[totCol]);
      if (I > 0 && J > 0 && K > 0) ratios.push(K / (I * J));
    });
    var enUni = ratios.filter(function (x) { return Math.abs(x - 1) < 0.02; }).length;
    var formato = (ratios.length && enUni >= ratios.length / 2) ? 'unidades' : 'cajas';

    var filas = [], totalCajas = 0, totalUnidades = 0, fechas = {}, noEncontrados = [], matchCount = 0, uxcDerivado = {};
    rows.forEach(function (r) {
      if (!esFila(r)) return;
      var codRaw = String(r[codCol]).trim();
      var cantOrig = Math.round(num(r[cantCol], 0));
      if (cantOrig <= 0) return;
      var I = num(r[cantCol]), J = num(r[precCol]), K = num(r[totCol]);
      var uxcFila = (I > 0 && J > 0 && K > 0) ? Math.round(K / (I * J)) : null;
      var fecha = celdaAFecha(r[0]);
      var art = matchCodigo(codRaw, idx);
      if (art) matchCount++; else noEncontrados.push(codRaw);
      if (formato === 'cajas' && uxcFila && uxcFila > 1) uxcDerivado[codRaw] = uxcFila;

      var u = (uxcFila && uxcFila > 1) ? uxcFila : (art ? uxcDe(art) : 1);
      var unidades, cajas;
      if (formato === 'cajas') {                 // viene en cajas -> a unidades (canónico)
        unidades = cantOrig * u;
        cajas = cantOrig;
      } else {                                   // ya viene en unidades (canónico)
        unidades = cantOrig;
        cajas = u > 1 ? Math.round(cantOrig / u) : cantOrig;
      }
      if (fecha) fechas[fecha] = true;
      totalUnidades += unidades;
      totalCajas += cajas;
      filas.push({
        codigo: codRaw, unidades: unidades, cajas: cajas,
        cantidadOriginal: cantOrig, uxc: u, fecha: fecha,
        descripcion: (r[codCol + 1] != null ? String(r[codCol + 1]).trim() : ''),
        articuloId: art ? art.id : null, nombre: art ? art.nombre : null
      });
    });
    return {
      formato: formato, filas: filas, totalCajas: totalCajas, totalUnidades: totalUnidades,
      fechas: Object.keys(fechas).sort(), noEncontrados: noEncontrados,
      matchCount: matchCount, uxcDerivado: uxcDerivado
    };
  }

  /* ---------- Quincenas de ventas (control de cargas) ----------
     Cada mes tiene 2 quincenas: 1ª = días 1–15, 2ª = 16–fin de mes. Las ventas de
     OSA se cargan por quincena; el módulo de control muestra cuáles están cargadas
     y cuáles pendientes. La clave es 'AAAA-MM-Q1'/'AAAA-MM-Q2' (ordena alfabéticamente). */
  var MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function ultimoDiaMes(anio, mes) { return new Date(anio, mes, 0).getDate(); } // mes 1–12
  function quincenaDe(iso) {
    if (!iso) return null;
    var p = String(iso).slice(0, 10).split('-');
    var anio = parseInt(p[0], 10), mes = parseInt(p[1], 10), dia = parseInt(p[2], 10);
    if (!anio || !mes || !dia) return null;
    var mitad = dia <= 15 ? 1 : 2;
    return {
      key: anio + '-' + pad(mes) + '-Q' + mitad,
      anio: anio, mes: mes, mitad: mitad,
      desde: anio + '-' + pad(mes) + '-' + (mitad === 1 ? '01' : '16'),
      hasta: anio + '-' + pad(mes) + '-' + pad(mitad === 1 ? 15 : ultimoDiaMes(anio, mes)),
      label: (mitad === 1 ? '1ª' : '2ª') + ' quincena de ' + MESES_ES[mes - 1] + ' ' + anio
    };
  }
  function quincenaSiguiente(q) {
    if (q.mitad === 1) return quincenaDe(q.anio + '-' + pad(q.mes) + '-16');
    var nm = q.mes === 12 ? 1 : q.mes + 1, na = q.mes === 12 ? q.anio + 1 : q.anio;
    return quincenaDe(na + '-' + pad(nm) + '-01');
  }
  // Lista de quincenas entre dos fechas (inclusive), ordenada.
  function listaQuincenas(desdeISO, hastaISO) {
    var a = quincenaDe(desdeISO), b = quincenaDe(hastaISO);
    if (!a || !b || a.key > b.key) return a && !b ? [a] : [];
    var out = [], cur = a, guard = 0;
    while (cur.key <= b.key && guard++ < 600) { out.push(cur); cur = quincenaSiguiente(cur); }
    return out;
  }
  // Ventas cargadas agrupadas por quincena: key -> {key, totalCajas, count, fechaCarga}.
  function cargasVentas() {
    var map = {};
    state.movimientos.forEach(function (m) {
      if (m.tipo !== 'venta') return;
      var k = m.quincena || ((quincenaDe(m.fecha) || {}).key);
      if (!k) return;
      if (!map[k]) map[k] = { key: k, totalCajas: 0, totalUnidades: 0, count: 0, fechaCarga: null };
      map[k].totalUnidades += m.cantidad;
      map[k].totalCajas += Math.round(m.cantidad / uxcDe(m.articuloId));
      map[k].count++;
      // Fecha real de carga a la base (created_at). Cae a m.fecha solo para
      // movimientos recién agregados en la sesión que todavía no se recargaron.
      var fc = m.cargadaEl || m.fecha;
      if (!map[k].fechaCarga || fc > map[k].fechaCarga) map[k].fechaCarga = fc;
    });
    return map;
  }
  function quincenaCargada(key) {
    var c = cargasVentas()[key];
    return (c && c.count > 0) ? c : null;
  }

  /* ---------- Respaldo / datos ---------- */
  function exportData() { return JSON.stringify(state, null, 2); }
  // Importa un respaldo JSON a Supabase: reemplaza artículos y movimientos.
  async function importData(json) {
    if (!sb) throw new Error('Supabase no disponible');
    var p = typeof json === 'string' ? JSON.parse(json) : json;
    var meta = Object.assign(blank().meta, p.meta || {});
    var arts = Array.isArray(p.articulos) ? p.articulos : [];
    var movs = Array.isArray(p.movimientos) ? p.movimientos : [];
    await borrarTodo();
    // Artículos
    state.articulos = arts.map(function (a) {
      if (!a.id) a.id = 'a_' + (a.codigo || uid());
      return a;
    });
    if (state.articulos.length) {
      await sb.from(T.art).upsert(state.articulos.map(artToRow), { onConflict: 'cod_cliente,codigo' });
    }
    // Movimientos por tipo (movToRow resuelve codigo/uxc desde state.articulos)
    var porTipo = { venta: [], entrega: [], ajuste: [] };
    movs.forEach(function (m) {
      var tipo = (m.tipo === 'venta' || m.tipo === 'entrega') ? m.tipo : 'ajuste';
      porTipo[tipo].push(movToRow({
        tipo: tipo, articuloId: m.articuloId, cantidad: m.cantidad,
        fecha: m.fecha, nota: m.nota, quincena: m.quincena, _formato: m.formato
      }));
    });
    for (var t in porTipo) { if (porTipo[t].length) await sb.from(tablaDe(t)).insert(porTipo[t]); }
    // Config
    state.meta = meta;
    await sb.from(T.cfg).upsert(metaToRow(), { onConflict: 'cod_cliente' });
    await loadAll();
  }
  // Borra todos los datos OSA (movimientos + artículos) en Supabase.
  function borrarTodo() {
    return Promise.all([
      sb.from(T.ven).delete().eq('cod_cliente', COD_CLIENTE),
      sb.from(T.ent).delete().eq('cod_cliente', COD_CLIENTE),
      sb.from(T.aju).delete().eq('cod_cliente', COD_CLIENTE)
    ]).then(function () {
      return sb.from(T.art).delete().eq('cod_cliente', COD_CLIENTE);
    });
  }
  // "Borrar todo": vacía movimientos y artículos y vuelve a sembrar el catálogo.
  async function resetAll() {
    if (!sb) { state = blank(); return; }
    await borrarTodo();
    await seedArticulos();
    await loadAll();
  }

  /* ---------- Catálogo real (Loekemeyer · cliente Osa Distribuidora SRL) ----------
     [codigo, nombre, ventasRanking]  ·  ordenado por total (mayor a menor).
     OJO: el ranking viene EN CAJAS (informe de ventas de OSA). En el seed se
     convierte a UNIDADES (× Uni×Caja) para que el promedio mensual quede en la
     unidad canónica. El total abarca ~periodoMeses meses (ver meta.periodoMeses). */
  var CATALOGO = [
    ['505', 'Pelador mango plástico', 6365],
    ['513', 'Pelador mango metálico', 4075],
    ['506', 'Abrelatas uña rojo', 3627],
    ['504', 'Afila cuchillos', 2190],
    ['501', 'Abrelatas a manija', 2184],
    ['502', 'Abrelatas mariposa cromado', 1404],
    ['546', 'Corta queso blandos mango Loeke', 760],
    ['031', 'Filtro de café 10cm', 745],
    ['544', 'Batidor pera alambre', 605],
    ['520', 'Sacacorcho tipo mozo cromado', 397],
    ['512', 'Abrelatas mariposa capuchón rojo', 390],
    ['523', 'Sacacorcho doble aleta', 380],
    ['529E', 'Sacacorcho doble impulso acero', 319],
    ['315', 'Pisa papas acero inox', 307],
    ['530', 'Sacacorcho tipo mozo color', 284],
    ['521', 'Sacacorcho combinado cromado', 278],
    ['519', 'Cuchillo untar mango madera x2', 266],
    ['508', 'Sacafuentes articulado', 246],
    ['579', 'Tapón de vino/cerveza x1 color', 239],
    ['507', 'Rompenueces', 212],
    ['587', 'Pelador metálico corte láser', 210],
    ['562', 'Corta pizza 6cm mango Loeke', 194],
    ['395', 'Descorazonador de manzana', 193],
    ['577', 'Tapón de vino/cerveza x1 premium', 179],
    ['559', 'Corta ravioles c/mango Loeke', 176],
    ['531', 'Sacacorcho combinado color', 166],
    ['057', 'Destapa corona x1 cromado', 160],
    ['518', 'Sacafuente pizzero', 159],
    ['575', 'Tapón de vino/cerveza x1 negro', 158],
    ['510', 'Abrelata uña cromado', 150],
    ['551', 'Cuchillo de untar mango plástico x2', 110],
    ['560', 'Pinza corta alambre 21cm', 106],
    ['589E', 'Pelador mango acrílico', 100],
    ['598E', 'Pelador negro dentado', 100],
    ['246', 'Prensa matambre', 81],
    ['511', 'Abrelatas uña 3 en 1', 80],
    ['564', 'Corta pizza 8cm mango madera', 78],
    ['525E', 'Sacacorcho cabo de madera', 130], // 525 y 525E son el mismo artículo (75 + 55)
    ['542', 'Ahueca papas', 69],
    ['580E', 'Batidor mini', 131], // 580 y 580E son el mismo artículo: se fusionan (68 + 63)
    ['280', 'Manga repostera + 4 boquillas', 60],
    ['811E', 'Corta pizza mango ergonómico Ø9cm', 50],
    ['543', 'Ahueca frutas', 42],
    ['935E', 'Espátula calada nylon mango madera', 40],
    ['538E', 'Sacacorcho azul', 40],
    ['509', 'Pala batidora', 38],
    ['515', 'Batidor resorte', 38],
    ['934E', 'Cuchara fideos nylon mango madera', 35],
    ['548', 'Pincel pastelero', 34],
    ['361E', 'Rallador 4 lados acero inox', 31],
    ['566E', 'Aceitera 100 ml', 30],
    ['937E', 'Batidor pera nylon mango madera', 30],
    ['583E', 'Especiero tapa bamboo', 30],
    ['396', 'Enrulador de manteca', 25],
    ['478E', 'Sacacorcho doble impulso', 25],
    ['570', 'Pala de canelones', 23],
    ['561', 'Pinza grande alambre', 22],
    ['596', 'Pinza de ensalada mango plástico 23cm', 22],
    ['229', 'Ñoquera madera', 20],
    ['581', 'Sacacorcho mango ergonómico', 20],
    ['931E', 'Espátula lisa nylon mango madera', 20],
    ['936E', 'Espumadera nylon mango madera', 20],
    ['932E', 'Cuchara nylon mango madera', 20],
    ['540E', 'Sacacorcho premium', 20],
    ['539E', 'Sacacorcho negro', 20],
    ['536E', 'Sacacorcho full black', 20],
    ['222', 'Bate bife madera', 16],
    ['595', 'Pinza de fiambre mango plástico 23cm', 16],
    ['948E', 'Espumadera acero inox', 16],
    ['325', 'Espátula repostera plástico 1 pza', 15],
    ['522E', 'Sacacorcho doble aleta premium', 15],
    ['943E', 'Cucharón acero inox', 15],
    ['574E', 'Artículo 574E', 15],
    ['585E', 'Sacacorcho doble aleta fundición', 15],
    ['809E', 'Corta pizza mango ergonómico 6cm', 15],
    ['569', 'Pelanaranjas x1 display', 14],
    ['554', 'Cucharita matera', 13],
    ['945E', 'Espátula calada acero inox', 11],
    ['563', 'Pinza hamburguesa', 10],
    ['586', 'Pelapapas mango ergonómico', 10],
    ['591', 'Despolvillador de yerba', 10],
    ['933E', 'Cucharón nylon mango madera', 10],
    ['941E', 'Espátula lisa acero inox', 10],
    ['942E', 'Cuchara acero inox', 10],
    ['944E', 'Cuchara fideos acero inox', 10],
    ['817E', 'Rallador c/mango ergonómico', 10],
    ['364E', 'Rallador gourmet grano medio', 10],
    ['328E', 'Rallador plano 3 usos acero inox', 8],
    ['360E', 'Rallador 4 lados a/l mango plástico', 6],
    ['594', 'Pinza de fideos mango plástico 25cm', 3],
    ['355', 'Pisa papas nylon con mango', 2],
    ['524', 'Sacacorcho de espumantes', 2],
    // Sin historial de ventas (no figuran en el ranking), pero OSA tiene stock
    // de ellos en el informe de Existencias: se agregan con total 0.
    ['517', 'Pinza gastronómica de acero', 0],
    ['946', 'Cuchara calada acero inoxidable', 0],
    // Productos nuevos del Cotizador Loekemeyer (con máximo objetivo, sin historial).
    ['816E', 'Pelador V mango ergonómico', 0],
    ['584E', 'Aceitera 400 ml', 0]
  ];

  // Stock inicial real del cliente (OSA) · informe "Existencias" del 23/06/26,
  // columna "Existencia" (stock físico). Total del informe: 30.388 cajas.
  // Códigos del informe = "L" + mi código (suele quitar la "E" final: L529 = 529E).
  // 525 y 580 se consolidan en su variante E. Lo que figura en blanco queda en 0.
  // 517 y 946 se agregaron al catálogo (no tenían historial de ventas).
  var STOCK_INICIAL = {
    '031': 2112, '222': 32, '315': 18, '395': 144, '396': 6, '478E': 13, '501': 1020,
    '502': 780, '504': 1343, '505': 6108, '506': 2268, '507': 24, '508': 100, '510': 1044,
    '511': 11, '512': 2, '513': 5364, '515': 48, '518': 474, '519': 1220, '520': 150,
    '521': 336, '522E': 4, '523': 218, '525E': 149, '529E': 88, '530': 252, '531': 360,
    '536E': 18, '540E': 17, '542': 185, '543': 84, '544': 677, '546': 660, '548': 23,
    '551': 2, '559': 96, '560': 4, '561': 4, '562': 276, '564': 9, '566E': 386, '569': 12,
    '570': 14, '574E': 60, '577': 3, '579': 19, '580E': 12, '583E': 16, '587': 491,
    '589E': 1627, '594': 20, '598E': 161, '931E': 240, '932E': 226, '933E': 108,
    '934E': 241, '935E': 239, '936E': 314, '937E': 144, '941E': 120, '942E': 45, '944E': 5,
    '948E': 10, '517': 12, '946': 120
  };

  // Unidades por caja (Uni×Caja) por código, derivadas del informe en cajas
  // (K ÷ (I×J)). Sirven para convertir entre cajas y unidades en la vista y para
  // normalizar imports en unidades. Se mantienen al vuelo con cada import en cajas.
  var UXC_SEED = {
    '031': 24, '246': 6, '280': 12, '315': 12, '355': 24, '395': 12, '396': 12,
    '501': 6, '502': 12, '504': 6, '505': 12, '506': 12, '507': 12, '508': 6,
    '509': 12, '510': 12, '513': 12, '515': 12, '518': 12, '519': 12, '520': 12,
    '521': 12, '523': 12, '525E': 24, '529E': 12, '530': 12, '531': 12, '542': 12,
    '543': 12, '544': 12, '546': 12, '548': 24, '551': 12, '559': 12, '562': 12,
    '564': 12, '566E': 6, '575': 12, '577': 12, '579': 12, '580E': 12, '583E': 15,
    '931E': 12, '932E': 12, '933E': 12, '934E': 12, '935E': 12, '936E': 12,
    '937E': 12, '941E': 12, '942E': 12, '945E': 12, '946E': 12, '948E': 12,
    // Uni×Caja según el Cotizador de Loekemeyer (las que faltaban; casi todas 12,
    // salvo 589E/325/570 = 24, corregidas con la fuente autoritativa).
    '512': 12, '587': 12, '057': 12, '560': 12, '589E': 24, '598E': 12, '511': 12,
    '811E': 12, '538E': 12, '361E': 12, '478E': 12, '570': 24, '561': 12, '596': 12,
    '229': 12, '581': 12, '540E': 12, '539E': 12, '536E': 12, '222': 12, '595': 12,
    '325': 24, '522E': 12, '943E': 12, '574E': 12, '585E': 12, '809E': 12, '569': 12,
    '554': 12, '563': 12, '586': 12, '591': 12, '944E': 12, '817E': 12, '364E': 12,
    '328E': 12, '360E': 12, '594': 12, '524': 12, '517': 12,
    // Productos nuevos del Cotizador (con máximo, sin historial).
    '816E': 12, '584E': 6
  };
  // uxc del catálogo: exacto, +E y -E (catálogo 946 <-> informe 946E). 1 si no se conoce.
  function uxcSeed(code) {
    code = String(code).toUpperCase();
    return UXC_SEED[code] || UXC_SEED[code + 'E'] || UXC_SEED[code.replace(/E$/, '')] || 1;
  }

  // Stock máximo objetivo por artículo, EN CAJAS (sheet "Cotizador Loekemeyer",
  // columna "Pedido en Cajas"). En el seed se convierte a unidades (× Uni×Caja).
  // Lo que no figura acá no tiene máximo => no se repone.
  var MAX_CAJAS = {
    '246': 1, '280': 10, '315': 15, '355': 5, '395': 10, '501': 20, '502': 20, '504': 30,
    '505': 100, '506': 50, '507': 5, '508': 20, '510': 10, '511': 5, '512': 20, '513': 50,
    '515': 10, '518': 10, '519': 10, '520': 10, '521': 10, '523': 15, '530': 10, '531': 10,
    '542': 10, '543': 10, '544': 20, '546': 30, '551': 10, '559': 15, '560': 5, '561': 5,
    '562': 15, '564': 15, '569': 4, '570': 3, '575': 20, '577': 20, '579': 20, '594': 5,
    '595': 5, '596': 5, '589E': 10, '598E': 10, '529E': 10, '538E': 10, '539E': 10,
    '540E': 10, '585E': 10, '525E': 10, '811E': 10, '057': 5, '942E': 10, '943E': 10,
    '944E': 10, '945E': 10, '948E': 10, '932E': 10, '933E': 10, '934E': 10, '935E': 10,
    '936E': 10, '937E': 10, '583E': 15, '031': 10, '580E': 10,
    '816E': 10, '584E': 20
  };

  // Filas del catálogo real para sembrar osa_articulos (una sola vez).
  function seedRows() {
    // OSA: se siembra el catálogo completo (todos los códigos del CATALOGO).
    return CATALOGO.map(function (row) {
      var codigo = row[0], nombre = row[1], totalCajas = row[2];
      var uxc = uxcSeed(codigo);    // unidades por caja (Uni×Caja)
      var maxCajas = MAX_CAJAS[codigo];
      return {
        id: 'a_' + codigo, cod_cliente: COD_CLIENTE, codigo: codigo, nombre: nombre, descripcion: '',
        precio: 0,
        // SEED_INICIAL=false (p. ej. TyL): catálogo y máximos precargados, pero
        // stock inicial e historial de ventas arrancan en 0 (sin movimientos).
        stock_inicial: SEED_INICIAL ? (STOCK_INICIAL[codigo] || 0) : 0,
        total_historico: SEED_INICIAL ? (totalCajas * uxc) : 0,
        uxc: uxc,
        stock_maximo: (maxCajas != null) ? maxCajas * uxc : null, // nivel objetivo EN UNIDADES
        promedio_manual: null, meses_pedido: null, activo: true, foto: null
      };
    });
  }
  // Siembra el catálogo en Supabase (idempotente por id; no pisa lo ya cargado).
  // clientSeed:false (p. ej. TyL, cuyo catálogo se siembra server-side desde su
  // surtido de compras) → no sembrar desde el CATALOGO de OSA.
  function seedArticulos() {
    if (CFG.clientSeed === false) return Promise.resolve({ data: [] });
    return sb.from(T.art).upsert(seedRows(), { onConflict: 'cod_cliente,codigo', ignoreDuplicates: true });
  }
  // "Cargar catálogo de ejemplo" = re-sembrar el catálogo real (no borra movimientos).
  async function loadDemo() {
    if (!sb) return;
    await seedArticulos();
    await loadAll();
  }

  /* ---------- Utilidades ---------- */
  function hoyISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // Imagen placeholder (SVG data-uri) con iniciales y color por nombre
  function placeholder(nombre, color) {
    var palette = ['#6366f1', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];
    nombre = nombre || '?';
    var initials = nombre.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    var c = color;
    if (!c) {
      var h = 0;
      for (var i = 0; i < nombre.length; i++) h = (h * 31 + nombre.charCodeAt(i)) % palette.length;
      c = palette[h];
    }
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c + '"/>' +
      '<stop offset="1" stop-color="' + shade(c, -28) + '"/></linearGradient></defs>' +
      '<rect width="400" height="260" fill="url(#g)"/>' +
      '<text x="200" y="148" font-family="Inter,Arial,sans-serif" font-size="92" font-weight="800" ' +
      'fill="#ffffff" fill-opacity="0.92" text-anchor="middle">' + initials + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function shade(hex, amt) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = clamp(parseInt(c.slice(0, 2), 16) + amt);
    var g = clamp(parseInt(c.slice(2, 4), 16) + amt);
    var b = clamp(parseInt(c.slice(4, 6), 16) + amt);
    return '#' + hx(r) + hx(g) + hx(b);
  }
  function clamp(v) { return Math.max(0, Math.min(255, v)); }
  function hx(v) { var s = v.toString(16); return s.length === 1 ? '0' + s : s; }

  /* ---------- Carga inicial / init (Supabase) ---------- */
  // Hidrata el estado en memoria desde Supabase. Requiere sesión OSA (lanza
  // 'no-session' si no hay login). app.js la espera antes del primer render.
  async function init() {
    if (!sb) throw new Error('supabase-js no cargado');
    var sess = (await sb.auth.getSession()).data.session;
    if (!sess) throw new Error('no-session');
    state.authUid = (sess.user && sess.user.id) || null;
    await loadAll();
    return true;
  }
  async function loadAll() {
    await loadConfig();
    await loadArticulos();
    await loadMovimientos();
    await loadFeriados();
    await loadUltimoPedido();
    await loadEnCamino();
  }
  async function loadConfig() {
    var r = await sb.from(T.cfg).select('*').eq('cod_cliente', COD_CLIENTE).maybeSingle();
    var c = r.data;
    if (!c) { await upsertConfig(); c = metaToRow(); }
    var n = Math.round(num(c.pedido_intervalo_dias, 15));
    state.meta = {
      empresa: c.empresa || 'Loekemeyer', cliente: c.cliente || 'Osa Distribuidora SRL',
      moneda: c.moneda || 'ARS', periodoMeses: c.periodo_meses || 17,
      mesesPedidoDefault: c.meses_pedido_default || 2,
      unidadVista: c.unidad_vista === 'unidades' ? 'unidades' : 'cajas',
      sucursalLK: c.sucursal_lk || 'Zuviria 5352- Villa Lugano',
      recordatorioPedido: c.recordatorio_pedido !== false,
      pedidoIntervaloDias: (n >= 1 && n <= 90) ? n : 15,
      emailRecordatorio: (c.email_recordatorio || '').trim()
    };
  }
  async function loadArticulos() {
    var r = await sb.from(T.art).select('*').eq('cod_cliente', COD_CLIENTE);
    var rows = r.data || [];
    if (!rows.length) { await seedArticulos(); r = await sb.from(T.art).select('*').eq('cod_cliente', COD_CLIENTE); rows = r.data || []; }
    state.articulos = rows.map(rowToArt);
  }
  async function loadMovimientos() {
    var res = await Promise.all([
      sb.from(T.ven).select('id,articulo_id,unidades,fecha,nota,quincena,created_at').eq('cod_cliente', COD_CLIENTE),
      sb.from(T.ent).select('id,articulo_id,unidades,fecha,nota').eq('cod_cliente', COD_CLIENTE),
      sb.from(T.aju).select('id,articulo_id,cantidad,fecha,nota').eq('cod_cliente', COD_CLIENTE)
    ]);
    state.movimientos = []
      .concat((res[0].data || []).map(ventaRowToMov))
      .concat((res[1].data || []).map(entregaRowToMov))
      .concat((res[2].data || []).map(ajusteRowToMov));
  }
  // Feriados nacionales AR (tabla compartida feriados_ar) → set ISO->true.
  async function loadFeriados() {
    try {
      var r = await sb.from('feriados_ar').select('fecha');
      var set = {};
      (r.data || []).forEach(function (x) { if (x && x.fecha) set[String(x.fecha).slice(0, 10)] = true; });
      state.feriados = set;
    } catch (e) { state.feriados = {}; }
  }
  function esFeriado(iso) { return !!(state.feriados && state.feriados[iso]); }
  // Fecha (ISO) del último pedido del cliente en `orders` (cualquier canal: formato
  // o catálogo mayorista). Sirve para no repetir el recordatorio si ya pidió.
  async function loadUltimoPedido() {
    state.ultimoPedidoFecha = null;
    if (!state.authUid) return;
    try {
      var r = await sb.from('orders').select('created_at')
        .eq('auth_user_id', state.authUid)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (r.data && r.data.created_at) state.ultimoPedidoFecha = String(r.data.created_at).slice(0, 10);
    } catch (e) { state.ultimoPedidoFecha = null; }
  }
  function getUltimoPedidoFecha() { return state.ultimoPedidoFecha; }
  // Marca "recién pedido" en memoria tras enviar, para suprimir el recordatorio al toque.
  function marcarPedidoEnviado(iso) { state.ultimoPedidoFecha = iso || hoyISO(); }
  // Pedidos del cliente ya en Supabase (cualquier canal) todavía sin entregar:
  // cod(MAYÚS) -> unidades en camino. RPC get_pedidos_en_camino (scopeado al cliente).
  async function loadEnCamino() {
    state.enCamino = {};
    if (!state.authUid) return;
    try {
      var r = await sb.rpc('get_pedidos_en_camino');
      (r.data || []).forEach(function (x) {
        var c = String((x && x.cod) || '').trim().toUpperCase();
        if (c) state.enCamino[c] = Math.max(0, Math.round(num(x.unidades, 0)));
      });
    } catch (e) { state.enCamino = {}; }
  }

  /* ---------- API pública ---------- */
  window.Store = {
    init: init,
    getMeta: getMeta, setMeta: setMeta,
    getUnidadVista: getUnidadVista, setUnidadVista: setUnidadVista,
    uxcDe: uxcDe, enVista: enVista, actualizarUxcDesde: actualizarUxcDesde,
    getArticulos: getArticulos, getArticulo: getArticulo,
    addArticulo: addArticulo, updateArticulo: updateArticulo, removeArticulo: removeArticulo,
    addMovimiento: addMovimiento, addMovimientosBatch: addMovimientosBatch,
    getMovimientos: getMovimientos, removeMovimiento: removeMovimiento,
    computeStocks: computeStocks, stockActual: stockActual, totales: totales,
    movimientosConSaldo: movimientosConSaldo,
    parseReporteVentas: parseReporteVentas, parseEntregas: parseEntregas,
    quincenaDe: quincenaDe, listaQuincenas: listaQuincenas,
    cargasVentas: cargasVentas, quincenaCargada: quincenaCargada,
    esFeriado: esFeriado, getUltimoPedidoFecha: getUltimoPedidoFecha, marcarPedidoEnviado: marcarPedidoEnviado,
    estado: estado, sugerido: sugerido, necesitaPedido: necesitaPedido, pedidoSugerido: pedidoSugerido,
    enCaminoDe: enCaminoDe,
    promedioMensual: promedioMensual, promedioMensualAuto: promedioMensualAuto,
    mesesPedido: mesesPedido, puntoPedido: puntoPedido,
    exportData: exportData, importData: importData, resetAll: resetAll, loadDemo: loadDemo,
    setSaveErrorHandler: function (fn) { onSaveError = fn; },
    placeholder: placeholder, hoyISO: hoyISO
  };
})();
