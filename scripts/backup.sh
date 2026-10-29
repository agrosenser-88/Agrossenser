#!/bin/sh
# Backup consistente do banco (VACUUM INTO) + pasta de uploads. Uso: npm run backup
set -e
cd "$(dirname "$0")/.."
DATA="${DATA_DIR:-data}"
OUT="${BACKUP_DIR:-backups}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
node --disable-warning=ExperimentalWarning -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DATA/agrosensor.db');d.exec(\"VACUUM INTO '$OUT/agrosensor.db'\");d.close();"
[ -d "$DATA/uploads" ] && cp -R "$DATA/uploads" "$OUT/uploads"
echo "Backup salvo em $OUT"
