// Surveille les "Grosses Cotes Boostées" (mise max <= MAX_STAKE_EUR) sur Winamax
// et les poste automatiquement dans le canal Telegram privé.
//
// Contrairement à Unibet, la page Winamax ne rend rien côté serveur -- les
// cotes arrivent via un flux temps réel (Socket.IO) après chargement du JS.
// Il faut donc un vrai navigateur (Cloudflare Browser Rendering) pour lire
// window.PRELOADED_STATE une fois les données poussées.

import puppeteer from '@cloudflare/puppeteer';

const WINAMAX_URL = 'https://www.winamax.fr/paris-sportifs/sports/100000';
const MAX_STAKE_EUR = 10;
const SEEN_TTL_SECONDS = 6 * 60 * 60; // 6h : évite de reposter la même cote à chaque poll
const STAKE_RE = /mise max\s*(\d+)\s*€/i;

// Journal d'erreurs persistant (KV, 7 jours) -- avant ça, un crash de check ou
// un envoi Telegram raté n'était visible QUE via console.log en direct
// (wrangler tail), donc invisible dès qu'on regarde après coup. Trouvé
// nécessaire en creusant pourquoi une flash Winamax n'était jamais arrivée
// dans le canal abonnés côté match du PSG, sans aucune preuve exploitable le
// lendemain. Lu via /errors.
async function logError(env, source, message) {
	try {
		const ts = Date.now();
		await env.SEEN_BOOSTS.put(`errlog:${ts}`, JSON.stringify({ ts, source, message }), { expirationTtl: 7 * 24 * 60 * 60 });
	} catch {
		// rien de plus qu'on puisse faire si même le log échoue
	}
}

const SPORT_EMOJI = {
	football: '⚽', foot: '⚽', 'ligue 1': '⚽', 'ligue 2': '⚽', 'ligue europa': '⚽',
	'champions league': '⚽', 'europa league': '⚽', 'conference league': '⚽',
	'premier league': '⚽', 'serie a': '⚽', bundesliga: '⚽', liga: '⚽',
	tennis: '🎾', atp: '🎾', wta: '🎾',
	basket: '🏀', nba: '🏀', wnba: '🏀',
	baseball: '⚾', npb: '⚾', kbo: '⚾', mlb: '⚾',
	rugby: '🏉', hand: '🤾', hockey: '🏒', volley: '🏐', mma: '🥊', boxe: '🥊',
};

function guessSportEmoji(title) {
	const lower = title.toLowerCase();
	for (const [k, emoji] of Object.entries(SPORT_EMOJI)) {
		if (lower.includes(k)) return emoji;
	}
	return '⚡';
}

// "Rugby" et "Combat" (MMA/Boxe) partagent un seul émoji générique -- impossible
// de savoir lequel sans essayer les deux (voir AMBIGUOUS_SPORT_GROUPS plus bas).
const SPORT_KEY_BY_EMOJI = {
	'⚽': 'football',
	'🏀': 'basketball',
	'🎾': 'tennis',
	'⚾': 'baseball',
	'🏒': 'hockey',
	'🥊': 'combat',
	'🏉': 'rugby',
	'🤾': 'handball',
	'🏐': 'volleyball',
};
const EMOJI_BY_SPORT_KEY = {
	football: '⚽',
	basketball: '🏀',
	tennis: '🎾',
	baseball: '⚾',
	hockey: '🏒',
	mma: '🥊',
	boxing: '🥊',
	rugby: '🏉',
	handball: '🤾',
	volleyball: '🏐',
};

// Source FIABLE du sport : state.categories[match.categoryId].categoryName
// (ex: "Football", "Baseball", "MMA") -- trouvé en creusant pourquoi "Atlas -
// Tigres" (Liga MX) et le combo MLB ressortaient avec sport:null : le titre
// seul ("Atlas - Tigres") ne contient aucun mot-clé sport, donc
// guessSportEmoji (deviné à partir du TITRE) échouait silencieusement alors
// que la vraie donnée structurée était disponible tout du long. MMA/Boxe sont
// ici distingués PRÉCISÉMENT (contrairement à l'émoji 🥊 partagé, ambigu) --
// plus besoin du groupe 'combat' quand la catégorie est connue.
const SPORT_KEY_BY_CATEGORY_NAME = {
	Football: 'football',
	Basketball: 'basketball',
	Tennis: 'tennis',
	Baseball: 'baseball',
	'Hockey sur glace': 'hockey',
	MMA: 'mma',
	Boxe: 'boxing',
	Rugby: 'rugby',
	Handball: 'handball',
	Volleyball: 'volleyball',
};

function formatOdd(n) {
	return Number(n).toFixed(2).replace('.', ',');
}

function formatKickoffTime(matchStartSeconds) {
	if (!matchStartSeconds) return null;
	try {
		const d = new Date(matchStartSeconds * 1000);
		const parts = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			hour: '2-digit',
			minute: '2-digit',
		}).formatToParts(d);
		const h = parts.find((p) => p.type === 'hour').value;
		const min = parts.find((p) => p.type === 'minute').value;
		return `${h}h${min}`;
	} catch {
		return null;
	}
}

function parseBoosts(state) {
	const boosts = [];
	if (!state || !state.matches) return boosts;

	for (const match of Object.values(state.matches)) {
		const bet = state.bets?.[String(match.mainBetId)];
		if (!bet) continue;

		const stakeMatch = (bet.betTypeName || bet.betTitle || '').match(STAKE_RE);
		if (!stakeMatch) continue;
		const maxStake = parseInt(stakeMatch[1], 10);

		const outcomeId = (bet.outcomes || [])[0];
		if (outcomeId == null) continue;
		const outcome = state.outcomes?.[String(outcomeId)];
		const newOdd = state.odds?.[String(outcomeId)];
		const oldOdd = bet.previousOdd;
		if (!outcome || newOdd == null || oldOdd == null) continue;

		const eventName = (match.title || '').replace(/^Cote Boost[ée]e\s*:\s*/i, '').trim();
		// state.categories[categoryId].categoryName est une donnée structurée
		// fiable ("Football", "Baseball", "MMA"...) -- prioritaire sur
		// guessSportEmoji qui devine à partir du TITRE et échoue silencieusement
		// dès que ni équipe ni compétition ne contient un mot-clé sport (ex:
		// "Atlas - Tigres", aucun des deux noms n'évoque le foot).
		const categoryName = state.categories?.[String(match.categoryId)]?.categoryName;
		const sportFromCategory = categoryName ? SPORT_KEY_BY_CATEGORY_NAME[categoryName] : null;
		const sportEmoji = sportFromCategory ? EMOJI_BY_SPORT_KEY[sportFromCategory] : guessSportEmoji(match.title || '');
		// Pour les paris boostés, tournamentId pointe souvent vers un regroupement
		// générique ("Tous les paris") plutôt que la vraie compétition -- inutile
		// comme indice de matching, on le traite comme absent plutôt que de faire
		// perdre une tentative de correspondance par nom à findPinnacleReference.
		const rawTournamentName = state.tournaments?.[String(match.tournamentId)]?.tournamentName || null;
		const tournamentName = rawTournamentName && !/tous les paris/i.test(rawTournamentName) ? rawTournamentName : null;

		boosts.push({
			marketId: String(bet.betId),
			eventName,
			sportEmoji,
			sport: sportFromCategory || SPORT_KEY_BY_EMOJI[sportEmoji] || null,
			league: tournamentName,
			description: outcome.label,
			oldOdds: formatOdd(oldOdd),
			newOdds: formatOdd(newOdd),
			maxStake,
			kickoff: formatKickoffTime(match.matchStart),
		});
	}
	return boosts;
}

function formatTelegramMessage(boost) {
	const lines = [
		`⚡ GROSSE COTE BOOSTÉE — WINAMAX`,
		``,
		`${boost.sportEmoji} ${boost.eventName}`,
		``,
		boost.description,
		``,
		`Cote : ${boost.oldOdds} → ${boost.newOdds}`,
		`💰 Mise max : ${boost.maxStake}€*`,
		``,
		`* Mise comptabilisée pour le bilan`,
	];
	if (boost.kickoff) {
		lines.push(``, `Disponible jusqu'à ${boost.kickoff}`);
	}
	return lines.join('\n');
}

async function sendToChat(env, chatId, text) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
		}),
	});
	if (res.status === 429) {
		const body = await res.json().catch(() => ({}));
		const wait = (body?.parameters?.retry_after || 2) * 1000;
		await new Promise((r) => setTimeout(r, wait));
		return sendToChat(env, chatId, text);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
	}
	const body = await res.json();
	return body.result; // { message_id, ... } -- utilisé pour éditer le message plus tard
}

async function editMessageText(env, chatId, messageId, text) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }),
	});
	if (res.status === 429) {
		const body = await res.json().catch(() => ({}));
		const wait = (body?.parameters?.retry_after || 2) * 1000;
		await new Promise((r) => setTimeout(r, wait));
		return editMessageText(env, chatId, messageId, text);
	}
	if (!res.ok) {
		const body = await res.text();
		if (/message is not modified/i.test(body)) return;
		throw new Error(`Telegram editMessageText failed: ${res.status} ${body}`);
	}
}

async function sendTelegramMessage(env, text) {
	return sendToChat(env, env.TELEGRAM_CHAT_ID, text);
}

// Recherche une cote de référence Pinnacle pour une cote boostée détectée sur
// Unibet/Winamax. Couvre : victoire simple, total buts, marge de victoire
// ("gagne de N buts ou plus"), et le marché combiné direct "Équipe & Over/Under"
// quand Pinnacle le propose (pas d'approximation nécessaire dans ce cas).
// Gère aussi les combos multi-matchs (paris sur plusieurs rencontres à la fois).
// Silencieux si rien de fiable n'est trouvé.

// Sports Pinnacle accessibles via l'API "guest" publique -- handball, volley,
// rugby, boxe et cyclisme renvoyaient 401 "No authorization token provided"
// SANS les headers Referer/Origin pinnacle.com (voir PINNACLE_API_HEADERS) ;
// avec, ils passent. Cyclisme/golf/snooker restent hors-jeu : modèle "outright
// parmi N concurrents", pas "équipe A vs équipe B".
const PINNACLE_SPORTS = {
	football: 29, // "Soccer" chez Pinnacle -- ne pas confondre avec leur sport "Football" (NFL)
	basketball: 4,
	tennis: 33,
	baseball: 3,
	hockey: 19,
	mma: 22,
	boxing: 6,
	handball: 18,
	volleyball: 34,
	rugbyUnion: 27,
	rugbyLeague: 26,
};

// "Rugby" et "Combat" (MMA/Boxe) partagent un seul émoji générique côté
// Unibet/Winamax -- impossible de savoir lequel sans essayer les deux.
const AMBIGUOUS_SPORT_GROUPS = {
	rugby: ['rugbyUnion', 'rugbyLeague'],
	combat: ['mma', 'boxing'],
};

// Referer/Origin pinnacle.com : sans ça, l'API guest bloque certains sports en
// 401 (handball, volley, rugby, boxe, cyclisme) -- un vrai navigateur les
// envoie automatiquement, un fetch() brut non.
const PINNACLE_API_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	Referer: 'https://www.pinnacle.com/',
	Origin: 'https://www.pinnacle.com',
};

// Compétitions continentales -> pas de préfixe pays chez Pinnacle (elles sont
// préfixées "UEFA -"). Grands championnats domestiques -> préfixe pays Pinnacle.
// Sert à départager les homonymes entre pays ("Premier League" existe dans ~20
// pays chez Pinnacle) sans avoir à tous les essayer.
const EUROPEAN_COMPETITION_KEYWORDS = [
	'champions league',
	'ligue des champions',
	'europa league',
	'ligue europa',
	'conference league',
];
const DOMESTIC_LEAGUE_COUNTRY = [
	[/ligue 1|ligue 2|coupe de france/i, 'France'],
	[/premier league|fa cup|efl cup|championship anglais/i, 'England'],
	[/serie a|serie b|coppa italia/i, 'Italy'],
	[/liga(?!ue)|copa del rey/i, 'Spain'],
	[/bundesliga|dfb.?pokal/i, 'Germany'],
	[/eredivisie/i, 'Netherlands'],
	[/liga portugal|primeira liga/i, 'Portugal'],
	[/jupiler|pro league belge/i, 'Belgium'],
];

function leagueCountryHint(leagueLabel) {
	const clean = (leagueLabel || '').trim();
	if (!clean) return null;
	if (EUROPEAN_COMPETITION_KEYWORDS.some((k) => clean.toLowerCase().includes(k))) return 'UEFA';
	for (const [re, country] of DOMESTIC_LEAGUE_COUNTRY) {
		if (re.test(clean)) return country;
	}
	return null;
}

let leagueListCache = {};
let leagueListCacheAt = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

