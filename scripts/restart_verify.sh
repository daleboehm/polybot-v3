#!/bin/bash
systemctl start polybot-v3-rd
systemctl restart polybot-v3
sleep 5
echo "R&D: $(systemctl is-active polybot-v3-rd)"
echo "Prod: $(systemctl is-active polybot-v3)"
sqlite3 -column -header /opt/polybot-v3-rd/data/rd.db "SELECT slug, current_cash, trading_balance FROM entities;"
echo "Trades: $(sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT COUNT(*) FROM trades;')"
echo "Markets: $(sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT COUNT(*) FROM markets;')"
