# TradePilot Strategy Builder — MVP

Le Strategy Builder permet de décrire une stratégie en français, de la structurer avec Workers AI et de sauvegarder un brouillon dans l'espace personnel Supabase/D1.

## Ce qui est inclus

- Interface responsive « Créer mon bot » dans `public/index.html`.
- Interprétation de la description via le binding Cloudflare Workers AI et le modèle `@cf/zai-org/glm-4.7-flash`.
- Règles d'entrée/sortie descriptives, questions à clarifier et paramètres de risque bornés.
- Inscription / connexion e-mail via Supabase Auth (client public).
- API de sauvegarde protégée par vérification cryptographique du JWT Supabase.
- Isolation des brouillons par `workspace_id`; les lectures et suppressions ne peuvent viser que l'espace issu du jeton authentifié.
- Aucun code fourni par l'utilisateur n'est exécuté. Aucun ordre broker n'est transmis.

## Configuration requise

1. Créer ou réutiliser un projet Supabase et activer Email dans Authentication → Providers.
2. Conserver la confirmation d'adresse e-mail activée pour les inscriptions publiques.
3. Configurer sur le Worker :
   - `SUPABASE_URL` : URL du projet Supabase (déjà déclarée dans `wrangler.toml`, à vérifier).
   - `SUPABASE_ANON_KEY` : clé publishable / anon du projet. Elle est volontairement exposée par `GET /api/auth-config` pour initialiser le client navigateur. Ne jamais utiliser la clé `service_role`.
4. Vérifier que le binding D1 `DB` pointe vers la base `tradepilot-ai-db`.
5. Appliquer les migrations dans cet ordre depuis la racine du dépôt :

```bash
npx wrangler d1 execute tradepilot-ai-db --remote --file=migrations/0001_saas_core.sql
npx wrangler d1 execute tradepilot-ai-db --remote --file=migrations/0002_strategy_bots.sql
```

La première migration crée `users`, `workspaces`, `workspace_members`, `subscriptions` et `audit_events`. La deuxième crée `strategy_bots`. Ne pas appliquer la deuxième avant la première.

6. Configurer la clé publique côté Worker (elle n'est pas une clé service_role) :

```bash
npx wrangler secret put SUPABASE_ANON_KEY
```

Coller la clé anon / publishable depuis Supabase → Project Settings → API Keys. La route `/api/auth-config` ne renvoie que cette clé publique et l'URL du projet.

7. Déployer le Worker :

```bash
npx wrangler deploy
```

## Routes

- `GET /api/auth-config` : retourne l'URL Supabase et la clé publique anon/publishable.
- `POST /api/strategy-interpret` : transforme `{"idea":"..." }` en brouillon JSON via Workers AI. Limite applicative : 8 interprétations par IP et par fenêtre de 10 minutes lorsque KV est configuré.
- `GET /api/strategies` : liste les stratégies du workspace authentifié.
- `POST /api/strategies` : crée un brouillon. En-tête requis : `Authorization: Bearer <Supabase access token>`.
- `DELETE /api/strategies/{id}` : supprime un brouillon uniquement dans le workspace authentifié.

## Exemple de création

```json
{
  "name": "Gold RSI + MACD",
  "description": "Acheter le Gold quand le RSI revient au-dessus de 25 et que le MACD croise à la hausse.",
  "instrument": "XAUUSD",
  "timeframe": "M5",
  "config": {
    "entryConditions": ["RSI M5 repasse au-dessus de 25", "MACD M5 croise à la hausse"],
    "exitConditions": ["Sortie au signal opposé"],
    "riskPercent": 1,
    "stopLossEnabled": true
  }
}
```

Les instruments acceptés sont XAUUSD, EURUSD, GBPUSD et BTCUSD. Les timeframes acceptés sont M1, M5, M15, H1, H4 et D1. Le risque est limité côté serveur à 0,25–5 %.

## Limites du MVP

- L'interpréteur produit une proposition de règles : l'utilisateur doit la relire et compléter les questions ouvertes.
- Le backtest n'est pas encore branché à ce nouveau format de stratégie.
- Les brouillons sont enregistrés avec le statut `DRAFT` et le mode `ALERTS_ONLY`.
- Il n'existe aucune activation d'exécution réelle, aucune connexion MT5 créée par le Builder et aucun ordre automatique.
- Avant d'ouvrir les inscriptions au public, il faudra ajouter des tests automatisés, des quotas par compte, une politique de conservation/suppression et un audit de sécurité complet.
