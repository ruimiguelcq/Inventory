# Inventario de repuestos marinos

Aplicación web local para el inventario interno de un almacén. Permite configurar un acceso administrador, gestionar cuentas del equipo, mantener el catálogo de repuestos y registrar inventario con historial.

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
- **Gestión:** puede crear y editar artículos y modificar inventario.
- **Administración:** además puede crear cuentas y asignar Consulta o Gestión. El acceso inicial conserva su permiso de administración.

Los permisos se verifican en el servidor y los cambios se aplican en la siguiente petición, incluso en sesiones ya abiertas. Las contraseñas se guardan como hashes con sal; las cuentas y sus permisos se conservan al reiniciar. Las sesiones duran ocho horas y se cierran al reiniciar el servidor.

La protección de operaciones de escritura exige Gestión o Administración.

## Buscar, filtrar y archivar

Tras iniciar sesión se abre **Productos**. El lateral mantiene accesibles **Productos**, **Inventario** y **Órdenes de compra**, donde se preparan las listas de repuestos a pedir. Las cuentas, copias de seguridad y el cierre de sesión están en el menú superior según los permisos.

**Productos** es una búsqueda instantánea por P/N o nombre con un selector **Activos/Archivados/Todos** (Activos por defecto). La tabla muestra exactamente Producto (con miniatura), P/N, Estado, Inventario, Categoría, Tipo de producto y Proveedor; las columnas Producto y P/N se alinean a la izquierda y el resto al centro. El nombre abre la ficha con inventario e historial. La celda **Inventario** dice `N existencias`, en verde si N alcanza el mínimo de stock del producto y en rojo si no; un producto sin mínimo usa 10. Pagina de **50 en 50** con Anterior y Siguiente, sin selector de tamaño. La cabecera ofrece **Importar, Exportar y Agregar producto** en ese orden (Agregar producto solo para Gestión y Administración). Los enlaces antiguos a archivados redirigen a Productos.

La ficha de alta y edición usa dos columnas. A la izquierda: una tarjeta con P/N, Presentación, Producto, Descripción y **Multimedia** (la imagen, justo debajo de la descripción); luego **Precio**, con el precio de venta y un bloque **Precios adicionales** con **Precio de fábrica** (interno: solo lo ve el equipo) y la **Ganancia** calculada; y por último **Inventario**, con la cantidad disponible y la ubicación manual. A la derecha, **Organización del producto** con Categoría, Tipo de producto, Proveedor y Marca. Categoría, Tipo de producto y Proveedor son desplegables con buscador que permiten **crear y asignar al vuelo**; sin JavaScript siguen funcionando como lista y campo de creación. La app incorpora estas **categorías predefinidas**: Motor base y componentes internos; Admisión, escape y sobrealimentación; Enfriamiento y agua de mar; Lubricación; Combustible e inyección; Eléctrico, arranque y control; Montaje y accesorios. **Solo la cuenta administradora puede crear categorías**; Gestión y Administración siguen creando tipos y proveedores. La ficha del producto muestra Precio, Precio de fábrica y Ganancia. Los artículos anteriores empiezan **Sin categoría**, conservando cuentas, inventario e historial.

**Inventario** muestra solo los activos; su búsqueda es instantánea por P/N o nombre y sus columnas son **Producto** (con miniatura, alineado a la izquierda), **P/N**, **Disponible** e **Historial**. Disponible muestra el stock actual con el mismo verde/rojo que Productos (el mínimo del producto, 10 por defecto). No aparecen Comprometido, Por recibir, En inventario, Ubicación ni Mínimo.

Gestión y Administración pueden **ajustar el inventario en línea**: al pulsar el número de **Disponible** se abre un editor con **Fijar en** (total exacto) o **Ajustar** (sumar/restar), un motivo opcional y guardado directo; el movimiento queda en el historial. Consulta ve Disponible en solo lectura. La cabecera ofrece **Importar** y **Exportar**. Inventario pagina de **50 en 50** con Anterior y Siguiente, sin selector de tamaño.

Gestión y Administración pueden **Archivar** un repuesto desde su ficha para retirarlo de la vista activa sin borrar su historial ni inventario, y **Desarchivarlo** desde la misma ficha. La opción **Archivados** del selector de estado de Productos muestra los artículos archivados. No hay borrado definitivo desde la interfaz.

## Imágenes de los productos

Cada producto puede tener una imagen (JPG, PNG o WEBP, hasta 2 MB) que se sube, cambia o quita desde la ficha. La imagen se sirve por una ruta propia de la aplicación (`/products/<id>/image`) y se muestra como miniatura junto al nombre en las tablas de Productos, Inventario y listas de compra; un producto sin imagen se muestra sin hueco. Las imágenes se guardan en `data/images/` (configurable con `IMAGES_DIRECTORY`) y las copias de seguridad las incluyen junto a la base de datos: al restaurar una copia se reponen las imágenes de ese momento, conservando la copia previa del estado anterior.

## Existencias e historial

