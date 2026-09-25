# Inventario de repuestos marinos

Aplicación web local para el inventario interno de un almacén. Permite configurar un acceso administrador, gestionar cuentas del equipo, mantener el catálogo de repuestos y registrar existencias con historial.

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

- **Consulta:** puede ver el catálogo y el historial, sin modificar datos.
- **Gestión:** puede crear y editar artículos y modificar existencias.
- **Administración:** además puede crear cuentas y asignar Consulta o Gestión. El acceso inicial conserva su permiso de administración.

Los permisos se verifican en el servidor y los cambios se aplican en la siguiente petición, incluso en sesiones ya abiertas. Las contraseñas se guardan como hashes con sal; las cuentas y sus permisos se conservan al reiniciar. Las sesiones duran ocho horas y se cierran al reiniciar el servidor.

La protección de operaciones de escritura exige Gestión o Administración. El archivo se implementa en el ticket #5.

## Existencias e historial

Desde la tabla o la ficha del artículo, abre **Ajustar existencias**:

- **Ajustar por:** suma o resta la cantidad indicada.
- **Establecer en:** fija el total exacto tras un recuento.

Las cantidades son presentaciones completas (SET, KIT o unidad) y nunca pueden quedar negativas. Puedes indicar un motivo opcional. **Revisar cambio** muestra la operación y las cantidades anterior y nueva antes de **Confirmar cambio**. Si otra operación cambia las existencias mientras revisas, debes revisar de nuevo. Una confirmación no se aplica dos veces; abrir otra revisión en la misma sesión reemplaza la anterior.

**Historial** muestra cada operación con cantidad anterior/nueva, usuario, fecha/hora UTC, presentación y motivo. No permite editar ni eliminar movimientos. El stock y su movimiento se guardan juntos en una transacción SQLite y se conservan al reiniciar.

La primera ejecución tras esta actualización añade las tablas y columnas necesarias a la base de datos existente. Los artículos existentes y nuevos comienzan con cero existencias hasta registrar un ajuste o recuento.

## Probar

```powershell
npm test
```
