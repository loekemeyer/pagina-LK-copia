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
IMG_PARAMS = ""  # se completa en main() con la fecha de la exportación

WA_VENTAS = "5491131181021"
def _v_actual():
    """?v= de assets = versión de version.js sin puntos (2.3.522 -> 23522), el
    mismo valor que pone el hook pre-commit. Antes era un literal que quedaba
    viejo y cada regeneración desfasaba el cache-busting de las 20 páginas."""
    try:
        with open(os.path.join(RAIZ, "version.js"), encoding="utf-8") as f:
            m = re.search(r'APP_VERSION = "(\d+)\.(\d+)\.(\d+)"', f.read())
        return "".join(m.groups()) if m else "0"
    except OSError:
        return "0"


V = _v_actual()  # el hook pre-commit lo vuelve a sincronizar en cada commit

# Mientras no se publiquen (no están linkeadas desde el sitio ni en el
# sitemap) van con noindex. Al publicar: NOINDEX = False y agregarlas al sitemap.
NOINDEX = True

# Fichas individuales: una URL estable por artículo, armada SOLO con el código.
# El nombre cambia (se corrige una tilde, se renombra) y el código no, así que
# la URL no se mueve. productos/articulo/<cod>.html
SUB_ART = "articulo"

# MATERIAL, LAVAVAJILLAS, LAVADO, DESCRIPCIÓN y DESTACADO salen SOLO de
# scripts/fichas-manual.csv, que completa la empresa a mano (04/10/2026: "no
# inventes que un artículo es de acero inoxidable si yo no te lo dije"). Ni la
# subcategoría ni el nombre se usan para deducir material.
MANUAL = os.path.join(RAIZ, "scripts", "fichas-manual.csv")
DONDE = os.path.join(RAIZ, "scripts", "donde-comprar.json")
PAG_DONDE = "donde-comprar.html"

MARCA = {"@type": "Brand", "name": "Loekemeyer"}
ORG_ID = DOMINIO + "/#organizacion"
WEB_ID = DOMINIO + "/#sitio"


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


def head(titulo, descripcion, canonical, pref, extra_jsonld=None, og_image=None, og_type="website"):
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
    <meta property="og:type" content="{og_type}" />
    <meta property="og:url" content="{canonical}" />
    <meta property="og:image" content="{og_image or DOMINIO + '/img/img_landing.webp'}" />
    <meta property="og:site_name" content="Loekemeyer" />
    <meta property="og:locale" content="es_AR" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/png" href="{pref}img/favicon.jpg" />
    <link rel="stylesheet" href="{pref}css/styles.index.css?v={V}" />
    <link rel="stylesheet" href="{pref}css/productos.css?v={V}" />
    <link rel="stylesheet" href="{pref}css/ficha.css?v={V}" />
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
          {a(pref + SALIDA + "/" + PAG_DONDE, "Dónde comprar", "donde")}
          <a class="prod-topbar-cta" href="{pref}mayorista.html">Pedido mayorista</a>
        </nav>
      </div>
    </header>"""


def footer(pref, extra=""):
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
    <script src="{pref}js/catalogo-vivo.js?v={V}" defer></script>{extra}
  </body>
</html>
"""


def firma(ps):
    """Los códigos que la página ya tiene pintados. catalogo-vivo.js compara
    contra esto: si coincide con lo que devuelve Supabase, no toca nada."""
    return "|".join(p["cod"] for p in ps)


def bajada(cat):
    """Las tres partes del texto de una línea:
       1. intro   — qué hay en la línea, escrito a mano en el JSON
       2. derivado — cuántos artículos y cómo se despacha, sacado de los datos
       3. cierre  — el dato propio de esa línea, escrito a mano en el JSON
    Antes las 19 páginas cerraban con la MISMA frase ("Fabricantes desde 1950;
    venta mayorista por caja cerrada a comercios de todo el país"). Además de
    sonar a plantilla, Google lo lee como contenido duplicado entre páginas del
    mismo sitio.
    """
    ps = cat["productos"]
    n = len(ps)
    cajas = sorted({p["uxb"] for p in ps if p.get("uxb")})
    art = f"{n} artículos" if n != 1 else "1 artículo"
    if not cajas:
        medio = f"{art}."
    elif len(cajas) == 1:
        medio = f"{art}. Caja cerrada de {cajas[0]} unidades."
    else:
        lista = ", ".join(str(c) for c in cajas[:-1]) + f" o {cajas[-1]}"
        medio = f"{art}. Caja cerrada de {lista} unidades."
    partes = [cat["intro"].strip(), medio, (cat.get("cierre") or "").strip()]
    return " ".join(x for x in partes if x)


