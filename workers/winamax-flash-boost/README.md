# Winamax Flash Boost → Telegram

Vérifie toutes les 10 minutes la page réelle des cotes boostées Winamax et poste automatiquement dans le canal Telegram privé toute "Grosse Cote Boostée" (mise max ≤ 10€). Aucune relecture manuelle.

## Différence avec le worker Unibet

Contrairement à Unibet (page rendue côté serveur, simple fetch HTTP), Winamax charge ses cotes via un flux temps réel (Socket.IO) après exécution du JavaScript. Il faut donc un vrai navigateur -- ce worker utilise [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) (`@cloudflare/puppeteer`) pour naviguer sur la page, attendre que `window.PRELOADED_STATE` soit rempli par le flux temps réel, puis en extraire les cotes.

La bonne URL est `https://www.winamax.fr/paris-sportifs/sports/100000` -- **pas** `/cotes-boostees` (qui est une simple page marketing sans données).

## Coût

Le plan gratuit Cloudflare inclut 10 min de navigateur/jour. Chaque check prend ~5-6 secondes, donc un check toutes les 10 minutes (144/jour) reste largement dans ce budget gratuit (~12-15 min/jour au pire, à surveiller). La fenêtre de disponibilité d'une Grosse Cote Boostée est de 30-35 minutes, donc ce rythme laisse une marge confortable.

## Déploiement

Identique au worker `unibet-flash-boost` (voir son README), avec en plus le binding `browser` déjà configuré dans `wrangler.toml` :

```bash
cd workers/winamax-flash-boost
npm install
wrangler login
wrangler kv namespace create SEEN_BOOSTS   # copier l'id dans wrangler.toml
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler deploy
```

## Tester manuellement

`https://winamax-flash-boost.<ton-sous-domaine>.workers.dev/run`

## Limite connue

Si Winamax change la structure de `window.PRELOADED_STATE` ou l'URL de la page, le parsing dans `parseBoosts` devra être ajusté. Le filtre sur la mise max se base sur le texte `betTypeName`/`betTitle` ("mise max X €"), pas sur un champ dédié -- assez robuste tant que Winamax garde cette formulation.
