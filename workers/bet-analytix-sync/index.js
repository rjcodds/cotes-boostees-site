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
