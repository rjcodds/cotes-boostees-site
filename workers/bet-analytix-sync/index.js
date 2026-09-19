// Enregistre automatiquement dans bet-analytix (bilan personnel de
// l'utilisatrice, https://app.bet-analytix.com) chaque cote boostée publiée
// sur le canal payant -- comme un pari "en attente", réglé (gagné/perdu) à
// la main par l'utilisatrice ensuite (aucun moyen pour nous de connaître le
// résultat d'un match automatiquement).
//
// Appelé par winamax-flash-boost et unibet-flash-boost via SERVICE BINDING
// (pas un fetch() public -- un Worker ne peut pas appeler un autre
// *.workers.dev du même compte par fetch() classique, voir wrangler.toml).
// Toujours en meilleur effort : un échec ici ne doit JAMAIS faire échouer
// le post Telegram réel, seulement être loggé pour investigation.
//
// Reverse-engineering du site fait à la main (aucune API publique/officielle
// documentée) -- voir README pour le détail de comment chaque endpoint/champ
// a été trouvé. Fragile par nature : si bet-analytix change son API, ça
// cassera silencieusement (d'où le log d'erreur systématique).

const BAX_API = 'https://api-v2.bet-analytix.com';
const BAX_APP_ORIGIN = 'https://app.bet-analytix.com';

// Trouvé en inspectant le trafic réseau de l'app (voir README) -- "sid" est
// envoyé dès la requête de LOGIN elle-même (pas émis par le serveur en
// réponse), et reste identique après une déconnexion/reconnexion complète :
// c'est un identifiant de session/appareil généré une fois côté client, pas
// un jeton qui tourne. Une valeur arbitraire est rejetée (500 "Error
// System"), donc on réutilise celle du navigateur de l'utilisatrice.
const BAX_SID = '152120';

// id_bankroll interne (PAS l'id "1712234" de l'URL publique -- deux champs
// différents dans la réponse de GET /bankroll/:id, voir README). "Boost
// 25/26" est la bankroll dédiée aux cotes boostées suivies ici.
const BAX_BANKROLL_ID = 4;

// Trouvé via GET /bookmakers (liste complète, ~1100 entrées) -- à confirmer
// si un jour une cote apparaît avec le mauvais bookmaker dans bet-analytix.
const BOOKMAKER_IDS = {
	winamax: 11,
	unibet: 10,
	betclic: 2,
	bet365: 21,
};

// SEUL "football: 1" est confirmé (via un vrai pari test créé dans l'app).
// Le reste est déduit de l'ORDRE d'un dictionnaire de traduction interne à
// l'app (clé "sport" du fichier i18n Nuxt, `sport:{football:...,tennis:...}`)
// -- probable mais pas vérifié différemment de football. Les 6 entrées
// boxing/badminton/golf/tennisDeTable/mma/formule1 ont été ajoutées en lisant
// le MÊME dictionnaire plus loin (positions 10/11/13/20/26/31 sur 76 sports
// listés) pendant un backfill de paris historiques (capture d'écran du canal)
// qui en avait besoin -- même méthode de découverte que les 8 premières
// entrées, donc même niveau de confiance, pas plus. Si une cote se retrouve
// mal catégorisée dans bet-analytix, corriger ici (impact limité : ça ne
// fausse que la répartition par sport, jamais les montants/résultats).
const SPORT_IDS = {
	football: 1,
	tennis: 2,
	basketball: 3,
	rugby: 4,
	handball: 5,
	volleyball: 6,
	hockey: 7,
	baseball: 9,
	boxing: 10,
	badminton: 11,
	golf: 13,
	tennis_de_table: 20,
	mma: 26,
	formule1: 31,
};

function parseFrenchDecimal(s) {
	if (s == null) return null;
	const n = parseFloat(String(s).replace(',', '.'));
	return isNaN(n) ? null : n;
}