Desde **Inventario**, pulsa el número de **Disponible** para ajustarlo en línea, o abre **Ajustar inventario** desde la ficha del artículo:

- **Fijar en / Establecer en:** fija el total exacto tras un recuento.
- **Ajustar / Ajustar por:** suma o resta la cantidad indicada.

El editor en línea guarda directamente, sin paso de revisión.

Las cantidades son presentaciones completas (SET, KIT o unidad) y nunca pueden quedar negativas. Puedes indicar un motivo opcional. **Revisar cambio** muestra la operación y las cantidades anterior y nueva antes de **Confirmar cambio**. Si otra operación cambia el inventario mientras revisas, debes revisar de nuevo. Una confirmación no se aplica dos veces; abrir otra revisión en la misma sesión reemplaza la anterior.

**Historial** muestra cada operación con cantidad anterior/nueva, usuario, fecha/hora UTC, presentación y motivo. No permite editar ni eliminar movimientos. El stock y su movimiento se guardan juntos en una transacción SQLite y se conservan al reiniciar.

La primera ejecución tras esta actualización añade las tablas y columnas necesarias a la base de datos existente. Los artículos existentes y nuevos comienzan con inventario en cero hasta registrar un ajuste o recuento.

## Importar desde Excel

Desde **Productos → Importar productos** o **Inventario → Importar**, Gestión y Administración cargan un archivo `.xlsx` con una sola hoja, hasta 2 MB y 1000 filas de datos. Cada vista tiene su propio alcance.

**Productos** importa el catálogo, sus categorías, tipos y proveedores y, opcionalmente, el inventario en el mismo lote. La primera fila contiene los encabezados:

| P/N | Producto | Descripción | Presentación | Marca | Ubicación | Mínimo de stock | Categoría | Tipo | Proveedor | Precio | Estado | Cantidad |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 001-MAR | Junta de motor | Junta con retén reforzado | KIT | Marina Parts | Caja 4 | 2 | Motor | Repuesto | Marino S.A. | 12.50 | Activo | 5 |

- Guarda **P/N como texto** en Excel, incluidos los identificadores numéricos, para conservar ceros iniciales. Usa valores sin fórmulas. Presentaciones admitidas: `SET`, `KIT`, `unidad`. El precio se escribe en dólares con hasta dos decimales.
- **Catálogo:** requiere P/N, Producto (o Descripción en archivos antiguos) y Presentación; crea artículos o actualiza los existentes por P/N, sin distinguir mayúsculas ASCII. `Producto` es el nombre y `Descripción` la descripción larga; si el archivo solo trae `Descripción`, se usa como nombre, de modo que los archivos de la v1.1 siguen importándose. Marca, Ubicación, Mínimo de stock, Categoría, Tipo, Proveedor y Precio son opcionales: una columna ausente conserva el valor existente y una celda vacía lo borra. Las categorías, tipos y proveedores escritos se crean o reutilizan sin duplicar equivalentes. Las altas sin importar inventario comienzan en cero.
- **Estado** es informativo: se importa sin archivar ni desarchivar; el estado se cambia desde la ficha del producto. Las imágenes no forman parte del Excel.
- **Existencias (opcional en Productos):** requiere la columna Cantidad. Elige explícitamente **Ajustar por** (sumar/restar) o **Establecer en** (total exacto). Las cantidades deben ser enteras y el resultado no puede ser negativo.

**Inventario** importa solo cantidades de artículos existentes. La primera fila contiene los encabezados:

| P/N | Producto | Cantidad |
| --- | --- | --- |
| 001-MAR | Junta de motor | 5 |

- Requiere P/N y Cantidad. La importación actualiza el inventario de artículos que ya existen y **rechaza los P/N desconocidos en lugar de crearlos**. Elige explícitamente **Ajustar por** o **Establecer en**.

También se aceptan los encabezados `Ubicación principal`, `Mínimo`, `Disponible`, `Tipo de producto` y encabezados sin acentos.

**Revisar importación** muestra altas, actualizaciones, datos anteriores/nuevos y errores por fila; categoría, tipo y proveedor forman parte de la misma operación. Los P/N duplicados dentro del archivo, campos obligatorios ausentes, fórmulas o cantidades inválidas bloquean el lote completo: corrige el archivo y vuelve a cargarlo. No se omiten filas inválidas ni se guardan cambios al previsualizar.

**Confirmar importación** guarda todo en una única transacción, incluidas las categorías, tipos y proveedores. Si los artículos o su inventario han cambiado desde la vista previa, exige revisarla de nuevo. El historial registra cada operación de stock con usuario, fecha/hora y origen **Importación Excel**. **Cancelar importación** descarta la revisión y no modifica datos. Una confirmación solo puede usarse una vez y pertenece a la sesión que la creó; otra vista previa válida sustituye la anterior. Las revisiones pendientes se pierden al cerrar sesión o reiniciar.

La dependencia ExcelJS usa una sustitución de `uuid` por su versión 11 corregida, compatible con la API `v4` que utiliza.

## Exportar a Excel

