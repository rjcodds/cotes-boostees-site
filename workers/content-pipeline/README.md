# Pipeline de contenu (TikTok/Instagram) — Étage 1 : brief + script

**Statut : étage 1 câblé, pas encore déployé (secrets manquants). Pas de
génération vidéo ni de publication automatique -- volontaire.**

## Architecture prévue (3 étages)

1. **Brief + script** (ce worker, aujourd'hui) — repère la meilleure cote
   boostée du jour par edge % (déjà calculé par `unibet-flash-boost` et
   `winamax-flash-boost` via leur système de digest quotidien, réutilisé ici
   via `/digest-data` -- rien n'est re-scrapé ni recalculé), génère un script
   court via Claude, l'envoie sur un canal Telegram dédié pour validation
   manuelle.
2. **Génération vidéo** (à venir) — une fois le script validé, appel à
   Kie.ai (Veo 3 / Kling) pour produire la vidéo. Toujours en review avant
   publication.
3. **Publication auto** (à venir, seulement une fois la qualité constante) —
   Blotato ou Upload-Post pour poster automatiquement sur TikTok/Instagram.

Pourquoi commencer en mode review manuelle plutôt que tout automatiser
d'un coup : ça publierait du contenu généré par IA sous la marque
@RJCBoost en public -- mieux vaut valider le format sur quelques jours
avant de lâcher la bride.

## Pourquoi pas de génération vidéo tout de suite

Pas de compte Kie.ai créé pour l'instant (à faire par l'utilisatrice,
étape manuelle). Une fois la clé API disponible, l'étage 2 se branche sur
le script validé de l'étage 1.

## Secrets à poser avant de déployer

```
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put CONTENT_REVIEW_CHAT_ID
```

`TELEGRAM_BOT_TOKEN` peut être le même bot que les autres workers.
`CONTENT_REVIEW_CHAT_ID` doit être un canal/chat Telegram dédié à la
review de contenu -- distinct du canal spawn (monitoring) et du canal
abonnés, pour ne pas mélanger les usages.

## Test manuel

`GET /run` déclenche un brief immédiatement (sans attendre le cron de
20h05) -- utile pour valider le format avant de laisser tourner en
automatique.
