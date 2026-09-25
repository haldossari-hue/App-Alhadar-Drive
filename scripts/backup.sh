#!/bin/sh
# نسخة احتياطية آمنة للقاعدة والملفات أثناء التشغيل. جدولها يومياً عبر cron:
#   0 3 * * * /path/to/alhadar-drive/scripts/backup.sh
set -e
cd "$(dirname "$0")/.."
DIR=${DATA_DIR:-./data}
OUT=${BACKUP_DIR:-./backups}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$OUT"
node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('$DIR/alhadar.db').exec(\"VACUUM INTO '$OUT/alhadar-$STAMP.db'\");"
tar -czf "$OUT/uploads-$STAMP.tgz" -C "$DIR" uploads
find "$OUT" -type f -mtime +30 -delete
echo "backup ok: $OUT/alhadar-$STAMP.db"
