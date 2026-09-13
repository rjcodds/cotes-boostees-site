# bet-analytix-sync — journalisation automatique du bilan

Enregistre automatiquement dans [bet-analytix](https://app.bet-analytix.com)
(bilan personnel de l'utilisatrice) chaque cote boostée flash publiée sur le
canal payant par `winamax-flash-boost` et `unibet-flash-boost`, comme un pari
**"en attente"**. L'utilisatrice règle elle-même le résultat (gagné/perdu)
dans l'app ensuite -- aucun moyen pour nous de connaître le résultat d'un
match automatiquement.

## Statut : fonctionnel, branché sur les deux workers principaux

Testé de bout en bout (un vrai pari créé et confirmé via l'API). Chaque appel
se connecte à nouveau (pas de cache de jeton -- volume trop faible pour que
ça vaille la peine, un login de plus par cote publiée est négligeable).

## ⚠️ Reverse-engineering, pas une API publique

**bet-analytix n'a aucune API documentée.** Tout ce qui suit a été trouvé à
la main en inspectant le trafic réseau de l'app (Nuxt/Vue) avec
l'utilisatrice, capture d'écran par capture d'écran. C'est fragile par
nature : si bet-analytix change son backend, ça cassera **silencieusement**
côté nous (chaque échec est loggé via `/errors`, jamais bloquant pour le
post Telegram réel).

### Authentification

`POST https://api-v2.bet-analytix.com/auth/login`
```json
{"email": "...", "password": "..."}
```
→ `{"accessToken": "...", "refreshToken": "..."}` (accessToken valide ~15 min,
décodé du JWT -- jamais vérifié si le refreshToken est exploité ici, on
relogin à chaque appel).

**En-têtes obligatoires sur TOUTES les requêtes** (login inclus), sans quoi
l'API renvoie un `403 Access denied` générique (WAF/gateway, avant même
d'atteindre l'app) :
- `Origin: https://app.bet-analytix.com`
- `Referer: https://app.bet-analytix.com/`
- `User-Agent:` un vrai user-agent de navigateur (n'importe lequel semble
  passer)

**En-têtes obligatoires en plus, sans quoi l'API renvoie un `500 Error
System` générique** (donc la requête AVAIT le bon format, mais un handler
côté backend plante) :
- `app: appBax` -- identifiant d'app statique, toujours cette valeur.
- `sid: 152120` -- **le plus piégeux**. Ressemble à un jeton de session, mais
  il est envoyé dès la requête de LOGIN elle-même (donc pas émis par le
  serveur EN RÉPONSE à une connexion), et il est resté identique après une
  déconnexion/reconnexion complète testée en direct avec l'utilisatrice.
  C'est un identifiant de session/appareil généré UNE FOIS côté client
  (probablement stocké en `localStorage`), pas un jeton qui tourne. Une
  valeur arbitraire (`999999`, ou l'en-tête absent) est **rejetée** -- donc
  ce n'est pas un simple "présence requise", la valeur compte. On réutilise
  celle du navigateur de l'utilisatrice, qui semble fonctionner pour son
  compte de façon durable. **Si l'intégration se met à échouer un jour sans
  raison apparente, vérifier ce champ en premier** -- si bet-analytix
  invalide un jour cette valeur (rotation de session forcée, changement de
  device...), il faudra la redemander à l'utilisatrice via le même protocole
  (F12 → Réseau → filtrer "auth" → inspecter les en-têtes de requête d'un
  `POST /auth/login`).

### Bankroll

L'URL publique de la bankroll (`app.bet-analytix.com/bankroll/1712234`)
utilise un ID **différent** de celui attendu par l'API pour CRÉER un pari :
- `GET /bankroll/1712234` (le nombre de l'URL) renvoie l'objet bankroll, qui
  contient à la fois `"id": 1712234` (le même nombre, cohérent) **et**
  `"id_bankroll": 4` (un champ séparé, plus petit).
- `POST /bet` attend `"bankroll": 4` (le `id_bankroll`, PAS le `id`/1712234).
  Utiliser le mauvais des deux donne... en fait pas testé, jamais essayé le
  1712234 dans le payload de création -- si jamais ce fix casse un jour,
  c'est le premier endroit à vérifier.

Bankroll actuellement ciblée : "Boost 25/26" (`id_bankroll: 4`), la bankroll
dédiée par l'utilisatrice aux cotes boostées suivies ici.

### Créer un pari

`POST /bet`, `Authorization: Bearer <accessToken>` + les en-têtes ci-dessus.

Voir `BAX_BANKROLL_ID`, `BOOKMAKER_IDS`, `SPORT_IDS` dans `index.js` pour le
payload exact et les IDs déjà confirmés. Points d'attention :
- `bookmaker` : IDs trouvés via `GET /bookmakers` (liste globale d'environ
  1100 bookmakers, PAS scopée au compte). Winamax=11, Unibet=10, Betclic=2,
  Bet365=21. **Incohérence trouvée et jamais résolue** : lors du pari test
  utilisé pour reverse-engineerer le format, l'utilisatrice a dit avoir
  sélectionné "Betclic" dans le formulaire, mais le payload capturé
  contenait `"bookmaker": 8`, qui correspond en fait à "ParionsSport" dans
  la liste globale -- probable erreur de clic de sa part en testant vite,
  mais si un jour une cote Betclic apparaît mal catégorisée dans l'app,
  revérifier avec un nouveau pari test propre.
- `sport` : **seul `football: 1` est confirmé** (via le pari test réel,
  "Toulon gagne à la MT"). Le reste (tennis=2, basketball=3, rugby=4,
  handball=5, volleyball=6, hockey=7, baseball=9) est déduit de l'ORDRE d'un
  dictionnaire de traduction interne à l'app (pas une vraie liste d'IDs
  vérifiée). Risque faible si faux : ça ne fausse que la répartition par
  sport dans les stats bet-analytix, jamais les montants/résultats
  financiers. Si l'utilisatrice signale un sport mal catégorisé, corriger
  la constante `SPORT_IDS` dans `index.js` -- idéalement en lui demandant de
  créer un pari test sur ce sport et de capturer le payload réseau, même
  méthode que pour tout ce fichier.
- `selections[0].status` (et `state` en retour) : `0` = en attente. Pas
  vérifié quelles valeurs correspondent à gagné/perdu/remboursé -- pas
  nécessaire ici puisque l'utilisatrice règle elle-même dans l'app.

## Utilisation par les autres workers

`winamax-flash-boost` et `unibet-flash-boost` appellent `POST /log` sur ce
worker via **service binding** (`env.BAX_WORKER`, PAS un `fetch()` public
vers `*.workers.dev` -- bloqué entre workers du même compte, voir
`content-pipeline` pour le précédent), juste après un post Telegram réussi
sur le canal payant :

```json
{
  "eventName": "...",
  "description": "...",
  "odds": "3,50",
  "stake": 10,
  "bookmaker": "winamax",
  "sport": "football"
}
```

Toujours en meilleur effort : un échec ici (bookmaker/sport inconnu, API
bet-analytix indisponible, etc.) est loggé (`/errors`) mais ne bloque et ne
retarde jamais le post Telegram réel, qui a déjà eu lieu avant cet appel.

## Ce qui manque encore

- **Cotes ajoutées manuellement** (Betclic, Bet365 Super Boost, GCB Winamax
  invisibles au scraper...) : ne passent PAS par `checkAndPost`, donc ne
  sont PAS loggées automatiquement pour l'instant. Si l'utilisatrice
  confirme vouloir aussi ces cas-là dans le bilan, il faudra soit appeler
  `POST /log` sur ce worker manuellement au moment du post ad-hoc, soit
  ajouter un appel dédié dans les routes de debug ponctuelles utilisées pour
  ces publications manuelles.
- Pas de cache de jeton (login à chaque appel) -- acceptable au volume
  actuel (quelques cotes/jour), à revoir si le volume grossit beaucoup.
- `mma`/`combat`/`boxing` : sports vus dans les autres workers, absents de
  `SPORT_IDS` -- seront loggés comme "sport inconnu" (skip silencieux,
  visible dans `/errors`) jusqu'à confirmation des vrais IDs.

## Secrets à poser avec `wrangler secret put <NOM>`

```
BETANALYTIX_EMAIL
BETANALYTIX_PASSWORD
```
