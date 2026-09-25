# Inventario de repuestos marinos

Aplicación web local para el inventario interno de un almacén. La primera versión permite configurar un acceso administrador y mantener el catálogo de repuestos.

## Requisitos

- Node.js 22.5 o posterior (usa SQLite integrado en Node).

## Iniciar

```powershell
npm start
```

Abre <http://127.0.0.1:3000>. En el primer inicio, crea el nombre de usuario y la contraseña de administrador. La aplicación escucha solo en `127.0.0.1` y guarda sus datos en `data/inventory.sqlite`.

Para cambiar el puerto o la ruta de la base de datos, define `PORT` o `DATABASE_PATH` antes de iniciar el proceso.

## Probar

```powershell
npm test
```
