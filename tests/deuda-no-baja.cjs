// Candado (Luis, 07/10/2026): el navegador del CLIENTE no baja deuda ni límite de
// crédito. La leyenda D / LC / PP la calcula el servidor (trigger
// aa_orders_leyenda_servidor en orders + sheets-proxy v74). Si alguien vuelve a
// pedir debt / credit_limit en un select de customers de una pantalla de cliente,
// o a calcular la leyenda con customerProfile.debt, esto se pone en rojo.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..", process.argv[2] || ".");
const archivos = ["script.js", "osa/js/app.js", "vendor-import-excel.js"];
let fallas = 0;
for (const a of archivos) {
  const f = path.join(root, a);
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
  const strings = src.match(/["'`][^"'`\n]*\bcod_cliente\b[^"'`\n]*["'`]/g) || [];
  for (const s of strings) {
    if (/\b(debt|credit_limit)\b/.test(s)) { console.log(`FALLA ${a}: select con deuda -> ${s}`); fallas++; }
  }
  if (/customerProfile\??\.(debt|credit_limit)/.test(src)) { console.log(`FALLA ${a}: usa customerProfile.debt/credit_limit`); fallas++; }
  if (/\b(prof|order\.customer)\??\.(debt|credit_limit)/.test(src)) { console.log(`FALLA ${a}: lee debt/credit_limit del perfil`); fallas++; }
}
console.log(fallas ? `deuda-no-baja: ${fallas} fallas` : "deuda-no-baja: OK");
process.exit(fallas ? 1 : 0);