function stripDiacritics(s) {
	return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTeam(name) {
	return stripDiacritics(name || '')
		.toLowerCase()
		.replace(/\b(fc|cf|sc|ac|afc|cfc|united|utd|sg|de|club)\b/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function levenshtein(a, b) {
	const m = a.length, n = b.length;
	if (!m) return n;
	if (!n) return m;
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
		}
		prev = cur;
	}
	return prev[n];
}

// Compare mot a mot avec une petite tolerance d'edit-distance : couvre les
// variantes orthographiques entre langues (Salzbourg/Salzburg, etc.) sans
// avoir besoin d'une table de traduction figee.
function wordsFuzzyMatch(wa, wb) {
	if (wa === wb) return true;
	if (wa.length < 4 || wb.length < 4) return false;
	const maxDist = wa.length > 7 || wb.length > 7 ? 2 : 1;
	return levenshtein(wa, wb) <= maxDist;
}

// Ajoute les paires de mots adjacents comme tokens candidats en plus des mots
// individuels -- gère les variantes où un nom composé est écrit collé d'un
// côté et en mots séparés de l'autre ("Baystars" chez Winamax / "Bay Stars"
// chez Pinnacle pour Yokohama DeNA BayStars).
function withCompoundWords(words) {
	const out = new Set(words);
	for (let i = 0; i < words.length - 1; i++) out.add(words[i] + words[i + 1]);
	return [...out];
}

function teamsMatch(a, b) {
	const na = normalizeTeam(a);
	const nb = normalizeTeam(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.includes(nb) || nb.includes(na)) return true;
	const wordsA = [...new Set(na.split(' ').filter((w) => w.length > 2))];
	const wordsB = [...new Set(nb.split(' ').filter((w) => w.length > 2))];
	if (!wordsA.length || !wordsB.length) return false;
	// Bidirectionnel : selon l'ordre des arguments, c'est parfois A qui a le mot
	// composé collé (et B qui doit être joint pour matcher), parfois l'inverse.
	const poolA = withCompoundWords(wordsA);
	const poolB = withCompoundWords(wordsB);
	let overlapAtoB = 0;
	for (const w of wordsA) if (poolB.some((x) => wordsFuzzyMatch(w, x))) overlapAtoB++;
	let overlapBtoA = 0;
	for (const w of wordsB) if (poolA.some((x) => wordsFuzzyMatch(w, x))) overlapBtoA++;
	const overlap = Math.max(overlapAtoB, overlapBtoA);
	return overlap >= Math.min(wordsA.length, wordsB.length) * 0.5;
}

// Identifie LE matchup racine (celui qui porte moneyline/total/team_total)
// parmi tous les matchups renvoyés pour une league -- pas les props/spéciaux
// (corners, cartons, écarts...) qui partagent souvent les mêmes noms
// d'équipes. Avant le coup d'envoi, ce matchup racine n'a pas de parentId.
// Une fois le match EN DIRECT, Pinnacle explose le match en plusieurs
// matchups distincts (corners, handicaps, etc.) qui partagent tous le même
// parentId (un simple conteneur sans marché propre, hasMarkets:false) -- il
// faut alors se fier à periods[].hasMoneyline pour repérer le bon parmi eux.
// Bug réel trouvé en essayant de rattraper une cote Championship en cours :
// tout type de leg (pas seulement le nouveau) échouait silencieusement dès
// qu'un match passait en direct, `!m.parentId` ne matchant plus rien.
function isRootMatchup(m) {
	return !m.parentId || Boolean(m.periods?.some((p) => p.hasMoneyline));
}

function americanToDecimal(american) {
	return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

function parseFrenchDecimal(s) {
	const n = parseFloat((s || '').replace(',', '.'));
	return isNaN(n) ? null : n;
}

// Extrait un décimal comparable d'une ref Pinnacle, quel que soit son type --
// sert au calcul d'edge % pour le digest quotidien (voir logDigestItem).
function refComparableDecimal(ref) {
	if (!ref) return null;
	if (ref.type === 'moneyline') {
		const backed = ref.backedDesignation === 'home' ? ref.moneyline.home : ref.backedDesignation === 'away' ? ref.moneyline.away : null;
		return backed ? americanToDecimal(backed.price) : null;
	}
	if (ref.type === 'single' || ref.type === 'combo') return ref.decimal;
	return null;
}

function todayKey() {
	const parts = new Intl.DateTimeFormat('fr-FR', {
		timeZone: 'Europe/Paris',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(new Date());
	const y = parts.find((p) => p.type === 'year').value;
	const m = parts.find((p) => p.type === 'month').value;
	const d = parts.find((p) => p.type === 'day').value;
	return `${y}-${m}-${d}`;
}

// Log un item pour le digest quotidien -- une clé KV par item (pas de
// compteur à incrémenter, évite les races en écriture concurrente).
async function logDigestItem(env, boost, edge) {
	const key = `digestitem:${todayKey()}:${boost.marketId}`;
	await env.SEEN_BOOSTS.put(
		key,
		JSON.stringify({ eventName: boost.eventName, description: boost.description, newOdds: boost.newOdds, edge }),
		{ expirationTtl: 2 * 24 * 60 * 60 }
	);
}

async function computeDigestStats(env, date) {
	const list = await env.SEEN_BOOSTS.list({ prefix: `digestitem:${date}:` });
	let count = 0;
	let withRef = 0;
	let best = null;
	for (const k of list.keys) {
		const raw = await env.SEEN_BOOSTS.get(k.name);
		if (!raw) continue;
		const item = JSON.parse(raw);
		count++;
		if (item.edge != null) {
			withRef++;
			if (!best || item.edge > best.edge) best = item;
		}
	}
	return { count, withRef, best };
}

// Combine les stats du jour des deux bookmakers et poste un récap sur le
// canal privé -- ne tourne que côté Winamax (même logique que
// detectDuplicates : évite un digest en double).
async function postDailyDigest(env) {
	if (!env.MONITORING_CHAT_ID) return;
	const date = todayKey();
	const mine = await computeDigestStats(env, date);
	let other = { count: 0, withRef: 0, best: null };
	try {
		const res = await fetch('https://unibet-flash-boost.jc-hd-affiliation.workers.dev/digest-data');
		if (res.ok) other = await res.json();
	} catch {
		// silencieux : un digest partiel (juste Winamax) vaut mieux que pas de digest
	}

	const totalCount = mine.count + other.count;
	const totalWithRef = mine.withRef + other.withRef;
	const globalBest = [mine.best, other.best].filter(Boolean).sort((a, b) => b.edge - a.edge)[0];

	const lines = [
		`📅 Digest quotidien — ${date}`,
		``,
		`Cotes boostées classiques vues : ${totalCount} (Winamax ${mine.count} / Unibet ${other.count})`,
		`Avec référence Pinnacle : ${totalWithRef}`,
	];
	if (globalBest) {
		lines.push(``, `🏆 Meilleure valeur : ${globalBest.eventName}`, globalBest.description, `${globalBest.newOdds} (+${globalBest.edge.toFixed(1)}% vs Pinnacle)`);
	}
	try {
		await sendToChat(env, env.MONITORING_CHAT_ID, lines.join('\n'));
	} catch (e) {
		console.log('postDailyDigest: send failed:', String(e));
	}
}

async function fetchLeagueData(leagueId) {
	const headers = PINNACLE_API_HEADERS;
	const [matchupsRes, marketsRes] = await Promise.all([
		fetch(`https://guest.api.arcadia.pinnacle.com/0.1/leagues/${leagueId}/matchups`, { headers }),
		fetch(`https://guest.api.arcadia.pinnacle.com/0.1/leagues/${leagueId}/markets/straight`, { headers }),
	]);
	if (!matchupsRes.ok || !marketsRes.ok) return null;
	const matchups = await matchupsRes.json();
	const markets = await marketsRes.json();
	return { matchups, markets };
}

// Récupère toutes les grandes ligues d'un sport en parallèle, avec un court
// cache mémoire (utile si plusieurs paris consécutifs se résolvent pendant le même check).
// Liste légère (id + nom, pas de matchups/markets) de toutes les compétitions
// actuellement actives chez Pinnacle pour un sport -- remplace l'ancienne liste
// figée à maintenir à la main. Courte mise en cache mémoire.
async function fetchLeagueList(sportKey) {
	const sportId = PINNACLE_SPORTS[sportKey];
	if (!sportId) return [];
	if (leagueListCache[sportKey] && Date.now() - leagueListCacheAt[sportKey] < CACHE_TTL_MS) {
		return leagueListCache[sportKey];
	}
	try {
		const res = await fetch(`https://guest.api.arcadia.pinnacle.com/0.1/sports/${sportId}/leagues`, {
			headers: PINNACLE_API_HEADERS,
		});
		if (!res.ok) return [];
		const data = await res.json();
		if (!Array.isArray(data)) return []; // ex: 401 -> objet d'erreur, pas un tableau
		const list = data.map((l) => ({ id: l.id, name: l.name }));
		leagueListCache[sportKey] = list;
		leagueListCacheAt[sportKey] = Date.now();
		return list;
	} catch {
		return [];
	}
}

function normalizeLeagueName(name) {
	return stripDiacritics(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function scoreLeagueName(name, label) {
	if (name === label) return 4;
	if (name.endsWith(` ${label}`) || name.endsWith(`- ${label}`)) return 3;
	if (name.includes(label)) return 2;
	const labelWords = [...new Set(label.split(' ').filter((w) => w.length > 2))];
	const nameWords = [...new Set(name.split(' ').filter((w) => w.length > 2))];
	if (labelWords.length) {
		const overlap = labelWords.filter((w) => nameWords.some((x) => wordsFuzzyMatch(w, x))).length;
		if (overlap === labelWords.length) return 1;
	}
	return 0;
}

// Fait correspondre le libellé de compétition Unibet/Winamax (ex: "Ligue 1",
// "NBA", "ATP Cincinnati") aux compétitions Pinnacle du même sport (ex:
// "France - Ligue 1"). Gère aussi les suffixes sponsor absents chez Pinnacle
// ("Ligue 2 BKT", "Ligue 1 McDonald's") en retentant sans le(s) dernier(s) mot(s).
// Retourne les meilleurs candidats en premier -- utile quand plusieurs pays
// partagent un nom générique : on essaiera chaque candidat jusqu'à ce qu'un
// match d'équipes soit trouvé, au lieu de se figer sur le premier venu.
function matchLeaguesByLabel(leagueList, leagueLabel, countryHint) {
	const raw = normalizeLeagueName(leagueLabel);
	if (!raw) return [];
	const hint = countryHint ? normalizeLeagueName(countryHint) : null;

	const words = raw.split(' ').filter(Boolean);
	const labelVariants = [raw];
	if (words.length > 1) labelVariants.push(words.slice(0, -1).join(' '));
	if (words.length > 2) labelVariants.push(words.slice(0, -2).join(' '));

	const scored = [];
	for (const league of leagueList) {
		const name = normalizeLeagueName(league.name);
		if (!name) continue;
		let bestScore = 0;
		for (const label of labelVariants) {
			if (!label) continue;
			bestScore = Math.max(bestScore, scoreLeagueName(name, label));
		}
		if (bestScore === 0) continue;
		if (hint && (name.startsWith(`${hint} `) || name.startsWith(`${hint}-`))) bestScore += 2;
		scored.push({ league, score: bestScore });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, 8).map((s) => s.league);
}

function priceForParticipant(markets, matchupId, participantId) {
	for (const mk of markets) {
		if (mk.matchupId !== matchupId) continue;
		const p = (mk.prices || []).find((pr) => pr.participantId === participantId);
		if (p) return p.price;
	}
	return null;
}

// Localise le matchup racine (marché principal, pas un special) d'un match
// donné par ses deux équipes -- sert à scoper les marchés spéciaux ci-dessous
// au bon match plutôt que de risquer d'en attraper un autre partageant le
// même nom de marché/suffixe (ex: une équipe qui joue le même jour dans 2
// compétitions différentes -- bug réel trouvé sur "Monaco To Win to Nil?"
// qui remontait le prix d'un match de Ligue 1 sans rapport au lieu du vrai
// match de Ligue Europa Conférence, faute de vérifier l'adversaire).
function findRootMatchup(matchups, teamA, teamB) {
	return matchups.find(
		(m) =>
			isRootMatchup(m) &&
			m.participants?.length === 2 &&
			((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
				(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
	);
}

// Marché "Équipe & Over/Under X.Y" -- pari combiné publié directement par
// Pinnacle, donc probabilité exacte (pas de corrélation à approximer).
function findCombinedWinTotal(leagues, teamA, teamB, teamName, side, points) {
	const label = `${side === 'over' ? 'Over' : 'Under'} ${points}`;
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.id !== parent.id && m.parentId !== parent.id) continue;
			const part = (m.participants || []).find(
				(p) => p.name?.includes(' & ') && p.name.endsWith(label) && teamsMatch(p.name.split(' & ')[0], teamName)
			);
			if (!part) continue;
			const price = priceForParticipant(markets, m.id, part.id);
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Marché "Équipe To Win to Nil?" -- spécial dédié par équipe (Yes/No), avec
// un suffixe " 1st Half" pour la variante 1ère mi-temps. Vérifié en direct
// sur Kasimpasa-Trabzonspor : description exacte "Trabzonspor To Win to Nil?"
// (ou "... To Win to Nil? 1st Half"), pas de calcul, prix Pinnacle direct.
// Participant "Yes" d'un spécial nommé "{Équipe} {suffix}" (ex: "Trabzonspor
// To Win to Nil?", "Fenerbahce To Score?") -- le nom Pinnacle contient
// l'équipe littéralement (peut différer en orthographe), on isole le préfixe
// et compare via teamsMatch plutôt qu'une égalité stricte.
function findSuffixedTeamYes(leagues, teamA, teamB, suffix, teamName) {
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			const desc = m.special?.description;
			if (!desc || !desc.endsWith(suffix)) continue;
			const teamPart = desc.slice(0, desc.length - suffix.length);
			if (!teamPart || !teamsMatch(teamPart, teamName)) continue;
			const yesPart = (m.participants || []).find((p) => p.name === 'Yes');
			const price = yesPart ? priceForParticipant(markets, m.id, yesPart.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

function findWinToNil(leagues, teamA, teamB, teamName, period = 0) {
	return findSuffixedTeamYes(leagues, teamA, teamB, period === 1 ? ' To Win to Nil? 1st Half' : ' To Win to Nil?', teamName);
}

// "TeamX marque" (au moins une fois) -- distinct de "marque en premier"
// (First Team To Score) et "marque exactement N buts" (Exact Team Goals),
// tous deux vérifiés avant ce marché dans parseLegs.
function findTeamToScore(leagues, teamA, teamB, teamName, period = 0) {
	return findSuffixedTeamYes(leagues, teamA, teamB, period === 1 ? ' To Score? 1st Half' : ' To Score?', teamName);
}

// Marché "Équipe Goals Odd/Even" -- pair/impair sur les buts d'UNE équipe,
// distinct de "Total Goals Odd/Even" (pair/impair du match entier, déjà géré
// par findSpecialByLabel).
function findTeamGoalsOddEven(leagues, teamA, teamB, teamName, label) {
	const suffix = ' Goals Odd/Even';
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			const desc = m.special?.description;
			if (!desc || !desc.endsWith(suffix)) continue;
			const teamPart = desc.slice(0, desc.length - suffix.length);
			if (!teamPart || !teamsMatch(teamPart, teamName)) continue;
			const part = (m.participants || []).find((p) => p.name === label);
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Helpers génériques réutilisés par plusieurs marchés spéciaux ci-dessous :
// un participant identifié par un nom fixe ("Odd"/"Even"/"Yes"/"No"...) ou
// par un nom d'équipe (comparé via teamsMatch, pas une égalité stricte).
function findSpecialByLabel(leagues, teamA, teamB, description, label) {
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			if (m.special?.description !== description) continue;
			const part = (m.participants || []).find((p) => p.name === label);
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}
function findSpecialByTeam(leagues, teamA, teamB, description, teamName) {
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			if (m.special?.description !== description) continue;
			const part = (m.participants || []).find((p) => teamsMatch(p.name, teamName));
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Marché "Double Chance" -- "{Équipe} Or Draw" / "Draw Or {Équipe}" /
// "{Équipe A} Or {Équipe B}". Prix Pinnacle déjà combiné, pas d'approximation.
// Le nom de participant Pinnacle contient le nom d'équipe littéral (peut
// différer en orthographe du nôtre) -- on isole le préfixe/suffixe "Or Draw"
// / "Draw Or" et on compare via teamsMatch, comme pour findWinToNil.
function findDoubleChance(leagues, teamA, teamB, teamName, side, period = 0) {
	const description = period === 1 ? 'Double Chance 1st Half' : 'Double Chance';
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			if (m.special?.description !== description) continue;
			const part = (m.participants || []).find((p) => {
				const name = p.name || '';
				if (side === 'teamOrDraw') {
					const mm = name.match(/^(.+)\s+Or\s+Draw$/);
					return mm && teamsMatch(mm[1], teamName);
				}
				if (side === 'drawOrTeam') {
					const mm = name.match(/^Draw\s+Or\s+(.+)$/);
					return mm && teamsMatch(mm[1], teamName);
				}
				return false;
			});
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Marché "Équipe Goals" (buts exacts d'une équipe) -- suffixe " Goals" (+
// " 1st Half"), même logique de préfixe que findWinToNil. Le dernier palier
// varie selon le sport/la période ("5+" en match complet, parfois "4+" en
// 1ère mi-temps) -- on essaie le nombre exact puis "N+" en repli plutôt que
// de figer un seuil.
function findExactTeamGoals(leagues, teamA, teamB, teamName, n, period = 0) {
	const suffix = period === 1 ? ' Goals 1st Half' : ' Goals';
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			const desc = m.special?.description;
			if (!desc || !desc.endsWith(suffix)) continue;
			const teamPart = desc.slice(0, desc.length - suffix.length);
			if (!teamPart || !teamsMatch(teamPart, teamName)) continue;
			const part =
				(m.participants || []).find((p) => p.name === String(n)) ||
				(m.participants || []).find((p) => p.name === `${n}+`);
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Marché "Exact Total Goals" (buts exacts du match, toutes équipes
// confondues) -- même repli "N" puis "N+" que findExactTeamGoals.
function findExactTotalGoals(leagues, teamA, teamB, n, period = 0) {
	const description = period === 1 ? 'Exact Total Goals 1st Half' : 'Exact Total Goals';
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			if (m.special?.description !== description) continue;
			const part =
				(m.participants || []).find((p) => p.name === String(n)) ||
				(m.participants || []).find((p) => p.name === `${n}+`);
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}

// Marché "Both Teams To Score?" pour un match nommé (équipes connues via
// l'eventName) -- variante same-match de findScheduleBtts, qui elle sert au
// combo multi-matchs sans noms d'équipes.
function findBtts(leagues, teamA, teamB, period = 0) {
	const description = period === 1 ? 'Both Teams To Score? 1st Half' : 'Both Teams To Score?';
	for (const { league, matchups, markets } of leagues) {
		const parent = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!parent) continue;
		const special = matchups.find((s) => s.parentId === parent.id && s.special?.description === description);
		const yesPart = special?.participants?.find((p) => p.name === 'Yes');
		const price = yesPart ? priceForParticipant(markets, special.id, yesPart.id) : null;
		if (price == null) continue;
		return { league: league.name, decimal: americanToDecimal(price), exact: true };
	}
	return null;
}

// Marché "Both Teams To Score/Total Goals" -- combo direct Pinnacle ("Yes &
// Over/Under X.Y"), pas une multiplication : BTTS et Total ne sont pas
// indépendants (marquer des deux côtés corrèle avec le nombre de buts), donc
// le prix combiné publié par Pinnacle est la seule source fiable ici.
function findBttsAndTotal(leagues, teamA, teamB, side, points) {
	const wantLabel = `Yes & ${side === 'over' ? 'Over' : 'Under'} ${points}`;
	for (const { league, matchups, markets } of leagues) {
		const parent = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!parent) continue;
		const special = matchups.find((s) => s.parentId === parent.id && s.special?.description === 'Both Teams To Score/Total Goals');
		const part = special?.participants?.find((p) => p.name === wantLabel);
		const price = part ? priceForParticipant(markets, special.id, part.id) : null;
		if (price == null) continue;
		return { league: league.name, decimal: americanToDecimal(price), exact: true };
	}
	return null;
}

// Marché "Odd/Even / Total Goals" -- même logique combo directe que
// findBttsAndTotal, pas lié à une équipe (pair/impair du match entier).
function findOddEvenAndTotal(leagues, teamA, teamB, label, side, points) {
	const wantLabel = `${label} & ${side === 'over' ? 'Over' : 'Under'} ${points}`;
	for (const { league, matchups, markets } of leagues) {
		const parent = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!parent) continue;
		const special = matchups.find((s) => s.parentId === parent.id && s.special?.description === 'Odd/Even / Total Goals');
		const part = special?.participants?.find((p) => p.name === wantLabel);
		const price = part ? priceForParticipant(markets, special.id, part.id) : null;
		if (price == null) continue;
		return { league: league.name, decimal: americanToDecimal(price), exact: true };
	}
	return null;
}

// Marché "Half-Time/Full-Time" -- combo direct Pinnacle, participant "{HT} -
// {FT}" où chaque côté est un nom d'équipe ou "Draw". htOutcome/ftOutcome
// valent soit un nom d'équipe, soit la chaîne littérale 'Draw'.
function findHalfTimeFullTime(leagues, teamA, teamB, htOutcome, ftOutcome) {
	for (const { league, matchups, markets } of leagues) {
		const parent = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!parent) continue;
		const special = matchups.find((s) => s.parentId === parent.id && s.special?.description === 'Half-Time/Full-Time');
		const part = special?.participants?.find((p) => {
			const mm = (p.name || '').match(/^(.+?)\s+-\s+(.+)$/);
			if (!mm) return false;
			const [, ht, ft] = mm;
			const htOk = htOutcome === 'Draw' ? ht === 'Draw' : teamsMatch(ht, htOutcome);
			const ftOk = ftOutcome === 'Draw' ? ft === 'Draw' : teamsMatch(ft, ftOutcome);
			return htOk && ftOk;
		});
		const price = part ? priceForParticipant(markets, special.id, part.id) : null;
		if (price == null) continue;
		return { league: league.name, decimal: americanToDecimal(price), exact: true };
	}
	return null;
}

// Approximation ÉTIQUETÉE (exact:false), à la demande explicite : "Double
// Chance" combiné à un Total ou un BTTS n'existe PAS comme marché direct
// chez Pinnacle -- vérifié sur plusieurs championnats (La Liga, Süper Lig)
// en inspectant le catalogue complet de marchés d'un vrai match. On
// multiplie donc deux marchés indépendants publiés séparément, ce qui n'est
// PAS statistiquement exact ("TeamX ou nul" corrèle avec le nombre de buts),
// d'où exact:false -- formatPinnacleReference affiche un avertissement.
function findDoubleChanceAndTotalApprox(leagues, teamName, side, teamA, teamB, totalSide, points) {
	const dc = findDoubleChance(leagues, teamA, teamB, teamName, side, 0);
	const total = findTotal(leagues, teamA, teamB, totalSide, points);
	if (!dc || !total) return null;
	return { league: dc.league, decimal: dc.decimal * total.decimal, exact: false };
}
function findDoubleChanceAndBttsApprox(leagues, teamName, side, teamA, teamB) {
	const dc = findDoubleChance(leagues, teamA, teamB, teamName, side, 0);
	const btts = findBtts(leagues, teamA, teamB, 0);
	if (!dc || !btts) return null;
	return { league: dc.league, decimal: dc.decimal * btts.decimal, exact: false };
}

// "TeamX gagne et les deux équipes marquent" -- marché Pinnacle direct
// (special "Both Teams To Score/Winner", même famille que
// findBttsAndTotal/findOddEvenAndTotal ci-dessus), participants "Yes &
// TeamX"/"No & TeamX"/"Yes & Draw"/"No & Draw". EXACT, pas une
// approximation -- contrairement à findDoubleChanceAndBttsApprox qui
// multiplie deux marchés indépendants faute de mieux.
function findWinAndBtts(leagues, teamA, teamB, team) {
	for (const { league, matchups, markets } of leagues) {
		const parent = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!parent) continue;
		const special = matchups.find((s) => s.parentId === parent.id && s.special?.description === 'Both Teams To Score/Winner');
		// "Yes & {Équipe}" -- on isole le nom après "Yes &" avant de comparer,
		// sinon teamsMatch fuzzy-matche n'importe quelle équipe via le mot
		// commun "Yes" partagé par tous les participants du marché.
		const part = special?.participants?.find((p) => {
			const suffixMatch = /^Yes\s*&\s*(.+)$/i.exec(p.name || '');
			return suffixMatch && teamsMatch(suffixMatch[1], team);
		});
		const price = part ? priceForParticipant(markets, special.id, part.id) : null;
		if (price == null) continue;
		return { league: league.name, decimal: americanToDecimal(price), exact: true };
	}
	return null;
}

// Marché "Player Props" (catégorie "Player Props" chez Pinnacle) -- "{Joueur}
// Total {Stat}" en Over/Under avec une ligne (prices[].points), pas un simple
// Yes/No. Contrairement aux marchés par équipe, la ligne Pinnacle est fixée
// par le marché lui-même (ex: 25.5) et doit correspondre EXACTEMENT au seuil
// annoncé dans le boost -- sinon ce n'est pas la même cote et on n'affiche
// rien plutôt que de comparer deux seuils différents. Vérifié en direct sur
// un match WNBA (seul sport où ces props existent via l'API guest -- aucun
// équivalent trouvé pour le foot, voir l'audit dans le commit correspondant).
function findPlayerProp(leagues, playerName, statLabel, side, threshold) {
	const suffix = ` Total ${statLabel}`;
	const wantLabel = side === 'over' ? 'Over' : 'Under';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
			if (m.special?.category !== 'Player Props') continue;
			const desc = m.special?.description;
			if (!desc || !desc.endsWith(suffix)) continue;
			const namePart = desc.slice(0, desc.length - suffix.length);
			if (!namePart || !teamsMatch(namePart, playerName)) continue;
			const part = (m.participants || []).find((p) => p.name === wantLabel);
			if (!part) continue;
			const mk = markets.find((mk) => mk.matchupId === m.id);
			const priceEntry = mk?.prices?.find((pr) => pr.participantId === part.id);
			if (!priceEntry || Math.abs((priceEntry.points ?? NaN) - threshold) > 0.01) continue;
			return { league: league.name, decimal: americanToDecimal(priceEntry.price), exact: true };
		}
	}
	return null;
}

// Marché "Équipe By N" / "Équipe By N+" (marge de victoire) -- somme les
// probabilités de toutes les marges >= au seuil demandé. Exact (pas d'approximation).
// BUG corrigé : "Winning Margin" et "Winning Margin 1st Half" produisent des
// noms de participants identiques ("TeamX By N") -- sans filtrer sur
// special.description, cette fonction pouvait piocher la mauvaise période
// selon l'ordre de retour de l'API (silencieux, jamais détecté sur un cas
// réel car les paris de marge boostés sont pour l'instant tous match complet).
function findWinningMargin(leagues, teamA, teamB, teamName, minMargin, period = 0) {
	const expectedDescription = period === 1 ? 'Winning Margin 1st Half' : 'Winning Margin';
	for (const { league, matchups, markets } of leagues) {
		const parent = findRootMatchup(matchups, teamA, teamB);
		if (!parent) continue;
		for (const m of matchups) {
			if (m.parentId !== parent.id) continue;
			if (m.special?.description !== expectedDescription) continue;
			const teamParts = (m.participants || [])
				.filter((p) => / By \d+\+?$/.test(p.name || '') && teamsMatch(p.name.split(' By ')[0], teamName))
				.map((p) => {
					const suffix = p.name.split(' By ')[1];
					return { id: p.id, n: parseInt(suffix, 10) };
				})
				.filter((p) => !isNaN(p.n));
			const qualifying = teamParts.filter((p) => p.n >= minMargin);
			if (!qualifying.length) continue;

			let probSum = 0;
			for (const q of qualifying) {
				const price = priceForParticipant(markets, m.id, q.id);
				if (price == null) return null;
				probSum += 1 / americanToDecimal(price);
			}
			if (!probSum) continue;
			return { league: league.name, decimal: 1 / probSum, exact: true };
		}
	}
	return null;
}

// Marché "Correct Score" -- somme les probabilités des scores exacts demandés
// ("gagne 1-0, 2-0 ou 3-0"). Exact : Pinnacle publie une cote par score exact,
// pas une approximation par multiplication de marchés indépendants.
function findCorrectScoreSum(leagues, teamName, opponentName, scoreLines, period = 0) {
	const expectedDescription = period === 1 ? 'Correct Score 1st Half' : 'Correct Score';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
			if (m.special?.description !== expectedDescription) continue;
			const parent = matchups.find((p) => p.id === m.parentId);
			const parentNames = (parent?.participants || []).map((p) => p.name);
			if (!parentNames.some((n) => teamsMatch(n, teamName)) || !parentNames.some((n) => teamsMatch(n, opponentName))) {
				continue;
			}

			// Tout ou rien : si un des scores exacts demandés est introuvable côté
			// Pinnacle, on n'affiche rien plutôt qu'une somme partielle (qui sous-
			// estimerait la vraie probabilité, donc gonflerait la cote affichée).
			let probSum = 0;
			let allFound = true;
			for (const [teamScore, oppScore] of scoreLines) {
				const part = (m.participants || []).find((p) => {
					const sm = (p.name || '').match(/^(.+?)\s+(\d+),\s*(.+?)\s+(\d+)$/);
					if (!sm) return false;
					const [, n1, s1, n2, s2] = sm;
					if (teamsMatch(n1, teamName) && teamsMatch(n2, opponentName)) {
						return parseInt(s1, 10) === teamScore && parseInt(s2, 10) === oppScore;
					}
					if (teamsMatch(n2, teamName) && teamsMatch(n1, opponentName)) {
						return parseInt(s2, 10) === teamScore && parseInt(s1, 10) === oppScore;
					}
					return false;
				});
				const price = part ? priceForParticipant(markets, m.id, part.id) : null;
				if (price == null) {
					allFound = false;
					break;
				}
				probSum += 1 / americanToDecimal(price);
			}
			if (!allFound || !probSum) continue;
			return { league: league.name, decimal: 1 / probSum, exact: true };
		}
	}
	return null;
}

// Trouve, dans une league Pinnacle déjà chargée, les matchups racine qui
// démarrent aujourd'hui (heure de Paris) exactement à hour:minute --
// utilisé par les combos schedule-based (scheduleBtts/scheduleTotal) qui
// n'ont aucun nom d'équipe, juste une heure de coup d'envoi partagée.
function findScheduledMatchups(matchups, hour, minute) {
	const now = new Date();
	const todayParts = new Intl.DateTimeFormat('fr-FR', {
		timeZone: 'Europe/Paris',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).formatToParts(now);
	const today = `${todayParts.find((p) => p.type === 'year').value}-${todayParts.find((p) => p.type === 'month').value}-${todayParts.find((p) => p.type === 'day').value}`;

	return matchups.filter((m) => {
		if (!isRootMatchup(m) || m.type !== 'matchup' || !m.startTime) return false;
		const parts = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(m.startTime));
		const date = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'day').value}`;
		if (date !== today) return false;
		if (hour == null) return true; // "matchs du jour" -- pas d'heure précise, toute la journée
		const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
		const mi = parseInt(parts.find((p) => p.type === 'minute').value, 10);
		return h === hour && mi === minute;
	});
}

// Combo "toutes les équipes marquent" sans noms d'équipes ("Les 2 équipes
// marquent dans chacun des N matchs à HHhMM") -- les matchs concernés se
// retrouvent via le calendrier Pinnacle de la compétition déjà identifiée.
// Si ce n'est pas exactement N matchs, ambigu -> silencieux plutôt que de
// deviner lesquels. BTTS ("Both Teams To Score?") est un marché direct
// Pinnacle, donc chaque leg est exacte ; matchs différents = indépendants.
function findScheduleBtts(leagues, count, hour, minute) {
	for (const { league, matchups, markets } of leagues) {
		const matching = findScheduledMatchups(matchups, hour, minute);
		if (matching.length !== count) continue; // pas le bon nombre -> ambigu, on essaiera une autre ligue candidate

		const subLegs = [];
		let probProduct = 1;
		let allFound = true;
		for (const m of matching) {
			const bttsSpecial = matchups.find((s) => s.parentId === m.id && s.special?.description === 'Both Teams To Score?');
			const yesPart = bttsSpecial?.participants?.find((p) => p.name === 'Yes');
			const price = yesPart ? priceForParticipant(markets, bttsSpecial.id, yesPart.id) : null;
			if (price == null) {
				allFound = false;
				break;
			}
			const decimal = americanToDecimal(price);
			probProduct *= 1 / decimal;
			subLegs.push({ label: (m.participants || []).map((p) => p.name).join(' - '), decimal });
		}
		if (!allFound) continue;
		return { league: league.name, decimal: 1 / probProduct, exact: true, subLegs };
	}
	return null;
}

// Même principe, mais total buts (Over/Under, sur le matchup racine
// directement, pas un "special") au lieu de BTTS.
function findScheduleTotal(leagues, count, hour, minute, side, points, period) {
	for (const { league, matchups, markets } of leagues) {
		const matching = findScheduledMatchups(matchups, hour, minute);
		if (matching.length !== count) continue;

		const subLegs = [];
		let probProduct = 1;
		let allFound = true;
		for (const m of matching) {
			const market = markets.find(
				(mk) => mk.matchupId === m.id && mk.type === 'total' && mk.period === period && mk.prices?.[0]?.points === points
			);
			const p = market?.prices.find((pr) => pr.designation === side);
			if (!p) {
				allFound = false;
				break;
			}
			const decimal = americanToDecimal(p.price);
			probProduct *= 1 / decimal;
			subLegs.push({ label: (m.participants || []).map((pp) => pp.name).join(' - '), decimal });
		}
		if (!allFound) continue;
		return { league: league.name, decimal: 1 / probProduct, exact: true, subLegs };
	}
	return null;
}

// Même principe que findScheduleBtts/findScheduleTotal, mais victoire de
// l'équipe à DOMICILE (moneyline, désignation "home") -- "Chaque équipe à
// domicile gagne (N matchs à HHhMM)", vraie cote Pro D2 vue sur Winamax.
function findScheduleHomeWin(leagues, count, hour, minute) {
	for (const { league, matchups, markets } of leagues) {
		const matching = findScheduledMatchups(matchups, hour, minute);
		if (matching.length !== count) continue;

		const subLegs = [];
		let probProduct = 1;
		let allFound = true;
		for (const m of matching) {
			const market = markets.find((mk) => mk.matchupId === m.id && mk.type === 'moneyline' && mk.period === 0);
			const p = market?.prices.find((pr) => pr.designation === 'home');
			if (!p) {
				allFound = false;
				break;
			}
			const decimal = americanToDecimal(p.price);
			probProduct *= 1 / decimal;
			subLegs.push({ label: (m.participants || []).map((pp) => pp.name).join(' - '), decimal });
		}
		if (!allFound) continue;
		return { league: league.name, decimal: 1 / probProduct, exact: true, subLegs };
	}
	return null;
}

// Même principe que findScheduleHomeWin, mais total buts DE L'ÉQUIPE À
// DOMICILE (marché "team_total", side:'home') au lieu du résultat du match --
// "Chaque équipe à domicile marque au moins N buts (N matchs du jour)",
// vraie cote Liiga vue sur Winamax.
function findScheduleHomeTeamTotal(leagues, count, hour, minute, side, points) {
	for (const { league, matchups, markets } of leagues) {
		const matching = findScheduledMatchups(matchups, hour, minute);
		if (matching.length !== count) continue;

		const subLegs = [];
		let probProduct = 1;
		let allFound = true;
		for (const m of matching) {
			const market = markets.find(
				(mk) => mk.matchupId === m.id && mk.type === 'team_total' && mk.period === 0 && mk.side === 'home' && mk.prices?.[0]?.points === points
			);
			const p = market?.prices.find((pr) => pr.designation === side);
			if (!p) {
				allFound = false;
				break;
			}
			const decimal = americanToDecimal(p.price);
			probProduct *= 1 / decimal;
			subLegs.push({ label: (m.participants || []).map((pp) => pp.name).join(' - '), decimal });
		}
		if (!allFound) continue;
		return { league: league.name, decimal: 1 / probProduct, exact: true, subLegs };
	}
	return null;
}

// period 0 = match complet, period 1 = 1ère mi-temps (foot/hand/etc.) -- même
// marché "moneyline" chez Pinnacle, juste une période différente.
function findMoneyline(leagues, teamA, teamB, period = 0) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				isRootMatchup(m) && // exclut les marchés spéciaux/props (ex: "team to score first") qui
				// peuvent partager les mêmes noms d'équipes que le match principal
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;
		const market = markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'moneyline' && mk.period === period);
		if (!market) continue;
		return { league: league.name, market, participants: matchup.participants };
	}
	return null;
}

// Approximation "{Joueur} marque au moins N points et {Équipe} gagne"
// (basket) -- même logique que playerScorerAndWin (marquer et gagner sont
// corrélés positivement, pas indépendants) : findPlayerProp (Points) *
// moneyline du même camp. Pinnacle uniquement -- ni Piwi ni Matchbook
// n'exposent de player props exploités ici (voir findPlayerProp).
function findPlayerPointsAndWinApprox(leagues, teamA, teamB, player, threshold, team) {
	const prop = findPlayerProp(leagues, player, 'Points', 'over', threshold);
	if (!prop) return null;
	const found = findMoneyline(leagues, teamA, teamB, 0);
	if (!found) return null;
	const parts = found.participants || [];
	const homePart = parts.find((p) => p.alignment === 'home') || parts[0];
	const awayPart = parts.find((p) => p.alignment === 'away') || parts[1];
	const designation = teamsMatch(homePart?.name, team) ? 'home' : teamsMatch(awayPart?.name, team) ? 'away' : null;
	if (!designation) return null;
	const backed = found.market.prices.find((p) => p.designation === designation);
	if (!backed) return null;
	return { league: prop.league, decimal: prop.decimal * americanToDecimal(backed.price), exact: false };
}

// Approximation "TeamX ouvre le score et gagne" -- pas de marché combiné
// direct (voir son commentaire dans parseLegs), multiplication de First Team
// To Score (special) et moneyline du même camp.
function findFirstScoreAndWinApprox(leagues, teamA, teamB, team, period = 0) {
	const fts = findSpecialByTeam(leagues, teamA, teamB, period === 1 ? 'First Team To Score 1st Half' : 'First Team To Score', team);
	if (!fts) return null;
	const found = findMoneyline(leagues, teamA, teamB, period);
	if (!found) return null;
	const parts = found.participants || [];
	const homePart = parts.find((p) => p.alignment === 'home') || parts[0];
	const awayPart = parts.find((p) => p.alignment === 'away') || parts[1];
	const designation = teamsMatch(homePart?.name, team) ? 'home' : teamsMatch(awayPart?.name, team) ? 'away' : null;
	if (!designation) return null;
	const backed = found.market.prices.find((p) => p.designation === designation);
	if (!backed) return null;
	return { league: fts.league, decimal: fts.decimal * americanToDecimal(backed.price), exact: false };
}

function findTotal(leagues, teamA, teamB, side, points, period = 0) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;
		let market = markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'total' && mk.period === period && mk.prices?.[0]?.points === points);
		if (!market) {
			// Tennis "total de jeux" -- contrairement au total de sets (déjà sur
			// le matchup racine, voir findBothWinASet), le nombre de jeux vit sur
			// un sous-matchup séparé dont les participants sont suffixés
			// "(Games)" (vu en direct sur Swiatek-Rybakina : matchup séparé, pas
			// de "special", même type 'total'/period que d'habitude). Repli
			// silencieux si absent (autres sports n'ont pas ce sous-matchup).
			const gamesMatchup = matchups.find((m) => m.parentId === matchup.id && (m.participants || []).some((p) => / \(Games\)$/.test(p.name || '')));
			if (gamesMatchup) {
				market = markets.find((mk) => mk.matchupId === gamesMatchup.id && mk.type === 'total' && mk.period === period && mk.prices?.[0]?.points === points);
			}
		}
		let isExactPoints = !!market;
		if (!market) {
			// La ligne exacte du boost a pu bouger depuis sa création (les
			// totaux évoluent en continu) -- repli sur la ligne alternative la
			// plus proche plutôt qu'abandonner silencieusement. Bug réel trouvé
			// sur un boost MLB ("plus de 7,5 runs" Nationals-Braves) : Pinnacle
			// n'offre plus que 8/8.5/9/9.5(main)/10/10.5/11, plus de 7.5 du
			// tout -- ref restait null alors qu'une vraie ligne très proche
			// (8.0) existe. Tolérance 2 points, marqué exact:false (repris par
			// formatPinnacleReference comme approximation étiquetée).
			const altMarkets = markets.filter(
				(mk) => mk.matchupId === matchup.id && mk.type === 'total' && mk.period === period && mk.prices?.[0]?.points != null
			);
			if (altMarkets.length) {
				altMarkets.sort((x, y) => Math.abs(x.prices[0].points - points) - Math.abs(y.prices[0].points - points));
				if (Math.abs(altMarkets[0].prices[0].points - points) <= 2) market = altMarkets[0];
			}
		}
		if (!market) continue;
		const p = market.prices.find((pr) => pr.designation === side);
		if (!p) continue;
		return { league: league.name, decimal: americanToDecimal(p.price), exact: isExactPoints, points: market.prices?.[0]?.points };
	}
	return null;
}

// Marché "team_total" -- Over/Under sur les buts D'UNE équipe, disponible
// directement sur le matchup principal (pas un special) via side:'home'/
// 'away'. teamName sert à déterminer quel côté (home/away) correspond à
// l'équipe demandée.
function findTeamTotal(leagues, teamA, teamB, teamName, side, points, period = 0) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;
		const homeName = matchup.participants.find((p) => p.alignment === 'home')?.name;
		const wantSide = teamsMatch(homeName, teamName) ? 'home' : 'away';
		const market = markets.find(
			(mk) =>
				mk.matchupId === matchup.id &&
				mk.type === 'team_total' &&
				mk.period === period &&
				mk.side === wantSide &&
				mk.prices?.[0]?.points === points
		);
		if (!market) continue;
		const p = market.prices.find((pr) => pr.designation === side);
		if (!p) continue;
		return { league: league.name, decimal: americanToDecimal(p.price), exact: true };
	}
	return null;
}

// "Les deux joueurs gagnent chacun (au moins) un set" (tennis, MÊME match)
// équivaut EXACTEMENT à "le match va au set décisif" en best-of-3 (2 sets
// gagnants) : la seule façon que les deux joueurs gagnent chacun >= 1 set
// est un score 2-1, ce qui revient exactement à "plus de 2,5 sets joués"
// -- pas une approximation, une AUTRE formulation du marché "Total Sets"
// déjà publié par Pinnacle sur le marché principal. Ne tient PAS en best-of-5
// (Grand Chelem messieurs : un 3-1 satisfait aussi la condition sans être
// "Over" la ligne totale) -- on vérifie donc explicitement que la ligne du
// marché Total vaut 2.5 avant de résoudre, sinon silencieux plutôt qu'un
// chiffre faux.
function findBothWinASet(leagues, teamA, teamB, points = 2.5) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				isRootMatchup(m) &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;
		const market = markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'total' && mk.period === 0);
		// points doit correspondre EXACTEMENT à la ligne demandée -- pas de
		// repli sur une autre ligne : "plus de 3,5 sets" (best-of-5, ligne
		// Pinnacle réelle 4.5) n'est pas la même chose que "plus de 2,5 sets"
		// (best-of-3, ligne 2.5). Silencieux si la ligne exacte n'existe pas
		// plutôt que de deviner. Bug réel trouvé sur un combo ATP US Open
		// (Grand Chelem, best-of-5) : l'ancienne version ignorait le seuil
		// demandé et vérifiait toujours contre 2.5, ratant silencieusement
		// tout best-of-5 (jamais de ligne 2.5 chez Pinnacle pour ces matchs).
		if (!market || market.prices?.[0]?.points !== points) continue;
		const p = market.prices.find((pr) => pr.designation === 'over');
		if (!p) continue;
		return { league: league.name, decimal: americanToDecimal(p.price), exact: true };
	}
	return null;
}

// --- Analyse du texte français libre des cotes boostées ---

// Une "leg" = une condition portant sur une équipe précise (gagne / gagne par
// marge / total buts-ou-points). Le texte peut décrire une seule leg (pari
// simple ou combiné même-match) ou plusieurs legs sur des matchs différents
// (combo multi-matchs). Le sport est déterminé une seule fois, en amont, à
// partir du sport réel de l'événement (pas d'une unité ambiguë dans le texte --
// "buts" et "points" existent dans plusieurs sports selon le contexte).
function parseLegs(eventName, description, sportKey) {
	if (!sportKey) return null; // sport non supporté par Pinnacle -- on ignore
	// Même nettoyage que côté Unibet (voir son commentaire détaillé) : Winamax
	// n'a pas de préfixe "CB - " mais garde des qualificatifs entre
	// parenthèses en fin de phrase ("(hors prol. et TAB)") jamais retirés
	// avant parseLegs, cassant les regex ancrées sur $ (ex: playerScorerAndWin
	// sur "... buteur et ... gagne (hors prol. et TAB)"). "(respectivement
	// contre ...)" explicitement épargné -- info réellement parsée plus bas.
	let d = stripDiacritics(description || '');
	for (let i = 0; i < 2; i++) {
		d = d
			.replace(/\s*\?\s*$/, '')
			// "(respectivement contre ...)" épargné (info réellement parsée plus
			// bas) -- "(N matchs à HHhMM)" épargné aussi (schedule combo, ex:
			// "Chaque équipe à domicile gagne (5 matchs à 19h30)") : bug réel
			// trouvé en direct, ce suffixe était supprimé avant même d'atteindre
			// le parseur dédié, qui ne voyait plus jamais l'heure/le nombre de matchs.
			.replace(/\s*\((?!respectivement)(?!\d+\s+matchs?\s+a\s+\d{1,2}h)(?:[^()]|\([^()]*\))*\)\s*$/i, '')
			.trim();
	}

	// Combo multi-matchs : "TeamA (vs OppA), TeamB (vs OppB) et TeamC (vs OppC)
	// gagnent chacun de N buts/points ou plus" -- la condition de marge est
	// partagée. "chacune" aussi accepté (accord féminin, ex. joueuses de
	// tennis) -- même bug class que joueurs/joueuses trouvé sur Diane Parry.
	const marginAll = d.match(/gagnent?\s+chacune?\s+(?:de\s+)?(\d+)\s*(?:buts?|points?|runs?|jeux?)\s+ou\s+plus/i);
	if (marginAll) {
		const margin = parseInt(marginAll[1], 10);
		const teamPattern = /(?:^|,\s*|-\s|et\s)([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\s*\(vs\.?\s+([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\)/g;
		const legs = [];
		let m;
		while ((m = teamPattern.exec(d)) !== null) {
			const team = m[1].trim();
			const opponent = m[2].trim();
			legs.push({ type: 'margin', team, teamA: team, teamB: opponent, margin, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs : "TeamA (vs OppA), TeamB (vs OppB) et TeamC (vs OppC)
	// marquent plus/moins de N buts/points chacun[e]" -- même forme que
	// marginAll ci-dessus, mais condition = total buts D'UNE équipe (marché
	// "team_total", déjà câblé via findTeamTotal), pas une marge de victoire.
	const teamTotalAllMatch = d.match(/marquent?\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:buts?|points?)\s+chacune?\b/i);
	if (teamTotalAllMatch) {
		const side = /plus/i.test(teamTotalAllMatch[1]) ? 'over' : 'under';
		const points = parseFloat(teamTotalAllMatch[2].replace(',', '.'));
		const teamPattern = /(?:^|,\s*|-\s|et\s)([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\s*\(vs\.?\s+([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\)/g;
		const legs = [];
		let m;
		while ((m = teamPattern.exec(d)) !== null) {
			const team = m[1].trim();
			const opponent = m[2].trim();
			legs.push({ type: 'teamTotal', teamA: team, teamB: opponent, team, side, points, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs sur total : "Plus/Moins de X buts/points/runs lors de
	// chacun des matchs suivants : TeamA - TeamB et TeamC - TeamD[, TeamE - TeamF]"
	// -- matchs différents = événements indépendants, multiplication exacte.
	const multiTotalMatch = d.match(
		/(plus|moins) de (\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?|jeux?)\s+(?:lors de |dans )?chacun des matchs suivants\s*:\s*(.+)/i
	);
	if (multiTotalMatch) {
		const side = /plus/i.test(multiTotalMatch[1]) ? 'over' : 'under';
		const points = parseFloat(multiTotalMatch[2].replace(',', '.'));
		const pairs = multiTotalMatch[3]
			.split(/,\s*|\s+et\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const legs = [];
		for (const pair of pairs) {
			const m2 = pair.match(/^([A-ZÀ-Ý][\w .'-]*?)\s+-\s+([A-ZÀ-Ý][\w .'-]*?)$/);
			if (!m2) continue;
			legs.push({ type: 'total', teamA: m2[1].trim(), teamB: m2[2].trim(), side, points, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs BTTS avec noms d'équipes explicites : "Chaque équipe
	// marque lors des matchs suivants : TeamA - TeamB et TeamC - TeamD" --
	// même forme que multiTotalMatch juste au-dessus, mais "chaque équipe
	// marque" (BTTS) au lieu d'un total. Vraie cote Saudi Pro League vue sur
	// Winamax, jamais parsée avant.
	const multiBttsNamedMatch = d.match(
		/chaque\s+equipe\s+marque\s+(?:lors\s+de[s]?\s+|dans\s+)?(?:chacun\s+des\s+)?matchs?\s+suivants\s*:\s*(.+)/i
	);
	if (multiBttsNamedMatch) {
		const pairs = multiBttsNamedMatch[1]
			.split(/,\s*|\s+et\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const legs = [];
		for (const pair of pairs) {
			const m2 = pair.match(/^([A-ZÀ-Ý][\w .'-]*?)\s+-\s+([A-ZÀ-Ý][\w .'-]*?)$/);
			if (!m2) continue;
			legs.push({ type: 'btts', teamA: m2[1].trim(), teamB: m2[2].trim(), sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs sur "plus de N,5 sets" (tennis, best-of-3) -- même
	// forme que multiTotalMatch juste au-dessus, mais unité "sets" : pas de
	// marché Over/Under numérique pour ça, "plus de 2,5 sets" = le match va
	// au 3e set = EXACTEMENT le marché bothWinASet déjà câblé (Piwi "Number of
	// Sets" -> "Three Sets" / Pinnacle "Total Sets" > 2.5) -- on réutilise ce
	// type leg par leg plutôt que d'en inventer un nouveau.
	const multiSetsMatch = d.match(
		/plus\s+de\s+(\d+(?:[.,]\d+)?)\s*sets?\s+(?:lors de |dans )?chacun des matchs suivants\s*:\s*(.+)/i
	);
	if (multiSetsMatch) {
		// Seuil réellement demandé ("plus de 3,5 sets" = match qui va au 5e
		// set = ligne Pinnacle 3.5, pas toujours 2.5 -- voir findBothWinASet).
		const points = parseFloat(multiSetsMatch[1].replace(',', '.'));
		const pairs = multiSetsMatch[2]
			.split(/,\s*|\s+et\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const legs = [];
		for (const pair of pairs) {
			const m2 = pair.match(/^([A-ZÀ-Ý][\w .'-]*?)\s+-\s+([A-ZÀ-Ý][\w .'-]*?)$/);
			if (!m2) continue;
			legs.push({ type: 'bothWinASet', teamA: m2[1].trim(), teamB: m2[2].trim(), points, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs sur victoire simple : "TeamA et TeamB gagnent chacun
	// leur match (respectivement contre OppA et OppB)" -- pas de total/marge,
	// juste une victoire par match, matchs différents = indépendants. Variante
	// "la première mi-temps" -> même marché Pinnacle "moneyline" mais period 1.
	const multiMoneylineMatch = d.match(
		/(.+?)\s+gagnent\s+chacune?\s+(leur\s+match|la\s+premiere\s+mi-?temps)\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiMoneylineMatch) {
		const period = /premiere/i.test(multiMoneylineMatch[2]) ? 1 : 0;
		const teamNames = multiMoneylineMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiMoneylineMatch[3].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({ type: 'moneyline', teamA: team, teamB: oppNames[i], team, period, sport: sportKey }));
		}
	}
	// Même forme, mais "gagnent chacun(e) par au moins N buts/points d'écart"
	// (marge de victoire) -- combo multi-matchs pour margin, même principe que
	// multiMoneylineMatch juste au-dessus mais avec un seuil de marge au lieu
	// d'une simple victoire. Vraie cote EFL Cup vue sur Winamax.
	const multiMarginMatch = d.match(
		/(.+?)\s+gagnent\s+chacune?\s+par\s+au\s+moins\s+(\d+)\s*(?:buts?|points?|runs?|jeux?)\s+d.ecart\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiMarginMatch) {
		const margin = parseInt(multiMarginMatch[2], 10);
		const teamNames = multiMarginMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiMarginMatch[3].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({ type: 'margin', teamA: team, teamB: oppNames[i], team, margin, period: 0, sport: sportKey }));
		}
	}
	// Même forme, mais "gagnent chacun(e) le 1er/premier set" (tennis) --
	// combo multi-matchs pour winsSet1 (gagne spécifiquement le 1er set, voir
	// sa définition single-match plus haut).
	const multiWinsSet1Match = d.match(
		/(.+?)\s+gagnent\s+chacune?\s+le\s+(?:premier|1(?:er|ere|ère)?)\s+set\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiWinsSet1Match) {
		const teamNames = multiWinsSet1Match[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiWinsSet1Match[2].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({ type: 'winsSet1', teamA: team, teamB: oppNames[i], team, period: 1, sport: sportKey }));
		}
	}

	// Combo multi-matchs sur but d'une équipe : "TeamA et TeamB marquent chacun
	// au moins N but(s) en première mi-temps/dans le match (respectivement
	// contre OppA et OppB)" -- même structure que le combo victoire ci-dessus,
	// mais "team_total over N-0.5" au lieu de moneyline. Piwi n'a pas de
	// marché "but d'une équipe en 1ère mi-temps" (vérifié en direct sur
	// Watford-Southampton et Burnley-West Ham, aucune ligue) -- Pinnacle
	// uniquement pour ce type, pas d'approximation Piwi possible.
	const multiTeamGoalMatch = d.match(
		/(.+?)\s+marquent\s+chacun\s+au\s+moins\s+(\d+)\s*buts?\s+(dans\s+le\s+match|en\s+premiere\s+mi-?temps)\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiTeamGoalMatch) {
		const period = /premiere/i.test(multiTeamGoalMatch[3]) ? 1 : 0;
		const points = parseInt(multiTeamGoalMatch[2], 10) - 0.5;
		const teamNames = multiTeamGoalMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiTeamGoalMatch[4].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({
				type: 'teamTotal',
				team,
				teamA: team,
				teamB: oppNames[i],
				side: 'over',
				points,
				period,
				sport: sportKey,
			}));
		}
	}

	// Combo multi-matchs "gagnent ou font match nul et plus/moins de N buts
	// dans chaque match (respectivement contre ...)" -- doubleChanceAndTotal
	// PAR match (voir sa version single-match plus haut), matchs différents =
	// indépendants.
	const multiDcAndTotalMatch = d.match(
		/(.+?)\s+gagnent\s+ou\s+font\s+match\s+nul\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?|jeux?)\s+dans\s+chaque\s+match\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiDcAndTotalMatch) {
		const totalSide = /plus/i.test(multiDcAndTotalMatch[2]) ? 'over' : 'under';
		const points = parseFloat(multiDcAndTotalMatch[3].replace(',', '.'));
		const teamNames = multiDcAndTotalMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiDcAndTotalMatch[4].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({
				type: 'doubleChanceAndTotal',
				team,
				side: 'teamOrDraw',
				teamA: team,
				teamB: oppNames[i],
				totalSide,
				points,
				sport: sportKey,
			}));
		}
	}

	// Combo "toutes les équipes marquent" SANS noms d'équipes -- juste une heure
	// de coup d'envoi partagée et un nombre de matchs ("Les 2 équipes marquent
	// dans chacun des 3 matchs à 13h00"). Pas de nom à faire correspondre : les
	// matchs concernés se retrouvent via le calendrier Pinnacle de la même
	// compétition (heure + date du jour) -- voir resolveScheduleBtts.
	const scheduleBttsMatch =
		/les\s+2\s+equipes|les\s+deux\s+equipes/i.test(d) &&
		d.match(/marquent\s+dans\s+chacun\s+des\s+(\d+)\s+matchs?\s+(?:a|de)\s+(\d{1,2})(?:h(\d{2})?|:(\d{2}))/i);
	if (scheduleBttsMatch) {
		return [
			{
				type: 'scheduleBtts',
				count: parseInt(scheduleBttsMatch[1], 10),
				hour: parseInt(scheduleBttsMatch[2], 10),
				minute: scheduleBttsMatch[3] ? parseInt(scheduleBttsMatch[3], 10) : scheduleBttsMatch[4] ? parseInt(scheduleBttsMatch[4], 10) : 0,
				sport: sportKey,
			},
		];
	}

	// Même principe, mais total buts au lieu de BTTS -- "Au moins un but
	// marqué (en 1ère mi-temps) lors de chacun des N matchs à HHhMM" ("au
	// moins un but" = Over 0.5). Vraie cote Ligue des Champions vue sur
	// Winamax, jamais parsée avant (ni Pinnacle ni les exchanges).
	const scheduleTotalMatch = d.match(
		/au\s+moins\s+(?:un|1)\s+but\s+marque\s*(en\s+(?:1ere|1ère|premiere|première)\s+mi-?temps)?\s*lors\s+de\s+chacun\s+des\s+(\d+)\s+matchs?\s+(?:a|de)\s+(\d{1,2})(?:h(\d{2})?|:(\d{2}))/i
	);
	if (scheduleTotalMatch) {
		return [
			{
				type: 'scheduleTotal',
				count: parseInt(scheduleTotalMatch[2], 10),
				hour: parseInt(scheduleTotalMatch[3], 10),
				minute: scheduleTotalMatch[4] ? parseInt(scheduleTotalMatch[4], 10) : scheduleTotalMatch[5] ? parseInt(scheduleTotalMatch[5], 10) : 0,
				side: 'over',
				points: 0.5,
				period: scheduleTotalMatch[1] ? 1 : 0,
				sport: sportKey,
			},
		];
	}

	// Même principe que scheduleTotalMatch juste au-dessus, mais un seuil de
	// buts arbitraire ("plus/moins de N,5 buts", pas figé à "au moins un
	// but") avec une heure de coup d'envoi précise. Vraie cote Coupe
	// d'Allemagne vue sur Winamax ("Plus de 2,5 buts dans chacun des 3 matchs
	// à 18h00") -- sans ce parseur dédié, ce texte tombait dans le fallback
	// total simple plus bas (team-agnostic) avec des "équipes" bidon, donnant
	// une mauvaise résolution silencieuse plutôt qu'un échec propre. Format
	// horaire toléré en "à HHhMM" OU "de HH:MM" (bug réel trouvé en direct sur
	// "... dans chacun des 6 matchs de 20:45" -- l'ancienne regex n'acceptait
	// que "à" + "HHhMM", donc ce texte tombait dans le même piège de
	// résolution silencieuse fausse que ce commentaire décrit).
	const scheduleTotalHourMatch = d.match(
		/(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?\s+dans\s+chacun\s+des\s+(\d+)\s+matchs?\s+(?:a|de)\s+(\d{1,2})(?:h(\d{2})?|:(\d{2}))/i
	);
	if (scheduleTotalHourMatch) {
		return [
			{
				type: 'scheduleTotal',
				count: parseInt(scheduleTotalHourMatch[3], 10),
				hour: parseInt(scheduleTotalHourMatch[4], 10),
				minute: scheduleTotalHourMatch[5]
					? parseInt(scheduleTotalHourMatch[5], 10)
					: scheduleTotalHourMatch[6]
					? parseInt(scheduleTotalHourMatch[6], 10)
					: 0,
				side: /plus/i.test(scheduleTotalHourMatch[1]) ? 'over' : 'under',
				points: parseFloat(scheduleTotalHourMatch[2].replace(',', '.')),
				period: 0,
				sport: sportKey,
			},
		];
	}

	// Même principe que scheduleTotalMatch ci-dessus, mais "dans chacun des N
	// matchs DU JOUR" (toute la journée, pas une heure de coup d'envoi
	// précise) et un seuil de buts arbitraire (pas figé à "au moins un but").
	// Vraie cote Ligue 2 vue sur Unibet ("Plus de 1.5 buts dans chacun des 5
	// matchs du jour") -- même mécanisme (findScheduledMatchups), juste sans
	// filtre horaire (hour=null -> matche toute la journée).
	const scheduleTotalDayMatch = d.match(/plus\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?\s+dans\s+chacun\s+des\s+(\d+)\s+matchs?\s+du\s+jour/i);
	if (scheduleTotalDayMatch) {
		return [
			{
				type: 'scheduleTotal',
				count: parseInt(scheduleTotalDayMatch[2], 10),
				hour: null,
				minute: null,
				side: 'over',
				points: parseFloat(scheduleTotalDayMatch[1].replace(',', '.')),
				period: 0,
				sport: sportKey,
			},
		];
	}

	// "Chaque équipe à domicile gagne (N matchs à HHhMM)" -- victoire du camp
	// domicile dans chacun des N matchs programmés à la même heure, sans nom
	// d'équipe (calendrier Pinnacle de la compétition, comme scheduleBtts/
	// scheduleTotal). Vraie cote Pro D2 vue sur Winamax.
	const scheduleHomeWinMatch = d.match(/chaque\s+equipe\s+a\s+domicile\s+gagne\s*\((\d+)\s+matchs?\s+(?:a|de)\s+(\d{1,2})(?:h(\d{2})?|:(\d{2}))\)/i);
	if (scheduleHomeWinMatch) {
		return [
			{
				type: 'scheduleHomeWin',
				count: parseInt(scheduleHomeWinMatch[1], 10),
				hour: parseInt(scheduleHomeWinMatch[2], 10),
				minute: scheduleHomeWinMatch[3]
					? parseInt(scheduleHomeWinMatch[3], 10)
					: scheduleHomeWinMatch[4]
					? parseInt(scheduleHomeWinMatch[4], 10)
					: 0,
				sport: sportKey,
			},
		];
	}

	// "Chaque équipe à domicile marque au moins N buts lors des N matchs du
	// jour" -- total buts DE L'ÉQUIPE À DOMICILE (pas le score du match
	// entier), dans chacun des N matchs de la journée, sans heure précise
	// (comme scheduleTotalDayMatch). Vraie cote Liiga (hockey) vue sur
	// Winamax, jamais parsée avant.
	const scheduleHomeTeamTotalMatch = d.match(
		/chaque\s+equipe\s+a\s+domicile\s+marque\s+au\s+moins\s+(\d+)\s*buts?\s+lors\s+des\s+(\d+)\s+matchs?\s+du\s+jour/i
	);
	if (scheduleHomeTeamTotalMatch) {
		return [
			{
				type: 'scheduleHomeTeamTotal',
				count: parseInt(scheduleHomeTeamTotalMatch[2], 10),
				hour: null,
				minute: null,
				side: 'over',
				points: parseInt(scheduleHomeTeamTotalMatch[1], 10) - 0.5,
				sport: sportKey,
			},
		];
	}

	// Combo multi-matchs total buts D'UNE équipe précise, noms explicites :
	// "TeamA et TeamB réalisent chacun au moins N buts/points/runs
	// (respectivement contre OppA et OppB)" -- même forme que
	// multiMoneylineMatch/multiMarginMatch, mais condition = team_total (déjà
	// câblé via findTeamTotal), pas victoire/marge. Vraie cote NPB (baseball)
	// vue sur Winamax.
	const multiTeamTotalNamedMatch = d.match(
		/(.+?)\s+realisent\s+chacun\s+au\s+moins\s+(\d+)\s*(?:buts?|points?|runs?|jeux?)\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiTeamTotalNamedMatch) {
		const points = parseInt(multiTeamTotalNamedMatch[2], 10) - 0.5;
		const teamNames = multiTeamTotalNamedMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiTeamTotalNamedMatch[3].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({
				type: 'teamTotal',
				teamA: team,
				teamB: oppNames[i],
				team,
				side: 'over',
				points,
				period: 0,
				sport: sportKey,
			}));
		}
	}

	// Combo multi-matchs sur score exact EN SETS (tennis), noms explicites :
	// "TeamA et TeamB gagnent chacune leur match N-M (respectivement contre
	// OppA et OppB)" -- même forme que multiMoneylineMatch, mais avec un
	// score de sets précis au lieu d'une simple victoire (setScore déjà
	// câblé pour le score exact single-match). Vraie cote WTA US Open vue sur
	// Winamax -- AVANT multiMoneylineMatch dans l'ordre des tests : sinon ce
	// dernier matcherait juste "leur match" et perdrait le score exact.
	const multiSetScoreNamedMatch = d.match(
		/(.+?)\s+gagnent\s+chacune?\s+leur\s+match\s+(\d+)-(\d+)\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiSetScoreNamedMatch) {
		const score = `${multiSetScoreNamedMatch[2]}-${multiSetScoreNamedMatch[3]}`;
		const teamNames = multiSetScoreNamedMatch[1].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		const oppNames = multiSetScoreNamedMatch[4].split(/,\s*|\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({ type: 'setScore', teamA: team, teamB: oppNames[i], team, score, sport: sportKey }));
		}
	}

	// Pari même-match combiné : "TeamX gagne et Plus/Moins de Y buts/points"
	const teams = splitTeams(eventName);
	if (!teams) return null;
	const [teamA, teamB] = teams;

	const extractedWinner = extractWinner(d);
	const winningTeam = isExactlyTeamName(teamA, extractedWinner) ? teamA : isExactlyTeamName(teamB, extractedWinner) ? teamB : null;

	const isFirstHalf = /(?:1ere|1ère|premiere|première)\s+mi-?temps/i.test(d);

	// Props joueur (basket uniquement -- seul sport où ces marchés existent
	// via l'API guest, voir findPlayerProp). Le nom capturé n'est PAS comparé
	// à teamA/teamB (c'est un joueur, pas une équipe) -- confiance dans
	// teamsMatch pour absorber les variantes d'écriture ("A. Fils" etc.),
	// comme déjà fait pour les "équipes" tennis.
	const playerPointsMatch = d.match(/^(.+?)\s+inscrit\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*points?\.?\s*$/i);
	const playerReboundsMatch = d.match(/^(.+?)\s+(?:prend|capte)\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*rebonds?\.?\s*$/i);
	const playerAssistsMatch = d.match(
		/^(.+?)\s+(?:d[eé]livre|distribue)\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*passes?(?:\s+d[ée]cisives?)?\.?\s*$/i
	);
	const playerThreesMatch = d.match(
		/^(.+?)\s+(?:r[eé]ussit|marque)\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:paniers?\s+(?:a|à)\s*3(?:\s*points?)?|3\s*[- ]?points?|tirs?\s+(?:a|à)\s*3(?:\s*points?)?)\.?\s*$/i
	);
	const playerPropMatch =
		(playerPointsMatch && ['Points', playerPointsMatch]) ||
		(playerReboundsMatch && ['Rebounds', playerReboundsMatch]) ||
		(playerAssistsMatch && ['Assists', playerAssistsMatch]) ||
		(playerThreesMatch && ['Threes Made', playerThreesMatch]);
	if (playerPropMatch) {
		const [statLabel, m] = playerPropMatch;
		return [
			{
				type: 'playerProp',
				player: m[1].trim(),
				statLabel,
				side: /plus/i.test(m[2]) ? 'over' : 'under',
				threshold: parseFloat(m[3].replace(',', '.')),
				sport: sportKey,
			},
		];
	}

	// --- Marchés combinés (vérifiés avant leurs variantes simples ci-dessous,
	// certaines n'étant pas ancrées en fin de chaîne et voleraient sinon le
	// combo pour ne renvoyer que la moitié de la condition) ---

	// "Les deux joueurs gagnent chacun (au moins) un set" (tennis, MÊME match
	// -- si "respectivement" est présent c'est le combo multi-matchs déjà géré
	// plus haut) -- voir findBothWinASet : équivaut au marché "Total Sets"
	// (Over 2.5) déjà publié par Pinnacle, pas une approximation. Côté Piwi,
	// correspond directement au marché "Number of Sets" -> "Three Sets".
	// Deuxième formulation réelle vue sur Unibet : "Les 2 joueurs gagnent un
	// set ?" (pas de "chacun", mais "les 2/deux joueurs" comme sujet lève
	// l'ambiguïté avec playerWinsASet qui vise UN seul joueur nommé).
	// "vainqueur"/"gagne et" exclus : "TeamX vainqueur et les 2 joueurs
	// gagnent un set" ET "TeamX gagne et les 2 joueurs gagnent un set"
	// contiennent cette même sous-chaîne mais désignent un marché DIFFÉRENT
	// (voir winNotStraightSetsMatch plus bas, vérifié avant celui-ci -- bug
	// réel trouvé en direct : sans cette exclusion, ce texte se faisait
	// silencieusement absorber ici, perdant la condition de victoire). Bug
	// réel trouvé sur une cote Diane Parry (tennis féminin) : "joueuses" (pas
	// "joueurs") n'était pas dans l'alternation -- legs restait null, aucune
	// source jamais tentée, alors que le marché existe bel et bien. Deuxième
	// bug réel trouvé sur une cote Rinderknech (Unibet, "gagne et" pas
	// "vainqueur et") : l'exclusion ne couvrait que "vainqueur", pas "gagne
	// et" -- même perte silencieuse de la condition de victoire.
	if (
		!/respectivement/i.test(d) &&
		!/(?:vainqueur|gagne)\s+et\s+les\s+(?:2|deux)\s+(?:joueurs|joueuses)\s+gagnent/i.test(d) &&
		/(?:gagnent?\s+chacune?|les\s+(?:2|deux)\s+(?:joueurs|joueuses)\s+gagnent)\s+(?:au\s+moins\s+)?(?:1|un)\s+set\b/i.test(d)
	) {
		return [{ type: 'bothWinASet', teamA, teamB, sport: sportKey }];
	}

	// "Plus de 2,5 sets lors du match" (tennis, MÊME match, pas de "chacun des
	// matchs suivants" -- sinon combo déjà géré plus haut) -- formulation
	// alternative de la même condition ("le match va au 3e set") que le
	// marché ci-dessus, vue telle quelle sur Winamax. Réutilise bothWinASet,
	// qui refuse déjà silencieusement si le match n'est pas best-of-3 (ligne
	// Pinnacle != 2.5).
	const totalSetsMatch = d.match(/plus\s+de\s+(\d+(?:[.,]\d+)?)\s*sets?\s+(?:lors\s+du\s+match|dans\s+le\s+match)?\.?\s*$/i);
	if (totalSetsMatch && parseFloat(totalSetsMatch[1].replace(',', '.')) === 2.5) {
		return [{ type: 'bothWinASet', teamA, teamB, sport: sportKey }];
	}

	// "{Joueur} remporte/gagne au moins 1 set" (tennis, UN SEUL joueur) --
	// marché Piwi direct "{Joueur} To Win A Set?" (Yes/No), vérifié en direct
	// sur A.Zverev v Norrie. Absent chez Pinnacle (confirmé plus tôt cette
	// session avec "Boisson remporte au moins 1 set" -- aucun marché trouvé).
	// teamA/teamB ajoutés (même si le joueur seul suffit pour Piwi) pour
	// permettre aussi la résolution Oddsportal en repli : somme de tous les
	// scores exacts où CE joueur gagne >=1 set, peu importe qui gagne le
	// match (contrairement à winNotStraightSets qui exige la victoire du
	// match ET un set concédé) -- voir findOddsportalReference.
	const playerWinsASetMatch = d.match(/^(.+?)\s+(?:remporte|gagne)\s+(?:au\s+moins\s+)?(?:1|un)\s+set\s*\??\.?\s*$/i);
	if (playerWinsASetMatch && !/respectivement/i.test(d)) {
		const cand = playerWinsASetMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		return [{ type: 'playerWinsASet', player: cand, team, teamA, teamB, sport: sportKey }];
	}

	// "Les 2 équipes marquent et plus/moins de N buts" -- marché Pinnacle
	// direct "Both Teams To Score/Total Goals".
	const bttsAndTotalMatch = d.match(
		/les\s+(?:2|deux)\s+equipes\s+marquent\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i
	);
	if (bttsAndTotalMatch) {
		return [
			{
				type: 'bttsAndTotal',
				teamA,
				teamB,
				side: /plus/i.test(bttsAndTotalMatch[1]) ? 'over' : 'under',
				points: parseFloat(bttsAndTotalMatch[2].replace(',', '.')),
				sport: sportKey,
			},
		];
	}

	// "Nombre/total de buts pair/impair et plus/moins de N buts" -- marché
	// Pinnacle direct "Odd/Even / Total Goals".
	const oddEvenAndTotalMatch = d.match(
		/(?:nombre|total)\s+(?:de\s+)?buts?\s+(impair|pair)\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i
	);
	if (oddEvenAndTotalMatch) {
		return [
			{
				type: 'oddEvenAndTotal',
				teamA,
				teamB,
				label: /impair/i.test(oddEvenAndTotalMatch[1]) ? 'Odd' : 'Even',
				side: /plus/i.test(oddEvenAndTotalMatch[2]) ? 'over' : 'under',
				points: parseFloat(oddEvenAndTotalMatch[3].replace(',', '.')),
				sport: sportKey,
			},
		];
	}

	// "TeamX ou match nul et plus/moins de N buts" / "Match nul ou TeamY et
	// plus/moins de N buts" -- APPROXIMATION étiquetée (pas de marché direct
	// Pinnacle, voir findDoubleChanceAndTotalApprox).
	const dcTeamAndTotalMatch =
		d.match(/^(.+?)\s+(?:gagne\s+)?ou\s+(?:fait\s+)?(?:le\s+)?match\s+nul\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i) ||
		d.match(/^double\s+chance\s*:?\s*(.+?)\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i);
	if (dcTeamAndTotalMatch) {
		const cand = dcTeamAndTotalMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{
					type: 'doubleChanceAndTotal',
					team,
					side: 'teamOrDraw',
					teamA,
					teamB,
					totalSide: /plus/i.test(dcTeamAndTotalMatch[2]) ? 'over' : 'under',
					points: parseFloat(dcTeamAndTotalMatch[3].replace(',', '.')),
					sport: sportKey,
				},
			];
		}
	}
	const dcDrawAndTotalMatch = d.match(
		/^(?:fait\s+)?(?:le\s+)?match\s+nul\s+ou\s+(.+?)\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i
	);
	if (dcDrawAndTotalMatch) {
		const cand = dcDrawAndTotalMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{
					type: 'doubleChanceAndTotal',
					team,
					side: 'drawOrTeam',
					teamA,
					teamB,
					totalSide: /plus/i.test(dcDrawAndTotalMatch[2]) ? 'over' : 'under',
					points: parseFloat(dcDrawAndTotalMatch[3].replace(',', '.')),
					sport: sportKey,
				},
			];
		}
	}

	// "TeamX ou match nul et les deux équipes marquent" / "Match nul ou TeamY
	// et les deux équipes marquent" -- APPROXIMATION étiquetée (idem, voir
	// findDoubleChanceAndBttsApprox).
	const dcTeamAndBttsMatch =
		d.match(/^(.+?)\s+(?:gagne\s+)?ou\s+(?:fait\s+)?(?:le\s+)?match\s+nul\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i) ||
		d.match(/^double\s+chance\s*:?\s*(.+?)\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i);
	if (dcTeamAndBttsMatch) {
		const cand = dcTeamAndBttsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChanceAndBtts', team, side: 'teamOrDraw', teamA, teamB, sport: sportKey }];
	}
	const dcDrawAndBttsMatch = d.match(
		/^(?:fait\s+)?(?:le\s+)?match\s+nul\s+ou\s+(.+?)\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i
	);
	if (dcDrawAndBttsMatch) {
		const cand = dcDrawAndBttsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChanceAndBtts', team, side: 'drawOrTeam', teamA, teamB, sport: sportKey }];
	}

	// "TeamX mène à la mi-temps et gagne le match" (même équipe aux deux
	// bouts) / "TeamX gagne à la mi-temps et à la fin du match" (autre
	// formulation réelle vue sur un vrai boost Liga MX, "gagne" répété au lieu
	// de "mène") / "...et TeamY gagne le match" (équipes différentes) / "Match
	// nul à la mi-temps et TeamX gagne le match" / "TeamX mène à la mi-temps
	// et match nul (à la fin)" -- marché Pinnacle direct "Half-Time/Full-Time".
	const htftSameTeamMatch =
		d.match(/^(.+?)\s+m[eè]ne\s+[aà]\s+la\s+mi-?temps\s+et\s+gagne(?:\s+le\s+match)?\.?\s*$/i) ||
		d.match(/^(.+?)\s+gagne\s+[aà]\s+la\s+mi-?temps\s+et\s+[aà]\s+la\s+fin\s+du\s+match\.?\s*$/i);
	const htftDrawAtHalfMatch = d.match(
		/^match\s+nul\s+[aà]\s+la\s+mi-?temps\s+et\s+(.+?)\s+gagne(?:\s+le\s+match)?\.?\s*$/i
	);
	const htftDrawAtFullMatch = d.match(
		/^(.+?)\s+m[eè]ne\s+[aà]\s+la\s+mi-?temps\s+et\s+(?:le\s+match\s+se\s+termine\s+sur\s+un\s+)?match\s+nul(?:\s+[aà]\s+la\s+fin)?\.?\s*$/i
	);
	const htftTwoTeamsMatch = d.match(/^(.+?)\s+m[eè]ne\s+[aà]\s+la\s+mi-?temps\s+et\s+(.+?)\s+gagne(?:\s+le\s+match)?\.?\s*$/i);
	if (htftSameTeamMatch) {
		const cand = htftSameTeamMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'htft', htOutcome: team, ftOutcome: team, teamA, teamB, sport: sportKey }];
	}
	if (htftDrawAtHalfMatch) {
		const cand = htftDrawAtHalfMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'htft', htOutcome: 'Draw', ftOutcome: team, teamA, teamB, sport: sportKey }];
	}
	if (htftDrawAtFullMatch) {
		const cand = htftDrawAtFullMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'htft', htOutcome: team, ftOutcome: 'Draw', teamA, teamB, sport: sportKey }];
	}
	if (htftTwoTeamsMatch) {
		const candHt = htftTwoTeamsMatch[1].trim();
		const candFt = htftTwoTeamsMatch[2].trim();
		const htTeam = isExactlyTeamName(teamA, candHt) ? teamA : isExactlyTeamName(teamB, candHt) ? teamB : null;
		const ftTeam = isExactlyTeamName(teamA, candFt) ? teamA : isExactlyTeamName(teamB, candFt) ? teamB : null;
		if (htTeam && ftTeam) return [{ type: 'htft', htOutcome: htTeam, ftOutcome: ftTeam, teamA, teamB, sport: sportKey }];
	}

	// "Les 2/deux équipes marquent chacune au moins N runs/buts/points" -- PAS
	// juste "les 2 équipes marquent" (BTTS classique, >=1 chacune, un marché
	// bien plus facile). Bug réel trouvé sur un boost MLB (Arizona-Philadelphie,
	// "chacune au moins 3 runs", cote boostée 2,40) : la regex BTTS nue plus
	// bas matche sur "marquent" en tant que sous-chaîne (le \b ne vérifie que
	// la fin du mot "marquent", pas ce qui suit), donc le seuil "chacune au
	// moins 3 runs" tombait silencieusement dans le marché BTTS classique
	// (>=1 run chacune, un événement bien plus probable) -- ligne de référence
	// totalement fausse (1,12 affiché au lieu du ~2,4 réel). Doit être vérifié
	// AVANT le fallback BTTS nu plus bas. Construit via team_total pour chaque
	// équipe, indépendamment multipliés (approximation, aucun marché combiné
	// direct chez Pinnacle/Piwi/Matchbook pour ce seuil).
	const bothTeamTotalMatch = d.match(
		/les\s+(?:2|deux)\s+equipes\s+marquent\s+chacune\s+au\s+moins\s+(\d+)\s*(?:runs?|buts?|points?)\b/i
	);
	if (bothTeamTotalMatch) {
		const n = parseInt(bothTeamTotalMatch[1], 10);
		return [{ type: 'bothTeamTotal', teamA, teamB, points: n - 0.5, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX gagne et les deux équipes marquent" -- combo direct chez Pinnacle
	// ("Both Teams To Score/Winner" special, participants "Yes & TeamX"/"No &
	// TeamX"/"Yes & Draw"/"No & Draw"), PAS juste "les 2 équipes marquent"
	// seul. Bug réel trouvé sur une cote Cardiff City (4,50) affichée avec une
	// ligne Piwi à 1,63 qui ne correspondait à rien -- le "TeamX gagne et"
	// était silencieusement ignoré, la regex btts nue plus bas matchant sur
	// simple sous-chaîne sans vérifier le préfixe victoire. Doit être vérifié
	// AVANT le fallback btts seul juste en dessous.
	if (winningTeam && /les\s+(?:2|deux)\s+equipes\s+marquent\b/i.test(d)) {
		return [
			{
				type: 'winAndBtts',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
				teamA,
				teamB,
				period: isFirstHalf ? 1 : 0,
				sport: sportKey,
			},
		];
	}

	// "Les 2/deux équipes marquent" (même match, pas de combo multi-matchs --
	// déjà géré plus haut) -- marché Pinnacle direct "Both Teams To Score?".
	if (/les\s+(?:2|deux)\s+equipes\s+marquent\b/i.test(d)) {
		return [{ type: 'btts', teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX ouvre le score et gagne (le match)" -- contrairement à
	// winAndBtts ci-dessus, aucun marché combiné direct pour ça chez
	// Pinnacle/Piwi/Matchbook (vérifié en direct sur Rayo Vallecano-Alaves :
	// aucun des trois n'a de special "First To Score And Win"). Approximation
	// par multiplication (First Team To Score Pinnacle * moneyline du même
	// camp), non exacte -- les deux sont corrélés positivement en réalité
	// (l'équipe qui ouvre le score gagne plus souvent), donc probablement une
	// sous-estimation de la vraie cote, mais mieux qu'aucune ligne.
	const firstScoreAndWinMatch = d.match(/^(.+?)\s+ouvre\s+le\s+score\s+et\s+gagne(?:\s+le\s+match)?\.?\s*$/i);
	if (firstScoreAndWinMatch) {
		const cand = firstScoreAndWinMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [{ type: 'firstScoreAndWin', team, teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
		}
	}

	// "TeamX ou match nul" / "Double chance TeamX" -> Pinnacle "TeamX Or Draw" ;
	// "Match nul ou TeamY" -> "Draw Or TeamY". Marché "Double Chance" direct.
	const teamOrDrawMatch =
		d.match(/^(.+?)\s+(?:gagne\s+)?ou\s+(?:fait\s+)?(?:le\s+)?match\s+nul\.?\s*$/i) || d.match(/^double\s+chance\s*:?\s*(.+?)\.?\s*$/i);
	if (teamOrDrawMatch) {
		const cand = teamOrDrawMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChance', team, teamA, teamB, side: 'teamOrDraw', period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}
	const drawOrTeamMatch = d.match(/^(?:fait\s+)?(?:le\s+)?match\s+nul\s+ou\s+(.+?)\.?\s*$/i);
	if (drawOrTeamMatch) {
		const cand = drawOrTeamMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChance', team, teamA, teamB, side: 'drawOrTeam', period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX ne perd pas" -- marché Pinnacle direct "Draw No Bet" (mise
	// remboursée en cas de nul, pas une combinaison à calculer).
	const drawNoBetMatch = d.match(/^(.+?)\s+ne\s+perd\s+pas(?:\s+(?:ce|le)\s+match)?\.?\s*$/i);
	if (drawNoBetMatch) {
		const cand = drawNoBetMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'drawNoBet', team, teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX marque en premier" / "TeamX marque le premier but" / "TeamX
	// ouvre le score" -- marché Pinnacle direct "First Team To Score"
	// (Team/Team/Neither) si c'est une équipe ; sinon probablement un joueur
	// ("Mbappé ouvre le score") -- marché Piwi direct "Player First
	// Goalscorer" (distinct de "Player To Score", n'importe quand).
	const firstToScoreMatch =
		d.match(/^(.+?)\s+(?:marque|inscrit)\s+(?:le\s+)?premi[eè]re?\s+but\b/i) ||
		d.match(/^(.+?)\s+marque\s+en\s+premier\b/i) ||
		d.match(/^(.+?)\s+ouvre\s+le\s+score\.?\s*$/i);
	if (firstToScoreMatch) {
		const cand = firstToScoreMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'firstToScore', team, teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
		return [{ type: 'playerFirstScorer', player: cand, sport: sportKey }];
	}

	// "TeamX marque un nombre de buts pair/impair" -- marché Pinnacle direct
	// "TeamX Goals Odd/Even" (par équipe, distinct du pair/impair du match
	// entier ci-dessous). Vérifié en premier : le déclencheur "marque un" est
	// propre à la variante par équipe, mais on garde l'ordre par prudence.
	const teamOddEvenMatch = d.match(/^(.+?)\s+marque\s+un\s+nombre\s+(?:de\s+)?buts?\s+(impair|pair)\b/i);
	if (teamOddEvenMatch) {
		const cand = teamOddEvenMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{
					type: 'teamGoalsOddEven',
					team,
					teamA,
					teamB,
					label: /impair/i.test(teamOddEvenMatch[2]) ? 'Odd' : 'Even',
					sport: sportKey,
				},
			];
		}
	}

	// "Nombre/total de buts pair/impair" -- marché Pinnacle direct "Total
	// Goals Odd/Even".
	const oddEvenMatch = d.match(/(?:nombre|total)\s+(?:de\s+)?buts?\s+(impair|pair)\b/i);
	if (oddEvenMatch) {
		return [
			{
				type: 'oddEvenTotal',
				teamA,
				teamB,
				label: /impair/i.test(oddEvenMatch[1]) ? 'Odd' : 'Even',
				period: isFirstHalf ? 1 : 0,
				sport: sportKey,
			},
		];
	}

	// "TeamX marque exactement N buts" -- marché Pinnacle direct "TeamX Goals".
	const exactTeamGoalsMatch = d.match(/^(.+?)\s+marque\s+exactement\s+(\d+)\s*buts?\b/i);
	if (exactTeamGoalsMatch) {
		const cand = exactTeamGoalsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{
					type: 'exactTeamGoals',
					team,
					teamA,
					teamB,
					n: parseInt(exactTeamGoalsMatch[2], 10),
					period: isFirstHalf ? 1 : 0,
					sport: sportKey,
				},
			];
		}
	}

	// "Exactement N buts au total / dans le match" -- marché Pinnacle direct
	// "Exact Total Goals" (pas lié à une équipe précise).
	const exactTotalGoalsMatch = d.match(/exactement\s+(\d+)\s*buts?\s+(?:au\s+total|dans\s+le\s+match|marques?)\b/i);
	if (exactTotalGoalsMatch) {
		return [
			{ type: 'exactTotalGoals', teamA, teamB, n: parseInt(exactTotalGoalsMatch[1], 10), period: isFirstHalf ? 1 : 0, sport: sportKey },
		];
	}

	// "TeamX marque plus/moins de N buts" -- total buts D'UNE ÉQUIPE (pas le
	// match entier, distinct de "total" et de "exactement N buts" ci-dessus).
	// Marché Pinnacle direct "team_total" (type de marché sur le matchup
	// principal, pas un special). Marché Piwi direct "{Équipe} Over/Under N
	// Goals".
	const teamTotalMatch = d.match(/^(.+?)\s+marque\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?\.?\s*$/i);
	if (teamTotalMatch) {
		const cand = teamTotalMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{
					type: 'teamTotal',
					team,
					teamA,
					teamB,
					side: /plus/i.test(teamTotalMatch[2]) ? 'over' : 'under',
					points: parseFloat(teamTotalMatch[3].replace(',', '.')),
					period: isFirstHalf ? 1 : 0,
					sport: sportKey,
				},
			];
		}
	}

	// "Plus/moins de N cartons (dans le match)" -- marché Piwi direct "Cards
	// Over/Under N" (aucun équivalent Pinnacle trouvé pour ce marché).
	const cardsTotalMatch = d.match(/(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*cartons?\b/i);
	if (cardsTotalMatch) {
		return [
			{
				type: 'cardsTotal',
				side: /plus/i.test(cardsTotalMatch[1]) ? 'over' : 'under',
				points: parseFloat(cardsTotalMatch[2].replace(',', '.')),
				sport: sportKey,
			},
		];
	}

	// "Plus/moins de N corners (dans le match)" -- marché Piwi direct "Corners
	// Over/Under N".
	const cornersTotalMatch = d.match(/(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*corners?\b/i);
	if (cornersTotalMatch) {
		return [
			{
				type: 'cornersTotal',
				side: /plus/i.test(cornersTotalMatch[1]) ? 'over' : 'under',
				points: parseFloat(cornersTotalMatch[2].replace(',', '.')),
				sport: sportKey,
			},
		];
	}

	// "Un penalty est tiré/accordé/sifflé dans le match" -- marché Piwi direct
	// "Penalty Taken?".
	if (/\bpenalty\b/i.test(d) && /\b(tir[ée]|accord[ée]|siffl[ée]|obtenu)\b/i.test(d)) {
		return [{ type: 'penaltyTaken', sport: sportKey }];
	}

	// "{Joueur} inscrit/marque un doublé" -> au moins 2 buts ; "un
	// triplé"/"un hat-trick" -> marché Piwi dédié "exactement 3 ou plus".
	// Marché Piwi direct ("Player To Score 2 Goals or More" / "Player To
	// Score a Hat-trick?"), aucun équivalent Pinnacle (voir playerScorer).
	const playerBraceMatch = d.match(/^(.+?)\s+(?:inscrit|marque)\s+un\s+doubl[ée]\.?\s*$/i);
	const playerHatTrickMatch = d.match(/^(.+?)\s+(?:inscrit|marque)\s+(?:un\s+)?(?:triple|hat-?trick)\.?\s*$/i);
	if (playerBraceMatch) {
		return [{ type: 'playerScorer', player: playerBraceMatch[1].trim(), minGoals: 2, sport: sportKey }];
	}
	if (playerHatTrickMatch) {
		return [{ type: 'playerScorer', player: playerHatTrickMatch[1].trim(), minGoals: 3, sport: sportKey }];
	}

	// "{Joueur} reçoit un carton" / "est averti" / "voit un carton
	// (jaune|rouge)" -- marché Piwi direct "Player Shown a Card".
	const playerCardedMatch = d.match(
		/^(.+?)\s+(?:re[cç]oit\s+un\s+carton|est\s+averti|voit\s+un\s+carton)(?:\s+(?:jaune|rouge))?\.?\s*$/i
	);
	if (playerCardedMatch) {
		return [{ type: 'playerCarded', player: playerCardedMatch[1].trim(), sport: sportKey }];
	}

	// "{Joueur} marque au moins N points et {Équipe} gagne" (basket) --
	// APPROXIMATION étiquetée, même logique que playerScorerAndWin juste en
	// dessous : findPlayerProp (Points) * moneyline du même camp. Vérifié
	// AVANT playerScorerAndWinMatch : sa regex ("marque et TeamX gagne") ne
	// matche pas "marque au moins N points et..." de toute façon (le "et"
	// n'est pas immédiatement après "marque"), mais autant être explicite sur
	// l'ordre pour la lisibilité.
	const playerPointsAndWinMatch = d.match(
		/^(.+?)\s+marque\s+au\s+moins\s+(\d+(?:[.,]\d+)?)\s*points?\s+et\s+(.+?)\s+gagne(?:\s+le\s+match)?\.?\s*$/i
	);
	if (playerPointsAndWinMatch) {
		const playerCand = playerPointsAndWinMatch[1].trim();
		const threshold = parseFloat(playerPointsAndWinMatch[2].replace(',', '.'));
		const teamCand = playerPointsAndWinMatch[3].trim();
		const team = isExactlyTeamName(teamA, teamCand) ? teamA : isExactlyTeamName(teamB, teamCand) ? teamB : null;
		const playerIsTeam = isExactlyTeamName(teamA, playerCand) || isExactlyTeamName(teamB, playerCand);
		if (team && !playerIsTeam) {
			return [{ type: 'playerPointsAndWin', player: playerCand, threshold, team, teamA, teamB, sport: sportKey }];
		}
	}

	// "{Joueur} buteur et {Équipe} gagne" -- APPROXIMATION étiquetée (voir
	// findPlayerScorerAndWinApprox côté Piwi) : marque et gagne ne sont pas
	// indépendants (corrélation positive), donc le produit des deux marchés
	// Piwi sous-estime la vraie probabilité conjointe -- c'est le combo qui a
	// causé le bug original Salah/Trabzonspor (résolu à l'époque en le
	// laissant silencieux ; maintenant qu'on a Piwi, un chiffre approximatif
	// étiqueté vaut mieux que rien, à la demande explicite de l'utilisatrice).
	const playerScorerAndWinMatch =
		d.match(/^(.+?)\s+buteu(?:r|se)\s+et\s+(.+?)\s+gagne(?:\s+le\s+match)?\.?\s*$/i) ||
		d.match(/^(.+?)\s+marque\s+et\s+(.+?)\s+gagne(?:\s+le\s+match)?\.?\s*$/i);
	if (playerScorerAndWinMatch) {
		const playerCand = playerScorerAndWinMatch[1].trim();
		const teamCand = playerScorerAndWinMatch[2].trim();
		const team = isExactlyTeamName(teamA, teamCand) ? teamA : isExactlyTeamName(teamB, teamCand) ? teamB : null;
		const playerIsTeam = isExactlyTeamName(teamA, playerCand) || isExactlyTeamName(teamB, playerCand);
		if (team && !playerIsTeam) {
			// "PlayerA ou PlayerB buteur et TeamX gagne" -- deux joueurs
			// interchangeables (l'un OU l'autre marque), pas un seul nom de
			// joueur contenant littéralement " ou ". Bug réel trouvé sur "O.
			// Blomberg ou J.P. Hauge buteur et Bodø/Glimt gagne" : le nom entier
			// était pris comme UN SEUL joueur, ne correspondant à personne.
			if (/\s+ou\s+/i.test(playerCand)) {
				const players = playerCand.split(/\s+ou\s+/i).map((p) => p.trim());
				if (players.length === 2) {
					return [{ type: 'playersEitherScorerAndWin', players, team, sport: sportKey }];
				}
			}
			return [{ type: 'playerScorerAndWin', player: playerCand, team, sport: sportKey }];
		}
	}

	// "{JoueurA} et {JoueurB} buteurs" -- AND (les DEUX doivent marquer, pas
	// "l'un ou l'autre" comme playersEitherScorerAndWin), SANS condition de
	// victoire (contrairement à playerScorerAndWinMatch juste au-dessus, qui
	// exige un suffixe "et TeamX gagne" -- absent ici donc pas de collision).
	// APPROXIMATION étiquetée : P(les deux marquent) = P(A marque) × P(B
	// marque), traités comme indépendants (en vrai peut-être corrélés si
	// même équipe -- même caveat que playerScorerAndWin). Vraie cote Coupe
	// d'Allemagne vue sur Unibet (M.Beier et K.Karetsas).
	const playersAllScoreMatch = d.match(/^(.+?)\s+et\s+(.+?)\s+buteu(?:rs?|ses?)\s*$/i);
	if (playersAllScoreMatch) {
		const p1 = playersAllScoreMatch[1].trim();
		const p2 = playersAllScoreMatch[2].trim();
		const p1IsTeam = isExactlyTeamName(teamA, p1) || isExactlyTeamName(teamB, p1);
		const p2IsTeam = isExactlyTeamName(teamA, p2) || isExactlyTeamName(teamB, p2);
		if (!p1IsTeam && !p2IsTeam) {
			return [{ type: 'playersAllScore', players: [p1, p2], sport: sportKey }];
		}
	}

	// "{Joueur} buteur" -- marché Piwi direct "Player To Score" (aucun
	// équivalent Pinnacle, voir la découverte du 2026-08-15 : Pinnacle n'a
	// aucun marché buteur par match pour le foot, seulement un "Top
	// Goalscorer" sur la saison entière).
	const playerScorerMatch = d.match(/^(.+?)\s+buteu(?:r|se)\.?\s*$/i);
	if (playerScorerMatch) {
		return [{ type: 'playerScorer', player: playerScorerMatch[1].trim(), sport: sportKey }];
	}

	// "TeamX marque" (au moins une fois), bare -- marché Pinnacle direct
	// "TeamX To Score?". Vérifié en dernier parmi les marchés "marque" : les
	// variantes plus spécifiques ("en premier", "exactement N buts") sont
	// déjà retournées plus haut si elles correspondent. Si le candidat n'est
	// PAS une des deux équipes, c'est probablement un joueur ("Mohamed Salah
	// marque") -- même marché Piwi "Player To Score" que "buteur" ci-dessus.
	const teamToScoreMatch = d.match(/^(.+?)\s+marque(?:\s+(?:au\s+moins\s+une\s+fois|un\s+but))?\.?\s*$/i);
	if (teamToScoreMatch) {
		const cand = teamToScoreMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'teamToScore', team, teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
		return [{ type: 'playerScorer', player: cand, sport: sportKey }];
	}

	// "{Combattant} gagne par KO/TKO/DSQ ou Soumission" -- combo MMA (pas
	// decision), marché Piwi direct "Method of Victory" (somme des deux
	// sélections concernées, comme correctScore pour le foot). Aucun
	// équivalent Pinnacle trouvé (mma:22 n'a pas ce special).
	const methodOfVictoryMatch =
		winningTeam && d.match(/gagne\s+par\s+KO[/,]?\s*TKO(?:[/,]?\s*DSQ)?\s+ou\s+Soumission\.?\s*$/i);
	if (methodOfVictoryMatch) {
		return [{ type: 'methodOfVictory', fighter: winningTeam, sport: sportKey }];
	}

	// "N jeux ou plus (dans le match)" -- même marché que "plus de N,5 jeux"
	// ci-dessous, formulation alternative vue sur Winamax pour le total de
	// jeux tennis (au lieu de "plus de N,5 jeux"). "N ou plus" = au moins N =
	// Over (N-0.5), même conversion que scheduleTotal pour "au moins un but".
	const totalOrMoreMatch = d.match(/(\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?|jeux?)\s+ou\s+plus\b/i);
	const totalMatch =
		d.match(/(plus|moins) de (\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?|jeux?)/i) ||
		(totalOrMoreMatch && ['', 'plus', String(parseFloat(totalOrMoreMatch[1].replace(',', '.')) - 0.5)]);
	// Deux formulations existent pour la marge de victoire : "gagne par/de N
	// buts ou plus" et "gagne par au moins N buts d'écart".
	const marginMatch =
		d.match(/gagne\s+(?:par|de)\s+(\d+)\s*(?:buts?|points?|runs?|jeux?)\s+ou\s+plus/i) ||
		d.match(/gagne\s+par\s+au\s+moins\s+(\d+)\s*(?:buts?|points?|runs?|jeux?)(?:\s+d.ecart)?/i);
	// "TeamX gagne le match 1-0, 2-0 ou 3-0" ET "TeamX gagne 1:0, 2:0 ou 3:0"
	// sont deux formulations réelles vues sur Unibet -- "le match" est
	// optionnel, le séparateur de score est soit "-" soit ":" (bug trouvé sur
	// un vrai boost Alaves qui utilisait la forme courte + les deux-points).
	// "sur le score de" toléré en plus (vraie cote tennis vue sur Unibet :
	// "R.Jodar gagne le match sur le score de 3-1 ou 3-2" -- même mécanisme
	// que le foot, juste un score EN SETS au lieu de buts, résolu uniquement
	// via Oddsportal côté exchanges/Pinnacle n'ayant pas ce marché pour le
	// tennis, voir findOddsportalReference).
	const correctScoreMatch =
		winningTeam &&
		d.match(/gagne\s+(?:le\s+match\s+)?(?:sur\s+le\s+score\s+de\s+)?((?:\d+\s*[:-]\s*\d+\s*(?:,\s*|\s+ou\s+))+\d+\s*[:-]\s*\d+)\.?\s*$/i);

	// "TeamX remporte le 1er set A-B ou C-D" (tennis) -- même mécanisme que
	// correctScore, mais sur le score EN JEUX du 1er set (period:1) au lieu
	// du score du match en sets. Réutilise le type 'correctScore' (déjà
	// capable de sommer plusieurs scores exacts), seule la période change --
	// voir findOddsportalReference qui bascule automatiquement sur l'onglet
	// "1st Set" quand period===1. Vraie cote Unibet vue sur C.Moutet.
	const winsSet1ScoreMatch = d.match(
		/^(.+?)\s+remporte\s+le\s+(?:1(?:er|ere|ère)?|premier)\s+set\s+(?:sur\s+le\s+score\s+de\s+)?((?:\d+\s*[:-]\s*\d+\s*(?:,\s*|\s+ou\s+))+\d+\s*[:-]\s*\d+)\s*$/i
	);
	if (winsSet1ScoreMatch) {
		const cand = winsSet1ScoreMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			const scoreLines = [...winsSet1ScoreMatch[2].matchAll(/(\d+)\s*[:-]\s*(\d+)/g)].map((m) => [
				parseInt(m[1], 10),
				parseInt(m[2], 10),
			]);
			return [
				{
					type: 'correctScore',
					team,
					opponent: team === teamA ? teamB : teamA,
					teamA,
					teamB,
					scoreLines,
					period: 1,
					sport: sportKey,
				},
			];
		}
	}

	// "TeamX vainqueur/gagne et les 2/deux joueurs gagnent un set" (tennis) --
	// mathématiquement équivalent à "TeamX gagne sans faire un blanchissage
	// (l'adversaire gagne au moins 1 set)", donc à la somme de tous les
	// scores exacts où TeamX gagne SAUF le score le plus large (3-0/2-0).
	// Résolu dynamiquement (pas de liste de scores fixe -- s'adapte au
	// format best-of-3 ou best-of-5 selon ce que la page renvoie réellement),
	// voir findOddsportalReference. Vraie cote Unibet vue sur G.Monfils
	// ("vainqueur et") puis sur A.Rinderknech ("gagne et", pas "vainqueur et"
	// -- même sens, formulation Unibet différente, ajoutée après un bug réel
	// où ce texte tombait silencieusement dans bothWinASet).
	const winNotStraightSetsMatch = d.match(
		/^(.+?)\s+(?:vainqueur|gagne)\s+et\s+les\s+(?:2|deux)\s+(?:joueurs|joueuses)\s+gagnent\s+(?:un|1)\s+set\s*$/i
	);
	if (winNotStraightSetsMatch) {
		const cand = winNotStraightSetsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [{ type: 'winNotStraightSets', team, opponent: team === teamA ? teamB : teamA, teamA, teamB, sport: sportKey }];
		}
	}

	if (winningTeam && totalMatch) {
		return [
			{
				type: 'winAndTotal',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
				side: /plus/i.test(totalMatch[1]) ? 'over' : 'under',
				points: parseFloat(totalMatch[2].replace(',', '.')),
				sport: sportKey,
			},
		];
	}
	// "TeamX gagne par exactement N buts ou exactement M buts d'écart" -- marge
	// EXACTE (pas "ou plus" comme marginMatch) -- calculable EXACTEMENT via
	// Asian Handicap : P(marge = k) = P(couvre -(k-0.5)) - P(couvre -(k+0.5)),
	// somme sur chaque k demandé. Pas d'équivalent direct Pinnacle non plus
	// (pas de marché "Winning Margin" avec valeur exacte) -- Piwi/Matchbook
	// uniquement pour ce type.
	const exactMarginMatch =
		winningTeam &&
		d.match(
			/gagne\s+par\s+((?:exactement\s+\d+\s*(?:buts?|points?|runs?|jeux?)\s*(?:,\s*|\s+ou\s+))*exactement\s+\d+\s*(?:buts?|points?|runs?|jeux?))\s+d.ecart\.?\s*$/i
		);
	if (exactMarginMatch) {
		const margins = [...exactMarginMatch[1].matchAll(/exactement\s+(\d+)/gi)].map((m) => parseInt(m[1], 10));
		return [
			{
				type: 'exactMargin',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
				margins,
				sport: sportKey,
			},
		];
	}
	if (winningTeam && marginMatch) {
		return [
			{
				type: 'margin',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
				teamA,
				teamB,
				margin: parseInt(marginMatch[1], 10),
				period: isFirstHalf ? 1 : 0,
				sport: sportKey,
			},
		];
	}
	if (totalMatch && !winningTeam) {
		return [
			{
				type: 'total',
				teamA,
				teamB,
				side: /plus/i.test(totalMatch[1]) ? 'over' : 'under',
				points: parseFloat(totalMatch[2].replace(',', '.')),
				period: isFirstHalf ? 1 : 0,
				sport: sportKey,
			},
		];
	}
	if (correctScoreMatch) {
		// "TeamX gagne le match A-B, C-D ou E-F" -- somme exacte des scores exacts
		// concernés via le marché "Correct Score" de Pinnacle.
		const scoreLines = [...correctScoreMatch[1].matchAll(/(\d+)\s*[:-]\s*(\d+)/g)].map((m) => [
			parseInt(m[1], 10),
			parseInt(m[2], 10),
		]);
		return [
			{
				type: 'correctScore',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
				scoreLines,
				period: isFirstHalf ? 1 : 0,
				sport: sportKey,
			},
		];
	}
	// "TeamX gagne 2-0/2-1" (tennis, score EXACT en sets -- PAS un score de
	// buts, à ne pas confondre avec correctScore) -- marché direct "Set
	// Betting" chez Piwi ET Matchbook, format "{Joueur} {V}-{D}". Absent chez
	// Pinnacle (vérifié en direct sur Borges v Nakashima, aucun special de ce
	// type sur un match par ailleurs complet) -- exchange only, un des rares
	// cas où Piwi/Matchbook couvrent plus que Pinnacle. Un seul chiffre après
	// "gagne" (pas de liste "ou") pour ne pas empiéter sur correctScoreMatch.
	const setScoreMatch = winningTeam && d.match(/gagne\s+(?:le\s+match\s+)?(\d)-(\d)\.?\s*$/i);
	if (setScoreMatch) {
		return [{ type: 'setScore', team: winningTeam, score: `${setScoreMatch[1]}-${setScoreMatch[2]}`, sport: sportKey }];
	}
	// "TeamX gagne le 1er/premier set" (tennis, gagne SPÉCIFIQUEMENT le 1er
	// set, sans score précisé -- différent de playerWinsASet qui vise "au
	// moins un set" n'importe lequel) -- marché Piwi direct "Set 1 Winner"
	// (participants = simples noms de joueurs comme un moneyline). Absent
	// chez Matchbook (vérifié, aucun marché "Set 1" trouvé sur aucun match
	// tennis en cours) et chez Pinnacle. Bug réel trouvé sur une cote Diane
	// Parry ("gagne le premier set", pas "1er set") : "premier" n'était pas
	// dans l'alternation, legs restait null, ref jamais tentée sur AUCUNE
	// source -- pas une histoire de données absentes, un vrai trou de parsing.
	const winsSet1Match = winningTeam && d.match(/gagne\s+le\s+(?:1(?:er|ere|ère)?|premier)\s+set\.?\s*$/i);
	if (winsSet1Match) {
		return [{ type: 'winsSet1', team: winningTeam, teamA, teamB, period: 1, sport: sportKey }];
	}
	// "TeamX gagne sans encaisser de but" -- marché spécial dédié "Team To Win
	// to Nil?" (Yes/No), variante 1ère mi-temps si précisé.
	const winToNilMatch =
		winningTeam &&
		d.match(/gagne\s+sans\s+encaisser\s+(?:de|un)\s+but(\s+en\s+(?:1ere|1ère|premiere|première)\s+mi-?temps)?\.?\s*$/i);
	if (winToNilMatch) {
		return [
			{
				type: 'winToNil',
				team: winningTeam,
				teamA,
				teamB,
				period: winToNilMatch[1] ? 1 : 0,
				sport: sportKey,
			},
		];
	}
	// "TeamX gagne" ou "TeamX gagne le match", et RIEN d'autre après -- sinon
	// c'est un marché différent ("gagne les deux mi-temps" par ex.) qui ne doit
	// surtout pas être confondu avec la victoire simple : mieux vaut n'afficher
	// aucune ligne Pinnacle qu'une mauvaise.
	const isPlainWin = winningTeam && /^[A-ZÀ-Ý][\w .'-]*?\s+gagne(\s+le\s+match)?\s*[.!]?\s*$/i.test(d.trim());
	if (isPlainWin || /resultat du match|resultat final|1x2/i.test(d)) {
		// "team" (côté effectivement backé) n'est connu que dans le cas isPlainWin --
		// sert à calculer l'edge % contre le bon prix Pinnacle (pas les 3 à la fois).
		return [{ type: 'moneyline', teamA, teamB, team: isPlainWin ? winningTeam : null, sport: sportKey }];
	}
	return null;
}

function extractWinner(d) {
	// ".*?" au lieu d'une classe de caractères restrictive ([\w .'-]) : cette
	// dernière ne couvre ni les lettres nordiques (ø, å...) ni le "/" des noms
	// composés ("Bodø/Glimt"), donc le match échouait ENTIÈREMENT dès qu'un de
	// ces caractères apparaissait dans le nom -- pas juste tronqué, aucun leg
	// du tout. Toujours non-greedy donc s'arrête au premier " gagne" rencontré,
	// même comportement sinon.
	const m = d.match(/^([A-ZÀ-Ý].*?)\s+gagne\b/i);
	return m ? m[1].trim() : '';
}

// Comparaison stricte pour valider qu'un texte extrait EST le nom d'équipe,
// pas juste teamsMatch (inclusion de sous-chaîne trop permissive pour ce cas
// précis) -- sinon "Mohamed Salah buteur et Trabzonspor" se fait prendre pour
// le nom de l'équipe "Trabzonspor" juste parce que la chaîne se termine par
// ce nom, et un pari combiné but+victoire se fait passer pour une simple
// victoire (mauvaise cote de référence, pire qu'aucune référence).
// Appelé PARTOUT comme isExactlyTeamName(nomEquipeComplet, texteExtrait) --
// le 1er argument est le vrai nom (roster), le 2e le texte extrait de la
// description (parfois abrégé, parfois un morceau de combo mal découpé).
function isExactlyTeamName(fullName, extracted) {
	const nc = normalizeTeam(fullName);
	const nt = normalizeTeam(extracted);
	if (!nc || !nt) return false;
	if (nc === nt) return true;
	// Un texte extrait bien plus LONG que le nom complet est suspect (combo
	// mal découpé qui contient le nom en plus d'autre chose, ex: le bug
	// Salah/Trabzonspor). Bien plus COURT est normal (prénom abrégé façon
	// Winamax : "D. Medvedev" vs "Daniil Medvedev") -- ne doit PAS être
	// rejeté avant même d'essayer le fuzzy match. Bug réel trouvé sur
	// "D. Medvedev gagne 2-1" qui ne parsait pas du tout (le sens du test
	// était inversé, il rejetait justement les abréviations légitimes).
	if (nt.length - nc.length > 4) return false;
	return teamsMatch(fullName, extracted);
}

function splitTeams(eventName) {
	const cleaned = (eventName || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
	const parts = cleaned.split(/\s+(?:-|vs\.?)\s+/i);
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return [parts[0].trim(), parts[1].trim().replace(/\s*[\u{1F1E6}-\u{1F1FF}]+\s*$/gu, '').trim()];
}

// leagueData : { league: {id, name}, matchups, markets } pour LA compétition
// Pinnacle déjà identifiée comme correspondant au libellé Unibet/Winamax --
// voir findPinnacleReference pour la sélection du candidat.
async function resolveLeg(leg, leagueData) {
	const leagues = [leagueData];
	if (leg.type === 'winAndTotal') {
		const direct = findCombinedWinTotal(leagues, leg.team, leg.opponent, leg.team, leg.side, leg.points);
		if (direct) return direct;
		// Pas de marché combiné direct (spécial Pinnacle "Équipe & Over/Under N"
		// absent, ligne de boost ne correspondant à aucun seuil publié) --
		// repli en approximation : produit moneyline × total, deux marchés
		// indépendants. Corrélation jugée faible pour ce type de combo en
		// tennis (contrairement au football où marge de victoire et total
		// buts sont fortement liés) : gagner en 2 sets serrés peut donner
		// autant de jeux que gagner en 3 sets, donc l'approximation reste
		// raisonnable -- exact:false quand même, par cohérence avec les
		// autres approximations étiquetées du fichier.
		const moneylineFound = findMoneyline(leagues, leg.team, leg.opponent, 0);
		const total = findTotal(leagues, leg.team, leg.opponent, leg.side, leg.points, leg.period || 0);
		if (!moneylineFound || !total) return null;
		const parts = moneylineFound.participants || [];
		const homePart = parts.find((p) => p.alignment === 'home') || parts[0];
		const awayPart = parts.find((p) => p.alignment === 'away') || parts[1];
		const designation = teamsMatch(homePart?.name, leg.team) ? 'home' : teamsMatch(awayPart?.name, leg.team) ? 'away' : null;
		if (!designation) return null;
		const priceEntry = moneylineFound.market.prices.find((p) => p.designation === designation);
		if (!priceEntry) return null;
		return { league: moneylineFound.league, decimal: americanToDecimal(priceEntry.price) * total.decimal, exact: false };
	}
	if (leg.type === 'margin') {
		return findWinningMargin(leagues, leg.teamA, leg.teamB, leg.team, leg.margin, leg.period || 0);
	}
	if (leg.type === 'total') {
		return findTotal(leagues, leg.teamA, leg.teamB, leg.side, leg.points, leg.period || 0);
	}
	if (leg.type === 'correctScore') {
		return findCorrectScoreSum(leagues, leg.team, leg.opponent, leg.scoreLines, leg.period || 0);
	}
	if (leg.type === 'winToNil') {
		return findWinToNil(leagues, leg.teamA, leg.teamB, leg.team, leg.period || 0);
	}
	if (leg.type === 'btts') {
		return findBtts(leagues, leg.teamA, leg.teamB, leg.period || 0);
	}
	if (leg.type === 'doubleChance') {
		return findDoubleChance(leagues, leg.teamA, leg.teamB, leg.team, leg.side, leg.period || 0);
	}
	if (leg.type === 'drawNoBet') {
		return findSpecialByTeam(leagues, leg.teamA, leg.teamB, leg.period === 1 ? 'Draw No Bet 1st Half' : 'Draw No Bet', leg.team);
	}
	if (leg.type === 'firstToScore') {
		return findSpecialByTeam(
			leagues,
			leg.teamA,
			leg.teamB,
			leg.period === 1 ? 'First Team To Score 1st Half' : 'First Team To Score',
			leg.team
		);
	}
	if (leg.type === 'oddEvenTotal') {
		return findSpecialByLabel(
			leagues,
			leg.teamA,
			leg.teamB,
			leg.period === 1 ? 'Total Goals Odd/Even 1st Half' : 'Total Goals Odd/Even',
			leg.label
		);
	}
	if (leg.type === 'exactTeamGoals') {
		return findExactTeamGoals(leagues, leg.teamA, leg.teamB, leg.team, leg.n, leg.period || 0);
	}
	if (leg.type === 'exactTotalGoals') {
		return findExactTotalGoals(leagues, leg.teamA, leg.teamB, leg.n, leg.period || 0);
	}
	if (leg.type === 'teamTotal') {
		return findTeamTotal(leagues, leg.teamA, leg.teamB, leg.team, leg.side, leg.points, leg.period || 0);
	}
	if (leg.type === 'bothTeamTotal') {
		const a = findTeamTotal(leagues, leg.teamA, leg.teamB, leg.teamA, 'over', leg.points, leg.period || 0);
		const b = findTeamTotal(leagues, leg.teamA, leg.teamB, leg.teamB, 'over', leg.points, leg.period || 0);
		if (!a || !b) return null;
		return { league: a.league, decimal: 1 / ((1 / a.decimal) * (1 / b.decimal)), exact: false };
	}
	if (leg.type === 'teamToScore') {
		return findTeamToScore(leagues, leg.teamA, leg.teamB, leg.team, leg.period || 0);
	}
	if (leg.type === 'teamGoalsOddEven') {
		return findTeamGoalsOddEven(leagues, leg.teamA, leg.teamB, leg.team, leg.label);
	}
	if (leg.type === 'playerProp') {
		return findPlayerProp(leagues, leg.player, leg.statLabel, leg.side, leg.threshold);
	}
	if (leg.type === 'bttsAndTotal') {
		return findBttsAndTotal(leagues, leg.teamA, leg.teamB, leg.side, leg.points);
	}
	if (leg.type === 'winAndBtts') {
		const direct = findWinAndBtts(leagues, leg.teamA, leg.teamB, leg.team);
		if (direct) return direct;
		// Pas de spécial "Both Teams To Score/Winner" pour ce match (vu en
		// direct sur UEFA Women's Champions League : le seul spécial combiné
		// disponible était "BTTS & Total", pas "BTTS & Winner") -- repli en
		// approximation moneyline × BTTS, même caveat de corrélation que
		// findWinAndTotal ci-dessus (le marché combiné existe généralement
		// chez Pinnacle pour les grandes compétitions masculines, moins
		// systématiquement en féminin, d'où ce repli).
		const moneylineFound = findMoneyline(leagues, leg.teamA, leg.teamB, leg.period || 0);
		const btts = findBtts(leagues, leg.teamA, leg.teamB, leg.period || 0);
		if (!moneylineFound || !btts) return null;
		const parts = moneylineFound.participants || [];
		const homePart = parts.find((p) => p.alignment === 'home') || parts[0];
		const awayPart = parts.find((p) => p.alignment === 'away') || parts[1];
		const designation = teamsMatch(homePart?.name, leg.team) ? 'home' : teamsMatch(awayPart?.name, leg.team) ? 'away' : null;
		if (!designation) return null;
		const priceEntry = moneylineFound.market.prices.find((p) => p.designation === designation);
		if (!priceEntry) return null;
		return { league: moneylineFound.league, decimal: americanToDecimal(priceEntry.price) * btts.decimal, exact: false };
	}
	if (leg.type === 'firstScoreAndWin') {
		return findFirstScoreAndWinApprox(leagues, leg.teamA, leg.teamB, leg.team, leg.period || 0);
	}
	if (leg.type === 'playerPointsAndWin') {
		return findPlayerPointsAndWinApprox(leagues, leg.teamA, leg.teamB, leg.player, leg.threshold, leg.team);
	}
	if (leg.type === 'oddEvenAndTotal') {
		return findOddEvenAndTotal(leagues, leg.teamA, leg.teamB, leg.label, leg.side, leg.points);
	}
	if (leg.type === 'doubleChanceAndTotal') {
		return findDoubleChanceAndTotalApprox(leagues, leg.team, leg.side, leg.teamA, leg.teamB, leg.totalSide, leg.points);
	}
	if (leg.type === 'doubleChanceAndBtts') {
		return findDoubleChanceAndBttsApprox(leagues, leg.team, leg.side, leg.teamA, leg.teamB);
	}
	if (leg.type === 'htft') {
		return findHalfTimeFullTime(leagues, leg.teamA, leg.teamB, leg.htOutcome, leg.ftOutcome);
	}
	if (leg.type === 'bothWinASet') {
		return findBothWinASet(leagues, leg.teamA, leg.teamB, leg.points || 2.5);
	}
	if (leg.type === 'scheduleBtts') {
		return findScheduleBtts(leagues, leg.count, leg.hour, leg.minute);
	}
	if (leg.type === 'scheduleTotal') {
		return findScheduleTotal(leagues, leg.count, leg.hour, leg.minute, leg.side, leg.points, leg.period || 0);
	}
	if (leg.type === 'scheduleHomeWin') {
		return findScheduleHomeWin(leagues, leg.count, leg.hour, leg.minute);
	}
	if (leg.type === 'scheduleHomeTeamTotal') {
		return findScheduleHomeTeamTotal(leagues, leg.count, leg.hour, leg.minute, leg.side, leg.points);
	}
	if (leg.type === 'moneyline') {
		const found = findMoneyline(leagues, leg.teamA, leg.teamB, leg.period || 0);
		if (!found) return null;
		const home = found.market.prices.find((p) => p.designation === 'home');
		const away = found.market.prices.find((p) => p.designation === 'away');
		const draw = found.market.prices.find((p) => p.designation === 'draw');
		// Détermine quel côté (home/away) correspond à l'équipe effectivement
		// backée par le boost -- sert à calculer l'edge % contre le bon prix,
		// pas contre les 3 issues à la fois.
		let backedDesignation = null;
		if (leg.team) {
			const parts = found.participants || [];
			const homePart = parts.find((p) => p.alignment === 'home') || parts[0];
			const awayPart = parts.find((p) => p.alignment === 'away') || parts[1];
			if (teamsMatch(homePart?.name, leg.team)) backedDesignation = 'home';
			else if (teamsMatch(awayPart?.name, leg.team)) backedDesignation = 'away';
		}
		return { league: found.league, moneyline: { home, away, draw }, backedDesignation };
	}
	return null;
}

// Essaie chaque leg contre une compétition candidate ; abandonne dès qu'une
// leg échoue (pas de résultat partiel trompeur), sinon renvoie tous les
// résultats résolus.
async function resolveLegsAgainstLeague(legs, league) {
	const leagueData = await fetchLeagueData(league.id);
	if (!leagueData) return null;
	const resolved = [];
	for (const leg of legs) {
		const r = await resolveLeg(leg, { league, ...leagueData });
		if (!r) return null;
		resolved.push(r);
	}
	return resolved;
}

// Dernier recours quand le nom de la compétition ne matche rien (ou que les
// candidats par nom ne résolvent pas les legs) : scanne le reste des
// compétitions du sport par lots plutôt que d'abandonner silencieusement. Le
// plan payant lève la limite de sous-requêtes/requête qui rendait ça risqué
// sur le plan gratuit -- concurrence bornée par lot pour ne pas non plus
// spammer l'API guest de Pinnacle.
async function scanAllLeaguesForLegs(legs, leagueList, skipIds) {
	const BATCH_SIZE = 20;
	const remaining = leagueList.filter((l) => !skipIds.has(l.id));
	for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
		const batch = remaining.slice(i, i + BATCH_SIZE);
		const results = await Promise.all(batch.map((league) => resolveLegsAgainstLeague(legs, league)));
		const hit = results.find(Boolean);
		if (hit) return hit;
	}
	return null;
}

async function findPinnacleReferenceForSport(eventName, description, leagueLabel, sportKey) {
	const legs = parseLegs(eventName, description, sportKey);
	if (!legs || !legs.length) return null;

	const leagueList = await fetchLeagueList(sportKey);
	const candidates = matchLeaguesByLabel(leagueList, leagueLabel, leagueCountryHint(leagueLabel));

	let resolved = null;
	for (const candidate of candidates) {
		resolved = await resolveLegsAgainstLeague(legs, candidate);
		if (resolved) break;
	}
	if (!resolved && leagueList.length) {
		const tried = new Set(candidates.map((c) => c.id));
		resolved = await scanAllLeaguesForLegs(legs, leagueList, tried);
	}
	// Combo multi-matchs dont les matchs ne sont PAS tous dans la même
	// compétition (ex: un match Ligue Europa + un match Ligue Europa
	// Conférence combinés dans un même "TeamA (vs OppA), TeamB (vs OppB)...") :
	// les deux tentatives ci-dessus supposent une seule league partagée par
	// toutes les legs, donc échouent par construction ici. Repli : résoudre
	// chaque leg indépendamment (son propre scan complet du sport), comme
	// déjà fait côté Piwi/Matchbook pour ces mêmes combos.
	if (!resolved && legs.length > 1 && leagueList.length) {
		const perLeg = [];
		for (const leg of legs) {
			const hit = await scanAllLeaguesForLegs([leg], leagueList, new Set());
			if (!hit) {
				perLeg.length = 0;
				break;
			}
			perLeg.push(hit[0]);
		}
		if (perLeg.length === legs.length) resolved = perLeg;
	}
	if (!resolved) return null;

	if (resolved.length === 1 && resolved[0].moneyline) {
		return {
			type: 'moneyline',
			league: resolved[0].league,
			moneyline: resolved[0].moneyline,
			backedDesignation: resolved[0].backedDesignation,
		};
	}
	if (resolved.length === 1 && resolved[0].subLegs) {
		// scheduleBtts : une seule "leg" en interne, mais qui représente plusieurs
		// matchs -- affiche le détail comme un vrai combo.
		return {
			type: 'combo',
			legues: [resolved[0].league],
			legs: resolved[0].subLegs,
			decimal: resolved[0].decimal,
			exact: true,
			legCount: resolved[0].subLegs.length,
		};
	}
	if (resolved.length === 1) {
		return { type: 'single', league: resolved[0].league, decimal: resolved[0].decimal, exact: resolved[0].exact, points: resolved[0].points };
	}
	// combo multi-matchs : legs indépendantes (matchs différents) -> multiplication exacte.
	// Une leg "moneyline" n'a pas de .decimal direct (home/away/draw séparés) --
	// il faut extraire le prix du côté effectivement backé.
	const legDecimal = (r) => {
		if (r.moneyline) {
			const backed = r.backedDesignation === 'home' ? r.moneyline.home : r.backedDesignation === 'away' ? r.moneyline.away : null;
			return backed ? americanToDecimal(backed.price) : null;
		}
		return r.decimal;
	};
	if (resolved.some((r) => legDecimal(r) == null)) return null; // pas d'approximation si un côté est ambigu
	let probProduct = 1;
	for (const r of resolved) probProduct *= 1 / legDecimal(r);
	return {
		type: 'combo',
		legues: [...new Set(resolved.map((r) => r.league))],
		legs: resolved.map((r, i) => ({
			label: legs[i].teamA ? `${legs[i].teamA} - ${legs[i].teamB}` : legs[i].team,
			decimal: legDecimal(r),
			points: r.points,
			exact: r.exact,
		})),
		decimal: 1 / probProduct,
		exact: true, // matchs différents = événements indépendants, pas d'approximation
		legCount: resolved.length,
	};
}

// Winamax ne fournit pas de champ sport fiable pour ses cotes boostées (juste
// un titre libre, souvent sans aucun mot-clé sport dedans -- voir
// guessSportEmoji) : on essaie chaque sport supporté à tour de rôle plutôt que
// d'abandonner. Le parsing du texte (parseLegs) est gratuit et identique quel
// que soit le sport essayé ; seul un sport qui matche vraiment déclenche des
// appels réseau. Foot en premier : de loin le plus fréquent.
async function findPinnacleReference(eventName, description, leagueLabel, sportKey) {
	const sportsToTry = sportKey ? AMBIGUOUS_SPORT_GROUPS[sportKey] || [sportKey] : Object.keys(PINNACLE_SPORTS);
	for (const sport of sportsToTry) {
		const ref = await findPinnacleReferenceForSport(eventName, description, leagueLabel, sport);
		if (ref) return ref;
	}
	return null;
}

// edge % = combien la cote boostée paie de plus (ou de moins) que le prix
// Pinnacle jugé "juste" -- positif veut dire meilleure valeur que le marché.
function edgeSuffix(boostDecimal, pinnacleDecimal) {
	if (!boostDecimal || !pinnacleDecimal) return '';
	const edge = (boostDecimal / pinnacleDecimal - 1) * 100;
	const sign = edge >= 0 ? '+' : '';
	return ` (${sign}${edge.toFixed(1)}% vs Pinnacle)`;
}

function formatPinnacleReference(ref, boostDecimal) {
	if (!ref) return null;
	if (ref.type === 'moneyline') {
		const { home, away, draw } = ref.moneyline;
		const parts = [];
		if (home) parts.push(`1: ${americanToDecimal(home.price).toFixed(2)}`);
		if (draw) parts.push(`N: ${americanToDecimal(draw.price).toFixed(2)}`);
		if (away) parts.push(`2: ${americanToDecimal(away.price).toFixed(2)}`);
		let line = `📊 Pinnacle (${ref.league}) : ${parts.join(' · ')}`;
		const backed = ref.backedDesignation === 'home' ? home : ref.backedDesignation === 'away' ? away : null;
		if (backed) line += edgeSuffix(boostDecimal, americanToDecimal(backed.price));
		return line;
	}
	if (ref.type === 'single') {
		// exact:false = approximation étiquetée (ex: Double Chance x Total/BTTS,
		// marché combiné inexistant chez Pinnacle -- deux marchés indépendants
		// multipliés, corrélation réelle non prise en compte, voir
		// findDoubleChanceAndTotalApprox).
		const approxTag =
			ref.exact === false
				? ref.points != null
					? ` ⚠️ ligne la plus proche disponible (${ref.points})`
					: ' ⚠️ approximatif (corrélation non prise en compte)'
				: '';
		return `📊 Pinnacle (${ref.league}) : ${ref.decimal.toFixed(2)}${approxTag}${edgeSuffix(boostDecimal, ref.decimal)}`;
	}
	if (ref.type === 'combo') {
		const breakdown = ref.legs
			.map((l) => `${l.label} : ${l.decimal.toFixed(2)}${l.exact === false && l.points != null ? ` (ligne la plus proche : ${l.points})` : ''}`)
			.join('\n');
		const product = ref.legs.map((l) => l.decimal.toFixed(2)).join(' × ');
		return `📊 Pinnacle (combo ${ref.legCount} matchs) :\n${breakdown}\n${product} = ${ref.decimal.toFixed(2)}${edgeSuffix(boostDecimal, ref.decimal)}`;
	}
	return null;
}


// Suivi perso (usage interne) : compare l'instantané précédent au nouveau et
// notifie chaque ajout / suppression / variation de cote sur un canal Telegram
// dédié -- distinct du canal abonnés, jamais le même volume.
function diffBoosts(prevBoosts, currentBoosts) {
	const prevByMarket = new Map(prevBoosts.map((b) => [b.marketId, b]));
	const currentByMarket = new Map(currentBoosts.map((b) => [b.marketId, b]));
	const events = [];

	for (const [marketId, b] of currentByMarket) {
		const prevB = prevByMarket.get(marketId);
		if (!prevB) {
			events.push({ type: 'add', boost: b });
		} else if (prevB.newOdds !== b.newOdds) {
			events.push({ type: 'change', boost: b, prevOdds: prevB.newOdds });
		}
	}
	for (const [marketId, b] of prevByMarket) {
		if (!currentByMarket.has(marketId)) {
			events.push({ type: 'remove', boost: b });
		}
	}
	return events;
}

function buildMonitoringBodyLines(type, boost, prevOdds) {
	const icon = type === 'add' ? '➕' : type === 'remove' ? '➖' : '🔄';
	const label = type === 'add' ? 'Nouvelle cote' : type === 'remove' ? 'Cote retirée' : 'Cote modifiée';
	const lines = [`${icon} ${label} — WINAMAX`, ``, `${boost.sportEmoji} ${boost.eventName}`, boost.description];
	if (type === 'change') {
		lines.push(``, `Cote : ${prevOdds} → ${boost.newOdds}`);
	} else {
		lines.push(``, `Cote : ${boost.oldOdds} → ${boost.newOdds}`);
	}
	lines.push(`Mise max : ${boost.maxStake}€`);
	if (boost.kickoff) lines.push(`Disponible jusqu'à ${boost.kickoff}`);
	return lines;
}

// Reconstruit le texte complet d'un message "Nouvelle cote" avec une ligne
// Pinnacle à jour -- utilisé à la fois au premier envoi et lors d'une
// réédition (voir refreshTrackedPinnacleRefs).
function rebuildAddMessageText(boost, refLine) {
	const lines = buildMonitoringBodyLines('add', boost);
	if (refLine) lines.push(``, refLine);
	return lines.join('\n');
}

async function formatMonitoringMessage(env, event) {
	const { type, boost, prevOdds } = event;
	const lines = buildMonitoringBodyLines(type, boost, prevOdds);

	// Référence Pinnacle : uniquement pour les nouvelles cotes, uniquement si un
	// pari équivalent (victoire simple / total buts) existe sur une grande ligue.
	let refLine = null;
	let edge = null;
	if (type === 'add') {
		let havePinnacle = false;
		let havePiwi = false;
		let haveMatchbook = false;
		try {
			const ref = await findPinnacleReference(boost.eventName, boost.description, boost.league, boost.sport);
			const boostDecimal = parseFrenchDecimal(boost.newOdds);
			const pinnacleDecimal = refComparableDecimal(ref);
			edge = boostDecimal && pinnacleDecimal ? (boostDecimal / pinnacleDecimal - 1) * 100 : null;
			refLine = formatPinnacleReference(ref, boostDecimal);
			if (refLine) {
				lines.push(``, refLine);
				havePinnacle = true;
			}
		} catch {
			// silencieux : pas de reference dispo ne doit jamais bloquer l'alerte
		}
		// Référence exchange (Piwi247/Betfair) en complément de Pinnacle, usage
		// perso uniquement -- jamais republiée aux abonnés (canal monitoring
		// privé seulement). Réutilise les mêmes legs que Pinnacle (parseLegs)
		// pour cibler le marché EXACT du boost, pas juste le 1X2. Ne doit
		// jamais bloquer l'alerte non plus. Les combos schedule-based
		// (scheduleBtts/scheduleTotal) n'ont pas de nom d'équipe dans
		// eventName ("Ligue des Champions") -- routées séparément, sans
		// dépendre de splitTeams.
		let legs = null;
		let teams = null;
		try {
			legs = parseLegs(boost.eventName, boost.description, boost.sport);
			const isSchedule = legs?.length === 1 && ['scheduleBtts', 'scheduleTotal', 'scheduleHomeWin', 'scheduleHomeTeamTotal'].includes(legs[0].type);
			let piwiRef = null;
			if (isSchedule) {
				piwiRef = await findPiwiScheduleReference(legs[0]);
			} else {
				teams = splitTeams(boost.eventName);
				if (teams) piwiRef = await findPiwiReference(legs, teams[0], teams[1]);
			}
			const piwiLine = formatPiwiReference(piwiRef);
			if (piwiLine) {
				lines.push(piwiLine);
				havePiwi = true;
			}
		} catch {
			// silencieux
		}
		// Référence exchange Matchbook, même principe que Piwi juste au-dessus
		// (usage perso, jamais republiée aux abonnés) -- deuxième source
		// indépendante, utile pour comparer/prendre la cote la plus haute.
		try {
			const isSchedule = legs?.length === 1 && ['scheduleBtts', 'scheduleTotal', 'scheduleHomeWin', 'scheduleHomeTeamTotal'].includes(legs[0].type);
			let matchbookRef = null;
			if (isSchedule) {
				matchbookRef = await findMatchbookScheduleReference(legs[0]);
			} else {
				teams = teams || splitTeams(boost.eventName);
				if (teams) matchbookRef = await findMatchbookReference(legs, teams[0], teams[1]);
			}
			const matchbookLine = formatMatchbookReference(matchbookRef);
			if (matchbookLine) {
				lines.push(matchbookLine);
				haveMatchbook = true;
			}
		} catch {
			// silencieux
		}
		// Oddsportal en DERNIER recours seulement -- coûte un Browser Rendering,
		// donc appelé uniquement quand aucune des 3 autres sources n'a rien
		// trouvé pour ce marché (demande explicite de l'utilisatrice : ne pas
		// l'afficher systématiquement, seulement en complément).
		if (!havePinnacle && !havePiwi && !haveMatchbook && legs?.length === 1 && teams) {
			try {
				const oddsportalRef = await findOddsportalReference(env, legs[0], teams[0], teams[1]);
				const oddsportalLine = formatOddsportalReference(oddsportalRef);
				if (oddsportalLine) lines.push(oddsportalLine);
			} catch {
				// silencieux
			}
		}
	}

	return { text: lines.join('\n'), refLine, edge };
}

const PIN_TRACK_TTL_SECONDS = SEEN_TTL_SECONDS; // même durée de vie qu'un boost "vu"

async function postMonitoringDiff(env, prevBoosts, currentBoosts) {
	if (!env.MONITORING_CHAT_ID) {
		console.log('postMonitoringDiff: MONITORING_CHAT_ID not set, skipping');
		return;
	}
	if (!prevBoosts) {
		console.log('postMonitoringDiff: no prevBoosts (first run since snapshot expired), skipping diff');
		return;
	}
	const events = diffBoosts(prevBoosts, currentBoosts);
	console.log(`postMonitoringDiff: prev=${prevBoosts.length} current=${currentBoosts.length} events=${events.length}`);
	for (const event of events) {
		try {
			if (event.type === 'remove') {
				// Pas d'alerte pour les cotes retirées (demande explicite de
				// l'utilisatrice, pas utile) -- juste le ménage KV, silencieux.
				await env.SEEN_BOOSTS.delete(`pintrack:${event.boost.marketId}`);
				continue;
			}
			const { text, refLine, edge } = await formatMonitoringMessage(env, event);
			const sent = await sendToChat(env, env.MONITORING_CHAT_ID, text);

			if (event.type === 'add') {
				if (refLine && sent?.message_id) {
					await env.SEEN_BOOSTS.put(
						`pintrack:${event.boost.marketId}`,
						JSON.stringify({ chatId: env.MONITORING_CHAT_ID, messageId: sent.message_id, boost: event.boost, lastRefLine: refLine }),
						{ expirationTtl: PIN_TRACK_TTL_SECONDS }
					);
				}
				// Digest quotidien : toutes les cotes "classiques" suivies en
				// monitoring, pas seulement le sous-ensemble flash (≤10€, dispo
				// quelques minutes) qui part sur le canal public.
				try {
					await logDigestItem(env, event.boost, edge);
				} catch {
					// silencieux : le digest est une info secondaire
				}
			}
		} catch (e) {
			console.log('postMonitoringDiff: sendToChat failed:', String(e));
			await logError(env, 'postMonitoringDiff', String(e));
		}
		await new Promise((r) => setTimeout(r, 350)); // évite le flood control Telegram
	}
}

// Revérifie périodiquement les cotes Pinnacle déjà affichées et édite le
// message Telegram d'origine si la cote a bougé -- Pinnacle réajuste ses prix
// en continu jusqu'au coup d'envoi, contrairement au boost Unibet/Winamax lui-
// même qui reste fixe une fois publié.
async function refreshTrackedPinnacleRefs(env) {
	if (!env.MONITORING_CHAT_ID) return;
	const list = await env.SEEN_BOOSTS.list({ prefix: 'pintrack:' });
	for (const key of list.keys) {
		const raw = await env.SEEN_BOOSTS.get(key.name);
		if (!raw) continue;
		const tracked = JSON.parse(raw);
		try {
			const ref = await findPinnacleReference(
				tracked.boost.eventName,
				tracked.boost.description,
				tracked.boost.league,
				tracked.boost.sport
			);
			const newRefLine = formatPinnacleReference(ref, parseFrenchDecimal(tracked.boost.newOdds));
			if (!newRefLine || newRefLine === tracked.lastRefLine) continue;

			await editMessageText(env, tracked.chatId, tracked.messageId, rebuildAddMessageText(tracked.boost, newRefLine));
			tracked.lastRefLine = newRefLine;
			await env.SEEN_BOOSTS.put(key.name, JSON.stringify(tracked), { expirationTtl: PIN_TRACK_TTL_SECONDS });
		} catch (e) {
			console.log('refreshTrackedPinnacleRefs failed for', key.name, ':', String(e));
		}
	}
}

async function fetchPreloadedState(env) {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		);
		// domcontentloaded + polling ensuite (au lieu de networkidle2) : plus rapide
		// et plus robuste si Cloudflare Browser Rendering est ralenti/soft-bloqué par
		// Winamax. 15s (au lieu de 10s) : sur le plan payant le coût d'un check plus
		// long est négligeable, alors qu'un timeout trop serré faisait échouer des
		// checks entiers (et donc rater des diffs de monitoring) quand Cloudflare
		// mettait un peu plus de temps que la moyenne à charger la page.
		await page.goto(WINAMAX_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
		// Sonde au lieu d'attendre systématiquement 4s : dès que Socket.IO a poussé
		// des cotes dans PRELOADED_STATE (ou après 4s max), on continue -- économise
		// du temps de navigateur (quota gratuit limité) sans perdre en fiabilité.
		for (let i = 0; i < 8; i++) {
			const hasMatches = await page.evaluate(
				() => Object.keys(window.PRELOADED_STATE?.matches || {}).length > 0
			);
			if (hasMatches) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		return await page.evaluate(() => window.PRELOADED_STATE || null);
	} finally {
		await browser.close();
	}
}

// Compare la structure de deux legs parsés (même type, même(s) équipe(s), même
// seuil) -- pas juste le texte brut, qui diffère souvent entre bookmakers pour
// un marché identique. Le sport passé à parseLegs ne sert qu'à activer le
// parsing (il n'influence pas la structure retournée), donc on peut comparer
// sans connaître le vrai sport des deux côtés.
function legsEquivalent(legsA, legsB) {
	if (!legsA || !legsB || legsA.length !== legsB.length) return false;
	return legsA.every((a, i) => {
		const b = legsB[i];
		if (a.type !== b.type) return false;
		if (a.type === 'moneyline' || a.type === 'total') {
			return teamsMatch(a.teamA, b.teamA) && teamsMatch(a.teamB, b.teamB) && a.side === b.side && a.points === b.points;
		}
		if (a.type === 'winAndTotal') {
			return teamsMatch(a.team, b.team) && a.side === b.side && a.points === b.points;
		}
		if (a.type === 'margin') {
			return teamsMatch(a.team, b.team) && a.margin === b.margin;
		}
		if (a.type === 'correctScore') {
			return teamsMatch(a.team, b.team) && JSON.stringify(a.scoreLines) === JSON.stringify(b.scoreLines);
		}
		return false;
	});
}

// Le même match/marché peut être boosté chez Unibet ET Winamax en même temps
// -- utile de le savoir pour prendre la meilleure cote des deux. Ne tourne que
// côté Winamax (pas besoin de le faire des deux côtés, ça doublonnerait
// l'alerte) : va chercher le /current public d'Unibet (fetch simple, pas de
// Browser Rendering) et compare structurellement.
async function detectDuplicates(env, myBoosts) {
	if (!env.MONITORING_CHAT_ID) return;
	let otherBoosts;
	try {
		const res = await fetch('https://unibet-flash-boost.jc-hd-affiliation.workers.dev/current');
		if (!res.ok) return;
		otherBoosts = (await res.json()).boosts || [];
	} catch {
		return;
	}

	for (const mine of myBoosts) {
		const myLegs = parseLegs(mine.eventName, mine.description, 'football'); // sport bidon, juste pour activer le parsing
		if (!myLegs) continue;
		for (const other of otherBoosts) {
			const otherLegs = parseLegs(other.eventName, other.description, 'football');
			if (!otherLegs || !legsEquivalent(myLegs, otherLegs)) continue;

			const pairKey = [mine.marketId, other.marketId].sort().join('|');
			const dupKey = `dup:${pairKey}`;
			if (await env.SEEN_BOOSTS.get(dupKey)) continue;

			const mineDecimal = parseFrenchDecimal(mine.newOdds);
			const otherDecimal = parseFrenchDecimal(other.newOdds);
			const better = mineDecimal != null && otherDecimal != null && mineDecimal >= otherDecimal ? 'WINAMAX' : 'UNIBET';
			const text = [
				`🔀 Doublon détecté entre bookmakers`,
				``,
				mine.eventName,
				`WINAMAX : ${mine.description} — ${mine.newOdds}`,
				`UNIBET : ${other.description} — ${other.newOdds}`,
				``,
				`Meilleure valeur : ${better}`,
			].join('\n');
			try {
				await sendToChat(env, env.MONITORING_CHAT_ID, text);
			} catch (e) {
				console.log('detectDuplicates: send failed:', String(e));
			}
			await env.SEEN_BOOSTS.put(dupKey, '1', { expirationTtl: SEEN_TTL_SECONDS });
		}
	}
}

// Rattrapage ponctuel (déclenché à la main via /backfill-pinnacle quand
// besoin -- pas un cron permanent) : applique la logique Pinnacle actuelle
// aux cotes déjà actives, édite le message existant si déjà suivi.
async function backfillPinnacleRefs(env) {
	if (!env.MONITORING_CHAT_ID) return { checked: 0, updated: 0, sent: 0 };
	const raw = await env.SEEN_BOOSTS.get('current_snapshot');
	const boosts = raw ? JSON.parse(raw).boosts : [];
	let updated = 0;
	let sent = 0;
	for (const boost of boosts) {
		const trackKey = `pintrack:${boost.marketId}`;
		try {
			const ref = await findPinnacleReference(boost.eventName, boost.description, boost.league, boost.sport);
			const pinnacleLine = formatPinnacleReference(ref, parseFrenchDecimal(boost.newOdds));
			let piwiLine = null;
			let matchbookLine = null;
			try {
				const legs = parseLegs(boost.eventName, boost.description, boost.sport);
				const isSchedule = legs?.length === 1 && ['scheduleBtts', 'scheduleTotal', 'scheduleHomeWin', 'scheduleHomeTeamTotal'].includes(legs[0].type);
				if (isSchedule) {
					piwiLine = formatPiwiReference(await findPiwiScheduleReference(legs[0]));
					matchbookLine = formatMatchbookReference(await findMatchbookScheduleReference(legs[0]));
				} else {
					const teams = splitTeams(boost.eventName);
					if (teams) {
						piwiLine = formatPiwiReference(await findPiwiReference(legs, teams[0], teams[1]));
						matchbookLine = formatMatchbookReference(await findMatchbookReference(legs, teams[0], teams[1]));
					}
				}
			} catch {
				// silencieux
			}
			const refLine = [pinnacleLine, piwiLine, matchbookLine].filter(Boolean).join('\n');
			if (!refLine) continue;

			const existingRaw = await env.SEEN_BOOSTS.get(trackKey);
			if (existingRaw) {
				const tracked = JSON.parse(existingRaw);
				if (refLine !== tracked.lastRefLine) {
					await editMessageText(env, tracked.chatId, tracked.messageId, rebuildAddMessageText(boost, refLine));
					tracked.lastRefLine = refLine;
					tracked.boost = boost;
					await env.SEEN_BOOSTS.put(trackKey, JSON.stringify(tracked), { expirationTtl: PIN_TRACK_TTL_SECONDS });
					updated++;
				}
			} else {
				const text = `📊 Référence Pinnacle (rattrapage) — ${boost.sportEmoji} ${boost.eventName}\n${boost.description}\n\n${refLine}`;
				const sentMsg = await sendToChat(env, env.MONITORING_CHAT_ID, text);
				if (sentMsg?.message_id) {
					await env.SEEN_BOOSTS.put(
						trackKey,
						JSON.stringify({ chatId: env.MONITORING_CHAT_ID, messageId: sentMsg.message_id, boost, lastRefLine: refLine }),
						{ expirationTtl: PIN_TRACK_TTL_SECONDS }
					);
				}
				sent++;
			}
		} catch (e) {
			console.log('backfillPinnacleRefs failed for', boost.marketId, ':', String(e));
		}
		await new Promise((r) => setTimeout(r, 350));
	}
	return { checked: boosts.length, updated, sent };
}

// --- Piwi247 (Betfair Exchange en marque blanche) : référence exchange en
// complément de Pinnacle, usage strictement personnel (jamais republié aux
// abonnés). Contrairement à Pinnacle, les cotes live passent uniquement par
// un WebSocket (pas de REST), avec un mini-protocole SockJS custom -- reverse
// engineered en capturant le trafic réel du site (pas de documentation
// publique). Aucune authentification requise, vérifié en direct.
const PIWI_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	Origin: 'https://www.piwi247.com',
	Referer: 'https://www.piwi247.com/',
};

function randomPiwiSocketPath() {
	const serverId = String(Math.floor(Math.random() * 900) + 100);
	const sessionId = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	return `${serverId}/${sessionId}`;
}

// Ouvre le WebSocket "multiple-market-prices", s'abonne au marché demandé, et
// renvoie le premier instantané de prix reçu (contient déjà les cotes back/lay
// courantes -- pas besoin d'attendre une mise à jour). Ferme la connexion
// aussitôt après : usage ponctuel de référence, pas un flux permanent.
async function fetchPiwiMarketPrices(marketId, eventId) {
	const url = `https://exch.piwi247.com/customer/ws/multiple-market-prices/${randomPiwiSocketPath()}/websocket`;
	let res;
	try {
		res = await fetch(url, { headers: { ...PIWI_HEADERS, Upgrade: 'websocket' } });
	} catch (e) {
		console.log('fetchPiwiMarketPrices: fetch failed', String(e));
		return null;
	}
	const ws = res.webSocket;
	if (!ws) {
		console.log('fetchPiwiMarketPrices: no webSocket on response, status', res.status);
		return null;
	}
	ws.accept();

	return new Promise((resolve) => {
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(() => finish(null), 8000);

		ws.addEventListener('message', (evt) => {
			const data = typeof evt.data === 'string' ? evt.data : '';
			if (data === 'o') {
				ws.send(JSON.stringify([JSON.stringify([{ applicationType: 'WEB' }])]));
				ws.send(JSON.stringify([JSON.stringify([{ marketId, eventId, applicationType: 'WEB' }])]));
				return;
			}
			if (data.startsWith('a[')) {
				try {
					const outer = JSON.parse(data.slice(1));
					const inner = JSON.parse(outer[0]);
					finish(inner);
				} catch (e) {
					console.log('fetchPiwiMarketPrices: parse error', String(e));
					finish(null);
				}
			}
		});
		ws.addEventListener('close', () => finish(null));
		ws.addEventListener('error', () => finish(null));
	});
}

// Découverte d'un événement Piwi par noms d'équipe -- limitée pour l'instant
// à /customer/api/popular (grands événements du moment). La recherche
// complète (toutes compétitions, tous horaires) exige un jeton x-csrf-token
// sur l'endpoint POST correspondant, pas encore reverse-engineered -- si le
// match n'y figure pas, silencieux comme pour tout marché introuvable.
// Retourne la liste des marchés disponibles pour l'événement (id + nom),
// vérifiée en direct sur plusieurs vrais matchs : Match Odds, Goal Lines,
// Correct Score, Double Chance, Draw no Bet, Total Goals Odd/Even, Half
// Time/Full Time, {Équipe} Win to Nil, Both teams to Score?, Player To
// Score, Match Odds and Over/Under 2.5 Goals, etc. -- le catalogue varie
// d'un match à l'autre (comme les "team props" Pinnacle, certains marchés
// n'apparaissent que près du coup d'envoi).
// Compétitions Piwi connues -- /customer/api/competition/{id} donne le
// calendrier COMPLET (tous les matchs à venir, pas juste les gros) sans
// jeton CSRF, contrairement à l'endpoint de recherche générale (POST
// /customer/api/sport/details/extra-time, protégé par x-csrf-token non
// reverse-engineered malgré plusieurs tentatives). Liste volontairement
// partielle -- à enrichir au fil des vraies cotes rencontrées.
// Compétitions Piwi connues, par sport -- calendrier complet sans jeton CSRF
// (voir plus haut pourquoi la recherche générale n'est pas accessible).
// Foot vérifié en profondeur ; basket et MMA juste amorcés (une ligue
// chacun) -- à enrichir dès qu'une vraie cote d'un autre championnat/sport
// ne trouve rien.
const PIWI_COMPETITIONS_BY_SPORT = {
	football: [
		'117', // Spain - La Liga
		'10932509', // England - Premier League
		'81', // Italy - Serie A
		'59', // Germany - Bundesliga
		'61', // Germany - Bundesliga 2
		'55', // France - Ligue 1
		'57', // France - Ligue 2
		'7129730', // England - Championship
		'228', // UEFA Champions League
		'9404054', // Netherlands - Eredivisie
		'194215', // Turkey - Super League
		'5627174', // Mexico - Liga MX
		'340643', // England - Community Shield (one-off cup final, retrouvé via Betfair)
	],
	basketball: [
		'11295025', // WNBA
		'10547864', // NBA
	],
	mma: [
		'10581356', // UFC Matches
	],
	baseball: [
		'11196870', // MLB
	],
	hockey: [
		'12550521', // NHL
	],
	// Tennis : contrairement au foot, un ID par TOURNOI (pas un championnat
	// saisonnier) -- change chaque semaine, à mettre à jour plus souvent que
	// les autres sports, ET séparément par circuit ATP/WTA (tournois distincts
	// même quand joués la même semaine dans la même ville). Actuel au
	// 2026-08-16.
	tennis: [
		'12822480', // ATP Cincinnati OH 2026 -- retrouvé via l'événement A.Zverev v Norrie
		'12822537', // WTA Cincinnati 2026 -- retrouvé via l'événement Boisson v Bencic
	],
};

// Noms de marchés Piwi pour moneyline/total -- diffèrent par sport ("Match
// Odds"/"Goal Lines" en foot, "Moneyline"/"Total Points" en basket, "Fight
// Result" en MMA (pas de "total"), "Total Runs" en baseball, "Total Goals"
// en hockey. Vérifié en direct pour chaque sport avant d'écrire quoi que ce
// soit. Hockey a aussi un "60 Minute 3 Way Match Odds" (avec match nul après
// 60 min) non câblé -- "Moneyline" (vainqueur final, prolongation/tirs au
// but inclus) correspond mieux à "TeamX gagne" simple.
const PIWI_MARKET_NAMES = {
	football: { moneyline: 'Match Odds', total: 'Goal Lines' },
	basketball: { moneyline: 'Moneyline', total: 'Total Points' },
	mma: { moneyline: 'Fight Result' },
	baseball: { moneyline: 'Moneyline', total: 'Total Runs' },
	hockey: { moneyline: 'Moneyline', total: 'Total Goals' },
	// Vérifié en direct sur A.Zverev v Norrie (ATP Cincinnati) : "Match Odds"
	// confirmé, plus "Total Games" (buts/points -> jeux pour le tennis).
	tennis: { moneyline: 'Match Odds', total: 'Total Games' },
};

// Le séparateur entre les deux participants dans le nom d'événement Piwi
// varie par sport : " v " en foot/MMA, " @ " en basket (away @ home).
const PIWI_EVENT_SEPARATORS = [' v ', ' @ '];

function findEventInList(list, teamA, teamB) {
	return (list || []).find((c) => {
		if (c.type !== 'EVENT') return false;
		const sep = PIWI_EVENT_SEPARATORS.find((s) => c.name?.includes(s));
		if (!sep) return false;
		const [n1, n2] = c.name.split(sep);
		return (teamsMatch(n1, teamA) && teamsMatch(n2, teamB)) || (teamsMatch(n1, teamB) && teamsMatch(n2, teamA));
	});
}

// Cherche l'eventId par noms d'équipe : d'abord dans les compétitions
// connues DU SPORT concerné (calendrier complet), puis en repli sur
// /customer/api/popular (grands événements du moment, tous sports
// confondus -- peut être vide en heures creuses, aucune couverture garantie
// hors grosses affiches).
async function findPiwiEventId(teamA, teamB, sport) {
	for (const compId of PIWI_COMPETITIONS_BY_SPORT[sport] || []) {
		try {
			const res = await fetch(`https://exch.piwi247.com/customer/api/competition/${compId}`, { headers: PIWI_HEADERS });
			if (!res.ok) continue;
			const detail = await res.json();
			const found = findEventInList(detail.children, teamA, teamB);
			if (found) return found.id;
		} catch {
			// essaie la compétition connue suivante
		}
	}
	try {
		const res = await fetch('https://exch.piwi247.com/customer/api/popular', { headers: PIWI_HEADERS });
		if (res.ok) {
			const found = findEventInList(await res.json(), teamA, teamB);
			if (found) return found.id;
		}
	} catch {
		// silencieux
	}
	return null;
}

async function findPiwiEvent(teamA, teamB, sport) {
	const eventId = await findPiwiEventId(teamA, teamB, sport);
	if (!eventId) return null;
	try {
		const res = await fetch(`https://exch.piwi247.com/customer/api/event/${eventId}`, { headers: PIWI_HEADERS });
		if (!res.ok) return null;
		const detail = await res.json();
		const markets = (detail.children || []).filter((c) => c.type === 'MARKET').map((c) => ({ id: c.id, name: c.name }));
		return { eventId, markets };
	} catch {
		return null;
	}
}

function piwiMarketId(piwiEvent, name) {
	return piwiEvent.markets.find((m) => m.name === name)?.id || null;
}

// Certains marchés portent le nom de l'équipe DANS le nom du marché lui-même
// (ex: "SE Palmeiras Win to Nil") -- le nom Piwi peut différer en orthographe
// du nôtre, donc comparaison via teamsMatch sur le préfixe plutôt qu'une
// égalité stricte, même logique que findWinToNil côté Pinnacle.
function piwiMarketIdForTeamSuffix(piwiEvent, suffix, teamName) {
	const m = piwiEvent.markets.find((mk) => mk.name.endsWith(suffix) && teamsMatch(mk.name.slice(0, mk.name.length - suffix.length), teamName));
	return m ? m.id : null;
}

// homeTeam/awayTeam ne sont donnés que par le détail d'un marché précis (pas
// par la liste d'événements) -- récupérés une fois via Match Odds, réutilisés
// pour tous les marchés qui dépendent de l'ordre home/away (Correct Score,
// Double Chance).
async function piwiHomeAway(piwiEvent, sport = 'football') {
	const mid = piwiMarketId(piwiEvent, PIWI_MARKET_NAMES[sport]?.moneyline || 'Match Odds');
	if (!mid) return null;
	try {
		const res = await fetch(`https://exch.piwi247.com/customer/api/market/${mid}`, { headers: PIWI_HEADERS });
		if (!res.ok) return null;
		const detail = await res.json();
		return { home: detail.event?.homeTeam, away: detail.event?.awayTeam };
	} catch {
		return null;
	}
}

// Combine REST (noms + handicap éventuel des participants) + WebSocket (prix
// live back) pour UN marché Piwi donné. runnerPredicate filtre les
// participants voulus -- peut en retourner plusieurs (ex: pour sommer un
// Correct Score, comme findCorrectScoreSum côté Pinnacle).
async function fetchPiwiSelections(marketId, eventId, runnerPredicate) {
	let runners;
	try {
		const res = await fetch(`https://exch.piwi247.com/customer/api/market/${marketId}`, { headers: PIWI_HEADERS });
		if (!res.ok) return null;
		const detail = await res.json();
		runners = (detail.runners || []).filter((r) => runnerPredicate(r.runnerName, r.handicap));
		if (!runners.length) return null;
	} catch {
		return null;
	}
	const prices = await fetchPiwiMarketPrices(marketId, eventId);
	if (!prices?.rc?.length) return null;
	const out = [];
	for (const r of runners) {
		// "Pas de handicap" vaut 0.0 côté REST mais null côté WebSocket pour les
		// marchés simples (Match Odds, Draw no Bet...) -- !r.handicap traite les
		// deux comme équivalents (0 est falsy), la comparaison stricte ne
		// s'applique que pour un VRAI handicap non nul (ex: Goal Lines à 2.5).
		const rc = prices.rc.find((x) => x.id === r.selectionId && (!r.handicap || x.hc === r.handicap));
		const back = rc?.bdatb?.[0]?.odds;
		if (back) out.push({ name: r.runnerName, handicap: r.handicap, back });
	}
	return out.length ? out : null;
}

// Résout UNE leg déjà analysée (même structure que resolveLeg côté Pinnacle,
// voir parseLegs) contre le marché Piwi équivalent. Portée actuelle : foot
// uniquement (structure de marché vérifiée en direct pour ce sport), un seul
// match à la fois -- pas les combos multi-matchs, Piwi n'a pas d'équivalent
// direct à ça. Types SANS équivalent Piwi trouvé (marge de victoire, pair/
// impair par équipe, buts exacts, premier buteur équipe, combos Pair/Impair
// +Total et BTTS+Total) : silencieux, Pinnacle reste la seule référence pour
// ceux-là -- pas d'approximation inventée.
async function resolvePiwiLeg(leg, piwiEvent, homeAway) {
	const mk = (name) => piwiMarketId(piwiEvent, name);
	const isHome = (team) => homeAway && teamsMatch(homeAway.home, team);

	if (leg.type === 'moneyline') {
		// Nom du marché variable selon le sport : "Match Odds" (foot),
		// "Moneyline" (basket), "Fight Result" (MMA, 2 côtés seulement).
		const mid = mk(PIWI_MARKET_NAMES[leg.sport]?.moneyline);
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, () => true);
		if (!sels) return null;
		const backed = leg.team ? sels.find((s) => teamsMatch(s.name, leg.team)) : null;
		return { decimal: backed ? backed.back : null, all: sels };
	}
	if (leg.type === 'total' && (leg.period || 0) === 0) {
		// "Goal Lines" (foot) / "Total Points" (basket) -- même structure
		// consolidée multi-lignes dans les deux cas.
		const mid = mk(PIWI_MARKET_NAMES[leg.sport]?.total);
		if (!mid) return null;
		// runnerName inclut le chiffre ("Over 2.5", pas juste "Over") -- on ne
		// s'appuie que sur le préfixe + le handicap exact, pas une égalité
		// stricte sur le nom complet (fragile au formatage du nombre).
		const prefix = leg.side === 'over' ? 'Over' : 'Under';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name, hc) => name?.startsWith(prefix) && hc === leg.points);
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'total' && leg.period === 1) {
		// "First Half Goals N" est un marché SÉPARÉ par ligne (pas consolidé
		// comme Goal Lines) -- même structure que Cards/Corners Over/Under.
		const mid = mk(`First Half Goals ${leg.points}`);
		if (!mid) return null;
		const prefix = leg.side === 'over' ? 'Over' : 'Under';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name?.startsWith(prefix));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'winAndTotal') {
		// N'importe quelle ligne, pas seulement 2.5 -- le nom du marché
		// l'embarque directement ("Match Odds and Over/Under 3.5 Goals"),
		// silencieux si Piwi n'a pas cette ligne précise pour ce match.
		const mid = mk(`Match Odds and Over/Under ${leg.points} Goals`);
		if (!mid) return null;
		const cond = leg.side === 'over' ? `Over ${leg.points} Goals` : `Under ${leg.points} Goals`;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => {
			const idx = name.lastIndexOf('/');
			if (idx === -1) return false;
			return name.slice(idx + 1) === cond && teamsMatch(name.slice(0, idx), leg.team);
		});
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'winAndBtts') {
		// Marché "Match Odds and Both teams to Score" -- participants nommés
		// "{Équipe}/Yes" ou "{Équipe}/No" (et "Draw/Yes", "Draw/No").
		const mid = mk('Match Odds and Both teams to Score');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => {
			const idx = name?.lastIndexOf('/');
			if (idx == null || idx === -1) return false;
			return name.slice(idx + 1) === 'Yes' && teamsMatch(name.slice(0, idx), leg.team);
		});
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'teamTotal') {
		// Marché "{Équipe} Over/Under N Goals" -- nom du marché lui-même
		// contient l'équipe, recherche floue via piwiMarketIdForTeamSuffix
		// (même logique que Win to Nil).
		const mid = piwiMarketIdForTeamSuffix(piwiEvent, ` Over/Under ${leg.points} Goals`, leg.team);
		if (!mid) return null;
		const prefix = leg.side === 'over' ? 'Over' : 'Under';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name?.startsWith(prefix));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'bothTeamTotal') {
		const a = await resolvePiwiLeg({ type: 'teamTotal', team: leg.teamA, side: 'over', points: leg.points }, piwiEvent, homeAway);
		const b = await resolvePiwiLeg({ type: 'teamTotal', team: leg.teamB, side: 'over', points: leg.points }, piwiEvent, homeAway);
		if (!a?.decimal || !b?.decimal) return null;
		return { decimal: 1 / ((1 / a.decimal) * (1 / b.decimal)) };
	}
	if (leg.type === 'cardsTotal') {
		const mid = mk(`Cards Over/Under ${leg.points}`);
		if (!mid) return null;
		const prefix = leg.side === 'over' ? 'Over' : 'Under';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name?.startsWith(prefix));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'cornersTotal') {
		const mid = mk(`Corners Over/Under ${leg.points}`);
		if (!mid) return null;
		const prefix = leg.side === 'over' ? 'Over' : 'Under';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name?.startsWith(prefix));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'penaltyTaken') {
		const mid = mk('Penalty Taken?');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === 'Yes');
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'playerFirstScorer') {
		const mid = mk('Player First Goalscorer');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => teamsMatch(name, leg.player));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'playerCarded') {
		const mid = mk('Player Shown a Card');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => teamsMatch(name, leg.player));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'correctScore' && homeAway) {
		const teamIsHome = isHome(leg.team);
		const wantLines = new Set(
			leg.scoreLines.map(([teamScore, oppScore]) => (teamIsHome ? `${teamScore} - ${oppScore}` : `${oppScore} - ${teamScore}`))
		);
		// Le marché principal "Correct Score" ne couvre que les scores 0-3 de
		// chaque côté -- au-delà (ex: 4-1), le score exact bascule sur un
		// marché séparé "Correct Score 2 Home"/"Correct Score 2 Away" selon le
		// côté qui dépasse 3 buts. On cherche d'abord dans le principal, puis
		// dans les extensions pour les lignes restantes.
		const found = [];
		const remaining = new Set(wantLines);
		for (const marketName of ['Correct Score', 'Correct Score 2 Home', 'Correct Score 2 Away']) {
			if (!remaining.size) break;
			const mid = mk(marketName);
			if (!mid) continue;
			const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => remaining.has(name));
			if (sels) for (const s of sels) { found.push(s); remaining.delete(s.name); }
		}
		if (found.length !== wantLines.size) return null; // tout ou rien, comme pour Pinnacle
		const probSum = found.reduce((sum, s) => sum + 1 / s.back, 0);
		return probSum ? { decimal: 1 / probSum } : null;
	}
	if (leg.type === 'doubleChance' && homeAway) {
		const mid = mk('Double Chance');
		if (!mid) return null;
		const label = isHome(leg.team) ? 'Home or Draw' : 'Draw or Away';
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === label);
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'doubleChanceAndTotal' && homeAway) {
		// Pas de marché combiné direct chez Piwi -- approximation Double
		// Chance × Total (même principe que côté Pinnacle/Matchbook).
		const dcMid = mk('Double Chance');
		const totalMid = mk(PIWI_MARKET_NAMES[leg.sport]?.total);
		if (!dcMid || !totalMid) return null;
		const label = isHome(leg.team) ? 'Home or Draw' : 'Draw or Away';
		const dcSels = await fetchPiwiSelections(dcMid, piwiEvent.eventId, (name) => name === label);
		const prefix = leg.totalSide === 'over' ? 'Over' : 'Under';
		const totalSels = await fetchPiwiSelections(totalMid, piwiEvent.eventId, (name, hc) => name?.startsWith(prefix) && hc === leg.points);
		if (!dcSels?.[0] || !totalSels?.[0]) return null;
		return { decimal: dcSels[0].back * totalSels[0].back, exact: false };
	}
	if (leg.type === 'doubleChanceAndBtts' && homeAway) {
		const dcMid = mk('Double Chance');
		const bttsMid = mk('Both teams to Score?');
		if (!dcMid || !bttsMid) return null;
		const label = isHome(leg.team) ? 'Home or Draw' : 'Draw or Away';
		const dcSels = await fetchPiwiSelections(dcMid, piwiEvent.eventId, (name) => name === label);
		const bttsSels = await fetchPiwiSelections(bttsMid, piwiEvent.eventId, (name) => name === 'Yes');
		if (!dcSels?.[0] || !bttsSels?.[0]) return null;
		return { decimal: dcSels[0].back * bttsSels[0].back, exact: false };
	}
	if (leg.type === 'drawNoBet') {
		const mid = mk('Draw no Bet');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => teamsMatch(name, leg.team));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'oddEvenTotal') {
		const mid = mk('Total Goals Odd/Even');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === leg.label);
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'htft' && homeAway) {
		const mid = mk('Half Time/Full Time');
		if (!mid) return null;
		// Comparaison via teamsMatch (pas une égalité stricte) : leg.htOutcome/
		// ftOutcome sont NOS noms d'équipe extraits du texte Unibet/Winamax, qui
		// peuvent différer en orthographe du nom littéral Piwi.
		const outcomeMatches = (outcome, piwiSide) => (outcome === 'Draw' ? piwiSide === 'Draw' : teamsMatch(piwiSide, outcome));
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => {
			const [ht, ft] = (name || '').split('/');
			return outcomeMatches(leg.htOutcome, ht) && outcomeMatches(leg.ftOutcome, ft);
		});
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'winToNil') {
		const mid = piwiMarketIdForTeamSuffix(piwiEvent, ' Win to Nil', leg.team);
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === 'Yes');
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'setScore') {
		// Marché "Set Betting", runners "{Joueur} V-D" (ex: "Borges 2-0").
		const mid = mk('Set Betting');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => {
			const idx = (name || '').lastIndexOf(' ');
			if (idx === -1) return false;
			return name.slice(idx + 1) === leg.score && teamsMatch(name.slice(0, idx), leg.team);
		});
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'winsSet1') {
		// Marché "Set 1 Winner" -- participants = simples noms de joueurs.
		const mid = mk('Set 1 Winner');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => teamsMatch(name, leg.team));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'playerWinsASet') {
		// Marché Piwi "{Joueur} To Win A Set?" -- nommage incohérent selon le
		// joueur constaté en direct ("A Zverev To Win A Set?" a des runners
		// "Yes"/"No" bruts, "Norrie To Win A Set?" a "Norrie Yes"/"Norrie No"
		// préfixés) -- on accepte les deux formes.
		const mid = piwiMarketIdForTeamSuffix(piwiEvent, ' To Win A Set?', leg.player);
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === 'Yes' || name?.endsWith(' Yes'));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'bothWinASet') {
		// Marché Piwi direct "Number of Sets" -> "Three Sets" (le match va au
		// set décisif). On vérifie qu'il n'y a QUE 2 issues (Two/Three Sets) --
		// confirme le best-of-3, sinon silencieux (même garde-fou que côté
		// Pinnacle avec la ligne 2.5, voir findBothWinASet).
		const mid = mk('Number of Sets');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, () => true);
		if (!sels || sels.length !== 2) return null;
		const three = sels.find((s) => s.name === 'Three Sets');
		return three ? { decimal: three.back } : null;
	}
	if (leg.type === 'margin') {
		// Piwi n'a pas de marché "Winning Margin" direct comme Pinnacle -- le
		// marché "Asian Handicap" sert de SYNONYME exact : "gagne par au moins N
		// buts" = "couvre le handicap -(N-0.5)" (ex: marge >= 2 = handicap
		// -1.5). runnerName porte le nom d'équipe ET le handicap ("Racing
		// Santander -1.5") -- on isole le nom en retirant le suffixe numérique.
		const mid = mk('Asian Handicap');
		if (!mid) return null;
		const wantHandicap = -(leg.margin - 0.5);
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name, hc) => {
			if (hc !== wantHandicap) return false;
			const teamPart = (name || '').replace(/\s*[+-]\d+(?:\.\d+)?\s*$/, '').trim();
			return teamsMatch(teamPart, leg.team);
		});
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'exactMargin') {
		// P(marge = k) = P(couvre -(k-0.5)) - P(couvre -(k+0.5)), sommé sur
		// chaque k de leg.margins -- EXACT (pas une approximation), dérivé de
		// deux lignes Asian Handicap adjacentes par valeur demandée.
		const mid = mk('Asian Handicap');
		if (!mid) return null;
		const wantHcs = new Set(leg.margins.flatMap((k) => [-(k - 0.5), -(k + 0.5)]));
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name, hc) => {
			if (!wantHcs.has(hc)) return false;
			const teamPart = (name || '').replace(/\s*[+-]\d+(?:\.\d+)?\s*$/, '').trim();
			return teamsMatch(teamPart, leg.team);
		});
		if (!sels) return null;
		let prob = 0;
		for (const k of leg.margins) {
			const low = sels.find((s) => s.handicap === -(k - 0.5));
			const high = sels.find((s) => s.handicap === -(k + 0.5));
			if (!low) return null;
			prob += 1 / low.back - (high ? 1 / high.back : 0);
		}
		return prob > 0 ? { decimal: 1 / prob, exact: true } : null;
	}
	if (leg.type === 'btts') {
		const mid = mk('Both teams to Score?');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === 'Yes');
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'playerScorer') {
		// minGoals absent ou 1 -> "Player To Score" (n'importe quand) ; 2 ->
		// doublé ; 3+ -> "Hat-trick?" (marché dédié, pas une somme de lignes).
		const marketName =
			leg.minGoals >= 3 ? 'Player To Score a Hat-trick?' : leg.minGoals === 2 ? 'Player To Score 2 Goals or More' : 'Player To Score';
		const mid = mk(marketName);
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => teamsMatch(name, leg.player));
		return sels?.[0] ? { decimal: sels[0].back } : null;
	}
	if (leg.type === 'methodOfVictory') {
		// Somme de deux sélections ("{Fighter} by KO TKO or DQ" + "{Fighter} by
		// Submission") -- marché Piwi "Method of Victory", nom du combattant
		// abrégé au nom de famille dans le libellé Piwi ("Makhachev by..."), pas
		// le nom complet -- teamsMatch absorbe ça (substring).
		const mid = mk('Method of Victory');
		if (!mid) return null;
		const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => {
			const idx = name.indexOf(' by ');
			if (idx === -1) return false;
			const fighter = name.slice(0, idx);
			const method = name.slice(idx + 4);
			return teamsMatch(fighter, leg.fighter) && (method === 'KO TKO or DQ' || method === 'Submission');
		});
		if (!sels || sels.length !== 2) return null; // tout ou rien
		const probSum = sels.reduce((sum, s) => sum + 1 / s.back, 0);
		return probSum ? { decimal: 1 / probSum } : null;
	}
	if (leg.type === 'playerScorerAndWin') {
		// APPROXIMATION étiquetée : marque et gagne sont corrélés positivement
		// (un but marqué par ce joueur rend la victoire de son équipe plus
		// probable), donc multiplier les deux marchés indépendants SOUS-ESTIME
		// la vraie probabilité conjointe -- exact:false, voir formatPiwiReference.
		const scorerMid = mk('Player To Score');
		const mlMid = mk(PIWI_MARKET_NAMES[leg.sport]?.moneyline);
		if (!scorerMid || !mlMid) return null;
		const scorerSels = await fetchPiwiSelections(scorerMid, piwiEvent.eventId, (name) => teamsMatch(name, leg.player));
		const mlSels = await fetchPiwiSelections(mlMid, piwiEvent.eventId, (name) => teamsMatch(name, leg.team));
		if (!scorerSels?.[0] || !mlSels?.[0]) return null;
		return { decimal: scorerSels[0].back * mlSels[0].back, exact: false };
	}
	if (leg.type === 'playersEitherScorerAndWin') {
		// "PlayerA ou PlayerB buteur et TeamX gagne" -- combo à 2 joueurs
		// interchangeables. APPROXIMATION : P(l'un des deux marque) = 1 -
		// (1-p1)(1-p2) en traitant les deux comme indépendants (en vrai
		// légèrement corrélés, même joueurs même équipe), puis multiplié par
		// P(équipe gagne) -- même logique/étiquetage que playerScorerAndWin.
		const scorerMid = mk('Player To Score');
		const mlMid = mk(PIWI_MARKET_NAMES[leg.sport]?.moneyline);
		if (!scorerMid || !mlMid) return null;
		const scorerSels = await fetchPiwiSelections(scorerMid, piwiEvent.eventId, (name) => leg.players.some((p) => teamsMatch(name, p)));
		const mlSels = await fetchPiwiSelections(mlMid, piwiEvent.eventId, (name) => teamsMatch(name, leg.team));
		if (!scorerSels || scorerSels.length !== 2 || !mlSels?.[0]) return null;
		const noneScoreProb = scorerSels.reduce((prod, s) => prod * (1 - 1 / s.back), 1);
		const combinedProb = (1 - noneScoreProb) * (1 / mlSels[0].back);
		return combinedProb ? { decimal: 1 / combinedProb, exact: false } : null;
	}
	if (leg.type === 'playersAllScore') {
		// "PlayerA et PlayerB buteurs" -- AND, pas de condition de victoire.
		// APPROXIMATION : P(les deux marquent) = P(A marque) × P(B marque),
		// traités comme indépendants -- voir son commentaire dans parseLegs.
		const scorerMid = mk('Player To Score');
		if (!scorerMid) return null;
		const sels = await Promise.all(
			leg.players.map((p) => fetchPiwiSelections(scorerMid, piwiEvent.eventId, (name) => teamsMatch(name, p)))
		);
		if (sels.some((s) => !s?.[0])) return null;
		const combinedProb = sels.reduce((prod, s) => prod * (1 / s[0].back), 1);
		return combinedProb ? { decimal: 1 / combinedProb, exact: false } : null;
	}
	return null;
}