Desde **Productos** y **Inventario**, cualquier miembro del equipo con sesión iniciada (Consulta, Gestión o Administración) puede descargar:

- **Exportar productos** (Productos): el catálogo con P/N, Producto, Descripción, Presentación, Marca, Ubicación, Mínimo de stock, Categoría, Tipo, Proveedor, Precio, Estado y Cantidad en `productos.xlsx`. El estado se muestra como `Activo` o `Archivado`; el Excel no incluye imágenes.
- **Exportar** (Inventario): P/N, Producto y Cantidad de los artículos activos en `inventario.xlsx`.

La exportación completa respeta la búsqueda y el estado de la vista y recorre **todas las páginas**, no solo la visible. Conserva P/N como texto, las cantidades como números y los campos opcionales sin valor como celdas vacías. Exportar no modifica artículos, inventario ni historial.

Puedes cargar de nuevo el archivo en **Importar Excel** para revisar los cambios antes de confirmarlos. Para recuperar las cantidades exportadas desde Inventario, activa **Establecer en**; **Ajustar por** sumaría las cantidades al stock actual. Se aplican los límites de importación de 2 MB y 1000 filas por archivo; para inventarios mayores, prepara lotes dentro de esos límites conservando los encabezados. Una exportación sin artículos genera solo los encabezados.

## Órdenes de compra

**Órdenes de compra** reúne las listas de repuestos a pedir. Cada lista tiene un número interno y una fecha, se guarda como **borrador** y se recupera al reiniciar la aplicación.

Gestión y Administración pueden crear una **Nueva lista de compra**. En la ficha de la lista:

- El selector **Añadir artículo** ofrece solo artículos activos y muestra primero los **Agotados** y con **Stock bajo**; cualquier artículo activo puede añadirse.
- Cada artículo aparece **una sola vez** por lista. Volver a añadirlo conserva su línea sin sumar cantidades.
- La **cantidad solicitada** empieza vacía y se escribe manualmente; no se calcula desde el mínimo de stock. Puedes guardar un borrador incompleto. Si escribes una cantidad, debe ser un número entero mayor que cero.
- **Retirar** quita una línea. Los artículos archivados después siguen visibles e identificados en las listas existentes y pueden retirarse, pero no se ofrecen para nuevas incorporaciones.

Guardar o editar una lista **no cambia el inventario ni genera movimientos**. Consulta puede ver las listas; Gestión y Administración las crean y editan, con autorización y validación en el servidor.

Cualquier miembro del equipo con sesión iniciada (**Consulta**, **Gestión** o **Administración**) puede **Exportar a Excel** una lista completa. El archivo `compra-<número>.xlsx` contiene exactamente las columnas **P/N**, **Nombre** y **Cantidad solicitada**, con el P/N como texto y sin precios, impuestos, proveedor, número ni fecha dentro del documento. Para exportar, la lista necesita al menos un artículo y todas las cantidades solicitadas deben ser enteras y mayores que cero; si falta alguna, se indica el error y no se descarga ningún archivo parcial. Exportar no archiva la lista, no cambia el inventario ni el historial y puede repetirse.

Gestión y Administración pueden **Archivar** una lista para conservarla sin ediciones y **Reabrir** una archivada para recuperar el borrador. Archivar o reabrir no altera inventario ni historial. Las listas archivadas siguen consultándose y exportándose. Los artículos archivados que ya formaban parte de la lista siguen visibles como archivados y se incluyen al exportar; pueden retirarse mientras la lista sea un borrador.

Las listas y sus líneas se guardan en el mismo archivo SQLite y forman parte del estado incluido en las copias de seguridad y la restauración.

## Copias de seguridad

La aplicación crea copias de seguridad automáticas de la base de datos sin intervención manual:

- Al iniciar el servidor y cada 24 horas.
- Se guardan como archivos SQLite en `data/backups/` (o en `BACKUP_DIRECTORY`).
- Se conservan las 10 más recientes; las anteriores se eliminan automáticamente (`BACKUP_RETENTION`).

Desde **Copias de seguridad**, la cuenta administradora puede **Crear copia ahora** y ver cada copia con su fecha, tamaño, número de artículos, movimientos, categorías y listas de compra e integridad verificada.

**Restaurar** una copia reemplaza cuentas, artículos, categorías, inventario, historial y listas de compra por su contenido. Antes de reemplazar los datos, la aplicación guarda automáticamente una copia del estado anterior, de modo que una restauración siempre puede revertirse. El resultado se verifica: se comprueba la integridad de la base de datos restaurada y que sus recuentos de cuentas, artículos, movimientos, categorías y listas de compra coinciden con la copia elegida. Las copias anteriores a las categorías siguen siendo restaurables y se migran con los artículos Sin categoría. Una copia dañada aparece como **No verificable** y no puede restaurarse.

Parámetros opcionales: `BACKUP_DIRECTORY`, `BACKUP_INTERVAL_MS` y `BACKUP_RETENTION`.

## Probar

```powershell
npm test
```
