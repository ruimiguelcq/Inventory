# Inventario de repuestos marinos

Aplicación web local para el inventario interno de un almacén. Permite configurar un acceso administrador, gestionar cuentas del equipo y mantener el catálogo de repuestos.

## Requisitos

- Node.js 22.5 o posterior (usa SQLite integrado en Node).

## Iniciar

```powershell
npm start
```

Abre <http://127.0.0.1:3000>. En el primer inicio, crea el nombre de usuario y la contraseña de administrador. La aplicación escucha solo en `127.0.0.1` y guarda sus datos en `data/inventory.sqlite`.

Para cambiar el puerto o la ruta de la base de datos, define `PORT` o `DATABASE_PATH` antes de iniciar el proceso.

## Cuentas y permisos

Desde **Cuentas y permisos**, la cuenta administradora puede crear usuarios con una contraseña de al menos 12 caracteres y asignar o cambiar su permiso:

- **Consulta:** puede ver el catálogo, sin crear ni editar artículos.
- **Gestión:** puede crear y editar artículos.
- **Administración:** además puede crear cuentas y asignar Consulta o Gestión. El acceso inicial conserva su permiso de administración.

Los permisos se verifican en el servidor y los cambios se aplican en la siguiente petición, incluso en sesiones ya abiertas. Las contraseñas se guardan como hashes con sal; las cuentas y sus permisos se conservan al reiniciar. Las sesiones duran ocho horas y se cierran al reiniciar el servidor.

La protección de operaciones de escritura exige Gestión o Administración. Los flujos de ajuste de existencias y archivo se implementan en los tickets #4 y #5, respectivamente.

## Probar

```powershell
npm test
```
