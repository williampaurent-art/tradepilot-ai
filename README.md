# TradePilot AI

Tableau de bord d'analyse technique XAUUSD, hébergé sur Cloudflare Workers.

## Interface Market Intelligence

Le dossier `public/` contient l'interface responsive en français. La racine du Worker sert le tableau de bord via Cloudflare Workers Static Assets.

Fonctions affichées :
- cours Bid/Ask, source et horodatage lorsqu'une cotation live est disponible ;
- statut de marché uniquement lorsque la source le confirme ;
- analyse M1, M5, M15, H1, H4 et D1 ;
- EMA 20/50/200, RSI 14, MACD, ADX/DMI, Bollinger, ATR et Stochastique ;
- classification de régime (tendance, range, transition, indéterminé) ;
- structure par pivots, BOS/CHOCH et divergences RSI simplifiées ;
- supports/résistances, bornes de range et alertes de ralentissement ;
- calendrier économique Finance Calendar lorsque le secret API est configuré.

## API

- `GET /health` : santé du Worker et confirmation que l'exécution réelle est désactivée.
- `GET /status` : état du Cron, dernière analyse et dernière alerte.
- `GET /dashboard-data` : données agrégées pour le tableau de bord.
- `POST /assistant-chat` : assistant conversationnel XAUUSD propulsé par Cloudflare Workers AI. Le corps JSON accepte `question`, `history` et `marketContext` (photographie du tableau de bord).
- `GET /gold?timeframe=M1|M5|M15|H1|H4|D1` : diagnostic de données par unité.
- `GET /analyze` : analyse technique utilisée par le robot.
- `GET /calendar` : contexte du calendrier économique.

## Données et limites

La source OHLC configurée est BiQuote. Les intervalles H1, H4 et D1 sont demandés au fournisseur ; si un intervalle n'est pas pris en charge, si l'historique est insuffisant ou si les données sont périmées, le tableau de bord l'affiche comme indisponible au lieu d'inventer des valeurs. La disponibilité effective de chaque intervalle doit être vérifiée après déploiement.

Le score affiché est un indicateur technique descriptif et ne représente pas une probabilité de gain. Les divergences et les pivots sont des heuristiques techniques à valider sur données historiques. Le calendrier dépend du secret `FINANCE_CALENDAR_API_KEY`.

## Sécurité d'exécution

- Aucun endpoint du tableau de bord ne transmet d'ordre au broker.
- `liveTrading: false` reste la configuration attendue.
- Le Cron d'analyse reste configuré toutes les trois minutes (`*/3 * * * *`).
- Les alertes Telegram existantes ne sont pas remplacées par l'interface.


## Assistant conversationnel

L'assistant utilise le binding Cloudflare Workers AI `AI` et le modèle `@cf/meta/llama-3.1-8b-instruct`. Il reçoit une version filtrée des données du tableau de bord et un historique court. Une limite applicative de 12 requêtes par période de 10 minutes et par adresse IP est appliquée via KV lorsque KV est disponible.

Le quota gratuit Workers AI publié par Cloudflare est limité à 10 000 Neurons par jour ; les requêtes peuvent échouer lorsque le quota quotidien est épuisé sur l'offre Free. Vérifier la consommation dans le tableau de bord Cloudflare. L'assistant n'est pas un moteur d'exécution et ne transmet aucun ordre au broker.

La qualité des réponses dépend de la fraîcheur et de la couverture des données OHLC et du calendrier. L'assistant doit signaler les informations manquantes et ne doit jamais transformer un scénario anticipatif en signal confirmé.


## TradePilot Edge & SaaS

- `GET /signal-history` : journal des décisions et alertes du Cron.
- `GET /edge-stats` : résultats observés des alertes Telegram confirmées (TP/SL M1, win rate, expectancy R, ventilation achat/vente).

TradePilot Edge suit les alertes confirmées et mesure leurs résultats à partir des bougies M1 après l'alerte. Les résultats ambigus (TP et SL touchés dans la même bougie) sont exclus. Cette mesure n'intègre pas les frais, le spread ni le slippage et ne constitue pas une probabilité future.

Le schéma SaaS multi-espace (utilisateurs, workspaces, rôles, abonnements, droits, connexions broker en lecture seule et journal d'audit) est préparé dans `migrations/0001_saas_core.sql`. Il n'est pas encore activé : aucun binding D1 ni fournisseur d'identité/facturation n'a été configuré. La version actuelle ne doit donc pas être présentée comme une plateforme multi-utilisateur isolée prête à vendre. Voir [la feuille de route Edge & SaaS](docs/TRADEPILOT_EDGE_SAAS.md).

### Identité et comptes SaaS

- `GET /api/account` : vérifie un jeton d'accès Supabase (JWKS, ES256/RS256) et provisionne l'utilisateur, son espace personnel et son abonnement Free dans D1.
- Configuration et commandes d'activation : [guide Supabase Auth + D1](docs/SUPABASE_D1_SETUP.md).
- Cette fondation n'active pas encore les inscriptions dans l'interface : l'écran de connexion et l'isolation des routes/données historiques restent à réaliser avant toute ouverture publique.


## TradePilot Strategy Builder

Le Builder permet de décrire une stratégie en français, de générer un brouillon structuré avec Workers AI et de sauvegarder ses propres stratégies dans un espace utilisateur isolé.

- `GET /api/auth-config` : configuration publique du client Supabase Auth.
- `POST /api/strategy-interpret` : interprétation IA d'une stratégie en règles descriptives.
- `GET /api/strategies` et `POST /api/strategies` : liste et création de brouillons protégés par JWT Supabase.
- `DELETE /api/strategies/{id}` : suppression limitée au workspace authentifié.
- Migration complémentaire : `migrations/0002_strategy_bots.sql`, à appliquer après `0001_saas_core.sql`.

Configuration, migrations et limites : [Guide Strategy Builder](docs/STRATEGY_BUILDER_MVP.md).

Le Builder reste en mode brouillon / alertes uniquement. Il ne génère ni n'exécute de code utilisateur et ne transmet aucun ordre réel.
