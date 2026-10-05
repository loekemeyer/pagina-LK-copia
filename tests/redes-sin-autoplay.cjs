// tests/redes-sin-autoplay.cjs — «Contenido para tus redes» no reproduce solo.
//
// POR QUE (05/10/2026): cada <video> de la grilla tenia `autoplay`, asi que abrir
// la pantalla bajaba TODOS los videos completos del bucket products-videos
// (150 MB en un minuto, medido en los logs de Storage). Eso consume la
// transferencia mensual de Supabase que la organizacion comparte con Gestion.
// Ahora cada video baja recien cuando el cliente toca play.
//
// El preview de 3 s (05/10/2026) NO usa el atributo autoplay: lo arranca
// crPreviewIniciar por JS y le saca el src al terminar. Lo prueba
// tests/redes-preview-3s.cjs. Este candado sigue: el atributo no vuelve.
//
// Candado estatico sobre script.js: el <video class="cr-video"> tiene que ir
// SIN autoplay y con preload="none". Se corre sin comentarios para que el
// comentario que explica el cambio no cuente como codigo.
//
// Correr:  node tests/redes-sin-autoplay.cjs [ruta/a/script.js]
const fs = require("fs");
const path = require("path");

const archivo = process.argv[2] || path.join(__dirname, "..", "script.js");
const src = fs
  .readFileSync(archivo, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const tags = src.match(/<video class="cr-video"[^>]*>/g) || [];
const fallas = [];
if (tags.length === 0) fallas.push("no encontre el <video class=\"cr-video\"> de Contenido para tus redes");
tags.forEach((t) => {
  if (/\bautoplay\b/.test(t)) fallas.push("el video vuelve a tener autoplay: " + t);
  if (!/preload="none"/.test(t)) fallas.push("el video no tiene preload=\"none\": " + t);
});

if (fallas.length) {
  console.log("ROJO — redes-sin-autoplay");
  fallas.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("OK — redes-sin-autoplay (" + tags.length + " <video> sin autoplay, preload=none)");
