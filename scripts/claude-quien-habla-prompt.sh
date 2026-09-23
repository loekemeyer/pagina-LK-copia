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

QH_PAYLOAD="$payload" python3 - <<'PY'
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

NOMBRES = ["juan cruz", "thomas", "tomás", "tomas", "luis", "marianela", "mariane",
           "gastón", "gaston", "elías", "elias", "nazareno", "angely", "viviana", "vivi",
           "alan", "diego", "nora", "pablo", "martín", "martin", "romina", "iván", "ivan",
           "jhonny", "yanina", "melany", "franco", "damián", "damian"]
N = "|".join(re.escape(n) for n in NOMBRES)
L = "a-záéíóúñü"
RE_PRES = re.compile(rf"(?:^|[^{L}])(?:soy|habla|te escribe|escribe|ac[aá]|aqu[ií])\s+({N})(?![{L}])")
RE_INICIO = re.compile(rf"^\s*(?:hola[\s,!]+)?({N})(?![{L}])\s*(?:[,:;.!\-—]|$)")

def detectar(txt):
    if not isinstance(txt, str) or not txt.strip():
        return None
    low = txt.lower()
    if low.lstrip().startswith("<"):          # system-reminder, tool output, etc.
        return None
    m = RE_PRES.search(low)
    if m:
        return m.group(1)
    primera = next((l for l in low.splitlines() if l.strip()), "")
    m = RE_INICIO.match(primera)              # "luis", "luis, …", "Luis:", "hola luis"
    if m:
        return m.group(1)
    if len(low.split()) <= 3:                 # respuesta corta: "soy yo, marianela"
        m = re.search(rf"(?:^|[^{L}])({N})(?![{L}])", low)
        if m:
            return m.group(1)
    return None

quien = detectar(p.get("prompt"))    # SOLO el mensaje actual: la charla no se relee

def emit(msg):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": msg}}, ensure_ascii=False))

if quien:
    try:
        os.makedirs(home_dir, exist_ok=True)
        with open(marcas[0], "w") as f:
            f.write(quien + "\n")
    except Exception:
        pass
    emit(f"IDENTIDAD CONFIRMADA: **{quien}**. NO volver a preguntar ni pedir confirmacion en esta sesion "
         "(tampoco en las decisiones pendientes). Ruteo de Planify: si es Thomas -> employee_id 20 "
         "(Tomas Beviglia) con el nombre antepuesto por 'Th '; cualquier otro -> su propio employee_id, sin prefijo.")
    sys.exit(0)

emit("TODAVIA NO SABES QUIEN ESCRIBE, y el mail de la cuenta NO cuenta como respuesta: es de la CUENTA, "
     "no de la persona. NO frenes el trabajo con la pregunta: hace lo que te pidieron. Lo unico que espera es "
     "la ATRIBUCION -- no cargues una tarea de Planify ni registres un problema a nombre de nadie adivinado. "
     "ANTES DE CERRAR, sumalo a las decisiones pendientes: 'Confirmame quien sos (Thomas, Luis, Marianela, "
     "Gaston, Elias...) para dejar la tarea en la agenda correcta'. Si el usuario YA lo dijo en algun mensaje "
     "de esta charla y este aviso igual aparece, NO repreguntes: usa esa respuesta.")
PY
exit 0
