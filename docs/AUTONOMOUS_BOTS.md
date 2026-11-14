# Bots autonomes — TradePilot AI

## Comportement

Lorsque le Cron s'exécute (toutes les 3 minutes), le Worker :

1. Met à jour les résultats Edge des alertes principales.
2. Charge jusqu'à 20 bots dont le statut est `active` dans D1.
3. Pour chaque bot :
   - Vérifie que `liveTrading` n'est **pas** activé (hard-stop de sécurité).
   - Récupère les bougies clôturées + cotation live.
   - Exécute `evaluateConfiguredBot`.
   - Si un signal ACHAT ou VENTE est généré, l'enregistre dans `bot_signal_events` (avec déduplication sur timestamp + côté).
4. Aucun ordre n'est jamais envoyé.

## Prérequis

- Migration `0002_customer_bots.sql` appliquée.
- Bots créés via l'API authentifiée (`POST /api/bots`) et passés en `status = 'active'`.

## Limites actuelles

- Maximum 20 bots traités par cycle Cron (protection contre les timeouts).
- Pas encore de backtest historique automatisé.
- Pas de notification Telegram individuelle par bot (seulement le signal principal).
- Le mode localStorage (sans compte) ne peut pas être exécuté par le Cron.
