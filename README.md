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
- **Exécution autonome des bots `active`** (signaux enregistrés, jamais d'ordres réels)

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
migrations/           → Schéma D1 (SaaS + bots)
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
| `POST /api/bot-analyze` | Analyse d'une config bot |
| `GET/POST /api/bots` | Liste / création de bots (auth) |
| `POST /assistant-chat` | Assistant IA |

---

## Déploiement

```bash
# Prérequis
npm i -g wrangler
wrangler login

# Secrets nécessaires
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_GROUP_CHAT_ID
# (optionnel) wrangler secret put FINANCE_CALENDAR_API_KEY

# Déployer
wrangler deploy
```

Le Cron `*/3 * * * *` est déjà déclaré dans `wrangler.toml`.

---

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
