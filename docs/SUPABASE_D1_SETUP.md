# Activation Supabase Auth + Cloudflare D1

Cette étape active la fondation des comptes TradePilot. Elle ne modifie pas le moteur XAUUSD, le Cron de trois minutes, Telegram ni le mode sans ordre réel.

## 1. Créer le projet Supabase

1. Créer un projet Supabase.
2. Dans Project Settings → API, relever l'URL du projet (Project URL).
3. Activer l'authentification par e-mail dans Authentication → Providers.
4. Conserver la confirmation d'adresse e-mail activée pour les inscriptions publiques.
5. Ne jamais placer la clé service_role dans le navigateur ni dans le dépôt GitHub.

Le Worker vérifie les jetons d'accès signés par les clés publiques Supabase (JWKS). Les algorithmes acceptés sont ES256 et RS256. Les jetons doivent avoir le bon émetteur, l'audience authenticated et une expiration valide.

## 2. Créer la base D1

Depuis le terminal Wrangler connecté au bon compte Cloudflare :

```bash
npx wrangler d1 create tradepilot-ai-db
```

Cloudflare renvoie un identifiant de base. Ajouter ensuite ce binding dans wrangler.toml (remplacer la valeur par l'identifiant réellement renvoyé) :

```toml
[[d1_databases]]
binding = "DB"
database_name = "tradepilot-ai-db"
database_id = "ID_D1_REEL"
```

Ne pas déployer avec le texte fictif ID_D1_REEL.

## 3. Appliquer le schéma

```bash
npx wrangler d1 execute tradepilot-ai-db --remote --file=migrations/0001_saas_core.sql
```

Cette migration crée les utilisateurs, espaces, rôles, abonnements, droits, connexions broker en lecture seule, événements de signaux et événements d'audit. Elle impose un espace personnel par utilisateur et un seul abonnement actif par espace.

## 4. Configurer l'URL Supabase sur le Worker

Définir la variable non secrète :

```bash
npx wrangler secret put SUPABASE_URL
```

Saisir l'URL du projet Supabase, par exemple https://xxxx.supabase.co. Cette valeur est utilisée pour retrouver les clés publiques et vérifier l'émetteur JWT. Aucune clé service_role n'est requise par ce mécanisme.

Puis déployer :

```bash
npx wrangler deploy
```

## 5. Vérifier le compte authentifié

Après connexion côté application et obtention d'un access token Supabase :

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" https://tradepilot-ai.williampaurent.workers.dev/api/account
```

La réponse doit contenir l'utilisateur, son espace, son rôle propriétaire et son abonnement Free. Sans jeton valide, l'API répond 401. Si D1 n'est pas lié, elle répond 503.

## État fonctionnel et limites

- GET /api/account est protégé par la validation cryptographique du jeton Supabase.
- Le premier appel crée ou retrouve l'utilisateur, son espace personnel, son rôle owner et son abonnement Free.
- Le provisioning est conçu pour supporter les appels simultanés.
- Le tableau de bord historique et les journaux globaux existants ne sont pas encore convertis en données isolées par espace. Ne pas ouvrir l'inscription publique ni commercialiser des espaces partagés avant d'avoir migré toutes les routes privées et les données Edge vers D1 avec contrôle d'appartenance.
- Le front-end n'a pas encore d'écran d'inscription/connexion : il faut connecter le client Supabase au site et lui faire appeler /api/account avec l'access token.
- Aucun paiement, aucune clé broker et aucun ordre réel ne sont activés.