def url_art(cod, pref=""):
    return f"{pref}{SUB_ART}/{quote(str(cod))}.html"


def card(p, hnivel=3):
    """Una ficha del mosaico, para las páginas de línea.

    Adentro de una línea la ficha va en mosaico: el comercio reconoce el
    artículo por la foto, que es distinta artículo por artículo. La lista
    quedó para el índice de líneas, donde la miniatura es la foto de un
    artículo cualquiera y no representa a la línea entera.
    """
    badge = '<span class="prod-nuevo">NUEVO</span>' if p.get("badge") == "NUEVO" else ""
    uxb = f"{p['uxb']} unidades por caja" if p.get("uxb") else "consultar unidades por caja"
    sub = f'<p class="prod-meta">{esc(p["subcategoria"])}</p>' if p.get("subcategoria") else ""
    texto = f"Hola Loekemeyer, quiero consultar por el artículo {p['cod']} {p['nombre']}."
    return f"""
          <article class="prod-card" id="p-{esc(p['cod'])}">
            <div class="prod-thumb">
              <a href="{url_art(p['cod'])}" tabindex="-1"><img src="{img_url(p)}" alt="{esc(p['nombre'])} Loekemeyer, código {esc(p['cod'])}" width="400" height="400" loading="lazy" onerror="this.onerror=null;this.src='IMGFALLBACK'" /></a>
            </div>
            <div class="prod-body">
              <p class="prod-cod">{esc(p['cod'])}{badge}</p>
              <h{hnivel} class="prod-name"><a href="{url_art(p['cod'])}">{esc(p['nombre'])}</a></h{hnivel}>
              <p class="prod-meta">{uxb}</p>
              {sub}
              <a class="prod-cta" href="{wa_url(texto)}" target="_blank" rel="noopener" data-cod="{esc(p['cod'])}">Consultar disponibilidad</a>
            </div>
          </article>"""


def lista(ps, hnivel=3):
    """Mosaico de fichas. Se llama lista() por compatibilidad con las tres
    llamadas de pagina_categoria(); devuelve la grilla. hnivel: h2 si la
    página no tiene subsecciones (cuelga del H1), h3 si cuelga de un H2."""
    return '<div class="prod-grid">' + "".join(card(p, hnivel) for p in ps) + "\n        </div>"


