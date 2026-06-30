/**
 * mobile-toggle.js
 * Inyecta automáticamente la barra superior móvil y maneja la lógica
 * de despliegue del menú lateral en pantallas pequeñas.
 */
document.addEventListener('DOMContentLoaded', () => {
    const mainContent = document.querySelector('.main-content');
    const sidebar = document.querySelector('.sidebar');
    
    if (mainContent && sidebar) {
        // 1. Inyectar la barra superior móvil si no existe
        if (!document.getElementById('sidebarToggleMobile')) {
            const mobileHeader = document.createElement('div');
            mobileHeader.className = 'd-flex d-md-none justify-content-between align-items-center mb-3 p-3 border-bottom sticky-top';
            mobileHeader.style.cssText = 'margin: -15px -16px 20px -16px; background-color: var(--surface-color); z-index: 100; border-radius: 0;';
            mobileHeader.innerHTML = `
                <button class="btn btn-outline-secondary btn-sm" id="sidebarToggleMobile" type="button">
                    <i class="bi bi-list fs-4"></i>
                </button>
                <span class="fw-bold text-main">🏥 Citas Médicas</span>
                <div style="width: 40px;"></div>
            `;
            mainContent.insertBefore(mobileHeader, mainContent.firstChild);
        }

        // 2. Controlar la apertura y cierre del cajón (Sidebar)
        const sidebarToggle = document.getElementById('sidebarToggleMobile');
        if (sidebarToggle) {
            // Crear la capa oscurecedora (Overlay) si no existe
            let overlay = document.querySelector('.sidebar-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'sidebar-overlay';
                document.body.appendChild(overlay);
            }

            sidebarToggle.addEventListener('click', () => {
                sidebar.classList.add('show-sidebar');
                overlay.classList.add('show-sidebar');
            });

            overlay.addEventListener('click', () => {
                sidebar.classList.remove('show-sidebar');
                overlay.classList.remove('show-sidebar');
            });

            // Cerrar menú al hacer clic en un enlace de navegación
            const sidebarLinks = sidebar.querySelectorAll('.nav-link');
            sidebarLinks.forEach(link => {
                link.addEventListener('click', () => {
                    sidebar.classList.remove('show-sidebar');
                    overlay.classList.remove('show-sidebar');
                });
            });
        }
    }
});
