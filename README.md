# Inventario de repuestos marinos

Aplicación web local para el inventario interno de un almacén. Permite configurar un acceso administrador, gestionar cuentas del equipo, mantener el catálogo de repuestos y registrar existencias con historial.

## Requisitos

- Node.js 22.5 o posterior (usa SQLite integrado en Node).

## Iniciar

```powershell
npm install
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

## Importar desde Excel

Desde **Inventario → Importar Excel**, Gestión y Administración pueden cargar un archivo `.xlsx` con una sola hoja, hasta 2 MB y 1000 filas de datos. La primera fila contiene los encabezados:

| P/N | Descripción | Presentación | Marca | Ubicación | Mínimo de stock | Cantidad |
| --- | --- | --- | --- | --- | --- | --- |
| 001-MAR | Junta de motor | KIT | Marina Parts | Caja 4 | 2 | 5 |

- Guarda **P/N como texto** en Excel, incluidos los identificadores numéricos, para conservar ceros iniciales. Usa valores sin fórmulas. Presentaciones admitidas: `SET`, `KIT`, `unidad`.
- **Datos descriptivos:** requiere P/N, Descripción y Presentación; crea artículos o actualiza los existentes por P/N, sin distinguir mayúsculas ASCII. Marca, Ubicación y Mínimo de stock son opcionales: una columna ausente conserva el valor existente y una celda vacía lo borra. Las altas sin importar existencias comienzan en cero.
- **Existencias:** requiere P/N y Cantidad. Si solo importas existencias, los artículos deben existir. Elige explícitamente **Ajustar por** (sumar/restar) o **Establecer en** (total exacto). Las cantidades deben ser enteras y el resultado no puede ser negativo.
- Se pueden activar ambas opciones. También se aceptan los encabezados `Ubicación principal`, `Mínimo` y `Disponible`, y encabezados sin acentos.

**Revisar importación** muestra altas, actualizaciones, datos anteriores/nuevos y errores por fila. Los P/N duplicados dentro del archivo, campos obligatorios ausentes, fórmulas o cantidades inválidas bloquean el lote completo: corrige el archivo y vuelve a cargarlo. No se omiten filas inválidas ni se guardan cambios al previsualizar.

**Confirmar importación** guarda todo en una única transacción. Si los artículos o sus existencias han cambiado desde la vista previa, exige revisarla de nuevo. El historial registra cada operación de stock con usuario, fecha/hora y origen **Importación Excel**. **Cancelar importación** descarta la revisión y no modifica datos. Una confirmación solo puede usarse una vez y pertenece a la sesión que la creó; otra vista previa válida sustituye la anterior. Las revisiones pendientes se pierden al cerrar sesión o reiniciar.

La dependencia ExcelJS usa una sustitución de `uuid` por su versión 11 corregida, compatible con la API `v4` que utiliza.

## Exportar a Excel

Desde **Inventario**, cualquier miembro del equipo con sesión iniciada (Consulta, Gestión o Administración) puede descargar:

- **Exportar todo a Excel:** todos los artículos del inventario.
- **Exportar selección a Excel:** solo los artículos marcados en las casillas de la tabla. Una selección vacía o inválida muestra un mensaje y no descarga el inventario completo.

El archivo `inventario.xlsx` contiene una hoja con P/N, Descripción, Presentación, Marca, Ubicación, Mínimo de stock y Cantidad. Conserva P/N como texto, las cantidades como números y los campos opcionales sin valor como celdas vacías. Exportar no modifica artículos, existencias ni historial.

Puedes cargar el archivo en **Importar Excel** para revisar los cambios antes de confirmarlos. Para recuperar las cantidades exportadas, activa **Importar existencias** y elige **Establecer en**; **Ajustar por** sumaría las cantidades al stock actual. Se aplican los límites de importación de 2 MB y 1000 filas por archivo; para inventarios mayores, prepara lotes dentro de esos límites conservando los encabezados. Un inventario vacío genera solo los encabezados.

## Probar

```powershell
npm test
```
