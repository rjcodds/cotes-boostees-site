# Unibet Flash Boost → Telegram

Vérifie la page [cotes boostées Unibet](https://www.unibet.fr/cotes-boostees) toutes les 2 minutes, et poste automatiquement dans le canal Telegram privé toute cote dont la mise max est ≤ 10€. Aucune relecture manuelle : l'envoi est direct.

Comment ça marche : la page Unibet est rendue côté serveur, les cotes boostées sont donc présentes dans le HTML dès le chargement (pas besoin de navigateur headless). Le script extrait ces données par motif de texte, filtre sur la mise max, et évite de reposter deux fois la même cote grâce à un stockage Cloudflare KV (mémoire des cotes déjà envoyées, 6h).

## Prérequis

- Un compte Cloudflare (le même que pour le worker Telegram existant).
- Node.js installé, puis : `npm install -g wrangler`
- Un bot Telegram avec les droits de publication dans le canal privé :
  - Si tu as déjà un bot (utilisé pour le worker existant), tu peux le réutiliser — vérifie juste qu'il est **admin** du canal privé (Telegram exige que le bot soit admin pour poster, même s'il ne modère rien).
  - Sinon, crée-en un en écrivant à [@BotFather](https://t.me/BotFather) sur Telegram : `/newbot`, suis les instructions, il te donne un token du type `123456:ABC-...`.
  - Ajoute ce bot comme **administrateur** de ton canal privé (Paramètres du canal → Administrateurs → Ajouter).

## Récupérer le chat_id du canal privé

1. Poste n'importe quel message dans le canal privé.
2. Ouvre dans ton navigateur : `https://api.telegram.org/bot<TON_TOKEN>/getUpdates`
3. Cherche `"chat":{"id":-100xxxxxxxxxx` dans la réponse JSON — c'est ce nombre (avec le `-100` devant) qu'il faut utiliser comme `TELEGRAM_CHAT_ID`.

## Déploiement

```bash
cd workers/unibet-flash-boost

# Connexion à Cloudflare (ouvre le navigateur)
wrangler login

# Crée le stockage qui retient les cotes déjà envoyées
wrangler kv:namespace create SEEN_BOOSTS
# -> copie l'"id" renvoyé dans wrangler.toml (remplace TO_FILL_AFTER_KV_CREATE)

# Ajoute les secrets (ne jamais les mettre en clair dans wrangler.toml)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID

# Déploie
wrangler deploy
```

## Tester manuellement

Une fois déployé, ouvre `https://unibet-flash-boost.<ton-sous-domaine>.workers.dev/run` dans le navigateur : ça déclenche un check immédiat et répond en JSON (`{"checked":1,"eligible":0,"posted":0}` par exemple). Utile pour vérifier que ça tourne sans attendre le prochain cron.

## Ajuster

- **Changer le seuil de mise max** : `MAX_STAKE_EUR` en haut de `index.js` (actuellement 10).
- **Changer la fréquence de vérification** : `crons` dans `wrangler.toml` (actuellement toutes les 2 minutes).
- **Changer le format du message Telegram** : fonction `formatTelegramMessage` dans `index.js`.

## Limite connue

Unibet peut faire évoluer sa page à tout moment (changement de structure HTML/JSON) — si le script s'arrête de détecter des cotes qui existent bien sur le site, c'est probablement que le format a changé côté Unibet et qu'il faut ajuster le motif d'extraction dans `parseBoosts`.
