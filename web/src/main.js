// Punto de entrada: estilos, funcionalidades (cada una registra sus vistas y acciones) y arranque.
import './styles/fonts.css';
import './styles/app.css';
import './styles/v3.css';
import './features/auth/view.js';
import './features/inicio/view.js';
import './features/plantillas/view.js';
import './features/lineas/view.js';
import './features/tecnicos/view.js';
import './features/control/view.js';
import './features/entregas/view.js';
import './features/inventario/view.js';
import './features/controles/view.js';
import './features/reportes/view.js';
import './features/reportes/export.js';
import './features/existencia/view.js';
import './features/alertas/view.js';
import './features/config/view.js';
import './features/kits/deliver.js';
import './features/admin/view.js';
import './features/records/view.js';
import './features/novedades/view.js';
import './features/compras/view.js';
import './features/datos/view.js';
import { boot } from './ui/app.js';

boot();