def pagina_categoria(cat, todas):
    pref = "../"
    slug = cat["slug"]
    n = len(cat["productos"])
    titulo = f"{cat['nombre']} · Fabricante y mayorista · Loekemeyer"
    desc = f"{bajada(cat)} Loekemeyer Hnos S.R.L., fabricantes de utensilios de cocina desde 1950."
    canonical = f"{DOMINIO}/{SALIDA}/{slug}.html"
    jsonld = {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": cat["nombre"],
        "description": bajada(cat),
        "url": canonical,
        "inLanguage": "es-AR",
        "isPartOf": {"@type": "WebSite", "@id": WEB_ID, "name": "Loekemeyer", "url": DOMINIO + "/"},
        "publisher": {"@id": ORG_ID},
        "mainEntity": {"@type": "ItemList", "numberOfItems": n, "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "url": f"{DOMINIO}/{SALIDA}/{url_art(p['cod'])}",
             "name": p["nombre"]} for i, p in enumerate(cat["productos"])]},
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
        <section class="prod-subsection" id="{slugify(s)}" data-sub="{esc(s)}">
          <h2 class="prod-subtitle">{esc(s)} <span class="prod-count">{len(ps)}</span></h2>
          {lista(ps)}
        </section>"""
        resto = [p for p in cat["productos"] if not p.get("subcategoria")]
        if resto:
            cuerpo += f'<section class="prod-subsection" data-sub=""><h2 class="prod-subtitle">Otros <span class="prod-count">{len(resto)}</span></h2>{lista(resto)}</section>'
    else:
        cuerpo += lista(cat["productos"], 2)

    otras = "".join(
        f'<a href="{c["slug"]}.html">{esc(c["nombre"])}</a>' for c in todas if c["slug"] != slug)
    html = head(titulo, desc, canonical, pref, jsonld) + f"""
  <body class="prod-page">{topbar(pref, "productos")}
    <main class="prod-main" data-catalogo="linea" data-categoria="{esc(cat['categoria'])}" data-firma="{esc(firma(cat['productos']))}" data-vfoto="{IMG_PARAMS}">
      <div class="pub-wrap">
        <nav class="prod-breadcrumb" aria-label="Ubicación">
          <a href="{pref}index.html">Inicio</a> › <a href="index.html">Productos</a> › <span aria-current="page">{esc(cat['nombre'])}</span>
        </nav>
        <div class="prod-head">
          <p class="pub-kicker">Línea de producto</p>
          <h1>{esc(cat['nombre'])}</h1>
          <p class="prod-intro" data-intro="{esc(cat['intro'])}" data-cierre="{esc(cat.get('cierre',''))}">{esc(bajada(cat))}</p>
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
        "description": desc,
        "url": canonical,
        "inLanguage": "es-AR",
        "isPartOf": {"@type": "WebSite", "@id": WEB_ID, "name": "Loekemeyer", "url": DOMINIO + "/"},
        "publisher": {"@id": ORG_ID},
        "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Inicio", "item": DOMINIO + "/"},
            {"@type": "ListItem", "position": 2, "name": "Productos", "item": canonical}]},
        "mainEntity": {"@type": "ItemList", "numberOfItems": len(cats), "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "url": f"{DOMINIO}/{SALIDA}/{c['slug']}.html",
             "name": c["nombre"]} for i, c in enumerate(cats)]},
    }
    # El índice vuelve al mosaico, pero cada cuadro muestra HASTA CUATRO
    # artículos de la línea, al estilo de WhatsApp, y el cuarto lleva el
    # "+N" con los que faltan. Así la miniatura deja de ser la foto de un
    # artículo cualquiera —el primer pelador no representa a los nueve— y
    # pasa a ser una muestra de la línea.
    cards = ""
    for c in cats:
        ps = c["productos"]
        n = len(ps)
        muestra = ps[:4]
        resto = n - 3 if n > 4 else 0      # 9 artículos -> 3 a la vista y "+6"
        celdas = ""
        for i, prod in enumerate(muestra):
            mas = f'<span class="cat-mas">+{resto}</span>' if (resto and i == 3) else ""
            celdas += (f'<span class="cat-celda"><img src="{img_url(prod)}" alt="" width="400" height="400" '
                       f'loading="lazy" onerror="this.onerror=null;this.src=\'{pref}img/no-image.jpg\'" />{mas}</span>')
        cards += f"""
          <a class="cat-card" href="{c['slug']}.html" data-categoria="{esc(c['categoria'])}">
            <div class="cat-mosaico cat-mosaico--{min(n, 4)}" role="img" aria-label="{esc(c['nombre'])} Loekemeyer">{celdas}</div>
            <div class="cat-body">
              <h2 class="cat-name">{esc(c['nombre'])}</h2>
              <p class="cat-count">{n} artículos</p>
            </div>
          </a>"""
    cards = '<div class="cat-grid">' + cards + "\n        </div>"

    return head(titulo, desc, canonical, pref, jsonld) + f"""
  <body class="prod-page">{topbar(pref, "productos")}
    <main class="prod-main" data-catalogo="indice" data-firma="{esc(firma([p for c in cats for p in c['productos']]))}" data-vfoto="{IMG_PARAMS}">
      <div class="pub-wrap">
        <nav class="prod-breadcrumb" aria-label="Ubicación">
          <a href="{pref}index.html">Inicio</a> › <span aria-current="page">Productos</span>
        </nav>
        <div class="prod-head">
          <p class="pub-kicker">Catálogo completo</p>
          <h1>Todos nuestros utensilios de cocina</h1>
          <p class="prod-intro" data-intro="{total} artículos en {len(cats)} líneas. Fabricamos en Buenos Aires desde 1950. Sin precios: la lista mayorista se ve con tu usuario en la web mayorista, y el catálogo en PDF se descarga acá abajo.">{total} artículos en {len(cats)} líneas. Fabricamos en Buenos Aires desde 1950. Sin precios: la lista mayorista se ve con tu usuario en la web mayorista, y el catálogo en PDF se descarga acá abajo.</p>
        </div>
        {cards}
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


# La frase de marca rota entre tres versiones (elegida por el código, así es
# estable entre corridas): 199 páginas con la misma oración son contenido
# duplicado para un buscador. Las tres dicen lo mismo y sólo lo verificado:
# marca argentina, desde 1950, cuarta generación.
FRASES_MARCA = [
    "Loekemeyer es una marca argentina de utensilios de cocina con trayectoria desde 1950; hoy la cuarta generación de la familia sigue al frente.",
    "Detrás está Loekemeyer, marca argentina de utensilios de cocina que acompaña a las cocinas del país desde 1950 y hoy conduce la cuarta generación de la familia.",
    "Es un producto Loekemeyer, la marca argentina de utensilios de cocina que nació en 1950 y que hoy, en su cuarta generación, sigue en manos de la misma familia.",
]


def frase_marca(cod):
    return FRASES_MARCA[sum(ord(ch) for ch in str(cod)) % len(FRASES_MARCA)]


def frase_art(p, cat, man=None):
    """Descripción de la ficha: nombre, código, línea y la frase de marca. La
    descripción propia sólo si está en fichas-manual.csv.
    No dice que la empresa FABRICÓ el artículo: hay importados."""
    man = man or {}
    partes = [f"{p['nombre']} Loekemeyer, código {p['cod']}, de la línea {cat['nombre']}."]
    if man.get("descripcion"):
        partes.append(man["descripcion"].rstrip(".") + ".")
    # El destacado NO va acá: ya sale en su recuadro arriba del texto, y en el
    # JSON-LD la description lo repetiría dos veces.
    partes.append(frase_marca(p["cod"]))
    return " ".join(partes)


def cargar_manual():
    """fichas-manual.csv (separador ';', lo abre Excel). Columnas: cod, nombre,
    linea, material, apto_lavavajillas (Sí/No), instrucciones_lavado,
    descripcion, destacado. Celda vacía = no se publica nada de ese dato."""
    import csv
    if not os.path.exists(MANUAL):
        return {}
    with open(MANUAL, encoding="utf-8-sig", newline="") as f:
        return {r["cod"].strip(): {k: (v or "").strip() for k, v in r.items()}
                for r in csv.DictReader(f, delimiter=";") if r.get("cod")}


def cargar_donde():
    if not os.path.exists(DONDE):
        return {"comercios": [], "articulos": {}, "mercadolibre": ""}
    with open(DONDE, encoding="utf-8") as f:
        return json.load(f)


def lavavajillas(v):
    v = (v or "").strip().lower()
    if v in ("si", "sí", "s", "true", "1", "apto"):
        return "Sí"
    if v in ("no", "n", "false", "0", "no apto"):
        return "No"
    return ""


def seccion(titulo, cuerpo, id_=""):
    """Bloque desplegable de la ficha. <details open>: se lee y se indexa entero
    sin JavaScript, y quien quiera lo pliega."""
    ida = f' id="{id_}"' if id_ else ""
    return (f'<details class="art-sec" open{ida}><summary><h2>{titulo}</h2></summary>'
            f'<div class="art-sec-cuerpo">{cuerpo}</div></details>')


# Logos de los comercios (img/ del sitio). Un comercio sin logo NO se muestra
# en la ficha: la sección lleva sólo logos (Thomas, 05/10/2026). Para sumar uno,
# se agrega el archivo a img/ y la línea acá.
LOGOS_COMERCIO = {
    "jumbo": "jumbo_logo.png",
    "coto": "coto_logo.png",
    "laanonima": "laanonima_logo.png",
    "masonline": "changomas_logo.png",
}


def secciones_donde(p, donde, pref):
    """«Comercios que trabajan este artículo»: sólo los logos, cada uno con link a
    la tienda del comercio. Sin texto, sin Mercado Libre (se sacó «¿Dónde lo
    puedo comprar?» el 05/10/2026)."""
    ids = donde.get("articulos", {}).get(p["cod"], [])
    por_id = {c["id"]: c for c in donde.get("comercios", [])}
    logos = "".join(
        f'<li><a href="{esc(por_id[i]["url"])}" target="_blank" rel="noopener nofollow" title="{esc(por_id[i]["nombre"])}">'
        f'<img src="{pref}img/{LOGOS_COMERCIO[i]}" alt="{esc(por_id[i]["nombre"])}" loading="lazy" /></a></li>'
        for i in ids if i in por_id and i in LOGOS_COMERCIO)
    return seccion("Comercios que trabajan este artículo", f'<ul class="art-logos">{logos}</ul>') if logos else ""


def texto_cuidado(lav, lavado):
    """La frase de «Cuidado y lavado». La usan la ficha pública y el popup del
    catálogo mayorista (fichas.json), así dicen exactamente lo mismo."""
    txt = []
    if lav == "Sí":
        txt.append("Se puede lavar en lavavajillas.")
    elif lav == "No":
        txt.append("No es apto para lavavajillas.")
    if lavado:
        txt.append(lavado.rstrip(".") + ".")
    return " ".join(txt)


def pagina_articulo(p, cat, manual=None, donde=None):
    pref = "../../"
    cod = p["cod"]
    man = (manual or {}).get(str(cod), {})
    donde = donde or {}
    canonical = f"{DOMINIO}/{SALIDA}/{url_art(cod)}"
    url_linea = f"{DOMINIO}/{SALIDA}/{cat['slug']}.html"
    titulo = f"{p['nombre']} · Código {cod} · Loekemeyer"
    desc = frase_art(p, cat, man)
    meta_desc = (f"{p['nombre']} Loekemeyer, código {cod}, línea {cat['nombre']}. "
                 + (man["destacado"].rstrip(".") + ". " if man.get("destacado") else "")
                 + "Marca argentina de utensilios de cocina desde 1950.")
    mat = man.get("material", "")
    lav = lavavajillas(man.get("apto_lavavajillas"))
    lavado = man.get("instrucciones_lavado", "")
    foto = img_url(p)
    props = []
    if lav:
        props.append({"@type": "PropertyValue", "name": "Apto lavavajillas", "value": lav})
    prod_ld = {
        "@type": "Product",
        "@id": canonical + "#producto",
        "name": p["nombre"],
        "sku": cod,
        "image": foto,
        "description": desc,
        "brand": MARCA,
        "category": cat["nombre"],
        "url": canonical,
    }
    if mat:
        prod_ld["material"] = mat
    if props:
        prod_ld["additionalProperty"] = props
    # Sin "offers": la web pública no tiene precio y no se inventa. Sin
    # reviews ni ratings por la misma razón (los de Mercado Libre no son
    # nuestros y Google no acepta reseñas de terceros marcadas como propias).
    jsonld = {"@context": "https://schema.org", "@graph": [
        prod_ld,
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Inicio", "item": DOMINIO + "/"},
            {"@type": "ListItem", "position": 2, "name": "Productos", "item": f"{DOMINIO}/{SALIDA}/"},
            {"@type": "ListItem", "position": 3, "name": cat["nombre"], "item": url_linea},
            {"@type": "ListItem", "position": 4, "name": p["nombre"], "item": canonical}]},
    ]}
    badge = '<span class="prod-nuevo">NUEVO</span>' if p.get("badge") == "NUEVO" else ""
    # Datos: sólo lo que NO está ya a la vista (Thomas, 05/10/2026: código, línea,
    # marca y unidades por caja repetían la pastilla COD, el breadcrumb y la
    # descripción). Material y lavavajillas, y sólo si están en fichas-manual.csv.
    col = []
    if mat:
        col.append(("Material", esc(mat)))
    if lav:
        col.append(("Apto lavavajillas", lav))
    dl = ('<dl class="art-tabla">' + "".join(f"<div><dt>{k}:</dt> <dd>{v}</dd></div>" for k, v in col) + "</dl>"
          ) if col else ""
    destacado = (f'<span class="art-destacado"><span aria-hidden="true">★</span> {esc(man["destacado"])}</span>'
                 if man.get("destacado") else "")
    txt_cuidado = texto_cuidado(lav, lavado)
    cuidado = seccion("Cuidado y lavado", f"<p>{esc(txt_cuidado)}</p>") if txt_cuidado else ""
    # Relacionados: los vecinos de la misma línea (misma subcategoría primero).
    vec = [q for q in cat["productos"] if q["cod"] != cod]
    vec.sort(key=lambda q: 0 if q.get("subcategoria") == p.get("subcategoria") else 1)
    rel = "".join(
        f'<li><a href="{quote(str(q["cod"]))}.html"><img src="{img_url(q)}" alt="{esc(q["nombre"])} Loekemeyer, código {esc(q["cod"])}" '
        f'width="400" height="400" loading="lazy" onerror="this.onerror=null;this.src=\'{pref}img/no-image.jpg\'" />'
        f'<span class="prod-cod">{esc(q["cod"])}</span><span class="art-rel-nombre">{esc(q["nombre"])}</span></a></li>'
        for q in vec[:6])
    texto = f"Hola Loekemeyer, tengo un comercio y quiero consultar por el artículo {cod} {p['nombre']}."
    # «Agregar al pedido» + precio: los pinta js/ficha-compra.js SÓLO si hay una
    # sesión iniciada en el sitio (la misma de mayorista). Sin sesión queda el
    # link de WhatsApp para el comercio, igual que antes.
    scripts_compra = (
        '\n    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0"></script>'
        f'\n    <script src="{pref}js/ficha-compra.js?v={V}" defer></script>')
    return head(titulo, meta_desc, canonical, pref, jsonld, og_image=foto, og_type="product") + f"""
  <body class="prod-page">{topbar(pref, "productos")}
    <main class="prod-main">
      <div class="pub-wrap art-wrap">
        <article class="art-ficha">
          <aside class="art-izq">
            <nav class="prod-breadcrumb" aria-label="Ubicación">
              <a href="{pref}index.html">Inicio</a> › <a href="../index.html">Productos</a> › <a href="../{cat['slug']}.html">{esc(cat['nombre'])}</a> › <span aria-current="page">{esc(p['nombre'])}</span>
            </nav>
            <figure class="art-foto">
              <img src="{foto}" alt="{esc(p['nombre'])} Loekemeyer, código {esc(cod)}" width="400" height="400" fetchpriority="high" onerror="this.onerror=null;this.src='{pref}img/no-image.jpg'" />
            </figure>
          </aside>
          <div class="art-datos">
            <h1>{esc(p['nombre'])}</h1>
            <p class="art-cabecera"><span class="art-cod">COD {esc(cod)}</span>{badge}{destacado}</p>
            <p class="art-desc">{esc(desc)}</p>
            {'<div class="art-tablas">' + dl + '</div>' if dl else ''}
            <div class="art-compra" id="artCompra" data-cod="{esc(cod)}">
              <a class="prod-cta" href="{wa_url(texto)}" target="_blank" rel="noopener" data-cod="{esc(cod)}">Soy comercio: consultar por WhatsApp</a>
            </div>
            <hr class="art-sep" />
            {cuidado}
            {secciones_donde(p, donde, pref)}
            {seccion("Sobre la línea " + esc(cat["nombre"]), f'<p>{esc(bajada(cat))}</p><p><a href="../{cat["slug"]}.html">Ver los {len(cat["productos"])} artículos de {esc(cat["nombre"])}</a> · <a href="../index.html">Todo el catálogo</a></p>')}
            {seccion("Otros artículos de " + esc(cat["nombre"]), f'<ul class="art-rel-grid">{rel}</ul>') if rel else ''}
          </div>
        </article>
      </div>
    </main>{footer(pref, scripts_compra)}"""


def pagina_donde(cats, donde):
    """Página para el consumidor final: Loekemeyer no vende al público, así que
    en vez de un callejón sin salida le decimos dónde sí."""
    pref = "../"
    canonical = f"{DOMINIO}/{SALIDA}/{PAG_DONDE}"
    titulo = "Dónde comprar productos Loekemeyer · Supermercados y Mercado Libre"
    desc = ("Loekemeyer vende por mayor a comercios. Para comprar una unidad: Mercado Libre, Jumbo, Disco, Vea, Coto, "
            "Carrefour, La Anónima y ChangoMás, entre otros supermercados y bazares de todo el país.")
    comercios = donde.get("comercios", [])
    cuenta = {}
    for ids in donde.get("articulos", {}).values():
        for i in ids:
            cuenta[i] = cuenta.get(i, 0) + 1
    filas = "".join(
        f'<li><a href="{esc(c["url"])}" target="_blank" rel="noopener nofollow"><b>{esc(c["nombre"])}</b></a>'
        f'<span class="art-donde-alc">{esc(c.get("alcance", ""))}</span></li>' for c in comercios)
    lineas = "".join(f'<li><a href="{c["slug"]}.html">{esc(c["nombre"])}</a></li>' for c in cats)
    jsonld = {"@context": "https://schema.org", "@type": "WebPage", "name": "Dónde comprar productos Loekemeyer",
              "url": canonical, "description": desc, "inLanguage": "es-AR",
              "isPartOf": {"@id": WEB_ID}, "publisher": {"@id": ORG_ID},
              "breadcrumb": {"@type": "BreadcrumbList", "itemListElement": [
                  {"@type": "ListItem", "position": 1, "name": "Inicio", "item": DOMINIO + "/"},
                  {"@type": "ListItem", "position": 2, "name": "Productos", "item": f"{DOMINIO}/{SALIDA}/"},
                  {"@type": "ListItem", "position": 3, "name": "Dónde comprar", "item": canonical}]}}
    return head(titulo, desc, canonical, pref, jsonld) + f"""
  <body class="prod-page">{topbar(pref, "donde")}
    <main class="prod-main">
      <div class="pub-wrap">
        <nav class="prod-breadcrumb" aria-label="Ubicación">
          <a href="{pref}index.html">Inicio</a> › <a href="index.html">Productos</a> › <span aria-current="page">Dónde comprar</span>
        </nav>
        <div class="prod-head">
          <p class="pub-kicker">Para tu casa</p>
          <h1>Dónde comprar productos Loekemeyer</h1>
          <p class="prod-intro">Loekemeyer es una marca argentina de utensilios de cocina con trayectoria desde 1950. Vendemos sólo por mayor, a supermercados, bazares y distribuidores; si buscás una unidad para tu casa, la encontrás en estos lugares. En la ficha de cada artículo figura qué comercios lo trabajan.</p>
        </div>
        <section class="art-donde">
          <h2>Mercado Libre</h2>
          <p><a class="art-ml" href="https://listado.mercadolibre.com.ar/loekemeyer" target="_blank" rel="noopener nofollow">Ver productos Loekemeyer en Mercado Libre →</a></p>
          <h2>Supermercados</h2>
          <ul class="art-donde-lista">{filas}</ul>
          <p class="art-donde-nota">La disponibilidad y el precio dependen de cada comercio.</p>
        </section>
        <section class="art-linea">
          <h2>Buscá por línea de producto</h2>
          <ul class="art-donde-lineas">{lineas}</ul>
        </section>
        <div class="prod-cta-block">
          <h2>¿Tenés un comercio?</h2>
          <p>Escribinos por WhatsApp: te damos de alta y accedés a la lista de precios y al pedido online.</p>
          <div class="catalogo-actions">
            <a class="btn-catalogo" href="{wa_url('Hola Loekemeyer, tengo un comercio y quiero comprar por mayor.')}" target="_blank" rel="noopener">Comprar por mayor por WhatsApp</a>
          </div>
        </div>
      </div>
    </main>{footer(pref)}"""


def escribir_sitemap(cats, generado):
    """sitemap.xml completo. Mientras NOINDEX esté en True, el catálogo NO entra
    (sería contradecir el noindex de las propias páginas): queda como estaba,
    con la home y el login mayorista. Al publicar entran índice, líneas y fichas."""
    # lastmod: la fecha de la exportación para el catálogo (es cuando cambió el
    # dato), ninguna para la home y el login. Poner "hoy" en cada corrida es
    # mentirle al buscador, y aprende a ignorar el campo.
    urls = [(DOMINIO + "/", "1.0", None), (DOMINIO + "/mayorista", "0.8", None)]
    if not NOINDEX:
        urls.append((f"{DOMINIO}/{SALIDA}/", "0.9", generado))
        urls.append((f"{DOMINIO}/{SALIDA}/{PAG_DONDE}", "0.8", generado))
        urls += [(f"{DOMINIO}/{SALIDA}/{c['slug']}.html", "0.8", generado) for c in cats]
        urls += [(f"{DOMINIO}/{SALIDA}/{url_art(p['cod'])}", "0.6", generado) for c in cats for p in c["productos"]]
    cuerpo = "".join(f"  <url>\n    <loc>{u}</loc>\n" + (f"    <lastmod>{lm}</lastmod>\n" if lm else "")
                     + f"    <priority>{pr}</priority>\n  </url>\n" for u, pr, lm in urls)
    with open(os.path.join(RAIZ, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + cuerpo + "</urlset>\n")
    return len(urls)


def escribir_llms(cats, total):
    """llms.txt: resumen en texto plano para asistentes que lo leen (propuesta
    llmstxt.org). No es un truco: repite lo que dice el sitio, con los mismos
    datos. Los links al catálogo entran sólo cuando el catálogo es público."""
    lineas = ", ".join(c["nombre"].lower() for c in cats)
    txt = f"""# Loekemeyer

