#!/usr/bin/env python3
"""
generar-catalogo.py — arma el catálogo público estático (sin precios).

Lee scripts/catalogo-data.json (foto de public.products, activos) y escribe:
  <SALIDA>/index.html            portada con una card por línea
  <SALIDA>/<slug>.html           una página por línea con todos sus artículos

POR QUÉ ESTÁTICO. Google indexa mejor HTML plano que una página que arma la
grilla con JavaScript, y estas páginas existen para posicionar términos de
producto ("abrelatas", "bombillas para mate", "coladores de acero inoxidable").
La web mayorista (mayorista.html) sigue siendo la única que muestra precios.

CÓMO REGENERAR. Exportar los productos activos a scripts/catalogo-data.json
(mismo formato) y correr:  python3 scripts/generar-catalogo.py
Las carpetas scripts/ no se suben al IIS (ver deploy-iis.yml); las páginas sí.

DÓNDE SE PUBLICA. SALIDA = "productos", que es adonde ya apuntan el botón
"VER PRODUCTOS ONLINE" (index.html:124) y el link "Productos" del pie
(index.html:829). Hasta el 16/09/2026 se creía que esa carpeta tenía el sitio
viejo (abrelatas.htm, coladores.html, quienes_somos.html) y por eso el catálogo
se generaba en /catalogo/. Es falso: Tomás verificó que la carpeta NO existe en
el IIS y que los dos links de la home dan error. Publicar acá arregla ese 404 y
reusa las URLs que Google ya tiene indexadas del sitio viejo.
"""
import json
import os
import re
from urllib.parse import quote

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATOS = os.path.join(RAIZ, "scripts", "catalogo-data.json")
SALIDA = "productos"
DOMINIO = "https://loekemeyer.com"

# Mismo helper de imágenes que script.js (products-images es un bucket público,
# fotos 400x400 WebP). IMG_PARAMS es el cache-buster; mantener el mismo valor
# que en script.js / historial.js / sugerencias.js.
SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co"
BASE_IMG = SUPABASE_URL + "/storage/v1/object/public/products-images/"
IMG_PARAMS = "?v=20260916"

WA_VENTAS = "5491131181021"
V = "23400"  # ?v= de assets; el hook pre-commit lo sincroniza en cada commit

# Mientras no se publiquen (no están linkeadas desde el sitio ni en el
# sitemap) van con noindex. Al publicar: NOINDEX = False y agregarlas al sitemap.
NOINDEX = True


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def img_url(prod):
    """URL de la foto, con el mismo criterio que productImgUrls() de script.js:
    si products.images está cargado manda ese nombre; si no, se deriva del código.

    Verificado el 16/09/2026 contra storage.objects: los 199 artículos activos
    terminan con foto. 196 la resuelven por código y 3 por products.images
    (514E, 516 y 590ES, este último apunta a 590E.webp porque es el mismo pincel
    vendido suelto). NO hardcodear excepciones acá: si falta una foto, se carga
    en la base o se sube al bucket, que es lo que lee también el mayorista."""
    if isinstance(prod, dict):
        for nombre in prod.get("imagenes") or []:
            n = str(nombre).strip()
            if n.startswith("http"):
                return n
            if not n.endswith(".webp"):
                n += ".webp"
            return BASE_IMG + quote(n) + IMG_PARAMS
        cod = prod.get("cod", "")
    else:
        cod = prod
    return BASE_IMG + quote(str(cod)) + ".webp" + IMG_PARAMS


def wa_url(texto):
    return f"https://wa.me/{WA_VENTAS}?text={quote(texto)}"


