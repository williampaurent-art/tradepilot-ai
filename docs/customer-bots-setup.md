> **Statut : phase SaaS reportée.** Le parcours actuellement prioritaire est le Bot Builder local, sans inscription. Ce guide décrit uniquement les fondations futures Supabase/D1 ; il n'est pas nécessaire pour créer, modifier ou analyser les bots en mode local.

# Activation de l'espace client « Mes bots »

## Ce qui est ajouté

- Authentification e-mail / mot de passe via Supabase Auth.
- Jeton Supabase vérifié côté Worker avant toute opération sur les bots.
- Création et lecture des bots dans Cloudflare D1, rattachés à un workspace.
- Historique des signaux rattaché au bot et au workspace.
- Les requêtes filtrent systématiquement par `workspace_id`.
- Aucun ordre réel n'est envoyé.

## Configuration requise avant mise en production

### 1. Supabase

Le projet Supabase est déjà référencé par `SUPABASE_URL` dans `wrangler.toml`.

Dans Cloudflare Workers & Pages → `tradepilot-ai` → Settings → Variables and Secrets, ajouter :

- Nom : `SUPABASE_PUBLISHABLE_KEY`
- Valeur : la clé publishable `sb_publishable_...` du projet Supabase
- Type : variable texte (cette clé est conçue pour être utilisée côté client ; elle n'est pas une clé service-role)

Ne jamais ajouter une clé `service_role` ou un secret Supabase dans le navigateur.

Dans Supabase Auth, configurer les URL autorisées :
- Site URL : URL publique TradePilot
- Redirect URLs : URL publique TradePilot et ses pages d'authentification

### 2. Cloudflare D1

La base `tradepilot-ai-db` doit déjà contenir les tables de `migrations/0001_saas_core.sql`.

Appliquer ensuite `migrations/0002_customer_bots.sql` sur la base distante `tradepilot-ai-db`. Cette migration crée `trading_bots` et `bot_signal_events`.

Commande Wrangler depuis le dépôt :
```bash
npx wrangler d1 migrations apply tradepilot-ai-db --remote
```

Si le système de migrations Wrangler n'est pas initialisé, exécuter le SQL de `0002_customer_bots.sql` dans la console D1 après avoir confirmé que la migration 0001 est déjà appliquée.

### 3. Déploiement et vérification

Déployer le Worker après configuration des variables et de D1.

Vérifier :
- `GET /api/public-config` renvoie `ok: true` sans exposer de secret service-role.
- `/auth.html` permet inscription et connexion.
- `GET /api/account` avec un Bearer valide crée/récupère le workspace.
- `GET /api/bots` renvoie uniquement les bots du workspace connecté.
- `POST /api/bots` refuse les requêtes sans jeton et stocke le bot dans D1.
- Un compte différent ne peut pas lire les bots ou signaux du premier.

## Limite fonctionnelle actuelle

Les tables et l'API d'historique sont prêtes à recevoir les signaux, mais le moteur qui analyse chaque stratégie client et insère les signaux dans `bot_signal_events` n'est pas encore activé. L'interface indique donc clairement qu'aucun signal n'a été généré. Ne pas présenter les brouillons comme des bots actifs.
