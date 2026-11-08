// Punto de entrada: estilos, funcionalidades (cada una registra sus vistas y acciones) y arranque.
import './styles/fonts.css';
import './styles/app.css';
import './styles/v3.css';
import './features/auth/view.js';
import './features/inicio/view.js';
import './features/turnos/view.js';
import './features/tecnicos/view.js';
import './features/control/view.js';
import './features/entregas/view.js';
import './features/inventario/view.js';
import './features/controles/view.js';
import './features/reportes/view.js';
import './features/reportes/export.js';
import './features/alertas/view.js';
import './features/config/view.js';
import './features/admin/view.js';
import './features/datos/view.js';
import { boot } from './ui/app.js';

boot();