def head(titulo, descripcion, canonical, pref, extra_jsonld=None):
    robots = '<meta name="robots" content="noindex" /><!-- BORRADOR: quitar al publicar -->' if NOINDEX else ""
    jsonld = ""
    if extra_jsonld:
        jsonld = '<script type="application/ld+json">' + json.dumps(extra_jsonld, ensure_ascii=False) + "</script>"
    return f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{esc(titulo)}</title>
    <meta name="description" content="{esc(descripcion)}" />
    {robots}
    <link rel="canonical" href="{canonical}" />
    <meta property="og:title" content="{esc(titulo)}" />
    <meta property="og:description" content="{esc(descripcion)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="{canonical}" />
    <meta property="og:image" content="{DOMINIO}/img/img_landing.webp" />
    <link rel="icon" type="image/png" href="{pref}img/favicon.jpg" />
    <link rel="stylesheet" href="{pref}css/styles.index.css?v={V}" />
    <link rel="stylesheet" href="{pref}css/productos.css?v={V}" />
    <link rel="stylesheet" href="{pref}css/publico.css?v={V}" />
    {jsonld}
  </head>"""


def topbar(pref, activo):
    def a(href, txt, key):
        cur = ' aria-current="page"' if key == activo else ""
        return f'<a href="{href}"{cur}>{txt}</a>'
    return f"""
    <header class="prod-topbar">
      <div class="prod-topbar-row">
        <a class="prod-topbar-brand" href="{pref}index.html" aria-label="Inicio">
          <img src="{pref}img/logo.png" alt="Loekemeyer" class="logo-img" />
        </a>
        <nav class="prod-topbar-nav" aria-label="Secciones">
          {a(pref + SALIDA + "/index.html", "Productos", "productos")}
          {a(pref + "historia.html", "Historia", "historia")}
          <a class="prod-topbar-cta" href="{pref}mayorista.html">Pedido mayorista</a>
        </nav>
      </div>
    </header>"""


def footer(pref):
    return f"""
    <footer class="main-footer">
      <div class="container footer-grid">
        <div class="footer-brand">
          <img src="{pref}img/logo.png" alt="Loekemeyer" class="footer-logo" />
          <p>Cuarta generación de fabricantes de utensilios desde 1950.</p>
        </div>
        <div class="footer-contact">
          <div class="footer-item">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="white" d="M22 16.92v3a2 2 0 0 1-2.18 2A19.8 19.8 0 0 1 3 5.18 2 2 0 0 1 5 3h3a2 2 0 0 1 2 1.72c.12.81.3 1.6.54 2.36a2 2 0 0 1-.45 2.11L9 10a16 16 0 0 0 5 5l.81-.09a2 2 0 0 1 2.11.45c.76.24 1.55.42 2.36.54A2 2 0 0 1 22 16.92z"/></svg>
            <span>+54 9 11 3118 1021</span>
          </div>
          <div class="footer-item">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="white" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2l8 6 8-6"/></svg>
            <span>ventas@loekemeyer.com</span>
          </div>
          <div class="footer-item">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="white" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>
            <span>Cervantes 2868, Ciudad de Buenos Aires</span>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <div class="container footer-bottom-row">
          <span>© 2026 Loekemeyer Hnos S.R.L. — Todos los derechos reservados.
            <span data-app-version style="font-size: 11px; color: #9a9a9a; margin-left: 6px"></span></span>
          <div class="footer-links">
            <a href="{pref}{SALIDA}/index.html" class="footer-link">Productos</a>
            <a href="{pref}historia.html" class="footer-link">Historia</a>
            <a href="#" class="footer-link" data-modal="privacy">Política de privacidad</a>
            <a href="#" class="footer-link" data-modal="terms">Términos y condiciones</a>
          </div>
        </div>
      </div>
    </footer>

    <a class="wa" href="{wa_url('Hola Loekemeyer, quiero hablar con Ventas.')}" target="_blank" aria-label="WhatsApp" rel="noopener">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="30" height="30"><path fill="white" d="M16 3C9.4 3 4 8.3 4 14.9c0 2.4.7 4.7 2 6.6L4 29l7.7-2c1.8 1 3.9 1.5 6 1.5 6.6 0 12-5.3 12-11.9S22.6 3 16 3zm0 21.7c-1.9 0-3.7-.5-5.3-1.5l-.4-.2-4.6 1.2 1.2-4.4-.3-.4a9.7 9.7 0 0 1-1.6-5.4C5 9.5 9.9 4.8 16 4.8s11 4.7 11 10.5-4.9 9.4-11 9.4zm6-7c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.3c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.7s1.2 3.2 1.4 3.4c.2.2 2.4 3.6 5.8 5 .8.3 1.4.5 1.9.7.8.2 1.5.2 2.1.1.6-.1 1.9-.8 2.2-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z"/></svg>
    </a>

    <div class="modal-backdrop" id="legalModal" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="legalTitle">
        <button class="modal-close" type="button" aria-label="Cerrar">✕</button>
        <h3 id="legalTitle">Título</h3>
        <div class="modal-content" id="legalContent"></div>
      </div>
    </div>

    <script src="{pref}version.js?v={V}"></script>
    <script src="{pref}script.index.js?v={V}"></script>
    <script src="{pref}js/conversiones.js?v={V}"></script>
  </body>
