# 1. Copias de seguridad y restauración

Fecha: 2026-09-25

Estado: Aceptado

## Contexto

El ticket #1 difirió la estrategia concreta de copias de seguridad al momento de
la implementación, con el requisito de no perder datos. La aplicación guarda
todo su estado (cuentas, artículos, existencias e historial, incluidas las
imágenes de los productos) en una única base de datos SQLite,
`data/inventory.sqlite`, más los archivos de imagen servidos por la aplicación,
desde un solo ordenador.

## Decisión

- Usar snapshots del archivo SQLite mediante `VACUUM INTO`. Produce una copia
  consistente y compacta sin dejar de usar la conexión viva.
- Nombrar cada copia `inventario-<fecha ISO>-<aleatorio>.sqlite` dentro de
  `data/backups/` (configurable con `BACKUP_DIRECTORY`).
- Guardar la imagen de cada producto como archivo en `data/images/`
  (configurable con `IMAGES_DIRECTORY`), nombrada con el identificador del
  producto y un sufijo aleatorio; la fila del producto solo conserva el nombre
  del archivo. Una imagen por producto (JPG, PNG o WEBP, hasta 2 MB), sustituible
  o eliminable desde la ficha.
- Incluir las imágenes en cada copia: al crear una copia se copia también la
  carpeta de imágenes junto al archivo SQLite, en `<copia>.sqlite.images`. La
  retención elimina ambos al mismo tiempo.
- Restaurar intercambia la base de datos y la carpeta de imágenes por las de la
  copia elegida, de modo que el estado restaurado incluye exactamente las
  imágenes de esa copia (y descarta las posteriores). La copia de seguridad del
  estado anterior conserva las imágenes previas, así que una restauración siempre
  puede revertirse con ellas.
- Crear copias automáticamente al iniciar el servidor y cada 24 horas
  (`BACKUP_INTERVAL_MS`), conservando las 10 más recientes
  (`BACKUP_RETENTION`). La retención evita que las copias crezcan sin límite.
- Verificar cada copia abriéndola en modo solo lectura y ejecutando
  `PRAGMA integrity_check`; una copia que falle se marca como no verificable y
  no se puede restaurar.
- Restaurar reemplazando el archivo de base de datos por el de la copia. Primero
  se copia aparte la copia elegida (para que la retención no pueda borrarla),
  luego se toma una copia de seguridad del estado anterior, se cierra la conexión
  viva y se intercambia el archivo. La restauración se confirma con CSRF y un
  token de confirmación.
- Verificar la restauración comparando la integridad y los recuentos de
  artículos, movimientos y cuentas con la copia de origen.
- Si algo falla después del intercambio, recuperar automáticamente la copia de
  seguridad del estado anterior y reabrir la base de datos, de modo que la
  operación nunca deja el inventario a medias.

La restauración está reservada a la cuenta administradora.

## Consecuencias

- Una restauración recupera el estado completo y consistente, y siempre puede
  revertirse a la instantánea tomada justo antes de restaurar.
- Las imágenes de los productos viajan con las copias y con la restauración:
  restaurar repone las imágenes que existían en ese momento y descarta las
  posteriores; la copia previa conserva las imágenes del estado anterior.
- Las sesiones en memoria siguen siendo válidas mientras su usuario exista en
  los datos restaurados; si no existe, la sesión caduca de forma natural.
- La verificación por recuentos detecta copias corruptas o truncadas, aunque no
  detecta cambios de contenido con el mismo número de filas. Para eso está
  `PRAGMA integrity_check` sobre el archivo restaurado.