// Point d'entrée : résout la/les legs déjà analysées pour la CB (mêmes legs
// que Pinnacle, voir parseLegs) contre les marchés Piwi. Un seul match à la
// fois -- si `legs` vient d'un combo multi-matchs, silencieux (Piwi n'a pas
// de marché combiné multi-événements). Retourne le prix "juste" pour LA
// condition exacte du boost, pas les 3 côtés du 1X2 (sauf pour un moneyline
// simple, où les 3 restent affichés -- c'est déjà l'info utile).
async function findPiwiReference(legs, teamA, teamB) {
	if (!legs || !legs.length) return null;
	if (legs.length > 1) {
		// Combo multi-matchs à noms d'équipes explicites (PAS schedule-based --
		// voir findPiwiScheduleReference pour ça) : multiTotalMatch/
		// multiMoneylineMatch/multiTeamGoalMatch/multiSetsMatch portent déjà
		// leur propre teamA/teamB par leg (matchs différents), donc chacune se
		// résout indépendamment puis se multiplie -- matchs indépendants =
		// multiplication exacte, comme côté Pinnacle.
		const subLegs = [];
		let probProduct = 1;
		for (const leg of legs) {
			if (!PIWI_MARKET_NAMES[leg.sport] || !leg.teamA || !leg.teamB) return null;
			const piwiEvent = await findPiwiEvent(leg.teamA, leg.teamB, leg.sport);
			if (!piwiEvent) return null;
			const needsHomeAway = ['correctScore', 'doubleChance', 'htft', 'doubleChanceAndTotal', 'doubleChanceAndBtts'].includes(leg.type);
			const homeAway = needsHomeAway ? await piwiHomeAway(piwiEvent, leg.sport) : null;
			if (needsHomeAway && !homeAway) return null;
			const ref = await resolvePiwiLeg(leg, piwiEvent, homeAway);
			if (!ref?.decimal) return null;
			probProduct *= 1 / ref.decimal;
			subLegs.push({ label: `${leg.teamA} - ${leg.teamB}`, decimal: ref.decimal });
		}
		return { decimal: 1 / probProduct, exact: true, subLegs };
	}
	const leg = legs[0];
	if (leg.teamA && leg.teamA !== teamA && leg.teamB && leg.teamB !== teamB) return null; // leg d'un autre match (combo)
	// Sport pas encore exploré côté Piwi (pas de noms de marché confirmés) --
	// silencieux plutôt que de tenter une recherche à l'aveugle avec des noms
	// de marché foot qui n'existeraient pas pour ce sport.
	if (!PIWI_MARKET_NAMES[leg.sport]) return null;
	const piwiEvent = await findPiwiEvent(teamA, teamB, leg.sport);
	if (!piwiEvent) return null;
	const needsHomeAway = ['correctScore', 'doubleChance', 'htft', 'doubleChanceAndTotal', 'doubleChanceAndBtts'].includes(leg.type);
	const homeAway = needsHomeAway ? await piwiHomeAway(piwiEvent, leg.sport) : null;
	if (needsHomeAway && !homeAway) return null;
	return resolvePiwiLeg(leg, piwiEvent, homeAway);
}

