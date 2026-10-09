#!/bin/bash
# tests/run.sh — corre TODA la suite de la pagina LK y lista los rojos al final.
#
# POR QUE EXISTE (2026-09-23). Los tests de este repo estaban sueltos en tests/ y
# no los corria nadie: los hooks de git solo bumpean la version, no ejecutan nada.
# Un test que hay que acordarse de correr a mano es un test que no corre.
#
# ⚠ SIN `set -e` A PROPOSITO: con el corta en el primer rojo y nunca se sabe el
#   tamano del problema. Corre todo y despues dice que fallo.
#
# ⚠ AL AGREGAR UN TEST, AGREGARLO ACA. No se descubren solos, y un archivo suelto
#   en tests/ da la sensacion de estar cubierto sin estarlo.
#
# Correr:  bash tests/run.sh
cd "$(dirname "$0")/.." || exit 1
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
ROJOS=()
# ⚠ El total se CUENTA, no se escribe: estuvo clavado en 9 con 10 tests en la
#   lista. Un numero a mano se desfasa en el commit que agrega el test.
TOTAL=0
_correr() {
  echo "== $1 =="
  TOTAL=$((TOTAL + 1))
  if ! node "tests/$1"; then ROJOS+=("tests/$1"); fi
  echo
}

_correr css-balance.cjs
_correr payload-scope.cjs
_correr deuda-no-baja.cjs
_correr solo-agregar.cjs
_correr estado-gestion.cjs
_correr expreso-buscador.cjs
_correr expreso-render.cjs
_correr expreso-padron-caido.cjs
_correr expreso-galpon.cjs
_correr checkout-layout.cjs
_correr vendedor-repetir.cjs
_correr presupuesto.cjs
_correr perfil-sin-columna.cjs
_correr carrito-animacion.cjs
_correr oc-pdf-tyl.cjs
_correr redes-sin-autoplay.cjs
_correr redes-preview-3s.cjs
_correr popup-ver-video.cjs
_correr buscador-categoria.cjs
_correr ficha-hoja.cjs
_correr fc-acuerdo-desglose.cjs
_correr est-madre-unica.cjs
_correr lista-super-jumbo.cjs
_correr lista-super-sin-encabezado.cjs
_correr cencosud-cliente-chef.cjs
_correr alta-sin-login-frena.cjs
_correr reparar-auth-cuit-compartido.cjs
_correr ean-descarga.cjs

echo "======================================================================"
if [ ${#ROJOS[@]} -eq 0 ]; then
  echo "SUITE VERDE — $TOTAL corridas, 0 rojos"
else
  echo "SUITE EN ROJO — ${#ROJOS[@]} de $TOTAL:"
  for r in "${ROJOS[@]}"; do echo "  · $r"; done
  echo "======================================================================"
  exit 1
fi
echo "======================================================================"
