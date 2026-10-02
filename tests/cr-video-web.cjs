#!/usr/bin/env node
/**
 * tests/cr-video-web.cjs — "Contenido para tus redes": la grilla reproduce la
 * versión WEB liviana y "Descargar" baja el ORIGINAL en calidad máxima.
 *
 * POR QUÉ EXISTE (Gastón, 02/10/2026). Dos pedidos juntos:
 *
 *   1. "Que queden más chicos y con menor peso en la web pero que después puedan
 *      descargarlo en máxima calidad". Abrir la galería bajaba TODOS los videos
 *      enteros (autoplay + preload, 7 videos = 99 MB). Ahora cada producto tiene
 *      dos archivos en el bucket products-videos: "<cod>.mp4" (original, el que
 *      se descarga) y "preview/<cod>.mp4" (H.264 ~480px, < 1 MB, el que se ve).
 *      Sin versión web, la grilla cae al original.
 *   2. "Que se pueda reproducir en todos los dispositivos sin problema". 6 de los
 *      7 videos cargados eran HEVC (H.265, el "Alta eficiencia" del iPhone), que
 *      Firefox y muchas PCs no reproducen. El upload del admin ahora exige MP4 y
 *      rechaza un archivo HEVC.
 *
 * Corre las funciones de script.js en Node (sin navegador). Verifica:
 *   A. videoWebUrlDeCod: con versión web da preview/<cod>.mp4; sin ella, el original
 *   B. videoUrlDeCod (lo que descarga crDescargarVideo) es SIEMPRE el original
 *   C. _crEsHevc marca hvc1 y hev1, y deja pasar avc1 (H.264)
 *   D. _crVideoNoCompatible frena .mov/.webm y HEVC, y deja pasar MP4 H.264
 *   E. la grilla no hace autoplay ni precarga, reproduce la versión web, y el
 *      upload sólo acepta video/mp4
 *
 * Correr:  node tests/cr-video-web.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
let fallas = 0;
function ok(cond, msg) {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fallas++;
}
function sacar(re, nombre) {
  const m = SRC.match(re);
  if (!m) {
    console.log("  ✗ no se encontró " + nombre + " en script.js");
    fallas++;
    return "";
  }
  return m[0];
}

const ctx = {
  console,
  Blob,
  Uint8Array,
  encodeURIComponent,
  VIDEO_BASE: "https://x.supabase.co/storage/v1/object/public/products-videos/",
  PRODUCT_VIDEO_MAP: null,
  PRODUCT_VIDEO_WEB_MAP: null,
};
vm.createContext(ctx);
const codigo = [
  sacar(/const VIDEO_WEB_DIR = "preview";/, "VIDEO_WEB_DIR"),
  sacar(/function videoUrlDeCod\(cod\) \{[\s\S]*?\n\}\n/, "videoUrlDeCod"),
  sacar(/function videoWebUrlDeCod\(cod\) \{[\s\S]*?\n\}\n/, "videoWebUrlDeCod"),
  sacar(/async function _crEsHevc\(file\) \{[\s\S]*?\n\}\n/, "_crEsHevc"),
  sacar(/async function _crVideoNoCompatible\(file\) \{[\s\S]*?\n\}\n/, "_crVideoNoCompatible"),
].join("\n");
vm.runInContext(codigo + "\nthis.VIDEO_WEB_DIR = VIDEO_WEB_DIR;", ctx);

(async () => {
  console.log("A/B. URLs de reproducción y de descarga");
  vm.runInContext(
    'PRODUCT_VIDEO_MAP = new Map([["599E","599E.mp4"],["518","518.mp4"]]);' +
      'PRODUCT_VIDEO_WEB_MAP = new Map([["599E","599E.mp4"]]);',
    ctx,
  );
  const web599 = vm.runInContext('videoWebUrlDeCod("599E")', ctx);
  const web518 = vm.runInContext('videoWebUrlDeCod("518")', ctx);
  const dl599 = vm.runInContext('videoUrlDeCod("599E")', ctx);
  ok(/\/products-videos\/preview\/599E\.mp4$/.test(web599), "con versión web, la grilla reproduce preview/599E.mp4");
  ok(/\/products-videos\/518\.mp4$/.test(web518), "sin versión web, la grilla cae al original 518.mp4");
  ok(/\/products-videos\/599E\.mp4$/.test(dl599) && !/preview/.test(dl599), "Descargar baja el ORIGINAL, nunca la versión web");
  ok(vm.runInContext('videoWebUrlDeCod("999")', ctx) === null, "sin video, null");

  const blob = (txt) => new Blob([Buffer.from("....ftypisom" + txt + "....", "latin1")]);
  console.log("C. detector de HEVC");
  ok((await ctx._crEsHevc(blob("stsd....hvc1"))) === true, "hvc1 → HEVC");
  ok((await ctx._crEsHevc(blob("stsd....hev1"))) === true, "hev1 → HEVC");
  ok((await ctx._crEsHevc(blob("stsd....avc1"))) === false, "avc1 (H.264) → no es HEVC");
  // la marca puede estar al final del archivo (moov al final)
  const grande = new Blob([Buffer.alloc(9 * 1024 * 1024, 0x20), Buffer.from("hvc1", "latin1")]);
  ok((await ctx._crEsHevc(grande)) === true, "hvc1 al final de un archivo de 9 MB → HEVC");

  console.log("D. qué archivos acepta el upload");
  const f = (nombre, tipo, txt) =>
    Object.assign(new Blob([Buffer.from(txt, "latin1")], { type: tipo }), { name: nombre });
  ok(!!(await ctx._crVideoNoCompatible(f("a.mov", "video/quicktime", "avc1"))), ".mov → frena");
  ok(!!(await ctx._crVideoNoCompatible(f("a.webm", "video/webm", "vp09"))), ".webm → frena");
  ok(!!(await ctx._crVideoNoCompatible(f("a.mp4", "video/mp4", "hvc1"))), "MP4 en HEVC → frena");
  ok((await ctx._crVideoNoCompatible(f("a.mp4", "video/mp4", "avc1"))) === null, "MP4 H.264 → pasa");

  console.log("E. la grilla");
  const render = sacar(/function crRender\(\) \{[\s\S]*?\nwindow\.crRender = crRender;/, "crRender");
  const tagVideo = (render.match(/<video class="cr-video"[\s\S]*?<\/video>/) || [""])[0];
  ok(tagVideo && !/autoplay/.test(tagVideo), "el <video> no hace autoplay (arranca sólo el que se ve)");
  ok(/preload="none"/.test(tagVideo), 'el <video> no precarga (preload="none")');
  ok(/src="\$\{webUrl\}"/.test(tagVideo), "el <video> reproduce la versión web");
  ok(/_crObservarVideos\(grid\)/.test(render), "la grilla engancha el observador que reproduce lo visible");
  ok(!/accept="video\/mp4,video\/quicktime/.test(render) && /accept="video\/mp4"/.test(render), "los uploads aceptan sólo video/mp4");
  const desc = sacar(/async function crDescargarVideo\(cod, btn\) \{[\s\S]*?\n\}\n/, "crDescargarVideo");
  ok(/const url = videoUrlDeCod\(cod\)/.test(desc), "crDescargarVideo usa videoUrlDeCod (el original)");

  console.log(fallas ? `\n${fallas} falla(s)` : "\nOK");
  process.exit(fallas ? 1 : 0);
})();
