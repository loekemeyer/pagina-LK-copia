#!/usr/bin/env python3
"""Exporta public.products a scripts/catalogo-data.json.

POR QUÉ EXISTE
--------------
Todo lo que se ve en productos/ sale de catalogo-data.json: los artículos, el
"9 artículos" de cada línea, el "199 artículos en 19 líneas" del índice y el
"+N" de los mosaicos. Ese archivo era un volcado a mano del 15/09/2026, así que
un artículo nuevo cargado en Supabase NO aparecía hasta que alguien repitiera
el volcado. Este script lo hace solo.

QUÉ NO SE AUTOGENERA
--------------------
El nombre público de la línea, su slug y sus dos textos —`intro` (qué hay en la
línea) y `cierre` (el dato propio de esa línea)— son escritos a mano y viven en
el JSON. Este script los CONSERVA: los busca por el nombre de categoría de la
base y los vuelve a escribir tal cual. Si aparece una categoría nueva, la agrega
igual pero con los dos textos vacíos y avisa fuerte, porque esa página va a
salir sin texto propio hasta que alguien lo escriba.

Lo que está en el medio —"9 artículos. Caja cerrada de 12 o 24 unidades."— lo
arma el generador con los datos, así que no hay que tocarlo nunca.

CÓMO SE USA
-----------
    python3 scripts/exportar-catalogo.py --verificar   # no escribe: dice qué cambió
    python3 scripts/exportar-catalogo.py               # reescribe el JSON
    python3 scripts/exportar-catalogo.py --generar     # reescribe el JSON y las 20 páginas

La clave es la publishable del proyecto, la misma que usa script.js en el
navegador: es pública por diseño. Nunca poner acá una service_role ni una
clave legacy (ver la regla de claves de Supabase en CLAUDE.md).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import date

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTINO = os.path.join(RAIZ, "scripts", "catalogo-data.json")

SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co"
CLAVE = "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML"
CAMPOS = "cod,description,category,subcategory,uxb,images,badge_status,orden_catalogo"
PAGINA = 500


def traer_filas():
    """Todos los productos activos, paginado. El Storage y el REST piden el
    header `apikey` además del Bearer: con la clave nueva, sin `apikey` da 403
    `Invalid Compact JWS`."""
    # active=eq.true: un artículo en FALSE no viaja, así que desaparece del
    # catálogo en la siguiente exportación. Es el filtro que define qué se
    # publica.
    filas, desde = [], 0
    while True:
        url = (f"{SUPABASE_URL}/rest/v1/products?select={CAMPOS}"
               f"&active=eq.true&order=orden_catalogo.asc.nullslast&order=cod.asc")
        req = urllib.request.Request(url, headers={
            "apikey": CLAVE,
            "Authorization": f"Bearer {CLAVE}",
            "Range": f"{desde}-{desde + PAGINA - 1}",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            lote = json.load(r)
        filas.extend(lote)
        if len(lote) < PAGINA:
            return filas
        desde += PAGINA


def slugify(s):
    s = s.lower()
    for a, b in (("áàä", "a"), ("éèë", "e"), ("íìï", "i"), ("óòö", "o"), ("úùü", "u")):
        s = re.sub(f"[{a}]", b, s)
    s = s.replace("ñ", "n")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def armar(filas, previo):
    """Agrupa por categoría conservando nombre, slug, intro y orden escritos a mano."""
    antes = {c["categoria"]: c for c in previo.get("categorias", [])}
    por_cat, nuevas = {}, []
    for f in filas:
        cat = (f.get("category") or "Sin categoría").strip()
        if cat not in por_cat:
            viejo = antes.get(cat)
            if viejo is None:
                nuevas.append(cat)
            por_cat[cat] = {
                "categoria": cat,
                "nombre": (viejo or {}).get("nombre", cat),
                "slug": (viejo or {}).get("slug", slugify(cat)),
                "intro": (viejo or {}).get("intro", ""),
                "cierre": (viejo or {}).get("cierre", ""),
                "orden": None,
                "_orden_previo": (viejo or {}).get("orden"),
                "productos": [],
            }
        oc = f.get("orden_catalogo")
        if oc is not None:
            c = por_cat[cat]
            c["orden"] = oc if c["orden"] is None else min(c["orden"], oc)
        cod = (f.get("cod") or "").strip()
        por_cat[cat]["productos"].append({
            "cod": cod,
            "nombre": (f.get("description") or "").strip(),
            "uxb": f.get("uxb"),
            "subcategoria": (f.get("subcategory") or None),
            "badge": (f.get("badge_status") or None),
            # El marcador de importado es la letra E DESPUÉS del número, no la
            # última letra del código: 590ES también es importado.
            "importado": "E" in re.sub(r"^\d+", "", cod.upper()),
            "imagenes": f.get("images") or [],
            "_orden": oc,
        })

    cats = []
    tope = max([c["orden"] for c in por_cat.values() if c["orden"]] or [0])
    for c in por_cat.values():
        if c["orden"] is None:                      # categoría sin orden_catalogo
            c["orden"] = c.pop("_orden_previo") or tope + 1000
        else:
            c.pop("_orden_previo", None)
        c["productos"].sort(key=lambda p: (p["_orden"] is None, p["_orden"], p["cod"]))
        for p in c["productos"]:
            p.pop("_orden", None)
        cats.append(c)
    cats.sort(key=lambda c: c["orden"])
    return {
        "generado": date.today().isoformat(),
        "fuente": ("public.products (active = true), proyecto kwkclwhmoygunqmlegrg. "
                   "El campo 'imagenes' es products.images tal cual: si está cargado "
                   "manda sobre el nombre derivado del código."),
        "total": sum(len(c["productos"]) for c in cats),
        "categorias": cats,
    }, nuevas


def comparar(viejo, nuevo):
    def indice(d):
        return {p["cod"]: (c["categoria"], p["nombre"], p["uxb"], p["badge"])
                for c in d.get("categorias", []) for p in c["productos"]}
    a, b = indice(viejo), indice(nuevo)
    altas = sorted(set(b) - set(a))
    bajas = sorted(set(a) - set(b))
    cambios = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    cats_a = {c["categoria"] for c in viejo.get("categorias", [])}
    cats_b = {c["categoria"] for c in nuevo["categorias"]}
    return altas, bajas, cambios, sorted(cats_b - cats_a), sorted(cats_a - cats_b)


def main():
    ap = argparse.ArgumentParser(description="Exporta public.products al JSON del catálogo.")
    ap.add_argument("--verificar", action="store_true", help="no escribe nada: sólo informa qué cambiaría")
    ap.add_argument("--generar", action="store_true", help="después de exportar, regenera las 20 páginas")
    args = ap.parse_args()

    previo = {}
    if os.path.exists(DESTINO):
        with open(DESTINO, encoding="utf-8") as f:
            previo = json.load(f)

    try:
        filas = traer_filas()
    except Exception as e:
        print(f"ERROR al leer Supabase: {e}", file=sys.stderr)
        print("Si estás detrás de un proxy que bloquea supabase.co, corré esto desde la red de la empresa.",
              file=sys.stderr)
        return 1

    nuevo, cats_sin_texto = armar(filas, previo)
    altas, bajas, cambios, cats_nuevas, cats_ida = comparar(previo, nuevo)

    print(f"Leídos {len(filas)} artículos activos en {len(nuevo['categorias'])} líneas.")
    for etiqueta, lista in (("artículos nuevos", altas), ("artículos dados de baja", bajas),
                            ("artículos con cambios", cambios), ("líneas nuevas", cats_nuevas),
                            ("líneas que desaparecen", cats_ida)):
        if lista:
            print(f"  {etiqueta} ({len(lista)}): {', '.join(lista[:12])}"
                  + (" …" if len(lista) > 12 else ""))
    if not any((altas, bajas, cambios, cats_nuevas, cats_ida)):
        print("  Sin cambios respecto del JSON actual.")

    if cats_sin_texto:
        print("\n*** ATENCIÓN: estas líneas son nuevas y quedaron SIN texto de presentación:")
        for c in cats_sin_texto:
            print(f"      {c}  -> completar 'intro' (y revisar 'nombre' y 'slug') en {os.path.basename(DESTINO)}")
        print("    La página se genera igual, pero sale sin bajada y pierde posicionamiento.\n")

    if args.verificar:
        print("Modo --verificar: no se escribió nada.")
        return 0

    with open(DESTINO, "w", encoding="utf-8") as f:
        json.dump(nuevo, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Escrito {DESTINO} ({nuevo['total']} artículos).")

    if args.generar:
        print("Regenerando las páginas…")
        subprocess.run([sys.executable, os.path.join(RAIZ, "scripts", "generar-catalogo.py")], check=True)
    else:
        print("Falta regenerar: python3 scripts/generar-catalogo.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