// Récupère et aplatit tous les nœuds EVENT du calendrier complet d'une
// compétition Piwi (même endpoint que findPiwiEventId, mais on veut ici
// TOUS les événements avec leur startTime, pas juste celui qui matche des
// noms d'équipes).
async function fetchPiwiCompetitionEvents(competitionId) {
	try {
		const res = await fetch(`https://exch.piwi247.com/customer/api/competition/${competitionId}`, { headers: PIWI_HEADERS });
		if (!res.ok) return [];
		const data = await res.json();
		const events = [];
		const walk = (node) => {
			if (node?.type === 'EVENT') events.push(node);
			for (const c of node?.children || []) walk(c);
		};
		walk(data);
		return events;
	} catch {
		return [];
	}
}

// Équivalent Piwi de findScheduledMatchups côté Pinnacle : cherche, parmi les
// compétitions déjà trackées pour ce sport, celle où EXACTEMENT `count`
// événements démarrent aujourd'hui à hour:minute (heure de Paris). Ambigu
// (mauvais compte) -> essaie la compétition suivante plutôt que de deviner.
async function findPiwiScheduledEvents(sport, count, hour, minute) {
	const now = new Date();
	const todayParts = new Intl.DateTimeFormat('fr-FR', {
		timeZone: 'Europe/Paris',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).formatToParts(now);
	const today = `${todayParts.find((p) => p.type === 'year').value}-${todayParts.find((p) => p.type === 'month').value}-${todayParts.find((p) => p.type === 'day').value}`;

	for (const competitionId of PIWI_COMPETITIONS_BY_SPORT[sport] || []) {
		const events = await fetchPiwiCompetitionEvents(competitionId);
		const matching = events.filter((e) => {
			if (!e.startTime) return false;
			const parts = new Intl.DateTimeFormat('fr-FR', {
				timeZone: 'Europe/Paris',
				day: '2-digit',
				month: '2-digit',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23',
			}).formatToParts(new Date(e.startTime));
			const date = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'day').value}`;
			if (date !== today) return false;
			if (hour == null) return true; // "matchs du jour" -- pas d'heure précise, toute la journée
			const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
			const mi = parseInt(parts.find((p) => p.type === 'minute').value, 10);
			return h === hour && mi === minute;
		});
		if (matching.length === count) return matching;
	}
	return null;
}

// Charge les marchés (REST) d'un événement Piwi trouvé par le calendrier --
// même forme {eventId, markets} que findPiwiEvent, réutilisable telle
// quelle par piwiMarketId/fetchPiwiSelections.
async function fetchPiwiEventMarkets(eventId) {
	try {
		const res = await fetch(`https://exch.piwi247.com/customer/api/event/${eventId}`, { headers: PIWI_HEADERS });
		if (!res.ok) return null;
		const detail = await res.json();
		const markets = (detail.children || []).filter((c) => c.type === 'MARKET').map((c) => ({ id: c.id, name: c.name }));
		return { eventId, markets };
	} catch {
		return null;
	}
}

// Équivalent Piwi de findScheduleBtts/findScheduleTotal côté Pinnacle --
// combo multi-matchs sans nom d'équipe, matchs différents = indépendants,
// multiplication exacte.
async function findPiwiScheduleReference(leg) {
	if (!PIWI_MARKET_NAMES[leg.sport]) return null;
	const matching = await findPiwiScheduledEvents(leg.sport, leg.count, leg.hour, leg.minute);
	if (!matching) return null;

	const subLegs = [];
	let probProduct = 1;
	for (const e of matching) {
		const piwiEvent = await fetchPiwiEventMarkets(e.id);
		if (!piwiEvent) return null;
		let back = null;
		if (leg.type === 'scheduleBtts') {
			const mid = piwiMarketId(piwiEvent, 'Both teams to Score?');
			if (mid) {
				const sels = await fetchPiwiSelections(mid, piwiEvent.eventId, (name) => name === 'Yes');
				back = sels?.[0]?.back || null;
			}
		} else if (leg.type === 'scheduleTotal') {
			const marketName =
				leg.period === 1 ? `First Half Goals ${leg.points}` : PIWI_MARKET_NAMES[leg.sport]?.total;
			const mid = piwiMarketId(piwiEvent, marketName);
			if (mid) {
				const prefix = leg.side === 'over' ? 'Over' : 'Under';
				const sels = await fetchPiwiSelections(
					mid,
					piwiEvent.eventId,
					leg.period === 1 ? (name) => name?.startsWith(prefix) : (name, hc) => name?.startsWith(prefix) && hc === leg.points
				);
				back = sels?.[0]?.back || null;
			}
		}
		if (!back) return null;
		probProduct *= 1 / back;
		subLegs.push({ label: e.name, decimal: back });
	}
	return { decimal: 1 / probProduct, exact: true, subLegs };
}

function formatPiwiReference(piwiRef) {
	if (!piwiRef) return null;
	if (piwiRef.subLegs) {
		const breakdown = piwiRef.subLegs.map((l) => `${l.label} : ${l.decimal.toFixed(2)}`).join('\n');
		const product = piwiRef.subLegs.map((l) => l.decimal.toFixed(2)).join(' × ');
		return `♟️ Exchange (Piwi247, perso) (combo ${piwiRef.subLegs.length} matchs) :\n${breakdown}\n${product} = ${Number(piwiRef.decimal).toFixed(2)}`;
	}
	if (piwiRef.all) {
		const parts = piwiRef.all.map((r) => `${r.name} : ${Number(r.back).toFixed(2)}`);
		return `♟️ Exchange (Piwi247, perso) : ${parts.join(' · ')}`;
	}
	if (piwiRef.decimal) {
		const approxTag = piwiRef.exact === false ? ' ⚠️ approximatif (corrélation non prise en compte)' : '';
		return `♟️ Exchange (Piwi247, perso) : ${Number(piwiRef.decimal).toFixed(2)}${approxTag}`;
	}
	return null;
}

// --- Matchbook (exchange, REST public, AUCUNE authentification nécessaire
// pour lire prix/marchés -- vérifié en direct sur des matchs réels avec
// vraie profondeur de marché, ex: Elche-Barcelone). Complément à Piwi/
// Betfair : bien plus simple à interroger (REST pur, carnet d'ordres complet
// dans une seule réponse -- pas de protocole WebSocket custom comme Piwi) et
// surtout, résout le problème du tennis : Piwi exige de deviner l'ID du
// tournoi de la semaine, ici un simple filtre sport-id liste TOUS les matchs
// de tennis en cours en un seul appel, aucune compétition à chercher.
// Portée volontairement plus restreinte que Piwi pour l'instant : pas de
// props joueurs (absents des marchés exchange Matchbook, vérifié sur
// plusieurs matchs), couvre les types les plus fréquents vus sur de vraies
// cotes Unibet/Winamax cette session -- à enrichir si un vrai boost révèle
// un trou.
const MATCHBOOK_HEADERS = {
	Accept: 'application/json',
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
const MATCHBOOK_SPORT_IDS = { football: 15, tennis: 9, basketball: 4, baseball: 3, hockey: 6, mma: 126 };
// Séparateur entre participants dans le nom d'événement -- " vs " (foot,
// tennis, MMA) ou " at " (basket/baseball, away at home, même convention que
// Piwi : le participant AVANT "at" est l'extérieur, celui APRÈS est le
// domicile).
const MATCHBOOK_EVENT_SEPARATORS = [' vs ', ' at '];

let matchbookEventsCache = {};
const MATCHBOOK_CACHE_TTL_MS = 60 * 1000;
async function fetchMatchbookEvents(sport) {
	const sportId = MATCHBOOK_SPORT_IDS[sport];
	if (!sportId) return [];
	const cached = matchbookEventsCache[sport];
	if (cached && Date.now() - cached.at < MATCHBOOK_CACHE_TTL_MS) return cached.events;
	try {
		const res = await fetch(`https://api.matchbook.com/edge/rest/events?sport-ids=${sportId}&per-page=500`, {
			headers: MATCHBOOK_HEADERS,
		});
		if (!res.ok) return [];
		const data = await res.json();
		const events = data.events || [];
		matchbookEventsCache[sport] = { events, at: Date.now() };
		return events;
	} catch {
		return [];
	}
}

function findMatchbookEventInList(list, teamA, teamB) {
	for (const sep of MATCHBOOK_EVENT_SEPARATORS) {
		for (const ev of list) {
			const parts = (ev.name || '').split(sep);
			if (parts.length !== 2) continue;
			const [p1, p2] = parts.map((s) => s.trim());
			const home = sep === ' at ' ? p2 : p1;
			const away = sep === ' at ' ? p1 : p2;
			if ((teamsMatch(home, teamA) && teamsMatch(away, teamB)) || (teamsMatch(home, teamB) && teamsMatch(away, teamA))) {
				return { ...ev, home, away };
			}
		}
	}
	return null;
}

async function findMatchbookEvent(teamA, teamB, sport) {
	const list = await fetchMatchbookEvents(sport);
	return findMatchbookEventInList(list, teamA, teamB);
}

// Meilleur prix "back" disponible pour un runner -- plusieurs paliers de
// carnet d'ordres possibles, on prend le meilleur (le plus haut), pas juste
// le premier de la liste.
function matchbookBestBack(runner) {
	const backs = (runner.prices || []).filter((p) => p.side === 'back');
	if (!backs.length) return null;
	return Math.max(...backs.map((p) => Number(p['decimal-odds'] ?? p.odds)));
}

function matchbookMarket(markets, name, type) {
	return markets.find((m) => m.name === name && (!type || m['market-type'] === type));
}

// Helpers réutilisés à la fois par leur leg direct (total/btts/doubleChance)
// et par les approximations combinées (doubleChanceAndTotal/AndBtts, pas de
// marché direct chez Matchbook pour ces combos-là).
function matchbookTotalPrice(markets, side, points) {
	const m = markets.find((mk) => mk.name === 'Total' && mk['market-type'] === 'total' && mk.handicap === points);
	if (!m) return null;
	const wantName = side === 'over' ? `OVER ${points}` : `UNDER ${points}`;
	const r = m.runners.find((rr) => rr.name === wantName);
	return r ? matchbookBestBack(r) : null;
}
function matchbookBttsPrice(markets) {
	const m = matchbookMarket(markets, 'Both Teams To Score', 'both_to_score');
	if (!m) return null;
	const r = m.runners.find((rr) => rr.name === 'Yes');
	return r ? matchbookBestBack(r) : null;
}
// Prix "back" pour un handicap SIGNÉ donné (ex: -1.5) et une équipe -- le
// champ market.handicap chez Matchbook est TOUJOURS positif (une magnitude),
// le signe n'existe que dans le nom du runner ("FC Barcelona -1.5" / "Elche
// CF +1.5"), donc on construit le suffixe exact attendu directement plutôt
// que de filtrer sur le champ numérique.
function matchbookHandicapPrice(markets, wantHandicap, team) {
	const wantSuffix = `${wantHandicap < 0 ? '-' : '+'}${Math.abs(wantHandicap).toFixed(1)}`;
	for (const m of markets) {
		if (m.name !== 'Handicap' || m['market-type'] !== 'handicap') continue;
		const r = m.runners.find((rr) => {
			const name = rr.name || '';
			if (!name.endsWith(wantSuffix)) return false;
			return teamsMatch(name.slice(0, name.length - wantSuffix.length).trim(), team);
		});
		const back = r ? matchbookBestBack(r) : null;
		if (back) return back;
	}
	return null;
}

function matchbookDoubleChancePrice(markets, team) {
	const m = matchbookMarket(markets, 'Double Chance');
	if (!m) return null;
	// Runners "TeamX or Draw" / "Draw or TeamY" / "TeamX or TeamY" -- on veut
	// celui qui combine l'équipe cherchée ET "Draw", peu importe l'ordre.
	const r = m.runners.find((rr) => {
		const n = rr.name || '';
		if (!/draw/i.test(n)) return false;
		const other = n.replace(/\s*or\s*draw/i, '').replace(/draw\s*or\s*/i, '').trim();
		return teamsMatch(other, team);
	});
	return r ? matchbookBestBack(r) : null;
}

// Résout UNE leg déjà analysée (même structure que resolvePiwiLeg) contre
// les marchés Matchbook d'un événement déjà localisé. Les marchés sont déjà
// embarqués dans la réponse de /edge/rest/events (mbEvent.markets) -- PAS de
// second appel vers /events/{id}/markets, qui s'est avéré renvoyer un
// résultat vide/désynchronisé pour un événement fraîchement modifié (bug
// trouvé en vérifiant en direct : le second endpoint retournait 0 marché
// pour un ID pourtant valide et déjà garni côté liste).
function resolveMatchbookLeg(leg, mbEvent) {
	const markets = mbEvent.markets || [];
	const isHome = (team) => teamsMatch(mbEvent.home, team);
	const moneylineType = leg.sport === 'football' ? 'one_x_two' : 'money_line';
	const moneylineName = leg.sport === 'football' ? 'Match Odds' : 'Moneyline';

	if (leg.type === 'moneyline' && (leg.period || 0) === 0) {
		const m = matchbookMarket(markets, moneylineName, moneylineType);
		if (!m) return null;
		const all = m.runners.map((r) => ({ name: r.name, back: matchbookBestBack(r) })).filter((r) => r.back);
		if (!all.length) return null;
		const wanted = leg.team ? all.find((r) => teamsMatch(r.name, leg.team)) : null;
		return { decimal: wanted?.back, all };
	}
	if (leg.type === 'total' && (leg.period || 0) === 0) {
		const back = matchbookTotalPrice(markets, leg.side, leg.points);
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'total' && leg.period === 1) {
		const m = markets.find((mk) => mk.name === '1st Half Total' && mk['market-type'] === 'total' && mk.handicap === leg.points);
		if (!m) return null;
		const wantName = leg.side === 'over' ? `OVER ${leg.points}` : `UNDER ${leg.points}`;
		const r = m.runners.find((rr) => rr.name === wantName);
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'margin') {
		// Synonyme via Handicap, même logique que Piwi (Asian Handicap) :
		// "gagne par N buts ou plus" = "couvre le handicap -(N-0.5)".
		const back = matchbookHandicapPrice(markets, -(leg.margin - 0.5), leg.team);
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'exactMargin') {
		// P(marge = k) = P(couvre -(k-0.5)) - P(couvre -(k+0.5)), sommé sur
		// chaque k de leg.margins -- EXACT, dérivé de deux lignes Handicap
		// adjacentes par valeur demandée (même principe que côté Piwi).
		let prob = 0;
		for (const k of leg.margins) {
			const low = matchbookHandicapPrice(markets, -(k - 0.5), leg.team);
			const high = matchbookHandicapPrice(markets, -(k + 0.5), leg.team);
			if (!low) return null;
			prob += 1 / low - (high ? 1 / high : 0);
		}
		return prob > 0 ? { decimal: 1 / prob, exact: true } : null;
	}
	if (leg.type === 'correctScore' && (leg.period || 0) === 0) {
		const m = matchbookMarket(markets, 'Correct Score', 'correct_score');
		if (!m) return null;
		const teamIsHome = isHome(leg.team);
		// Format "X-Y" SANS espaces (différent de Piwi "X - Y") -- pas de
		// repli "ANY OTHER X WIN" pour les scores hors 0-3 : ce runner regroupe
		// plusieurs scores possibles, l'utiliser surestimerait un score exact
		// précis (ex: 4-1). Silencieux dans ce cas plutôt qu'un chiffre faux.
		const wantLines = new Set(
			leg.scoreLines.map(([teamScore, oppScore]) => (teamIsHome ? `${teamScore}-${oppScore}` : `${oppScore}-${teamScore}`))
		);
		const found = m.runners.filter((r) => wantLines.has(r.name));
		if (found.length !== wantLines.size) return null;
		const probSum = found.reduce((sum, r) => {
			const back = matchbookBestBack(r);
			return back ? sum + 1 / back : sum;
		}, 0);
		return probSum ? { decimal: 1 / probSum } : null;
	}
	if (leg.type === 'btts' && (leg.period || 0) === 0) {
		const back = matchbookBttsPrice(markets);
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'winToNil') {
		const name = isHome(leg.team) ? 'Home Team To Win To Nil' : 'Away Team To Win To Nil';
		const m = matchbookMarket(markets, name);
		if (!m) return null;
		const r = m.runners.find((rr) => rr.name === 'Yes');
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'setScore') {
		// Marché "Set Betting", runners "{Joueur} V-D" (ex: "Borges 2-0").
		const m = matchbookMarket(markets, 'Set Betting');
		if (!m) return null;
		const r = m.runners.find((rr) => {
			const idx = (rr.name || '').lastIndexOf(' ');
			if (idx === -1) return false;
			return rr.name.slice(idx + 1) === leg.score && teamsMatch(rr.name.slice(0, idx), leg.team);
		});
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'teamTotal' && (leg.period || 0) === 0) {
		const name = isHome(leg.team) ? 'Home Team Total Goals' : 'Away Team Total Goals';
		const m = markets.find((mk) => mk.name === name && mk.handicap === leg.points);
		if (!m) return null;
		const wantName = leg.side === 'over' ? `OVER ${leg.points}` : `UNDER ${leg.points}`;
		const r = m.runners.find((rr) => rr.name === wantName);
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'bothTeamTotal' && (leg.period || 0) === 0) {
		const a = resolveMatchbookLeg({ type: 'teamTotal', team: leg.teamA, side: 'over', points: leg.points, period: 0 }, mbEvent);
		const b = resolveMatchbookLeg({ type: 'teamTotal', team: leg.teamB, side: 'over', points: leg.points, period: 0 }, mbEvent);
		if (!a?.decimal || !b?.decimal) return null;
		return { decimal: 1 / ((1 / a.decimal) * (1 / b.decimal)) };
	}
	if (leg.type === 'doubleChance') {
		const back = matchbookDoubleChancePrice(markets, leg.team);
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'doubleChanceAndTotal') {
		// Pas de marché combiné direct chez Matchbook -- approximation en
		// multipliant Double Chance × Total (deux marchés indépendants, même
		// principe que findDoubleChanceAndTotalApprox côté Pinnacle).
		const dc = matchbookDoubleChancePrice(markets, leg.team);
		const total = matchbookTotalPrice(markets, leg.totalSide, leg.points);
		if (!dc || !total) return null;
		return { decimal: dc * total, exact: false };
	}
	if (leg.type === 'doubleChanceAndBtts') {
		const dc = matchbookDoubleChancePrice(markets, leg.team);
		const btts = matchbookBttsPrice(markets);
		if (!dc || !btts) return null;
		return { decimal: dc * btts, exact: false };
	}
	if (leg.type === 'drawNoBet' && (leg.period || 0) === 0) {
		const m = matchbookMarket(markets, 'Draw No Bet');
		if (!m) return null;
		const r = m.runners.find((rr) => teamsMatch(rr.name, leg.team));
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'htft') {
		const m = matchbookMarket(markets, 'Half Time/Full Time', 'half_time_full_time');
		if (!m) return null;
		// Format "TEAM/TEAM" tout en majuscules (ex: "FC BARCELONA/DRAW").
		const outcomeMatches = (outcome, side) => (outcome === 'Draw' ? side === 'DRAW' : teamsMatch(side, outcome));
		const r = m.runners.find((rr) => {
			const [ht, ft] = (rr.name || '').split('/');
			return outcomeMatches(leg.htOutcome, ht) && outcomeMatches(leg.ftOutcome, ft);
		});
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'winAndTotal') {
		const m = markets.find((mk) => mk.name === 'Match Result and Total Goals' && mk.handicap === leg.points);
		if (!m) return null;
		const cond = leg.side === 'over' ? `Over ${leg.points}` : `Under ${leg.points}`;
		const r = m.runners.find((rr) => {
			const idx = (rr.name || '').indexOf(' and ');
			if (idx === -1) return false;
			return rr.name.slice(idx + 5) === cond && teamsMatch(rr.name.slice(0, idx), leg.team);
		});
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'winAndBtts') {
		const m = matchbookMarket(markets, 'Match Result and Both Teams To Score');
		if (!m) return null;
		const r = m.runners.find((rr) => {
			const idx = (rr.name || '').indexOf(' and ');
			if (idx === -1) return false;
			return rr.name.slice(idx + 5) === 'Yes' && teamsMatch(rr.name.slice(0, idx), leg.team);
		});
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	if (leg.type === 'oddEvenTotal' && (leg.period || 0) === 0) {
		const m = matchbookMarket(markets, 'Odd or Even Total');
		if (!m) return null;
		const r = m.runners.find((rr) => rr.name === leg.label);
		const back = r ? matchbookBestBack(r) : null;
		return back ? { decimal: back } : null;
	}
	return null;
}

async function findMatchbookReference(legs, teamA, teamB) {
	if (!legs || !legs.length) return null;
	if (legs.length > 1) {
		// Combo multi-matchs à noms d'équipes explicites -- même principe que
		// côté Piwi (voir son commentaire) : chaque leg porte déjà son propre
		// teamA/teamB, résolution indépendante puis multiplication.
		const subLegs = [];
		let probProduct = 1;
		for (const leg of legs) {
			if (!MATCHBOOK_SPORT_IDS[leg.sport] || !leg.teamA || !leg.teamB) return null;
			const mbEvent = await findMatchbookEvent(leg.teamA, leg.teamB, leg.sport);
			if (!mbEvent) return null;
			const ref = await resolveMatchbookLeg(leg, mbEvent);
			if (!ref?.decimal) return null;
			probProduct *= 1 / ref.decimal;
			subLegs.push({ label: `${leg.teamA} - ${leg.teamB}`, decimal: ref.decimal });
		}
		return { decimal: 1 / probProduct, exact: true, subLegs };
	}
	const leg = legs[0];
	if (leg.teamA && leg.teamA !== teamA && leg.teamB && leg.teamB !== teamB) return null; // leg d'un autre match (combo)
	if (!MATCHBOOK_SPORT_IDS[leg.sport]) return null;
	const mbEvent = await findMatchbookEvent(teamA, teamB, leg.sport);
	if (!mbEvent) return null;
	return resolveMatchbookLeg(leg, mbEvent);
}

// Équivalent Matchbook de findScheduleBtts/findScheduleTotal côté Pinnacle.
// Pas de scoping par compétition possible (Matchbook n'expose aucun filtre
// competition/league sur /edge/rest/events, contrairement à Piwi où
// /customer/api/competition/{id} donne un calendrier déjà scopé) -- on
// filtre donc sur TOUT le sport par horaire exact, protégé par la même garde
// "exactement N événements" que partout ailleurs : si plusieurs compétitions
// démarrent au même horaire pile, ça reste ambigu -> silencieux plutôt que
// de risquer les mauvais matchs.
async function findMatchbookScheduleEvents(sport, count, hour, minute) {
	const list = await fetchMatchbookEvents(sport);
	const now = new Date();
	const todayParts = new Intl.DateTimeFormat('fr-FR', {
		timeZone: 'Europe/Paris',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).formatToParts(now);
	const today = `${todayParts.find((p) => p.type === 'year').value}-${todayParts.find((p) => p.type === 'month').value}-${todayParts.find((p) => p.type === 'day').value}`;

	const matching = list.filter((e) => {
		if (!e.start) return false;
		const parts = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(e.start));
		const date = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'day').value}`;
		if (date !== today) return false;
		if (hour == null) return true; // "matchs du jour" -- pas d'heure précise, toute la journée
		const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
		const mi = parseInt(parts.find((p) => p.type === 'minute').value, 10);
		return h === hour && mi === minute;
	});
	return matching.length === count ? matching : null;
}

async function findMatchbookScheduleReference(leg) {
	if (!MATCHBOOK_SPORT_IDS[leg.sport]) return null;
	const matching = await findMatchbookScheduleEvents(leg.sport, leg.count, leg.hour, leg.minute);
	if (!matching) return null;

	const subLegs = [];
	let probProduct = 1;
	for (const e of matching) {
		const markets = e.markets || [];
		let back = null;
		if (leg.type === 'scheduleBtts') {
			back = matchbookBttsPrice(markets);
		} else if (leg.type === 'scheduleTotal') {
			const marketName = leg.period === 1 ? '1st Half Total' : 'Total';
			const m = markets.find((mk) => mk.name === marketName && mk['market-type'] === 'total' && mk.handicap === leg.points);
			if (m) {
				const wantName = leg.side === 'over' ? `OVER ${leg.points}` : `UNDER ${leg.points}`;
				const r = m.runners.find((rr) => rr.name === wantName);
				back = r ? matchbookBestBack(r) : null;
			}
		}
		if (!back) return null;
		probProduct *= 1 / back;
		subLegs.push({ label: e.name, decimal: back });
	}
	return { decimal: 1 / probProduct, exact: true, subLegs };
}

function formatMatchbookReference(ref) {
	if (!ref) return null;
	if (ref.subLegs) {
		const breakdown = ref.subLegs.map((l) => `${l.label} : ${l.decimal.toFixed(2)}`).join('\n');
		const product = ref.subLegs.map((l) => l.decimal.toFixed(2)).join(' × ');
		return `📗 Exchange (Matchbook, perso) (combo ${ref.subLegs.length} matchs) :\n${breakdown}\n${product} = ${Number(ref.decimal).toFixed(2)}`;
	}
	if (ref.all) {
		const parts = ref.all.map((r) => `${r.name} : ${Number(r.back).toFixed(2)}`);
		return `📗 Exchange (Matchbook, perso) : ${parts.join(' · ')}`;
	}
	if (ref.decimal) {
		const approxTag = ref.exact === false ? ' ⚠️ approximatif (corrélation non prise en compte)' : '';
		return `📗 Exchange (Matchbook, perso) : ${Number(ref.decimal).toFixed(2)}${approxTag}`;
	}
	return null;
}

// --- Oddsportal (comparateur multi-bookmakers, EN COMPLÉMENT SEULEMENT --
// n'est appelé que quand Pinnacle/Piwi/Matchbook n'ont RIEN trouvé pour ce
// marché, jamais en plus). Contrairement aux exchanges, les cotes affichées
// sont déjà les meilleures parmi plusieurs bookmakers traditionnels -- exactement
// ce que demande l'utilisatrice pour comparer à la cote boostée. Coûte un
// lancement de Browser Rendering par appel (comme fetchPreloadedState), d'où
// le statut "complément" plutôt que "toujours affiché" : ça borne le volume
// à ce que les 3 autres sources ne couvrent pas.
const ODDSPORTAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Un slug par compétition suivie -- même limitation que PIWI_COMPETITIONS_BY_SPORT :
// Oddsportal n'expose pas d'ID stable par sport/circuit, juste un chemin par
// compétition. Tennis en particulier change de tournoi chaque semaine, à tenir
// à jour manuellement (voir le même commentaire côté Piwi).
const ODDSPORTAL_COMPETITIONS_BY_SPORT = {
	football: [
		'football/france/ligue-1',
		'football/france/ligue-2',
		'football/england/premier-league',
		'football/spain/laliga',
		'football/italy/serie-a',
		'football/germany/bundesliga',
		'football/europe/champions-league',
		'football/europe/europa-league',
		'football/europe/europa-conference-league',
	],
	basketball: ['basketball/usa/nba', 'basketball/usa/wnba'],
	baseball: ['baseball/usa/mlb'],
	hockey: ['hockey/usa/nhl'],
	tennis: [
		// Tournois de la semaine en cours -- pas d'ID stable, à mettre à jour
		// manuellement quand le tournoi change (voir PIWI_COMPETITIONS_BY_SPORT.tennis).
		'tennis/usa/atp-us-open',
		'tennis/usa/wta-us-open',
	],
};

// Repère le match sur Oddsportal par nom d'équipe -- simple fetch HTTP (pas
// besoin de Browser Rendering ici, la page liste les matchs du jour dans un
// bloc JSON-LD schema.org rendu côté serveur). Renvoie aussi home/away tels
// qu'affichés par Oddsportal (l'ordre peut différer du nôtre) pour savoir
// quelle colonne de la table de cotes correspond à quelle équipe.
async function findOddsportalMatchUrl(sport, teamA, teamB) {
	for (const slug of ODDSPORTAL_COMPETITIONS_BY_SPORT[sport] || []) {
		try {
			const res = await fetch(`https://www.oddsportal.com/${slug}/`, { headers: { 'User-Agent': ODDSPORTAL_UA } });
			if (!res.ok) continue;
			const html = await res.text();
			const re = /"name":"([^"]+?) - ([^"]+?)","startDate":"[^"]*","url":"(https:\/\/www\.oddsportal\.com\/[^"]+?)"/g;
			let m;
			while ((m = re.exec(html)) !== null) {
				const [, home, away, rawUrl] = m;
				if (
					(teamsMatch(home, teamA) && teamsMatch(away, teamB)) ||
					(teamsMatch(home, teamB) && teamsMatch(away, teamA))
				) {
					return { url: rawUrl.replace(/#.*$/, ''), home, away };
				}
			}
		} catch {
			continue;
		}
	}
	return null;
}

// Charge la page du match via Browser Rendering et navigue jusqu'au bon
// onglet marché/période avant de renvoyer le texte affiché. ORDRE IMPORTANT,
// vérifié en direct : sélectionner un onglet marché (ex: "Correct Score")
// réinitialise la période affichée à "Full Time" -- il faut donc cliquer les
// marchés D'ABORD, la période EN DERNIER, sinon la période retombe à "Full Time".
// marketClicks est un TABLEAU (pas une string) : certains marchés (ex: "Draw
// No Bet") sont planqués sous un sous-menu "More" et demandent 2 clics dans
// l'ordre, pas un seul.
async function fetchOddsportalBodyText(env, matchUrl, marketClicks, periodTab) {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setUserAgent(ODDSPORTAL_UA);
		await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
		await new Promise((r) => setTimeout(r, 4000));
		const clickTab = (text) =>
			page.evaluate((t) => {
				// Priorité aux boutons d'onglet marché identifiés par data-testid
				// (sports-nav-*-tab) -- bien plus fiable qu'un matching par texte
				// pur, qui attrapait parfois un homonyme ailleurs sur la page (bug
				// réel rencontré en investiguant : le bouton "MORE" du menu sports
				// vs celui des onglets marché, tous deux avec le texte "More").
				const tabButtons = Array.from(
					document.querySelectorAll('[data-testid="sports-nav-active-tab"], [data-testid="sports-nav-inactive-tab"]')
				);
				let target = tabButtons.find((e) => e.textContent?.trim() === t);
				if (!target) {
					const anchor = Array.from(document.querySelectorAll('div, span, a, button')).find(
						(e) => e.textContent?.trim() === '1X2' || e.textContent?.trim() === 'Home/Away'
					);
					if (!anchor) return false;
					const anchorY = anchor.getBoundingClientRect().top;
					const candidates = Array.from(document.querySelectorAll('a, button, div, span')).filter(
						(e) => e.textContent?.trim() === t && e.offsetParent !== null
					);
					if (!candidates.length) return false;
					candidates.sort(
						(a, b) => Math.abs(a.getBoundingClientRect().top - anchorY) - Math.abs(b.getBoundingClientRect().top - anchorY)
					);
					target = candidates[0].closest('a, button, [role="button"]') || candidates[0];
				}
				// "More" est un menu déclenché au survol (CSS :hover) chez certains
				// onglets -- dispatch mouseover/mouseenter en plus du click pour
				// couvrir les deux cas.
				for (const type of ['mouseover', 'mouseenter', 'click']) {
					target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
				}
				target.click();
				return true;
			}, text);
		for (const text of marketClicks || []) {
			if (!(await clickTab(text))) return null;
			await new Promise((r) => setTimeout(r, 3000));
		}
		if (periodTab) {
			if (!(await clickTab(periodTab))) return null;
			await new Promise((r) => setTimeout(r, 2000));
		}
		return await page.evaluate(() => document.body?.innerText || '');
	} finally {
		await browser.close();
	}
}

// Parse la table "Bookmakers ... Payout" (marchés à 2 ou 3 issues : vainqueur,
// total, BTTS, double chance...) en lignes {name, odds[], payout}. Approche
// ligne-par-ligne plutôt que regex sur les espaces exacts : "CLAIM BONUS"
// n'apparaît pas toujours entre le nom et les cotes (vu en direct, présence
// inconsistante), donc on ignore ce token plutôt que d'ancrer dessus.
function parseOddsportalBookmakerRows(bodyText) {
	const start = bodyText.indexOf('Bookmakers');
	if (start === -1) return [];
	const endMarkers = ['My coupon', 'Previous Matches', 'OddsAlert', 'Show more'];
	let end = bodyText.length;
	for (const marker of endMarkers) {
		const idx = bodyText.indexOf(marker, start);
		if (idx !== -1 && idx < end) end = idx;
	}
	const lines = bodyText
		.slice(start, end)
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && l !== 'CLAIM BONUS' && l !== 'CLAIM' && l !== 'Bookmakers');
	const rows = [];
	let i = 0;
	while (i < lines.length && (/^[12X]$/.test(lines[i]) || lines[i] === 'Payout')) i++;
	while (i < lines.length) {
		const name = lines[i];
		if (/^\d/.test(name) || name.endsWith('%')) {
			i++;
			continue;
		}
		i++;
		const nums = [];
		let sawPayout = false;
		while (i < lines.length && /^\d+(?:[.,]\d+)?%?$/.test(lines[i])) {
			nums.push(lines[i]);
			sawPayout = lines[i].endsWith('%');
			i++;
			if (sawPayout) break;
		}
		if (!sawPayout || nums.length < 2) continue;
		const payout = parseFloat(nums[nums.length - 1].replace('%', ''));
		const odds = nums.slice(0, -1).map((n) => parseFloat(n.replace(',', '.')));
		rows.push({ name, odds, payout });
	}
	return rows;
}

// Parse la table "score exact" (Correct Score) -- structure différente de
// parseOddsportalBookmakerRows : une ligne par score, avec le nombre de
// bookmakers qui le proposent et la MEILLEURE cote déjà calculée par
// Oddsportal (pas de détail par bookmaker sur ce marché-là).
function parseOddsportalScoreLines(bodyText) {
	const re = /(\d+:\d+)\n(\d+)\n\t\n\n(\d+(?:[.,]\d+)?)/g;
	const rows = [];
	let m;
	while ((m = re.exec(bodyText)) !== null) {
		rows.push({ score: m[1], count: parseInt(m[2], 10), decimal: parseFloat(m[3].replace(',', '.')) });
	}
	return rows;
}

// Parse la table "Over/Under" -- TOUTES les lignes (0.5, 0.75, 1, 1.25...)
// sont affichées ensemble sur le même onglet, pas de sélecteur de ligne
// séparé à cliquer. Meilleure cote déjà calculée par Oddsportal (comme
// parseOddsportalScoreLines), "-" quand aucun bookmaker n'a cette ligne.
function parseOddsportalOverUnderLines(bodyText) {
	const re = /Over\/Under \+(\d+(?:[.,]\d+)?)\n(\d+)\n\t\n\n([\d.,]+|-)\n\n\t\n\n([\d.,]+|-)\n\n\t/g;
	const rows = [];
	let m;
	while ((m = re.exec(bodyText)) !== null) {
		rows.push({
			points: parseFloat(m[1].replace(',', '.')),
			count: parseInt(m[2], 10),
			over: m[3] === '-' ? null : parseFloat(m[3].replace(',', '.')),
			under: m[4] === '-' ? null : parseFloat(m[4].replace(',', '.')),
		});
	}
	return rows;
}

function oddsportalPeriodTab(sport, period) {
	if (!period) return null; // "Full Time" est déjà l'onglet par défaut, pas besoin de cliquer
	return sport === 'tennis' ? '1st Set' : '1st Half';
}

// Dispatch par type de leg -- couvre les marchés les plus fréquents
// (vainqueur, total, BTTS, double chance, score exact tennis). Les types non
// couverts renvoient simplement null (pas d'erreur), comme les autres
// sources quand un marché n'existe pas.
async function findOddsportalReference(env, leg, teamA, teamB) {
	if (!ODDSPORTAL_COMPETITIONS_BY_SPORT[leg.sport]) return null;
	const match = await findOddsportalMatchUrl(leg.sport, teamA, teamB);
	if (!match) return null;
	const periodTab = oddsportalPeriodTab(leg.sport, leg.period || 0);

	const designationFor = (team) => {
		if (teamsMatch(match.home, team)) return 0;
		if (teamsMatch(match.away, team)) return 1;
		return null;
	};

	if (leg.type === 'moneyline') {
		const bodyText = await fetchOddsportalBodyText(env, match.url, [], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalBookmakerRows(bodyText);
		if (rows.length < 1) return null;
		const idx = leg.team ? designationFor(leg.team) : null;
		if (leg.team && idx == null) return null;
		const colIdx = idx == null ? null : idx;
		if (colIdx == null) return null; // pas de team backée précisée -- pas de ligne unique à afficher
		const best = Math.max(...rows.map((r) => r.odds[colIdx]).filter((v) => !isNaN(v)));
		if (!best) return null;
		return { decimal: best, bookmakerCount: rows.length, exact: true };
	}
	if (leg.type === 'btts') {
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Both Teams to Score'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalBookmakerRows(bodyText);
		if (!rows.length) return null;
		const best = Math.max(...rows.map((r) => r.odds[0]).filter((v) => !isNaN(v)));
		if (!best) return null;
		return { decimal: best, bookmakerCount: rows.length, exact: true };
	}
	if (leg.type === 'doubleChance') {
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Double Chance'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalBookmakerRows(bodyText);
		if (!rows.length) return null;
		// Colonnes Oddsportal (foot) : "1X" / "12" / "X2" -- teamOrDraw = home
		// gagne ou nul = colonne 0 si l'équipe backée est home, sinon colonne 2
		// (X2). drawOrTeam = l'inverse.
		const idx = designationFor(leg.team);
		if (idx == null) return null;
		let colIdx;
		if (leg.side === 'teamOrDraw') colIdx = idx === 0 ? 0 : 2;
		else colIdx = idx === 0 ? 2 : 0; // drawOrTeam
		const best = Math.max(...rows.map((r) => r.odds[colIdx]).filter((v) => !isNaN(v)));
		if (!best) return null;
		return { decimal: best, bookmakerCount: rows.length, exact: true };
	}
	if (leg.type === 'drawNoBet') {
		// Planqué sous le sous-menu "More" -- 2 clics dans l'ordre, vérifié en
		// direct (bouton data-testid="sports-nav-inactive-tab", pas un lien
		// direct dans la barre principale des onglets).
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['More', 'Draw No Bet'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalBookmakerRows(bodyText);
		if (!rows.length) return null;
		const idx = designationFor(leg.team);
		if (idx == null) return null; // table à 2 colonnes (1/2, pas de X) -- idx 0 ou 1 directement
		const best = Math.max(...rows.map((r) => r.odds[idx]).filter((v) => !isNaN(v)));
		if (!best) return null;
		return { decimal: best, bookmakerCount: rows.length, exact: true };
	}
	if (leg.type === 'total') {
		// Toutes les lignes affichées sur le même onglet -- pas de sélecteur de
		// ligne séparé à cliquer, juste à choisir la bonne dans la table.
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Over/Under'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalOverUnderLines(bodyText);
		if (!rows.length) return null;
		const row = rows.find((r) => Math.abs(r.points - leg.points) < 0.001);
		if (!row) return null;
		const val = leg.side === 'over' ? row.over : row.under;
		if (!val) return null;
		return { decimal: val, bookmakerCount: row.count, exact: true };
	}
	if (leg.type === 'setScore' && leg.sport === 'tennis') {
		// Score exact d'1 SET précis (ex: "2-1" en sets, pas en jeux) -- marché
		// "Correct Score" en période "Full Time" (le score du match, pas d'1 set).
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Correct Score'], null);
		if (!bodyText) return null;
		const rows = parseOddsportalScoreLines(bodyText);
		if (!rows.length) return null;
		const idx = designationFor(leg.team);
		if (idx == null) return null;
		const [a, b] = leg.score.split('-').map((n) => parseInt(n, 10));
		const wantScore = idx === 0 ? `${a}:${b}` : `${b}:${a}`;
		const row = rows.find((r) => r.score === wantScore);
		if (!row) return null;
		return { decimal: row.decimal, bookmakerCount: row.count, exact: true };
	}
	if (leg.type === 'correctScore') {
		// "TeamX gagne le match A-B, C-D ou E-F" -- somme des scores exacts
		// demandés (tout ou rien : un seul manquant -> silencieux, comme
		// findCorrectScoreSum côté Pinnacle, plutôt qu'une somme partielle qui
		// sous-estimerait la vraie probabilité). Réutilisé aussi pour le tennis
		// (score en SETS du match si period:0, ou en JEUX du 1er set si
		// period:1 -- même table "Correct Score", periodTab bascule déjà
		// l'onglet "1st Set" via oddsportalPeriodTab). Emplacement de l'onglet
		// "Correct Score" différent selon le sport, vérifié en direct : visible
		// directement dans la barre pour le tennis, planqué sous "More" pour le
		// foot (même sous-menu que Draw No Bet).
		const marketClicks = leg.sport === 'tennis' ? ['Correct Score'] : ['More', 'Correct Score'];
		const bodyText = await fetchOddsportalBodyText(env, match.url, marketClicks, periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalScoreLines(bodyText);
		if (!rows.length) return null;
		const idx = designationFor(leg.team);
		if (idx == null) return null;
		let probSum = 0;
		let minCount = Infinity;
		for (const [teamScore, oppScore] of leg.scoreLines) {
			const wantScore = idx === 0 ? `${teamScore}:${oppScore}` : `${oppScore}:${teamScore}`;
			const row = rows.find((r) => r.score === wantScore);
			if (!row) return null;
			probSum += 1 / row.decimal;
			minCount = Math.min(minCount, row.count);
		}
		if (!probSum) return null;
		return { decimal: 1 / probSum, bookmakerCount: minCount, exact: true };
	}
	if (leg.type === 'winNotStraightSets') {
		// "TeamX vainqueur et les 2 joueurs gagnent un set" -- équivalent à
		// "TeamX gagne SANS blanchir" (l'adversaire gagne au moins 1 set).
		// Contrairement à correctScore ci-dessus, la liste des scores n'est
		// PAS fixée à l'avance (dépend du format best-of-3 ou best-of-5) --
		// on prend TOUTES les lignes où TeamX gagne, on exclut seulement celle
		// où l'adversaire est à 0 (le blanchissage), et on somme le reste.
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Correct Score'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalScoreLines(bodyText);
		if (!rows.length) return null;
		const idx = designationFor(leg.team);
		if (idx == null) return null;
		let probSum = 0;
		let minCount = Infinity;
		let found = 0;
		for (const row of rows) {
			const [a, b] = row.score.split(':').map((n) => parseInt(n, 10));
			const [teamScore, oppScore] = idx === 0 ? [a, b] : [b, a];
			if (teamScore <= oppScore || oppScore === 0) continue; // pas une victoire de TeamX, ou blanchissage exclu
			probSum += 1 / row.decimal;
			minCount = Math.min(minCount, row.count);
			found++;
		}
		if (!found) return null;
		// Exact (pas une approximation) : la définition du pari EST exactement
		// "somme des scores exacts où l'adversaire gagne >=1 set", pas un
		// produit de marchés indépendants comme playerScorerAndWin.
		return { decimal: 1 / probSum, bookmakerCount: minCount, exact: true };
	}
	if (leg.type === 'playerWinsASet') {
		// "{Joueur} remporte au moins 1 set" -- PEU IMPORTE qui gagne le match
		// (contrairement à winNotStraightSets qui exige la victoire du match).
		// Somme de tous les scores exacts où le nombre de sets DU JOUEUR
		// (gagnant ou perdant le match) est >= 1 -- exclut uniquement le
		// blanchissage SUBI par ce joueur (l'adversaire à 0 sets concédés).
		// Construction demandée en direct par l'utilisatrice sur Z.Sonmez
		// (2-1, 2-0 pour elle + 1-2, où elle prend 1 set en perdant).
		const idx = designationFor(leg.player);
		if (idx == null) return null;
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Correct Score'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalScoreLines(bodyText);
		if (!rows.length) return null;
		let probSum = 0;
		let minCount = Infinity;
		let found = 0;
		for (const row of rows) {
			const [a, b] = row.score.split(':').map((n) => parseInt(n, 10));
			const playerSets = idx === 0 ? a : b;
			if (playerSets === 0) continue; // blanchissage subi -- exclu
			probSum += 1 / row.decimal;
			minCount = Math.min(minCount, row.count);
			found++;
		}
		if (!found) return null;
		return { decimal: 1 / probSum, bookmakerCount: minCount, exact: true };
	}
	if (leg.type === 'winsSet1') {
		// "{Joueur} gagne le 1er/premier set" -- period:1 fait déjà basculer
		// periodTab sur "1st Set" (score en JEUX du 1er set, pas en sets du
		// match). Somme toutes les lignes où le score du joueur > celui de
		// l'adversaire -- pas d'exclusion de blanchissage à faire ici
		// (6-0 compte comme une victoire du 1er set comme n'importe quel autre
		// score). Absent chez Pinnacle/Matchbook et Piwi souvent indisponible
		// (ID compétition tennis périmé) -- vu sur une cote Diane Parry où
		// aucune des 3 autres sources ne couvrait ce marché du tout.
		const idx = designationFor(leg.team);
		if (idx == null) return null;
		const bodyText = await fetchOddsportalBodyText(env, match.url, ['Correct Score'], periodTab);
		if (!bodyText) return null;
		const rows = parseOddsportalScoreLines(bodyText);
		if (!rows.length) return null;
		let probSum = 0;
		let minCount = Infinity;
		let found = 0;
		for (const row of rows) {
			const [a, b] = row.score.split(':').map((n) => parseInt(n, 10));
			const [teamScore, oppScore] = idx === 0 ? [a, b] : [b, a];
			if (teamScore <= oppScore) continue;
			probSum += 1 / row.decimal;
			minCount = Math.min(minCount, row.count);
			found++;
		}
		if (!found) return null;
		return { decimal: 1 / probSum, bookmakerCount: minCount, exact: true };
	}
	return null;
}

function formatOddsportalReference(ref) {
	if (!ref?.decimal) return null;
	const lowCountTag = ref.bookmakerCount < 4 ? ` ⚠️ seulement ${ref.bookmakerCount} bookmaker${ref.bookmakerCount > 1 ? 's' : ''}` : '';
	return `📊 Oddsportal (${ref.bookmakerCount} bookmakers) : ${Number(ref.decimal).toFixed(2)}${lowCountTag}`;
}

async function checkAndPost(env) {
	const state = await fetchPreloadedState(env);
	const boosts = parseBoosts(state);
	const eligible = boosts.filter((b) => b.maxStake <= MAX_STAKE_EUR);

	const prevRaw = await env.SEEN_BOOSTS.get('current_snapshot');
	const prevBoosts = prevRaw ? JSON.parse(prevRaw).boosts : null;

	// TTL largement au-dessus de l'intervalle du cron (5 min) : si un check
	// échoue (timeout Browser Rendering, cf. fetchPreloadedState plus haut),
	// postMonitoringDiff saute silencieusement le diff dès que prevBoosts est
	// absent -- un TTL trop court (15 min, soit seulement 3 checks ratés
	// d'affilée) faisait perdre définitivement les ajouts de cette fenêtre,
	// jamais rattrapés ensuite. 60 min tolère largement une mauvaise série.
	await env.SEEN_BOOSTS.put(
		'current_snapshot',
		JSON.stringify({ updatedAt: Date.now(), boosts }),
		{ expirationTtl: 60 * 60 }
	);
	await postMonitoringDiff(env, prevBoosts, boosts);
	await refreshTrackedPinnacleRefs(env);
	await detectDuplicates(env, boosts);

	let posted = 0;
	for (const boost of eligible) {
		const key = `seen:${boost.marketId}:${boost.newOdds}`;
		const already = await env.SEEN_BOOSTS.get(key);
		if (already) continue;

		// try/catch PAR cote : sans ça, un seul envoi qui échoue (Telegram
		// rate-limit, hoquet réseau...) faisait planter toute la boucle --
		// TOUTES les flash suivantes de ce même check étaient alors ignorées
		// silencieusement, pas seulement celle en échec. Repéré en creusant
		// pourquoi une flash Winamax attendue n'était jamais arrivée dans le
		// canal abonnés côté match du PSG.
		try {
			await sendTelegramMessage(env, formatTelegramMessage(boost));
			await env.SEEN_BOOSTS.put(key, '1', { expirationTtl: SEEN_TTL_SECONDS });
			posted++;
		} catch (e) {
			console.log('checkAndPost: sendTelegramMessage failed for', boost.marketId, ':', String(e));
			await logError(env, 'checkAndPost:send', `${boost.marketId}: ${String(e)}`);
		}
	}
	return { checked: boosts.length, eligible: eligible.length, posted };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/run') {
			try {
				const result = await checkAndPost(env);
				return new Response(JSON.stringify(result), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: String(e) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}
		if (url.pathname === '/current') {
			const raw = await env.SEEN_BOOSTS.get('current_snapshot');
			return new Response(raw || JSON.stringify({ updatedAt: null, boosts: [] }), {
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			});
		}
		if (url.pathname === '/digest-list-debug') {
			// Route de debug temporaire (à supprimer après le reporting) --
			// liste le détail complet des digestitem du jour (pas juste
			// count/withRef/best comme /digest-data), pour reconstruire ce qui a
			// été envoyé sur le canal spawn sans accès à l'historique Telegram.
			const date = url.searchParams.get('date') || todayKey();
			const list = await env.SEEN_BOOSTS.list({ prefix: `digestitem:${date}:` });
			const items = [];
			for (const key of list.keys) {
				const raw = await env.SEEN_BOOSTS.get(key.name);
				if (!raw) continue;
				items.push({ marketId: key.name.split(':')[2], ...JSON.parse(raw) });
			}
			return new Response(JSON.stringify({ date, items }, null, 2), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/digest-data') {
			// Symétrique de la route côté Unibet -- Winamax calculait déjà ses
			// propres stats en interne (appel direct dans postDailyDigest, pas
			// besoin d'HTTP pour soi-même) mais ne les exposait jamais en HTTP,
			// donc rien d'autre ne pouvait les lire de l'extérieur. Manquant
			// trouvé en branchant le pipeline de contenu dessus.
			const date = url.searchParams.get('date') || todayKey();
			const stats = await computeDigestStats(env, date);
			return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/backfill-pinnacle') {
			const result = await backfillPinnacleRefs(env);
			return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-monitoring-message') {
			// Route de debug temporaire -- rejoue formatMonitoringMessage EXACTEMENT
			// comme au moment d'un vrai "add", pour voir le message qui serait
			// réellement posté sur le canal spawn (le digest KV ne garde que
			// l'edge Pinnacle, pas les lignes Piwi/Matchbook/Oddsportal).
			const eventName = url.searchParams.get('eventName');
			const description = url.searchParams.get('description');
			const sport = url.searchParams.get('sport') || 'tennis';
			const newOdds = url.searchParams.get('newOdds') || '3,00';
			if (!eventName || !description) return new Response('usage: ?eventName=...&description=...&sport=tennis&newOdds=3,00', { status: 400 });
			const boost = { eventName, description, sport, league: null, newOdds, marketId: 'debug', maxStake: 20, kickoff: '', sportEmoji: '' };
			const result = await formatMonitoringMessage(env, { type: 'add', boost });
			return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-pinnacle-raw-specials') {
			// Route de debug temporaire -- dump les participants "spéciaux" (nom
			// contenant " & ") d'un match, pour voir si un marché combiné direct
			// existe (et à quel seuil) sans deviner à l'aveugle.
			const a = url.searchParams.get('a');
			const b = url.searchParams.get('b');
			const sport = url.searchParams.get('sport') || 'tennis';
			if (!a || !b) return new Response('usage: ?a=TeamA&b=TeamB&sport=tennis', { status: 400 });
			const leagueList = await fetchLeagueList(sport);
			let found = null;
			const BATCH_SIZE = 20;
			for (let i = 0; i < leagueList.length && !found; i += BATCH_SIZE) {
				const batch = leagueList.slice(i, i + BATCH_SIZE);
				const results = await Promise.all(
					batch.map(async (league) => {
						const leagueData = await fetchLeagueData(league.id);
						if (!leagueData) return null;
						const parent = findRootMatchup(leagueData.matchups, a, b);
						if (!parent) return null;
						const specials = [];
						for (const m of leagueData.matchups) {
							if (m.id !== parent.id && m.parentId !== parent.id) continue;
							for (const p of m.participants || []) {
								if (p.name?.includes(' & ')) specials.push({ matchupId: m.id, name: p.name });
							}
						}
						return { league: league.name, specials };
					})
				);
				found = results.find((r) => r?.specials?.length);
			}
			return new Response(JSON.stringify({ found }, null, 2), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-pinnacle') {
			const a = url.searchParams.get('a');
			const b = url.searchParams.get('b');
			const d = url.searchParams.get('d') || `${a} gagne`;
			const league = url.searchParams.get('league') || null;
			const sport = url.searchParams.get('sport') || 'football';
			if (!a || !b) return new Response('usage: ?a=TeamA&b=TeamB&d=Description&sport=football&league=(optionnel)', { status: 400 });
			const legs = parseLegs(`${a} - ${b}`, d, sport);
			const ref = await findPinnacleReference(`${a} - ${b}`, d, league, sport);
			return new Response(JSON.stringify({ legs, ref, line: formatPinnacleReference(ref) }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/debug-raw-match') {
			const q = (url.searchParams.get('q') || '').toLowerCase();
			const state = await fetchPreloadedState(env);
			const match = Object.values(state.matches || {}).find((m) => (m.title || '').toLowerCase().includes(q));
			const tournament = match ? state.tournaments?.[String(match.tournamentId)] : null;
			const category = match ? state.categories?.[String(match.categoryId)] : null;
			const sport = match ? state.sports?.[String(match.sportId)] : null;
			return new Response(
				JSON.stringify({ match, tournament, category, sport, topLevelKeys: Object.keys(state) }, null, 2),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}
		if (url.pathname === '/test-piwi') {
			const marketId = url.searchParams.get('marketId');
			const eventId = url.searchParams.get('eventId');
			if (!marketId || !eventId) return new Response('usage: ?marketId=X&eventId=Y', { status: 400 });
			const result = await fetchPiwiMarketPrices(marketId, eventId);
			return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-piwi-teams') {
			const a = url.searchParams.get('a');
			const b = url.searchParams.get('b');
			const d = url.searchParams.get('d') || `${a} gagne`;
			const sport = url.searchParams.get('sport') || 'football';
			if (!a || !b) return new Response('usage: ?a=TeamA&b=TeamB&d=Description&sport=football (optionnel)', { status: 400 });
			const legs = parseLegs(`${a} - ${b}`, d, sport);
			const ref = await findPiwiReference(legs, a, b);
			return new Response(JSON.stringify({ legs, ref, line: formatPiwiReference(ref) }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-schedule') {
			const count = parseInt(url.searchParams.get('count') || '3', 10);
			const hourParam = url.searchParams.get('hour');
			const hour = hourParam === 'none' ? null : parseInt(hourParam || '21', 10);
			const minute = hour == null ? null : parseInt(url.searchParams.get('minute') || '0', 10);
			const side = url.searchParams.get('side') || 'over';
			const points = parseFloat(url.searchParams.get('points') || '0.5');
			const period = parseInt(url.searchParams.get('period') || '0', 10);
			const type = url.searchParams.get('type') || 'scheduleTotal';
			const leg = { type, count, hour, minute, side, points, period, sport: 'football' };
			const piwiRef = await findPiwiScheduleReference(leg);
			const matchbookRef = await findMatchbookScheduleReference(leg);
			return new Response(
				JSON.stringify({
					leg,
					piwi: { ref: piwiRef, line: formatPiwiReference(piwiRef) },
					matchbook: { ref: matchbookRef, line: formatMatchbookReference(matchbookRef) },
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}
		if (url.pathname === '/test-oddsportal-teams') {
			const a = url.searchParams.get('a');
			const b = url.searchParams.get('b');
			const d = url.searchParams.get('d') || `${a} gagne`;
			const sport = url.searchParams.get('sport') || 'football';
			if (!a || !b) return new Response('usage: ?a=TeamA&b=TeamB&d=Description&sport=football (optionnel)', { status: 400 });
			const legs = parseLegs(`${a} - ${b}`, d, sport);
			if (!legs || legs.length !== 1) return new Response(JSON.stringify({ legs, ref: null }), { headers: { 'Content-Type': 'application/json' } });
			const ref = await findOddsportalReference(env, legs[0], a, b);
			return new Response(JSON.stringify({ legs, ref, line: formatOddsportalReference(ref) }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/test-matchbook-raw') {
			try {
				const res = await fetch('https://api.matchbook.com/edge/rest/events?sport-ids=15&per-page=5', { headers: MATCHBOOK_HEADERS });
				const body = await res.text();
				return new Response(JSON.stringify({ status: res.status, ok: res.ok, bodyStart: body.slice(0, 500) }), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: String(e) }), { headers: { 'Content-Type': 'application/json' } });
			}
		}
		if (url.pathname === '/test-matchbook-teams') {
			const a = url.searchParams.get('a');
			const b = url.searchParams.get('b');
			const d = url.searchParams.get('d') || `${a} gagne`;
			const sport = url.searchParams.get('sport') || 'football';
			if (!a || !b) return new Response('usage: ?a=TeamA&b=TeamB&d=Description&sport=football (optionnel)', { status: 400 });
			const legs = parseLegs(`${a} - ${b}`, d, sport);
			const mbEvent = await findMatchbookEvent(a, b, sport);
			const ref = await findMatchbookReference(legs, a, b);
			return new Response(JSON.stringify({ legs, mbEvent, ref, line: formatMatchbookReference(ref) }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/errors') {
			const list = await env.SEEN_BOOSTS.list({ prefix: 'errlog:' });
			const entries = (await Promise.all(list.keys.map((k) => env.SEEN_BOOSTS.get(k.name))))
				.filter(Boolean)
				.map((e) => JSON.parse(e))
				.sort((a, b) => b.ts - a.ts);
			return new Response(JSON.stringify(entries), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response('OK. Utilise /run pour déclencher un check manuel, /current pour le suivi.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		if (event.cron === '7 8 * * *') {
			ctx.waitUntil(
				postDailyDigest(env).catch((e) => {
					console.error('postDailyDigest failed:', e);
					return logError(env, 'postDailyDigest', String(e));
				})
			);
			return;
		}
		ctx.waitUntil(
			checkAndPost(env).catch((e) => {
				console.error('checkAndPost failed:', e);
				return logError(env, 'checkAndPost', String(e));
			})
		);
	},
};