> Loekemeyer Hnos S.R.L. es una empresa argentina de utensilios de cocina, con sede y planta en Cervantes 2868, Ciudad Autónoma de Buenos Aires. Fabrica utensilios desde 1950 y hoy está al frente la cuarta generación de la familia. Vende por mayor a supermercados, bazares, distribuidores y comercios de todo el país.

- Nombre legal: Loekemeyer Hnos S.R.L. (CUIT 30-51584245-0)
- Marca: Loekemeyer
- Fundación: 1950, Buenos Aires, Argentina
- Rubro: diseño, fabricación y comercialización de utensilios y accesorios de cocina
- Catálogo: {total} artículos en {len(cats)} líneas ({lineas})
- Venta: mayorista, por caja cerrada. Los precios se ven con usuario en la web mayorista.
- Para consumidores: los productos se compran en Mercado Libre y en supermercados como Jumbo, Disco, Vea, Coto, Carrefour, La Anónima y ChangoMás.
- Contacto comercial: ventas@loekemeyer.com · +54 9 11 3118 1021
- Instagram: https://www.instagram.com/loekemeyer

## Páginas

- [Inicio]({DOMINIO}/): quiénes somos, catálogo y contacto
- [Catálogo en PDF]({DOMINIO}/pdf/catalogo.pdf)
- [Pedido mayorista]({DOMINIO}/mayorista): acceso para clientes (requiere usuario)
"""
    if not NOINDEX:
        txt += f"\n## Catálogo\n\n- [Todos los productos]({DOMINIO}/{SALIDA}/)\n"
        txt += f"- [Dónde comprar]({DOMINIO}/{SALIDA}/{PAG_DONDE}): Mercado Libre y supermercados que venden Loekemeyer al público\n"
        txt += "".join(f"- [{c['nombre']}]({DOMINIO}/{SALIDA}/{c['slug']}.html): {c['intro'].strip()}\n" for c in cats)
    with open(os.path.join(RAIZ, "llms.txt"), "w", encoding="utf-8") as f:
        f.write(txt)


def slugify(s):
    s = s.lower()
    s = re.sub(r"[áàä]", "a", s); s = re.sub(r"[éèë]", "e", s); s = re.sub(r"[íìï]", "i", s)
    s = re.sub(r"[óòö]", "o", s); s = re.sub(r"[úùü]", "u", s); s = s.replace("ñ", "n")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def escribir_fichas_json(cats, manual):
    """productos/fichas.json: TODOS los artículos activos (Thomas, 05/10/2026:
    "todos los productos tengan su ficha técnica"). El catálogo mayorista
    (script.js) dibuja el botón «Ficha técnica» en los códigos que figuran acá;
    un código nuevo sin regenerar no lo lleva (su página todavía no existe)."""
    fichas = {}
    for c in cats:
        for prod in c["productos"]:
            fichas[str(prod["cod"])] = {"n": prod["nombre"]}
    with open(os.path.join(RAIZ, SALIDA, "fichas.json"), "w", encoding="utf-8") as fh:
        json.dump({"fichas": fichas}, fh, ensure_ascii=False, sort_keys=True, indent=0)
        fh.write("\n")
    return len(fichas)


def main():
    global IMG_PARAMS
    with open(DATOS, encoding="utf-8") as f:
        datos = json.load(f)
    # El ?v= de las fotos sale de la fecha de exportación: si alguien reemplaza
    # una foto en el bucket con el mismo nombre, la próxima exportación cambia
    # el parámetro y el navegador no sirve la vieja de cache.
    IMG_PARAMS = "?v=" + datos.get("generado", "").replace("-", "")
    cats = sorted(datos["categorias"], key=lambda c: c["orden"])
    out = os.path.join(RAIZ, SALIDA)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(pagina_index(cats, datos["total"]))
    for c in cats:
        with open(os.path.join(out, c["slug"] + ".html"), "w", encoding="utf-8") as f:
            f.write(pagina_categoria(c, cats))
    # Fichas: se borran las de artículos que ya no están (un código dado de
    # baja no puede quedar con su página viva y huérfana).
    manual = cargar_manual()
    donde = cargar_donde()
    with open(os.path.join(out, PAG_DONDE), "w", encoding="utf-8") as f:
        f.write(pagina_donde(cats, donde))
    dart = os.path.join(out, SUB_ART)
    os.makedirs(dart, exist_ok=True)
    vivos = set()
    for c in cats:
        for prod in c["productos"]:
            nombre = str(prod["cod"]) + ".html"
            vivos.add(nombre)
            with open(os.path.join(dart, nombre), "w", encoding="utf-8") as f:
                f.write(pagina_articulo(prod, c, manual, donde))
    for viejo in os.listdir(dart):
        if viejo.endswith(".html") and viejo not in vivos:
            os.remove(os.path.join(dart, viejo))
    n_map = escribir_sitemap(cats, datos.get("generado") or None)
    escribir_llms(cats, datos["total"])
    n_fichas = escribir_fichas_json(cats, manual)
    print(f"fichas.json: {n_fichas} artículos con ficha técnica cargada")
    print(f"{len(cats) + 1} páginas en {out}/ + {len(vivos)} fichas en {out}/{SUB_ART}/ "
          f"({datos['total']} artículos) · sitemap {n_map} URLs · NOINDEX={NOINDEX}")


if __name__ == "__main__":
    main()
