#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# HOOK SessionStart — le recuerda al modelo, EN EL MOMENTO EN QUE IMPORTA, que
# tiene que preguntar quién está escribiendo antes de hacer nada.
#
# ⚠ POR QUÉ EXISTE (medido el 2026-09-23).
# La regla estaba escrita SÓLO en prosa, en el `CLAUDE.md`, y no se cumplía. Tres
# causas, las tres medidas:
#
#   1) En las sesiones cloud el harness inyecta el mail de la cuenta
#      (`thomasloke1@gmail.com`). La regla tiene un escape —"si el mensaje ya lo
#      dice, no repreguntar"— y el mail lo dispara SIEMPRE: el modelo lee "ya se
#      sabe: Thomas" y no pregunta. Pero el mail es de la CUENTA, no de quien
#      escribe: de las 425 tareas que cargó Claude, 123 las pidió Luis.
#   2) La regla convive con "⚠ REGLA: NO preguntar — razonar primero", que dice
#      que preguntar es el último recurso. Leídas juntas, gana no preguntar.
#   3) `CLAUDE.md` tiene ~1.400 líneas y esa regla vive en la 220.
#
# La salida de un hook SessionStart SÍ le llega al modelo como contexto (medido:
# la línea de `claude-permisos.sh` aparece en cada arranque). La de un
# PreToolUse/PostToolUse en TEXTO PLANO **no**: el CLI la anota en el log como
# `success` y la descarta ("Hook output does not start with {, treating as plain
# text"). Para que llegue tiene que ser JSON con `hookSpecificOutput`.
#
# ⚠ Sólo habla en `startup`. En `resume` y `compact` la sesión ya viene con la
# identidad adentro y repreguntar sería ruido.
# ---------------------------------------------------------------------------
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
source_ev="$(printf '%s' "$payload" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')"

# Sin dato, se asume arranque: mejor preguntar de más que perder la tarea.
[ -z "$source_ev" ] && source_ev="startup"
[ "$source_ev" != "startup" ] && exit 0

cat <<'TXT'
QUIÉN ESTÁ ESCRIBIENDO: todavía NO se sabe. El mail de la cuenta es de la CUENTA,
no de la persona: por ese mismo mail escriben Thomas, Luis, Marianela, Elías y
otros (medido: de 425 tareas cargadas por Claude, 202 las pidió Thomas y 123 Luis).
NO se frena el trabajo por esto (Thomas, 23/09: *"andá trabajando en lo que te piden
pero agregá a pendientes o definiciones que te confirme quién es antes de cerrar"*):
se hace lo que se pidió, y la confirmación se pide EN LAS DECISIONES PENDIENTES del
cierre, hasta que llegue. Lo que sí espera es la ATRIBUCIÓN: no se carga una tarea
de Planify ni se registra un problema a nombre de alguien adivinado.
Ruteo, para no equivocarse: Thomas -> employee_id 20 (Tomás Beviglia) con el
nombre antepuesto por "Th ". Cualquier otro -> su propio employee_id, sin prefijo.
TXT
