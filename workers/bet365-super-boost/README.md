# Bet365 Super Boost → Telegram (canary quotidien — bloqué)

**Statut : bloqué au niveau réseau. Déployé uniquement comme "canary" : un
cron 1x/jour (voir `wrangler.toml`) vérifie si le blocage est levé et prévient
sur le canal privé de monitoring si c'est le cas. Pas de posting automatique
en continu tant que ça reste bloqué.**

## Ce qui a été fait

Le code présent dans ce dossier fonctionne et a été testé avec succès **en local** (Mac, IP résidentielle française) : il contourne la protection Cloudflare de Bet365, scrolle la page d'accueil pour déclencher le chargement paresseux des cartes de cotes boostées, et extrait proprement les données (description, cotes avant/après, mise/gain, distinction Super Boost / Bet Boost classique) directement depuis le DOM rendu.

## Pourquoi ce n'est pas déployé

Une fois déployé sur Cloudflare Workers (Browser Rendering), le navigateur hébergé par Cloudflare se fait **bloquer par la protection Cloudflare de Bet365 elle-même** :

```
"title": "Attention Required! | Cloudflare"
"bodyTextSample": "Sorry, you have been blocked..."
```

Confirmé via un vrai test en production (`wrangler tail` + requête réelle). Ce n'est pas un bug de code : c'est un blocage basé sur la réputation de l'IP. Cloudflare Browser Rendering utilise des IP de datacenter, que Bet365 détecte et bloque systématiquement -- aucun patch JavaScript (navigator.webdriver, etc.) ne peut réparer ça, contrairement au blocage "détection de navigateur automatisé" qu'on a contourné avec succès en local.

## Pour débloquer un jour

Il faudrait faire transiter les requêtes par un service de proxy résidentiel payant (IP "grand public" louées), qui apparaîtraient comme un vrai visiteur aux yeux de Bet365. C'est un coût récurrent et une étape supplémentaire dans l'évasion anti-bot, pas juste une question de code -- décision à prendre consciemment si on veut un jour réactiver ce worker.

## Si vous relancez ce chantier

Le code de `extractBoosts()` dans `index.js` reste valable tel quel (structure DOM + filtre `isSuperBoost`). Il suffirait de brancher une fonction `page.authenticate()`/proxy compatible avec `@cloudflare/puppeteer`, ou d'héberger ce worker ailleurs (pas sur Cloudflare Browser Rendering) avec un vrai proxy résidentiel configuré.
