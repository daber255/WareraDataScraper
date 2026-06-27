#!/bin/bash
set -e
PI_HOST="${PI_HOST:-pi@192.168.178.42}"
PI_DIR="/home/pi/WareraDataScraper"
LOCAL_DOCS="$(dirname "$0")/../docs"

echo "=== Syncing scripts to Pi ==="
rsync -ah "$(dirname "$0")/generate-dashboard.ts" "$(dirname "$0")/report-utils.ts" "$PI_HOST:$PI_DIR/scripts/"

echo "=== Stopping PM2 on Pi ==="
ssh "$PI_HOST" "source /home/pi/.nvm/nvm.sh && nvm use 22 && pm2 stop warera-scraper"

echo "=== Generating dashboard on Pi ==="
ssh "$PI_HOST" "source /home/pi/.nvm/nvm.sh && nvm use 22 && cd $PI_DIR && npx tsx scripts/generate-dashboard.ts"

echo "=== Copying output to this PC ==="
rsync -ah --delete "$PI_HOST:$PI_DIR/docs/" "$LOCAL_DOCS/"

echo "=== Restarting PM2 on Pi ==="
ssh "$PI_HOST" "source /home/pi/.nvm/nvm.sh && nvm use 22 && pm2 restart warera-scraper"

echo "=== Done ==="