</html>
"""


def card(p):
    badge = '<span class="prod-nuevo">NUEVO</span>' if p.get("badge") == "NUEVO" else ""
    uxb = f"{p['uxb']} unidades por caja" if p.get("uxb") else "consultar unidades por caja"
    sub = f'<p class="prod-meta">{esc(p["subcategoria"])}</p>' if p.get("subcategoria") else ""
    texto = f"Hola Loekemeyer, quiero consultar por el artículo {p['cod']} {p['nombre']}."
    return f"""
          <article class="prod-card" id="p-{esc(p['cod'])}">
            <div class="prod-thumb">
              <img src="{img_url(p)}" alt="{esc(p['nombre'])} Loekemeyer, código {esc(p['cod'])}" width="400" height="400" loading="lazy" onerror="this.onerror=null;this.src='IMGFALLBACK'" />
            </div>
            <div class="prod-body">
              <p class="prod-cod">{esc(p['cod'])}{badge}</p>
              <h3 class="prod-name">{esc(p['nombre'])}</h3>
              <p class="prod-meta">{uxb}</p>
              {sub}
              <a class="prod-cta" href="{wa_url(texto)}" target="_blank" rel="noopener" data-cod="{esc(p['cod'])}">Consultar disponibilidad</a>
            </div>
          </article>"""


def pagina_categoria(cat, todas):
    pref = "../"
    slug = cat["slug"]
    n = len(cat["productos"])
    titulo = f"{cat['nombre']} · Fabricante y mayorista · Loekemeyer"
    desc = f"{cat['intro']} {n} artículos de Loekemeyer Hnos S.R.L., fabricantes de utensilios de cocina desde 1950. Venta mayorista a todo el país."
    canonical = f"{DOMINIO}/{SALIDA}/{slug}.html"
    jsonld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": cat["nombre"],
        "url": canonical,
        "isPartOf": {"@type": "WebSite", "name": "Loekemeyer Hnos S.R.L.", "url": DOMINIO + "/"},
        "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Inicio", "item": DOMINIO + "/"},
            {"@type": "ListItem", "position": 2, "name": "Productos", "item": f"{DOMINIO}/{SALIDA}/"},
            {"@type": "ListItem", "position": 3, "name": cat["nombre"], "item": canonical}]},
    }
    # Subcategorías (Utensilios): subnav + subsecciones. El resto: una grilla.
    subs = []
    for p in cat["productos"]:
        s = p.get("subcategoria")
        if s and s not in subs:
            subs.append(s)
    cuerpo = ""
    if len(subs) > 1:
        cuerpo += '<nav class="prod-subnav" aria-label="Materiales">' + "".join(
            f'<a href="#{slugify(s)}">{esc(s)}</a>' for s in subs) + "</nav>"
        for s in subs:
            ps = [p for p in cat["productos"] if p.get("subcategoria") == s]
            cuerpo += f"""
        <section class="prod-subsection" id="{slugify(s)}">
          <h2 class="prod-subtitle">{esc(s)} <span class="prod-count">{len(ps)}</span></h2>
          <div class="prod-grid">{''.join(card(p) for p in ps)}
          </div>
        </section>"""
        resto = [p for p in cat["productos"] if not p.get("subcategoria")]
        if resto:
            cuerpo += f'<section class="prod-subsection"><h2 class="prod-subtitle">Otros <span class="prod-count">{len(resto)}</span></h2><div class="prod-grid">{"".join(card(p) for p in resto)}</div></section>'
    else:
        cuerpo += f'<div class="prod-grid">{"".join(card(p) for p in cat["productos"])}\n        </div>'

    otras = "".join(
        f'<a href="{c["slug"]}.html">{esc(c["nombre"])}</a>' for c in todas if c["slug"] != slug)
    html = head(titulo, desc, canonical, pref, jsonld) + f"""
  <body class="prod-page">{topbar(pref, "productos")}
    <main class="prod-main">
      <div class="pub-wrap">
        <nav class="prod-breadcrumb" aria-label="Ubicación">
          <a href="{pref}index.html">Inicio</a> › <a href="index.html">Productos</a> › <span aria-current="page">{esc(cat['nombre'])}</span>
        </nav>
        <div class="prod-head">
          <p class="pub-kicker">Línea de producto</p>
          <h1>{esc(cat['nombre'])}</h1>
          <p class="prod-intro">{esc(cat['intro'])} {n} artículos. Fabricantes desde 1950; venta mayorista por caja cerrada a comercios de todo el país.</p>
        </div>
        {cuerpo}
        <div class="prod-cta-block">
          <h2>¿Tenés un comercio?</h2>
          <p>Escribinos por WhatsApp: te damos de alta y accedés a la lista de precios y al pedido online.</p>
          <div class="catalogo-actions">
            <a class="btn-catalogo" href="{wa_url('Hola Loekemeyer, tengo un comercio y quiero comprar por mayor.')}" target="_blank" rel="noopener">Comprar por mayor por WhatsApp</a>
            <a class="btn-catalogo btn-catalogo--alt" href="{pref}pdf/catalogo.pdf" target="_blank" rel="noopener">Descargar catálogo PDF</a>
          </div>
        </div>
        <nav class="prod-subnav pub-otras" aria-label="Otras líneas"><span class="pub-otras-label">Otras líneas:</span>{otras}</nav>
      </div>
    </main>{footer(pref)}"""
    return html.replace("IMGFALLBACK", pref + "img/no-image.jpg")


def pagina_index(cats, total):
    pref = "../"
    titulo = "Utensilios de cocina · Productos Loekemeyer, fabricantes desde 1950"
    desc = (f"{total} utensilios de cocina en {len(cats)} líneas: abrelatas, pelapapas, sacacorchos, coladores, ralladores, "
            "bombillas, utensilios de acero inoxidable, nylon, silicona y madera. Fabricación propia en Buenos Aires y venta mayorista a todo el país.")
    canonical = f"{DOMINIO}/{SALIDA}/"
    jsonld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "Productos Loekemeyer",
        "url": canonical,
        "isPartOf": {"@type": "WebSite", "name": "Loekemeyer Hnos S.R.L.", "url": DOMINIO + "/"},
    }
    cards = ""
    for c in cats:
        primero = c["productos"][0]
        cards += f"""
          <a class="cat-card" href="{c['slug']}.html">
            <div class="cat-thumb"><img src="{img_url(primero)}" alt="{esc(c['nombre'])} Loekemeyer" width="400" height="400" loading="lazy" onerror="this.onerror=null;this.src='{pref}img/no-image.jpg'" /></div>
            <div class="cat-body">
              <h2 class="cat-name">{esc(c['nombre'])}</h2>
              <p class="cat-count">{len(c['productos'])} artículos</p>
            </div>
          </a>"""
    return head(titulo, desc, canonical, pref, jsonld) + f"""
  <body class="prod-page">{topbar(pref, "productos")}
    <main class="prod-main">
      <div class="pub-wrap">
        <nav class="prod-breadcrumb" aria-label="Ubicación">
          <a href="{pref}index.html">Inicio</a> › <span aria-current="page">Productos</span>
        </nav>
        <div class="prod-head">
          <p class="pub-kicker">Catálogo completo</p>
          <h1>Todos nuestros utensilios de cocina</h1>
          <p class="prod-intro">{total} artículos en {len(cats)} líneas. Fabricamos en Buenos Aires desde 1950. Sin precios: la lista mayorista se ve con tu usuario en la web mayorista, y el catálogo en PDF se descarga acá abajo.</p>
        </div>
        <div class="cat-grid">{cards}
        </div>
        <div class="prod-cta-block">
          <h2>Comprá directo a la fábrica</h2>
          <p>Supermercados, bazares, distribuidores y ferreterías de todo el país. Pedido online con seguimiento de entrega.</p>
          <div class="catalogo-actions">
            <a class="btn-catalogo" href="{wa_url('Hola Loekemeyer, tengo un comercio y quiero comprar por mayor.')}" target="_blank" rel="noopener">Comprar por mayor por WhatsApp</a>
            <a class="btn-catalogo btn-catalogo--alt" href="{pref}pdf/catalogo.pdf" target="_blank" rel="noopener">Descargar catálogo PDF</a>
          </div>
        </div>
      </div>
    </main>{footer(pref)}"""


def slugify(s):
    s = s.lower()
    s = re.sub(r"[áàä]", "a", s); s = re.sub(r"[éèë]", "e", s); s = re.sub(r"[íìï]", "i", s)
    s = re.sub(r"[óòö]", "o", s); s = re.sub(r"[úùü]", "u", s); s = s.replace("ñ", "n")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def main():
    with open(DATOS, encoding="utf-8") as f:
        datos = json.load(f)
    cats = sorted(datos["categorias"], key=lambda c: c["orden"])
    out = os.path.join(RAIZ, SALIDA)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(pagina_index(cats, datos["total"]))
    for c in cats:
        with open(os.path.join(out, c["slug"] + ".html"), "w", encoding="utf-8") as f:
            f.write(pagina_categoria(c, cats))
    print(f"{len(cats) + 1} páginas en {out}/ ({datos['total']} artículos)")


if __name__ == "__main__":
    main()
