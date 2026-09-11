// =============================================================================
// Edge Function: krikos-auto-import — entrypoint
// =============================================================================
// Importa SOLA la OC de súper que llega por Krikos: baja el PDF que guardó
// `krikos-ingest`, lo parsea con los MISMOS parsers del panel de LK y carga el
// pedido en `orders` / `order_items`. De ahí va solo a la PPP de Gestión por el
// camino de siempre (v_pedidos_match → lk_pedidos_match).
//
// El código vive en el repo (público) de Gestión Virgilio, clavado al commit:
//   admin/krikos-auto-import.js  ← la lógica
//   admin/krikos-parsers.js      ← los parsers, copiados textual de admin-supercot.js
// Se sirve por esm.sh porque el bundler de Supabase sólo acepta hosts conocidos
// (github.io lo rechaza). Al tocar cualquiera de los dos archivos: pushear allá y
// redeployar esta función con el sha nuevo — el commit fijo evita que un push
// cambie el importador sin que nadie se entere.
//
// Lo de la base (columnas auto_* y las 4 RPC krikos_auto_*) está en
// sql/krikos_auto_import.sql, con su rollback.
//
//   POST {}                         → importa lo pendiente (uso del cron)
//   POST { dry_run: true }          → no escribe nada, devuelve el diagnóstico
//   POST { ids: [10], force: true } → esas OC, salteando el guarda de vencidas
//   header  x-krikos-secret: <KRIKOS_INGEST_SECRET>
// =============================================================================

import { handler } from "https://esm.sh/gh/loekemeyer/Gestion-Virgilio@a55e1d0b18066ce6b7371ee4af9298156217d994/admin/krikos-auto-import.js";

Deno.serve(handler);
