// Loekemeyer — versión del sitio.
// Para actualizar en todos los footers, cambiar SOLO la línea de abajo
// y bumpear el `?v=` del <script src="./version.js?v=N"> en las HTML
// para invalidar el cache del navegador.
const APP_VERSION = "2.3.182";
// Expuesto para reusar la MISMA versión en subpáginas (p. ej. el Formato OSA),
// así con cambiar solo esta línea se actualiza todo.
window.APP_VERSION = APP_VERSION;

document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("[data-app-version]").forEach(function (el) {
    el.textContent = "v" + APP_VERSION;
  });
});
