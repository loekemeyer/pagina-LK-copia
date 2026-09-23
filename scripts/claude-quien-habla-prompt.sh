#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HOOK UserPromptSubmit — pregunta "¿quién sos?" hasta que haya una respuesta, y
# DESPUÉS SE CALLA.
#
# Thomas, 2026-09-23: *"que hasta que no tengas confirmación positiva del usuario
# preguntes quién es"*.
# Luis, 2026-09-23 (v21.87): *"seguís preguntando incluso después de que te
# contestan"*.
#
# ⚠ POR QUÉ SEGUÍA PREGUNTANDO (medido en la sesión de Luis del 23/09):
#   1) El primer mensaje fue "luis\nhabia puesto una traba…": el nombre en la
#      PRIMERA LÍNEA de un mensaje largo. La versión anterior sólo aceptaba
#      "soy X" o un mensaje de ≤ 3 palabras, así que no lo vio nunca.
#   2) Sin detección no hay marca, y sin marca insistía en CADA mensaje, aunque
#      la respuesta ya estuviera arriba en la charla.
#   3) La marca vivía en /tmp, que no sobrevive a un contenedor nuevo.
#
# Ahora:
#   · acepta el nombre en la primera línea ("luis", "luis, …", "Luis:") además de
#     "soy X" / "habla X" / "te escribe X";
#   · mira SÓLO el mensaje que acaba de entrar — la charla no se relee (Luis:
#     "no puede estar releyendo toda la charla"). Detectado una vez, deja la marca
#     y desde ahí sale en la primera línea sin leer nada;
#   · guarda la marca en ~/.claude/quien-habla/ (y lee también la de /tmp).
#
# ⚠ NO BLOQUEA: el trabajo sigue. Lo que espera es la ATRIBUCIÓN (Planify,
# auditoría). Un nombre mencionado de pasada NO cuenta ("Luis pidió que…").
#
# ⚠ La salida va en JSON: en texto plano el CLI la descarta.
# ---------------------------------------------------------------------------
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
command -v python3 >/dev/null 2>&1 || exit 0

QH_PAYLOAD="$payload" QH_SELF="${BASH_SOURCE[0]}" python3 - <<'PY'
import json, os, re, sys

try:
    p = json.loads(os.environ.get("QH_PAYLOAD") or "{}")
except Exception:
    p = {}
sid = p.get("session_id") or "sin-sesion"
home_dir = os.path.join(os.path.expanduser("~"), ".claude", "quien-habla")
marcas = [os.path.join(home_dir, sid),
          os.path.join(os.environ.get("TMPDIR", "/tmp"), "claude-quien-habla-" + sid)]
if any(os.path.isfile(m) for m in marcas):
    sys.exit(0)                     # ya contestó: no se pregunta más

import unicodedata
def _n(t):
    t = unicodedata.normalize("NFD", t.lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")

# Padrón de Planify (scripts/planify-padron.json): nombre o apellido -> employee_id.
here = os.path.dirname(os.path.abspath(os.environ.get("QH_SELF", "")))
try:
    pad = json.load(open(os.path.join(here, "planify-padron.json"), encoding="utf-8"))
except Exception:
    pad = {"empleados": [], "preferido": {}, "alias": {}}
NOM = {i: n for i, n in pad.get("empleados", [])}
TOK = {}                                    # token -> set(ids)
for i, n in NOM.items():
    for t in re.findall(r"[a-z]+", _n(n)):
        if len(t) >= 3 and t not in ("de", "la"):
            TOK.setdefault(t, set()).add(i)
for t, i in pad.get("alias", {}).items():
    TOK.setdefault(t, set()).add(i)
TOK.setdefault("thomas", set()).add("TH")   # Thomas -> 20 con prefijo 'Th '
PREF = pad.get("preferido", {})
PRES = ("soy", "habla", "escribe", "aca", "aqui")

def candidatos(palabras):
    """Intersección de los ids de los tokens de nombre consecutivos; None si el 1.º no es nombre."""
    ids, usados = None, []
    for w in palabras:
        if w not in TOK:
            break
        ids = TOK[w] if ids is None else (ids & TOK[w]) or ids
        usados.append(w)
    return (ids, usados) if ids else (None, [])

def detectar(txt):
    if not isinstance(txt, str) or not txt.strip() or txt.lstrip().startswith("<"):
        return None
    low = _n(txt)
    # 1) "soy X [Y]" / "habla X" / "te escribe X" en cualquier parte
    w = re.findall(r"[a-z]+", low)
    for k, x in enumerate(w):
        if x in PRES:
            ids, us = candidatos(w[k + 1:k + 3])
            if ids:
                return ids, us
    # 2) nombre al PRINCIPIO de la primera línea: "luis", "Luis:", "martin cornejo, …", "hola luis"
    primera = next((l for l in low.splitlines() if l.strip()), "")
    m = re.match(r"^\s*(?:hola[\s,!]+)?([a-z ]+?)\s*(?:[,:;.!\-—]|$)", primera)
    if m:
        pal = m.group(1).split()
        if 1 <= len(pal) <= 3:
            ids, us = candidatos(pal)
            if ids and len(us) == len(pal):
                return ids, us
    return None

quien = detectar(p.get("prompt"))    # SOLO el mensaje actual: la charla no se relee

def emit(msg):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": msg}}, ensure_ascii=False))

if quien:
    ids, usados = quien
    if "TH" in ids and len(ids) == 1:
        quien_txt, ruteo = "Thomas", "Thomas -> employee_id 20 (Tomas Beviglia) con el nombre antepuesto por 'Th '"
    else:
        ids = {i for i in ids if i != "TH"}
        if len(ids) > 1 and len(usados) == 1 and str(PREF.get(usados[0], "")) and PREF.get(usados[0]) in ids:
            ids = {PREF[usados[0]]}
        if len(ids) > 1:
            lista = "; ".join(f"{NOM[i]} (id {i})" for i in sorted(ids))
            emit(f"'{' '.join(usados)}' es AMBIGUO en Planify: {lista}. Segui trabajando; en las decisiones "
                 "pendientes pedi el apellido (ej. 'soy martin cornejo'). No cargues tareas hasta saberlo.")
            sys.exit(0)
        i = next(iter(ids))
        quien_txt, ruteo = NOM[i], f"{NOM[i]} -> employee_id {i}, sin prefijo"
    try:
        os.makedirs(home_dir, exist_ok=True)
        with open(marcas[0], "w") as f:
            f.write(quien_txt + "\n")
    except Exception:
        pass
    emit(f"IDENTIDAD CONFIRMADA: **{quien_txt}**. NO volver a preguntar ni pedir confirmacion en esta sesion "
         f"(tampoco en las decisiones pendientes). Planify: {ruteo}.")
    sys.exit(0)

emit("TODAVIA NO SABES QUIEN ESCRIBE, y el mail de la cuenta NO cuenta como respuesta: es de la CUENTA, "
     "no de la persona. NO frenes el trabajo con la pregunta: hace lo que te pidieron. Lo unico que espera es "
     "la ATRIBUCION -- no cargues una tarea de Planify ni registres un problema a nombre de nadie adivinado. "
     "ANTES DE CERRAR, sumalo a las decisiones pendientes: 'Confirmame quien sos (Thomas, Luis, Marianela, "
     "Gaston, Elias...; si el nombre se repite, con apellido) para dejar la tarea en la agenda correcta'. Si el usuario YA lo dijo en algun mensaje "
     "de esta charla y este aviso igual aparece, NO repreguntes: usa esa respuesta.")
PY
exit 0
