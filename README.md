# TradePilot AI

**Tableau de bord d'intelligence de marché XAUUSD + moteur de signaux autonomes.**

Hébergé sur Cloudflare Workers. Analyse technique multi-timeframe, alertes Telegram filtrées, suivi de performance (Edge), Bot Builder personnalisé et assistant conversationnel.

> **Sécurité** : `liveTrading` est **toujours désactivé**. Aucun ordre n'est jamais envoyé à un broker.

---

## Fonctionnalités

### Market Intelligence
- Cotation Bid/Ask live (BiQuote) avec contrôle de fraîcheur strict
- Analyse M1 · M5 · M15 · H1 · H4 · D1
- Indicateurs : EMA 20/50/200, RSI 14, MACD, ADX/DMI, Bollinger, ATR, Stochastique
- Régime de marché (tendance / range / transition)
- Structure (pivots, BOS/CHOCH), supports/résistances, divergences
- Calendrier économique + contexte macro (lorsque les clés sont configurées)

### Moteur autonome (Cron toutes les 3 minutes)
- Analyse complète multi-timeframe
- Scoring et confirmation de setup
- Alertes Telegram uniquement sur signaux **CONFIRMÉS**
- Contrôle anti-doublon + limite adaptative journalière
- Suivi des résultats (TP/SL) → **TradePilot Edge**
- Positions virtuelles X10 (papier)
- **Exécution autonome des bots `active` toutes les 3 minutes** (signaux confirmés enregistrés par espace, jamais d'ordres réels)

### Bot Builder
- Création de stratégies personnalisées (indicateurs, style, risque)
- Mode local (localStorage) pour essayer sans compte
- Mode cloud (D1) pour les utilisateurs authentifiés
- Historique des signaux par bot

### Assistant conversationnel
- Powered by Cloudflare Workers AI (Llama 3.1)
- Contexte du tableau de bord injecté
- Rate-limit IP

---

## Architecture

```
src/index.js          → Worker principal (Cron + API + Assets)
public/               → Interface (dashboard, builder, bots)
migrations/           → Schéma D1 (SaaS + bots + portail client)
docs/                 → Documentation technique
```

### Endpoints principaux

| Route | Description |
|-------|-------------|
| `GET /health` | Santé + confirmation `liveTrading: false` |
| `GET /status` | État du Cron et dernière analyse |
| `GET /dashboard-data` | Données agrégées pour l'interface |
| `GET /analyze` | Analyse technique on-demand |
| `GET /edge-stats` | Performance observée des alertes |
| `GET /api/portal` | Synthèse de l’espace client (auth) |
| `GET /api/portal/promotions` | Offres broker publiées, valides et filtrées par pays (auth) |
| `POST /api/portal/profile` | Mise à jour du profil client (auth) |
| `POST /api/portal/partner-click` | Attribution des clics partenaires (auth, retourne un click ID) |
| `POST /api/partner/webhook` | Réception de conversions VT Markets signées HMAC (secret serveur) |
| `GET /api/partner/dashboard` | Funnel, clics, campagnes et conversions (clé serveur, 7 à 365 jours) |
| `POST /api/portal/academy-progress` | Progression Academy (auth) |
| `POST /api/portal/broker-request` | Demande de parcours broker (auth + consentement) |
| `POST /api/bot-analyze` | Analyse d'une config bot |
| `GET/POST /api/bots` | Liste / création de bots (auth) |
| `POST /api/bots/:id` | Modifier un bot (auth + espace propriétaire) |
| `POST /api/bots/:id/status` | Activer / mettre en pause (auth) |
| `POST /api/bots/:id/analyze` | Analyse à la demande et sauvegarde du signal confirmé |
| `POST /api/bots/:id/delete` | Supprimer un bot (auth) |
| `GET /api/bots/:id/signals` | Historique cloud du bot (auth) |
| `POST /assistant-chat` | Assistant IA |

---

## Déploiement

```bash
# Prérequis
npm i -g wrangler
wrangler login

# Configuration Supabase (clé publishable requise pour connexion/inscription)
wrangler secret put SUPABASE_PUBLISHABLE_KEY

# Secrets nécessaires
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_GROUP_CHAT_ID
# (optionnel) wrangler secret put FINANCE_CALENDAR_API_KEY

# Déployer
wrangler deploy
```

Le Cron `*/3 * * * *` est déjà déclaré dans `wrangler.toml`.

---

## Activation du SaaS

Avant d'ouvrir les inscriptions :
1. Dans GitHub → Settings → Secrets and variables → Actions, créer les secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` et `SUPABASE_PUBLISHABLE_KEY`. Le jeton Cloudflare doit pouvoir gérer Workers et D1 ; la clé Supabase doit être la clé publishable du projet correspondant à `SUPABASE_URL`.
2. Le workflow `.github/workflows/deploy-worker.yml` exécute les tests, applique les migrations D1 puis déploie le Worker à chaque modification pertinente sur `main`. Si les secrets manquent, il saute le déploiement sans modifier la production.
3. Vérifier `GET /health`, `GET /api/public-config`, puis tester inscription, connexion, création, activation, analyse, historique et suppression avec deux comptes distincts.
4. Vérifier que chaque compte ne voit que les bots de son propre espace.
5. Garder les ordres réels désactivés.

Les bots actifs sont évalués par le Cron toutes les trois minutes, par lots tournants de 20 bots maximum pour préserver les limites CPU du Worker gratuit. Les signaux confirmés sont enregistrés dans D1, par espace. Les signaux propres aux clients ne sont pas envoyés au canal Telegram global.

### Portail client (migration 0004)
- Profil personnel lié au workspace authentifié
- Synthèse bots, signaux, plan et suivi broker
- Attribution des clics vers VT Markets et suivi de campagne
- Progression Academy stockée par utilisateur/espace
- Demandes de connexion broker enregistrées en attente, avec consentement
- Aucune donnée d’identification MT5 n’est collectée ; aucune connexion broker réelle n’est simulée

## Philosophie & limites

- Tout score est **heuristique**, jamais une probabilité de gain.
- Les résultats Edge n'incluent pas spread, slippage ni commissions.
- Les bots n'exécutent **aucun ordre réel**.
- Les données OHLC dépendent de la source BiQuote ; les timeframes non fournis sont affichés comme indisponibles.
- Le mode SaaS multi-utilisateur (auth + isolation) est préparé dans les migrations mais **pas encore activé en production**.

---

## Roadmap (prochaines étapes recommandées)

1. Modularisation complète de `src/index.js`
2. Backtest historique côté serveur pour les bots
3. Activation progressive de l'auth (Supabase / Cloudflare Access)
4. Fallback data source
5. Tests unitaires automatisés sur les indicateurs

---

**TradePilot AI** — analyse, discipline, transparence.


### Catalogue des promotions broker (migration 0005)
- Catalogue VT Markets structuré avec pays inclus/exclus, entité, types de compte, seuils, plafonds, dates, sources et date de vérification.
- L’API authentifiée GET /api/portal/promotions expose les catégories en revue comme pistes à confirmer ; seules les offres publiées, vérifiées depuis moins de 30 jours, non expirées et explicitement éligibles au pays, à l’entité et au type de compte sont présentées comme validées.
- Les catégories repérées publiquement sont préchargées en statut review : elles ne sont donc jamais présentées comme actives ou garanties.
- La page client renvoie vers les pages officielles et rappelle que l’éligibilité finale se confirme dans le Client Portal VT Markets.


### Attribution et conversions broker (migration 0006)
- Chaque clic VT Markets authentifié génère un `clickId` pseudonyme ; `utm_source` et `utm_campaign` sont conservés pour l'analyse par campagne. Le paramètre sub-ID sortant reste à confirmer par le broker.
- `POST /api/partner/webhook` accepte uniquement les événements signés HMAC-SHA256 via l’en-tête `x-vt-signature` (`sha256=<hex>`), avec déduplication par identifiant d’événement.
- Événements acceptés : `registration`, `account_approved`, `first_deposit`, `first_trade`, `active_trader`, `commission`.
- `GET /api/partner/dashboard` expose le funnel, les clics uniques par workspace, les séries quotidiennes, les campagnes, les conversions attribuées et les commissions séparées par devise. Paramètre `days` : 7 à 365 (défaut 30). Protégé par `PARTNER_DASHBOARD_KEY` dans l’en-tête `x-partner-dashboard-key`.
- Secrets Cloudflare à configurer avant activation : `VT_PARTNER_WEBHOOK_SECRET` et `PARTNER_DASHBOARD_KEY`. Le broker doit accepter/configurer le postback HMAC et transmettre le click ID ; tant que ce n’est pas fait, aucune conversion broker ne sera disponible.
- Aucune donnée personnelle du client n’est stockée dans le journal de postbacks.

- Contrat technique de postback VT Markets : [docs/partner-postbacks.md](docs/partner-postbacks.md).

- Le dashboard partenaire fournit désormais un funnel et des ventilations par campagne/source, avec des taux bruts explicitement signalés comme non-cohortes et des commissions regroupées par devise.

### Dashboard partenaire privé
- Interface `public/partner-dashboard.html` pour visualiser les clics, inscriptions, premiers trades, traders actifs, campagnes, conversions quotidiennes et commissions par devise.
- Accès aux données protégé par la clé `PARTNER_DASHBOARD_KEY`, saisie manuellement à chaque session et non stockée dans le navigateur.
- Ouvrir `/partner-dashboard.html` ; les données restent indisponibles tant que les postbacks broker et les secrets Cloudflare ne sont pas configurés.
---

## Market Data API v1 (branche de fondation)

- `GET /api/v1/markets` : catalogue initial de 10 instruments.
- `GET /api/v1/markets/:symbol/candles?timeframe=M15&limit=100` : chandeliers normalisés.
- Timeframes autorisés : M1, M5, M15, H1, H4, D1.
- Limite : 30 à 250 chandeliers par requête.
- Source initiale : BiQuote, derrière un adaptateur isolé.
- Les instruments autres que XAUUSD restent marqués `not-yet-verified` jusqu'à validation effective de la couverture fournisseur.
- Les erreurs de fournisseur renvoient `signalEligible: false` ; aucune donnée de remplacement n'est inventée.
- Cette API ne crée aucun signal et n'exécute aucun ordre.
- `GET /api/v1/markets/:symbol/analysis?limit=150` : analyse multi-timeframe M1, M5, M15, H1 et H4, avec score de consensus pondéré (10/15/25/25/25 %).
- Le consensus n'est calculé que sur les timeframes dont les bougies sont réellement disponibles ; les timeframes manquants sont explicitement listés.
- `signalEligible` reste faux si une timeframe manque ou si la couverture fournisseur de l'instrument n'est pas vérifiée.
- Le moteur technique expose EMA 9/20/50, RSI 14, MACD, Bollinger, ATR, ADX et niveaux de support/résistance. Le score est heuristique, non probabiliste.
- Le champ `execution` vaut toujours `NO_ORDERS` : l'API ne transmet aucun ordre au broker.

Les tests isolés se lancent avec `node --test tests/market-data.test.mjs`. Le workflow `Market Data Foundation Tests` ne fait que lancer ces tests ; il ne déploie pas le Worker.
