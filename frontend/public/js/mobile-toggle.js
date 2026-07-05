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

        // 3. Inyectar Widget de Código QR de Acceso Móvil en la Barra Lateral
        const qrContainer = document.createElement('div');
        qrContainer.className = 'mt-auto px-3 py-3 text-center border-top border-secondary-subtle d-none d-md-block';
        qrContainer.style.cssText = 'background-color: rgba(0,0,0,0.1); border-top: 1px solid var(--border-color) !important;';
        qrContainer.innerHTML = `
            <p class="small text-muted mb-2" style="font-size:0.75rem; font-weight: 550;"><i class="bi bi-phone-fill me-1"></i> Acceso Móvil</p>
            <div style="cursor: pointer;" onclick="abrirModalQR()" title="Click para ampliar">
                <img id="sidebar-qr-img" src="" alt="QR Acceso" class="img-fluid rounded border p-1 bg-white" style="max-height:85px; display:none;">
                <div id="sidebar-qr-loader" class="spinner-border spinner-border-sm text-primary" role="status"></div>
            </div>
            <small class="text-muted d-block mt-1" style="font-size:0.68rem; word-break:break-all;" id="sidebar-qr-url"></small>
        `;
        
        // Insertar antes del botón de modo oscuro/logout
        const logoutDiv = sidebar.querySelector('.px-3.py-2.mt-auto') || sidebar.querySelector('.mt-auto.mb-2');
        if (logoutDiv) {
            sidebar.insertBefore(qrContainer, logoutDiv);
        } else {
            sidebar.appendChild(qrContainer);
        }

        // Inyectar el Modal en el body si no existe
        if (!document.getElementById('qrAccesoModal')) {
            const modalHTML = `
            <div class="modal fade" id="qrAccesoModal" tabindex="-1" aria-hidden="true">
                <div class="modal-dialog modal-dialog-centered modal-sm">
                    <div class="modal-content" style="border-radius: 8px; background-color: var(--surface-color); color: var(--text-main); border: 1px solid var(--border-color);">
                        <div class="modal-header border-bottom-0 pb-0">
                            <h6 class="modal-title fw-bold"><i class="bi bi-qr-code-scan me-2"></i> Acceso Móvil</h6>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body text-center">
                            <p class="small text-muted mb-3" style="font-size:0.75rem;">Escanea este código con tu celular para abrir el sistema:</p>
                            <img id="modal-qr-img" src="" class="img-fluid rounded border p-2 bg-white mb-3" style="max-height:180px">
                            <div class="p-2 rounded bg-light text-dark font-monospace small mb-2" id="modal-qr-url-text" style="word-break:break-all; font-size: 0.72rem;"></div>
                            <small class="text-muted d-block" style="font-size: 0.65rem;">⚠️ Ambos dispositivos deben estar conectados a la misma red Wi-Fi.</small>
                        </div>
                    </div>
                </div>
            </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHTML);
        }

        // Función global para abrir el modal
        window.abrirModalQR = function() {
            const modalEl = document.getElementById('qrAccesoModal');
            if (window.bootstrap && modalEl) {
                const modal = new bootstrap.Modal(modalEl);
                modal.show();
            }
        };

        // Cargar datos del servidor
        fetch('/api/sistema/acceso-movil')
            .then(res => res.json())
            .then(data => {
                const qrImg = document.getElementById('sidebar-qr-img');
                const qrUrl = document.getElementById('sidebar-qr-url');
                const loader = document.getElementById('sidebar-qr-loader');
                
                if (qrImg && qrUrl && data.qrCodeDataUrl) {
                    qrImg.src = data.qrCodeDataUrl;
                    qrImg.style.display = 'inline-block';
                    if (loader) loader.remove();
                    
                    qrUrl.innerText = data.ipLocal + ':3001';
                    
                    const modalImg = document.getElementById('modal-qr-img');
                    const modalText = document.getElementById('modal-qr-url-text');
                    if (modalImg) modalImg.src = data.qrCodeDataUrl;
                    if (modalText) modalText.innerText = data.urlDashboard;
                }
            })
            .catch(err => console.error('Error al cargar QR:', err));
    }
});