async function baxLogin(env) {
	const res = await fetch(`${BAX_API}/auth/login`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Origin: BAX_APP_ORIGIN,
			Referer: `${BAX_APP_ORIGIN}/`,
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			app: 'appBax',
			sid: BAX_SID,
		},
		body: JSON.stringify({ email: env.BETANALYTIX_EMAIL, password: env.BETANALYTIX_PASSWORD }),
	});
	if (!res.ok) throw new Error(`baxLogin failed: HTTP ${res.status}`);
	const data = await res.json();
	if (!data?.accessToken) throw new Error('baxLogin: no accessToken in response');
	return data.accessToken;
}

async function baxCreateBet(env, accessToken, { label, odds, stake, bookmakerId, sportId, when }) {
	const date = when.toISOString().slice(0, 10);
	const time = when.toISOString().slice(11, 16);
	const body = {
		bankroll: BAX_BANKROLL_ID,
		bonus: null,
		bookmaker: bookmakerId,
		cashout: null,
		category: null,
		commission: { amount: null, applyOnLoss: false, base: null, percentage: null },
		date,
		eachway: null,
		freebet: false,
		live: false,
		masked: false,
		note: null,
		overallLabel: null,
		selections: [
			{
				betType: null,
				category: null,
				closing: null,
				competition: null,
				estimatedProbability: null,
				id: null,
				isExpanded: true,
				label,
				odds: odds.toFixed(3),
				showDetails: false,
				sport: sportId,
				status: 0, // en attente -- réglé à la main par l'utilisatrice
			},
		],
		stake,
		stakes: { single: stake, systemCombination: [] },
		time,
		tipster: null,
		type: 1, // simple
	};
	const res = await fetch(`${BAX_API}/bet`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
			Origin: BAX_APP_ORIGIN,
			Referer: `${BAX_APP_ORIGIN}/`,
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			app: 'appBax',
			sid: BAX_SID,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`baxCreateBet failed: HTTP ${res.status} -- ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

// Statuts de pari trouvés en capturant une vraie requête PUT /bet/:id envoyée
// par l'app en marquant un pari "Perdu" (utilisatrice, capture Network du
// 2026-09-18) : status:2 confirmé = perdu. Le reste est déduit du même
// dictionnaire i18n `stateBet` déjà utilisé pour SPORT_IDS (ordre :
// pending, won, lost, refunded, halfWon, halfLost, cashout, canceled) --
// SEUL `lost:2` est empiriquement confirmé, les autres suivent la même
// logique d'ordre que les IDs de sport (fiable jusqu'ici, mais pas vérifiée
// une par une). Vérifier `won` en direct avant de s'y fier à grande échelle.
const BET_STATUS = {
	pending: 0,
	won: 1,
	lost: 2,
	refunded: 3,
	halfWon: 4,
	halfLost: 5,
	cashout: 6,
	canceled: 7,
};

// Marque un pari EXISTANT gagné/perdu/etc. -- PUT (pas PATCH), et contrairement
// à baxCreateBet, le payload attendu ici reprend le format "réponse" de l'API
// (bookmaker et stake en chaînes, pas de wrapper "stakes", pas de "category"
// au niveau racine, "commission" à null tout court) plutôt que le format
// "requête" utilisé par POST /bet -- trouvé en capturant la vraie requête
// envoyée par l'app, aucune des deux formes devinées avant n'avait marché
// (juste un 500 générique, aucun détail exploitable).
function buildSettleBody({ betId, status, label, odds, stake, bookmakerId, sportId, when }) {
	const date = when.toISOString().slice(0, 10);
	const time = when.toISOString().slice(11, 16);
	return {
		bankroll: BAX_BANKROLL_ID,
		bonus: null,
		bookmaker: String(bookmakerId),
		cashout: null,
		commission: null,
		date,
		eachway: null,
		freebet: false,
		live: false,
		masked: false,
		note: null,
		overallLabel: label,
		selections: [
			{
				betType: null,
				category: null,
				closing: null,
				competition: null,
				estimatedProbability: null,
				id: betId,
				label,
				odds: odds.toFixed(3),
				sport: sportId,
				status,
			},
		],
		stake: stake.toFixed(2),
		time,
		tipster: null,
		type: 1,
	};
}

async function baxSettleBet(env, accessToken, params) {
	const { betId } = params;
	const body = buildSettleBody(params);
	const res = await fetch(`${BAX_API}/bet/${betId}`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
			Origin: BAX_APP_ORIGIN,
			Referer: `${BAX_APP_ORIGIN}/`,
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			app: 'appBax',
			sid: BAX_SID,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`baxSettleBet failed: HTTP ${res.status} -- ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

async function logError(env, source, message) {
	if (!env.SEEN_BOOSTS) return;
	try {
		const key = `errlog:${Date.now()}`;
		await env.SEEN_BOOSTS.put(key, JSON.stringify({ ts: Date.now(), source, message }), { expirationTtl: 30 * 24 * 60 * 60 });
	} catch {
		// si même le log échoue, rien à faire de plus
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/log' && request.method === 'POST') {
			let payload;
			try {
				payload = await request.json();
			} catch {
				return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), { status: 400 });
			}
			const { eventName, description, odds, stake, bookmaker, sport, date } = payload || {};
			// "date" optionnel (YYYY-MM-DD) -- utilisé pour le backfill de paris
			// historiques (capture d'écran/vidéo du canal), où le pari a réellement
			// été placé un autre jour que "maintenant". Repli sur la date/heure
			// actuelle (comportement d'origine) si absent ou invalide -- c'est le
			// cas normal du flux automatique (posts en direct).
			let when = new Date();
			if (date) {
				const parsed = new Date(`${date}T12:00:00Z`);
				if (!isNaN(parsed.getTime())) when = parsed;
			}
			const bookmakerId = BOOKMAKER_IDS[String(bookmaker || '').toLowerCase()];
			const sportId = SPORT_IDS[String(sport || '').toLowerCase()];
			const oddsDecimal = typeof odds === 'number' ? odds : parseFrenchDecimal(odds);
			const stakeNumber = typeof stake === 'number' ? stake : parseFloat(stake);

			if (!bookmakerId) {
				await logError(env, 'bet-analytix-sync', `bookmaker inconnu: ${bookmaker}`);
				return new Response(JSON.stringify({ ok: false, error: `bookmaker inconnu: ${bookmaker}` }), { status: 200 });
			}
			if (!sportId) {
				await logError(env, 'bet-analytix-sync', `sport inconnu: ${sport} (${eventName} -- ${description})`);
				return new Response(JSON.stringify({ ok: false, error: `sport inconnu: ${sport}` }), { status: 200 });
			}
			if (oddsDecimal == null || stakeNumber == null || !eventName || !description) {
				return new Response(JSON.stringify({ ok: false, error: 'payload incomplet' }), { status: 200 });
			}

			try {
				const accessToken = await baxLogin(env);
				const label = `${eventName} — ${description}`;
				const created = await baxCreateBet(env, accessToken, {
					label,
					odds: oddsDecimal,
					stake: stakeNumber,
					bookmakerId,
					sportId,
					when,
				});
				return new Response(JSON.stringify({ ok: true, created }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				console.log('bet-analytix-sync /log failed:', String(e));
				await logError(env, 'bet-analytix-sync', String(e));
				return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200 });
			}
		}

		if (url.pathname === '/settle' && request.method === 'POST') {
			// Marque un pari déjà créé comme gagné/perdu/etc. -- PAS utilisé par
			// le flux automatique des deux workers principaux (eux ne créent que
			// des paris "en attente" via /log, réglés à la main par
			// l'utilisatrice comme toujours), seulement pour le chantier de
			// règlement automatique par recherche web. Même garde `x-debug-token`
			// que les routes de recon ci-dessous : une vraie mutation sur le
			// bilan de l'utilisatrice ne doit pas être accessible à qui trouve
			// l'URL publique du worker, même logique que le confused deputy déjà
			// corrigé pour /debug-*.
			if (!env.DEBUG_TOKEN || request.headers.get('x-debug-token') !== env.DEBUG_TOKEN) {
				return new Response('forbidden', { status: 403 });
			}
			let payload;
			try {
				payload = await request.json();
			} catch {
				return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), { status: 400 });
			}
			const { id, status, eventName, description, odds, stake, bookmaker, sport, date } = payload || {};
			const statusCode = typeof status === 'number' ? status : BET_STATUS[String(status || '').toLowerCase()];
			const bookmakerId = BOOKMAKER_IDS[String(bookmaker || '').toLowerCase()];
			const sportId = SPORT_IDS[String(sport || '').toLowerCase()];
			const oddsDecimal = typeof odds === 'number' ? odds : parseFrenchDecimal(odds);
			const stakeNumber = typeof stake === 'number' ? stake : parseFloat(stake);
			let when = new Date();
			if (date) {
				const parsed = new Date(`${date}T12:00:00Z`);
				if (!isNaN(parsed.getTime())) when = parsed;
			}
			if (!id || !Number.isInteger(id)) return new Response(JSON.stringify({ ok: false, error: 'id manquant ou invalide' }), { status: 400 });
			if (statusCode == null) return new Response(JSON.stringify({ ok: false, error: `status inconnu: ${status}` }), { status: 400 });
			if (!bookmakerId) return new Response(JSON.stringify({ ok: false, error: `bookmaker inconnu: ${bookmaker}` }), { status: 400 });
			if (!sportId) return new Response(JSON.stringify({ ok: false, error: `sport inconnu: ${sport}` }), { status: 400 });
			if (oddsDecimal == null || stakeNumber == null || !eventName || !description) {
				return new Response(JSON.stringify({ ok: false, error: 'payload incomplet' }), { status: 400 });
			}
			try {
				const accessToken = await baxLogin(env);
				const label = `${eventName} — ${description}`;
				const updated = await baxSettleBet(env, accessToken, {
					betId: id,
					status: statusCode,
					label,
					odds: oddsDecimal,
					stake: stakeNumber,
					bookmakerId,
					sportId,
					when,
				});
				return new Response(JSON.stringify({ ok: true, updated }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				console.log('bet-analytix-sync /settle failed:', String(e));
				await logError(env, 'bet-analytix-sync', String(e));
				return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200 });
			}
		}

		// TOUTES les routes /debug-* ci-dessous minent un vrai token d'accès
		// bet-analytix (via baxLogin, les identifiants réels de l'utilisatrice)
		// pour appeler l'API en son nom -- SANS ce garde-fou, n'importe qui
		// trouvant l'URL publique du worker aurait pu s'en servir comme proxy
		// authentifié vers son compte bet-analytix (confused deputy). Trouvé et
		// corrigé avant tout usage réel, suite à une revue de sécurité
		// automatique déclenchée pendant leur écriture -- jamais exploité.
		// Préfixe générique (pas une liste explicite à tenir à jour) pour que
		// toute NOUVELLE route /debug-* future soit protégée par défaut plutôt
		// que d'avoir à se souvenir de l'ajouter à une liste.
		if (url.pathname.startsWith('/debug-')) {
			if (!env.DEBUG_TOKEN || request.headers.get('x-debug-token') !== env.DEBUG_TOKEN) {
				return new Response('forbidden', { status: 403 });
			}
		}

		if (url.pathname === '/debug-settle-body' && request.method === 'POST') {
			// Route de recon temporaire -- construit le body que /settle enverrait
			// SANS l'envoyer, pour comparer octet par octet contre une vraie
			// requête capturée dans le navigateur (voir buildSettleBody).
			let payload;
			try {
				payload = await request.json();
			} catch {
				return new Response('invalid JSON body', { status: 400 });
			}
			const { id, status, eventName, description, odds, stake, bookmaker, sport, date } = payload || {};
			const statusCode = typeof status === 'number' ? status : BET_STATUS[String(status || '').toLowerCase()];
			const bookmakerId = BOOKMAKER_IDS[String(bookmaker || '').toLowerCase()];
			const sportId = SPORT_IDS[String(sport || '').toLowerCase()];
			const oddsDecimal = typeof odds === 'number' ? odds : parseFrenchDecimal(odds);
			const stakeNumber = typeof stake === 'number' ? stake : parseFloat(stake);
			let when = new Date();
			if (date) {
				const parsed = new Date(`${date}T12:00:00Z`);
				if (!isNaN(parsed.getTime())) when = parsed;
			}
			const body = buildSettleBody({
				betId: id,
				status: statusCode,
				label: `${eventName} — ${description}`,
				odds: oddsDecimal,
				stake: stakeNumber,
				bookmakerId,
				sportId,
				when,
			});
			return new Response(JSON.stringify(body, null, 2), { headers: { 'Content-Type': 'application/json' } });
		}

		if (url.pathname === '/debug-raw' && request.method === 'GET') {
			// Route de recon temporaire -- appelle n'importe quel chemin GET de
			// l'API bet-analytix authentifié, pour explorer le schéma sans
			// deviner à l'aveugle (ex: ?path=/bankroll/1712234).
			const path = url.searchParams.get('path');
			// Whitelist stricte : chemin relatif uniquement (pas de "//" qui
			// changerait d'hôte, pas de "..", pas de user-info/port). SSRF
			// signalé par la revue de sécurité -- même si BAX_API est concaténé
			// en dur devant, mieux vaut ne pas faire confiance à une simple
			// concaténation de chaîne pour empêcher tout détournement.
			if (!path || !/^\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9_=&%.,-]*)?$/.test(path) || path.includes('..') || path.includes('//', 1)) {
				return new Response('usage: ?path=/bankroll/1712234 (chemin relatif simple, query string simple optionnelle)', { status: 400 });
			}
			try {
				const accessToken = await baxLogin(env);
				const headers = {
					Authorization: `Bearer ${accessToken}`,
					Origin: BAX_APP_ORIGIN,
					Referer: `${BAX_APP_ORIGIN}/`,
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					app: 'appBax',
					sid: BAX_SID,
				};
				const res = await fetch(`${BAX_API}${path}`, { headers });
				const text = await res.text();
				return new Response(JSON.stringify({ status: res.status, body: text }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				console.log('debug-raw failed:', String(e));
				return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 });
			}
		}

		if (url.pathname === '/debug-bet' && request.method === 'GET') {
			// Route de recon temporaire -- récupère la représentation complète
			// d'un pari existant (schéma exact attendu pour une mise à jour de
			// statut, jamais vu jusqu'ici -- toute la logique existante ne fait
			// QUE créer des paris "en attente").
			const id = url.searchParams.get('id');
			if (!id || !/^\d+$/.test(id)) return new Response('usage: ?id=123', { status: 400 });
			try {
				const accessToken = await baxLogin(env);
				const headers = {
					Authorization: `Bearer ${accessToken}`,
					Origin: BAX_APP_ORIGIN,
					Referer: `${BAX_APP_ORIGIN}/`,
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					app: 'appBax',
					sid: BAX_SID,
				};
				const res = await fetch(`${BAX_API}/bet/${id}`, { headers });
				const text = await res.text();
				return new Response(JSON.stringify({ status: res.status, body: text }), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				console.log('debug-bet failed:', String(e));
				return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 });
			}
		}

		if (url.pathname === '/errors') {
			const list = await env.SEEN_BOOSTS.list({ prefix: 'errlog:' });
			const entries = (await Promise.all(list.keys.map((k) => env.SEEN_BOOSTS.get(k.name))))
				.filter(Boolean)
				.map((e) => JSON.parse(e))
				.sort((a, b) => b.ts - a.ts);
			return new Response(JSON.stringify(entries), { headers: { 'Content-Type': 'application/json' } });
		}

		return new Response('OK. POST /log pour enregistrer un pari, GET /errors pour le journal.', { status: 200 });
	},
};
