# TradePilot AI — Bot Builder local

## Parcours utilisateur

1. Ouvrir **Créer bot** depuis la navigation.
2. Nommer la stratégie et sélectionner XAUUSD, un style et une unité de temps.
3. Choisir au moins deux indicateurs directionnels parmi EMA 9/21, RSI 14, MACD, Bollinger et Structure / liquidité. L'ATR 14 est un filtre de volatilité et sert au calcul des niveaux de risque.
4. Définir le capital de référence, le risque, la limite journalière, le nombre maximal de positions et les directions autorisées.
5. Enregistrer la configuration. Elle apparaît dans **Mes bots**.
6. Activer le bot dans l'interface, puis choisir **Analyser maintenant** pour lancer une analyse réelle.

## Moteur de signaux

L'endpoint public `POST /api/bot-analyze` valide le schéma, le marché XAUUSD, le timeframe et les indicateurs autorisés. Il récupère les bougies clôturées et la cotation live, vérifie la fraîcheur et la continuité, calcule les indicateurs sélectionnés, puis retourne ACHAT, VENTE ou ATTENDRE.

- EMA 9/21 : alignement et croisement.
- RSI 14 : momentum et progression du RSI.
- MACD : signe et accélération de l'histogramme.
- Bandes de Bollinger : franchissement de la médiane.
- Structure / liquidité : cassure de la plage des 20 bougies précédentes.
- ATR 14 : filtre de volatilité et distance de stop/objectif.
- Seuil heuristique de confirmation : 60/100.
- Stop : ATR multiplié par 1,25 (scalping), 1,75 (day) ou 2,25 (swing), avec plancher lié au spread.
- Objectif : 1,8 fois la distance du stop.

Les règles sont explicites et déterministes. Un score n'est pas une probabilité de gain. Les résultats doivent être testés sur des historiques suffisamment longs, avec spread, slippage, commissions et conditions propres au broker.

## Stockage et limites

- Les bots et signaux sont enregistrés dans le `localStorage` du navigateur.
- Les données ne sont pas synchronisées entre appareils ou navigateurs.
- L'analyse est déclenchée manuellement depuis la fiche du bot ; aucun traitement planifié par bot n'est activé.
- Un signal confirmé est conservé dans l'historique local avec son prix d'entrée, son stop, son objectif, son score et l'heure de la bougie clôturée.
- Les analyses ATTENDRE sont visibles comme dernière analyse mais ne sont pas ajoutées à l'historique des signaux confirmés.
- Les paramètres de capital et de risque sont informatifs. Aucun lot n'est calculé, car les spécifications de contrat et la devise du compte broker ne sont pas vérifiées.
- Aucun ordre réel n'est envoyé. Le mode de trading automatique n'est pas activé.

## Déploiement

Le Worker doit être déployé avec le nouveau code pour que `POST /api/bot-analyze` soit disponible. Le statut GitHub/Cloudflare doit être vérifié séparément ; un commit réussi ne prouve pas que la version publique est déjà déployée.

## Vérifications manuelles après déploiement

- `GET /health` retourne `liveTrading: false`.
- Créer une configuration sans compte et vérifier qu'elle apparaît dans Mes bots.
- Modifier puis enregistrer un bot et vérifier que son identifiant et son historique restent attachés.
- Activer, mettre en pause, réactiver puis supprimer un bot.
- Lancer une analyse lorsque le marché est ouvert et que la cotation est fraîche.
- Vérifier qu'une source périmée ou des bougies discontinues renvoient une erreur et aucun signal.
- Vérifier qu'une stratégie en pause ne peut pas lancer d'analyse depuis l'interface.
- Vérifier qu'un signal est dédupliqué pour la même bougie clôturée et la même direction.
