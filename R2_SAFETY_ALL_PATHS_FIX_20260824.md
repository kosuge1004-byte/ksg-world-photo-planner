# R2 safety all paths fix

All five JSON API cache paths now use the same R2 read/write/storage safety budget. Unguarded bucket.head and bucket.delete were removed from getOrCreateR2Json.

Protected endpoints:
- geocode
- timezone
- osm-site-context
- gsi-geoid GET/POST
- gsi-elevation

Every R2 get/put now passes the conservative guard.
