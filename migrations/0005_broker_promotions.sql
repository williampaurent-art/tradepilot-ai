-- VT Markets promotion catalogue. Only published, verified and date-valid offers are exposed.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS broker_promotions (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK (provider IN ('vt_markets')),
 slug TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 summary TEXT NOT NULL,
 promotion_type TEXT NOT NULL,
 entity_label TEXT,
 eligible_countries_json TEXT,
 excluded_countries_json TEXT,
 eligible_account_types_json TEXT,
 bonus_percent REAL CHECK (bonus_percent IS NULL OR bonus_percent >= 0),
 bonus_cap_amount REAL CHECK (bonus_cap_amount IS NULL OR bonus_cap_amount >= 0),
 bonus_cap_currency TEXT,
 min_deposit_amount REAL CHECK (min_deposit_amount IS NULL OR min_deposit_amount >= 0),
 min_deposit_currency TEXT,
 starts_at TEXT,
 ends_at TEXT,
 status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('draft','review','published','paused','expired')),
 terms_url TEXT,
 source_url TEXT NOT NULL,
 source_label TEXT,
 verified_at TEXT,
 published_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_broker_promotions_status_dates ON broker_promotions(provider,status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_broker_promotions_verified ON broker_promotions(provider,verified_at DESC);
-- Publicly visible offer categories are research leads only; none is advertised as active.
INSERT OR IGNORE INTO broker_promotions (id,provider,slug,title,summary,promotion_type,status,source_url,source_label) VALUES
('vt-promo-deposit-review','vt_markets','deposit-bonus','Bonus de dépôt','Crédit promotionnel éventuel, soumis aux campagnes actives, à la région, au compte et aux conditions spécifiques.','deposit_bonus','review','https://www.vtmarkets.com/en-eu/promotions/','Liste officielle VT Markets'),
('vt-promo-welcome-review','vt_markets','welcome-bonus','Bonus de bienvenue','Offre de bienvenue à confirmer dans le Client Portal pour le pays et l’entité du client.','welcome_bonus','review','https://www.vtmarkets.com/en-eu/promotions/','Liste officielle VT Markets'),
('vt-promo-vps-review','vt_markets','vps-refund','Remboursement VPS','Programme soumis à des seuils d’activité et à des conditions dédiées.','vps_rebate','review','https://www.vtmarkets.com/en-eu/promotions/','Liste officielle VT Markets'),
('vt-promo-club-review','vt_markets','clubelite','ClubÉlite','Programme de fidélité ou de récompenses dont les niveaux et conditions doivent être confirmés.','loyalty','review','https://www.vtmarkets.com/en-eu/promotions/','Liste officielle VT Markets');
