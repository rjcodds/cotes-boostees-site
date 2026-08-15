// Surveille la page "cotes boostées" d'Unibet et poste automatiquement dans le
// canal Telegram privé toute cote boostée dont la mise max est <= MAX_STAKE_EUR.
//
// Tourne sur un Cron Trigger Cloudflare (voir wrangler.toml). Les données sont
// lues depuis le JSON "BoostedBets" embarqué dans le HTML de la page (rendu
// côté serveur par Unibet) -- pas d'un navigateur headless, la page est
// directement exploitable via une simple requête HTTP.

const UNIBET_URL = 'https://www.unibet.fr/cotes-boostees';
const MAX_STAKE_EUR = 10;
const SEEN_TTL_SECONDS = 6 * 60 * 60; // 6h : évite de reposter la même cote à chaque poll
const STATE_SCRIPT_RE = /<script id="serverApp-state" type="application\/json">(.*?)<\/script>/s;
const ODDS_RE = /\(([\d,]+)\s*(?:->|→)\s*([\d,]+)\s*\/\s*Mise max\s*(\d+)\s*€\)/;

const SPORT_EMOJI = {
	Football: '⚽',
	Tennis: '🎾',
	Basketball: '🏀',
	Rugby: '🏉',
	'Hockey sur glace': '🏒',
	Handball: '🤾',
	Volleyball: '🏐',
	Baseball: '⚾',
	MMA: '🥊',
	Boxe: '🥊',
	Cyclisme: '🚴',
	Golf: '⛳',
	Snooker: '🎱',
	Fléchettes: '🎯',
};

// Sports pour lesquels Pinnacle expose une recherche par compétition (voir
// PINNACLE_SPORTS plus bas). Cyclisme/golf/snooker/fléchettes restent hors-jeu
// (modèle "outright", pas "équipe A vs équipe B"). Rugby et MMA/Boxe pointent
// vers un groupe ambigu (AMBIGUOUS_SPORT_GROUPS) : Unibet ne distingue pas
// Union/League, ni MMA/Boxe, sous un même libellé -- on essaie les deux.
const PINNACLE_SPORT_KEY_BY_LABEL = {
	Football: 'football',
	Basketball: 'basketball',
	Tennis: 'tennis',
	Baseball: 'baseball',
	'Hockey sur glace': 'hockey',
	MMA: 'combat',
	Boxe: 'combat',
	Rugby: 'rugby',
	Handball: 'handball',
	Volleyball: 'volleyball',
};

function stripCbPrefix(label) {
	return (label || '').replace(/^Cotes Boost[ée]es\s*/i, '').trim();
}

// Compétitions continentales -> drapeau européen. Championnats nationaux ->
// drapeau du pays. Heuristique sur le nom de ligue, forcément imparfaite --
// à enrichir au fil des cas réels rencontrés.
const EUROPEAN_COMPETITION_KEYWORDS = [
	'champions league',
	'ligue des champions',
	'europa league',
	'ligue europa',
	'conference league',
	"supercoupe d'europe",
	'supercoupe europe',
	'euroligue',
];
const DOMESTIC_LEAGUE_FLAGS = [
	[/ligue 1|ligue 2|coupe de france/i, '🇫🇷'],
	[/premier league|fa cup|efl cup|championship anglais/i, '🏴'],
	[/serie a|serie b|coppa italia/i, '🇮🇹'],
	[/liga(?!ue)|copa del rey/i, '🇪🇸'],
	[/bundesliga|dfb.?pokal/i, '🇩🇪'],
	[/eredivisie/i, '🇳🇱'],
	[/liga portugal|primeira liga/i, '🇵🇹'],
	[/jupiler|pro league belge/i, '🇧🇪'],
];

// Même heuristique que DOMESTIC_LEAGUE_FLAGS, mais renvoie le préfixe pays tel
// qu'utilisé dans les noms de compétition Pinnacle ("England - Premier League")
// -- sert à départager les ligues homonymes entre pays (ex: "Premier League"
// existe dans une vingtaine de pays chez Pinnacle) sans avoir à tout essayer.
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
	const clean = stripCbPrefix(leagueLabel);
	if (!clean) return null;
	if (EUROPEAN_COMPETITION_KEYWORDS.some((k) => clean.toLowerCase().includes(k))) return 'UEFA';
	for (const [re, country] of DOMESTIC_LEAGUE_COUNTRY) {
		if (re.test(clean)) return country;
	}
	return null;
}

// Matchs de sélections (amicaux, grands tournois) -> un drapeau par équipe
// plutôt qu'un drapeau de compétition.
const NATIONAL_TEAM_KEYWORDS = [
	'coupe du monde',
	/\bcdm\b/i,
	/\beuro\b/i,
	/\bcan\b/i,
	"coupe d'afrique",
	'amical',
	'nations league',
	'ligue des nations',
	'mondial',
	'qualif',
];

const COUNTRY_FLAGS = {
	france: '🇫🇷', belgique: '🇧🇪', suisse: '🇨🇭', espagne: '🇪🇸', italie: '🇮🇹',
	allemagne: '🇩🇪', angleterre: '🏴', portugal: '🇵🇹', 'pays-bas': '🇳🇱', hollande: '🇳🇱',
	argentine: '🇦🇷', bresil: '🇧🇷', uruguay: '🇺🇾', chili: '🇨🇱', colombie: '🇨🇴',
	maroc: '🇲🇦', senegal: '🇸🇳', algerie: '🇩🇿', tunisie: '🇹🇳', egypte: '🇪🇬',
	nigeria: '🇳🇬', ghana: '🇬🇭', cameroun: '🇨🇲', "cote d'ivoire": '🇨🇮',
	croatie: '🇭🇷', pologne: '🇵🇱', serbie: '🇷🇸', ukraine: '🇺🇦', turquie: '🇹🇷',
	autriche: '🇦🇹', danemark: '🇩🇰', suede: '🇸🇪', norvege: '🇳🇴', ecosse: '🏴',
	irlande: '🇮🇪', 'pays de galles': '🏴', usa: '🇺🇸', 'etats-unis': '🇺🇸', mexique: '🇲🇽',
	japon: '🇯🇵', 'coree du sud': '🇰🇷', australie: '🇦🇺', canada: '🇨🇦',
	qatar: '🇶🇦', 'arabie saoudite': '🇸🇦', iran: '🇮🇷',
};

function normalize(s) {
	return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function countryFlag(name) {
	return COUNTRY_FLAGS[normalize(name)] || null;
}

function competitionFlag(leagueLabel) {
	if (!leagueLabel) return null;
	const clean = leagueLabel.replace(/^Cotes Boost[ée]es\s*/i, '');
	const lower = clean.toLowerCase();
	if (EUROPEAN_COMPETITION_KEYWORDS.some((k) => lower.includes(k))) return '🇪🇺';
	for (const [re, flag] of DOMESTIC_LEAGUE_FLAGS) {
		if (re.test(clean)) return flag;
	}
	return null;
}

function isNationalTeamContext(leagueLabel) {
	if (!leagueLabel) return false;
	const clean = leagueLabel.replace(/^Cotes Boost[ée]es\s*/i, '');
	return NATIONAL_TEAM_KEYWORDS.some((k) => (k instanceof RegExp ? k.test(clean) : clean.toLowerCase().includes(k)));
}

function formatEventName(opponentA, opponentB, leagueLabel, sportLabel) {
	const emoji = SPORT_EMOJI[sportLabel] || '🏅';
	if (isNationalTeamContext(leagueLabel)) {
		const flagA = countryFlag(opponentA);
		const flagB = countryFlag(opponentB);
		if (flagA && flagB) {
			return `${emoji} ${opponentA} ${flagA} - ${opponentB} ${flagB}`;
		}
	}
	const compFlag = competitionFlag(leagueLabel);
	if (compFlag) {
		return `${emoji} ${opponentA} - ${opponentB} ${compFlag}`;
	}
	return `${emoji} ${opponentA} - ${opponentB}`;
}

function formatKickoffTime(parsedStart) {
	if (!parsedStart) return null;
	try {
		const d = new Date(parsedStart);
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

function parseBoosts(html) {
	const stateMatch = html.match(STATE_SCRIPT_RE);
	if (!stateMatch) return [];

	let data;
	try {
		data = JSON.parse(stateMatch[1]);
	} catch {
		return [];
	}

	const events = data?.BoostedBets?.events;
	if (!Array.isArray(events)) return [];

	const boosts = [];
	for (const event of events) {
		const opponentA = event.opponentA?.label;
		const opponentB = event.opponentB?.label;
		const sportLabel = event.path?.sport?.label;
		const leagueLabel = event.path?.league?.label;
		const kickoff = formatKickoffTime(event.parsedStart);

		for (const market of event.groupedMarkets || []) {
			const marketDesc = market.description;
			if (!marketDesc) continue;
			const oddsMatch = marketDesc.match(ODDS_RE);
			if (!oddsMatch) continue;
			const [, oldOdds, newOdds, maxStake] = oddsMatch;

			boosts.push({
				marketId: String(market.id),
				eventName: formatEventName(opponentA, opponentB, leagueLabel, sportLabel),
				sport: PINNACLE_SPORT_KEY_BY_LABEL[sportLabel] || null,
				league: stripCbPrefix(leagueLabel),
				description: marketDesc.replace(ODDS_RE, '').replace(/\s+/g, ' ').trim(),
				oldOdds,
				newOdds,
				maxStake: parseInt(maxStake, 10),
				kickoff,
			});
		}
	}
	return boosts;
}

function formatTelegramMessage(boost) {
	const lines = [
		`⚡ COTE BOOSTÉE FLASH — UNIBET`,
		``,
		boost.eventName,
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
		// "message is not modified" arrive si Telegram voit le texte comme
		// identique -- pas une vraie erreur, on l'ignore silencieusement.
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

// "Rugby" et "Combat" (MMA/Boxe) partagent un seul émoji/libellé générique côté
// Unibet/Winamax -- impossible de savoir lequel sans essayer les deux.
const AMBIGUOUS_SPORT_GROUPS = {
	rugby: ['rugbyUnion', 'rugbyLeague'],
	combat: ['mma', 'boxing'],
};

// Emoji en tête de l'eventName (posé par formatEventName / SPORT_EMOJI) -> sport
// Pinnacle correspondant (ou groupe ambigu, voir ci-dessus). Cyclisme/golf/
// snooker/fléchettes restent hors du modèle équipe A vs équipe B.
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

// Referer/Origin pinnacle.com : sans ça, l'API guest bloque certains sports en
// 401 (handball, volley, rugby, boxe, cyclisme) -- un vrai navigateur les
// envoie automatiquement, un fetch() brut non.
const PINNACLE_API_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	Referer: 'https://www.pinnacle.com/',
	Origin: 'https://www.pinnacle.com',
};

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

// Fait correspondre le libellé de compétition Unibet/Winamax (ex: "Ligue 1",
// "NBA", "Trophée des Champions") aux compétitions Pinnacle du même sport (ex:
// "France - Ligue 1"). Pinnacle préfixe souvent par le pays ("Pays - Ligue"),
// d'où le test d'inclusion en plus de l'égalité. Retourne les meilleurs
// candidats en premier -- utile quand plusieurs pays partagent un nom générique
// ("Cup", "Premier League") : on essaiera chaque candidat jusqu'à ce qu'un
// match d'équipes soit trouvé, au lieu de se figer sur le premier venu.
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

function matchLeaguesByLabel(leagueList, leagueLabel, countryHint) {
	const raw = normalizeLeagueName(leagueLabel);
	if (!raw) return [];
	const hint = countryHint ? normalizeLeagueName(countryHint) : null;

	// Les libellés Unibet/Winamax incluent parfois un sponsor en suffixe absent
	// chez Pinnacle ("Ligue 2 BKT", "Ligue 1 McDonald's") -- si la chaîne complète
	// ne matche rien, on retente en tronquant le(s) dernier(s) mot(s).
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
		// Bonus si le nom Pinnacle commence par le pays déduit du libellé Unibet/
		// Winamax -- départage les homonymes ("Premier League" existe dans ~20 pays)
		// sans avoir à tous les essayer un par un.
		if (hint && (name.startsWith(`${hint} `) || name.startsWith(`${hint}-`))) bestScore += 2;
		scored.push({ league, score: bestScore });
	}
	scored.sort((a, b) => b.score - a.score);
	// Le score du pays-hint résout l'essentiel des cas courants (grands
	// championnats européens) en un seul essai ; pour le reste (homonymes entre
	// pays sans hint dispo), on tente plusieurs candidats et on laisse la
	// vérification des noms d'équipes trancher -- borné pour rester raisonnable.
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

// Marché "Équipe & Over/Under X.Y" -- pari combiné publié directement par
// Pinnacle, donc probabilité exacte (pas de corrélation à approximer).
function findCombinedWinTotal(leagues, teamName, side, points) {
	const label = `${side === 'over' ? 'Over' : 'Under'} ${points}`;
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findSuffixedTeamYes(leagues, suffix, teamName) {
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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

function findWinToNil(leagues, teamName, period = 0) {
	return findSuffixedTeamYes(leagues, period === 1 ? ' To Win to Nil? 1st Half' : ' To Win to Nil?', teamName);
}

// "TeamX marque" (au moins une fois) -- distinct de "marque en premier"
// (First Team To Score) et "marque exactement N buts" (Exact Team Goals),
// tous deux vérifiés avant ce marché dans parseLegs.
function findTeamToScore(leagues, teamName, period = 0) {
	return findSuffixedTeamYes(leagues, period === 1 ? ' To Score? 1st Half' : ' To Score?', teamName);
}

// Marché "Équipe Goals Odd/Even" -- pair/impair sur les buts d'UNE équipe,
// distinct de "Total Goals Odd/Even" (pair/impair du match entier, déjà géré
// par findSpecialByLabel).
function findTeamGoalsOddEven(leagues, teamName, label) {
	const suffix = ' Goals Odd/Even';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findSpecialByLabel(leagues, description, label) {
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
			if (m.special?.description !== description) continue;
			const part = (m.participants || []).find((p) => p.name === label);
			const price = part ? priceForParticipant(markets, m.id, part.id) : null;
			if (price == null) continue;
			return { league: league.name, decimal: americanToDecimal(price), exact: true };
		}
	}
	return null;
}
function findSpecialByTeam(leagues, description, teamName) {
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findDoubleChance(leagues, teamName, side, period = 0) {
	const description = period === 1 ? 'Double Chance 1st Half' : 'Double Chance';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findExactTeamGoals(leagues, teamName, n, period = 0) {
	const suffix = period === 1 ? ' Goals 1st Half' : ' Goals';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findExactTotalGoals(leagues, n, period = 0) {
	const description = period === 1 ? 'Exact Total Goals 1st Half' : 'Exact Total Goals';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
				!m.parentId &&
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
				!m.parentId &&
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
				!m.parentId &&
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
				!m.parentId &&
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
	const dc = findDoubleChance(leagues, teamName, side, 0);
	const total = findTotal(leagues, teamA, teamB, totalSide, points);
	if (!dc || !total) return null;
	return { league: dc.league, decimal: dc.decimal * total.decimal, exact: false };
}
function findDoubleChanceAndBttsApprox(leagues, teamName, side, teamA, teamB) {
	const dc = findDoubleChance(leagues, teamName, side, 0);
	const btts = findBtts(leagues, teamA, teamB, 0);
	if (!dc || !btts) return null;
	return { league: dc.league, decimal: dc.decimal * btts.decimal, exact: false };
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
function findWinningMargin(leagues, teamName, minMargin, period = 0) {
	const expectedDescription = period === 1 ? 'Winning Margin 1st Half' : 'Winning Margin';
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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

// Combo "toutes les équipes marquent" sans noms d'équipes ("Les 2 équipes
// marquent dans chacun des N matchs à HHhMM") -- les matchs concernés se
// retrouvent via le calendrier Pinnacle de la compétition déjà identifiée :
// tous les matchs qui commencent à cette heure-là aujourd'hui (heure de
// Paris). Si ce n'est pas exactement N matchs, ambigu -> silencieux plutôt
// que de deviner lesquels. BTTS ("Both Teams To Score?") est un marché direct
// Pinnacle, donc chaque leg est exacte ; matchs différents = indépendants.
function findScheduleBtts(leagues, count, hour, minute) {
	const now = new Date();
	const todayParts = new Intl.DateTimeFormat('fr-FR', {
		timeZone: 'Europe/Paris',
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).formatToParts(now);
	const today = `${todayParts.find((p) => p.type === 'year').value}-${todayParts.find((p) => p.type === 'month').value}-${todayParts.find((p) => p.type === 'day').value}`;

	for (const { league, matchups, markets } of leagues) {
		const matching = matchups.filter((m) => {
			if (m.parentId || m.type !== 'matchup' || !m.startTime) return false;
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
			const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
			const mi = parseInt(parts.find((p) => p.type === 'minute').value, 10);
			return date === today && h === hour && mi === minute;
		});
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

// period 0 = match complet, period 1 = 1ère mi-temps (foot/hand/etc.) -- même
// marché "moneyline" chez Pinnacle, juste une période différente.
function findMoneyline(leagues, teamA, teamB, period = 0) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				!m.parentId && // exclut les marchés spéciaux/props (ex: "team to score first") qui
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

function findTotal(leagues, teamA, teamB, side, points) {
	for (const { league, matchups, markets } of leagues) {
		const matchup = matchups.find(
			(m) =>
				!m.parentId &&
				m.participants?.length === 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;
		const market = markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'total' && mk.period === 0 && mk.prices?.[0]?.points === points);
		if (!market) continue;
		const p = market.prices.find((pr) => pr.designation === side);
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
	const d = stripDiacritics(description || '');

	// Combo multi-matchs : "TeamA (vs OppA), TeamB (vs OppB) et TeamC (vs OppC)
	// gagnent chacun de N buts/points ou plus" -- la condition de marge est partagée.
	const marginAll = d.match(/gagnent?\s+chacun\s+(?:de\s+)?(\d+)\s*(?:buts?|points?|runs?)\s+ou\s+plus/i);
	if (marginAll) {
		const margin = parseInt(marginAll[1], 10);
		const teamPattern = /(?:^|,\s*|-\s|et\s)([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\s*\(vs\.?\s+([A-ZÀ-Ý][\w.'-]*(?:\s[A-ZÀ-Ý][\w.'-]*)*)\)/g;
		const legs = [];
		let m;
		while ((m = teamPattern.exec(d)) !== null) {
			legs.push({ type: 'margin', team: m[1].trim(), margin, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs sur total : "Plus/Moins de X buts/points/runs lors de
	// chacun des matchs suivants : TeamA - TeamB et TeamC - TeamD[, TeamE - TeamF]"
	// -- matchs différents = événements indépendants, multiplication exacte.
	const multiTotalMatch = d.match(
		/(plus|moins) de (\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?)\s+(?:lors de |dans )?chacun des matchs suivants\s*:\s*(.+)/i
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
			const m2 = pair.match(/^([A-ZÀ-Ý][\w .'-]*?)\s*-\s*([A-ZÀ-Ý][\w .'-]*?)$/);
			if (!m2) continue;
			legs.push({ type: 'total', teamA: m2[1].trim(), teamB: m2[2].trim(), side, points, sport: sportKey });
		}
		if (legs.length >= 2) return legs;
	}

	// Combo multi-matchs sur victoire simple : "TeamA et TeamB gagnent chacun
	// leur match (respectivement contre OppA et OppB)" -- pas de total/marge,
	// juste une victoire par match, matchs différents = indépendants. Variante
	// "la première mi-temps" -> même marché Pinnacle "moneyline" mais period 1.
	const multiMoneylineMatch = d.match(
		/(.+?)\s+gagnent\s+chacun\s+(leur\s+match|la\s+premiere\s+mi-?temps)\s*\(respectivement\s+contre\s+(.+?)\)/i
	);
	if (multiMoneylineMatch) {
		const period = /premiere/i.test(multiMoneylineMatch[2]) ? 1 : 0;
		const teamNames = multiMoneylineMatch[1].split(/\s+et\s+/).map((s) => s.trim());
		const oppNames = multiMoneylineMatch[3].split(/\s+et\s+/).map((s) => s.trim());
		if (teamNames.length >= 2 && teamNames.length === oppNames.length) {
			return teamNames.map((team, i) => ({ type: 'moneyline', teamA: team, teamB: oppNames[i], team, period, sport: sportKey }));
		}
	}

	// Combo "toutes les équipes marquent" SANS noms d'équipes -- juste une heure
	// de coup d'envoi partagée et un nombre de matchs ("Les 2 équipes marquent
	// dans chacun des 3 matchs à 13h00"). Pas de nom à faire correspondre : les
	// matchs concernés se retrouvent via le calendrier Pinnacle de la même
	// compétition (heure + date du jour) -- voir resolveScheduleBtts.
	const scheduleBttsMatch =
		/les\s+2\s+equipes|les\s+deux\s+equipes/i.test(d) &&
		d.match(/marquent\s+dans\s+chacun\s+des\s+(\d+)\s+matchs?\s+a\s+(\d{1,2})h(\d{2})?/i);
	if (scheduleBttsMatch) {
		return [
			{
				type: 'scheduleBtts',
				count: parseInt(scheduleBttsMatch[1], 10),
				hour: parseInt(scheduleBttsMatch[2], 10),
				minute: scheduleBttsMatch[3] ? parseInt(scheduleBttsMatch[3], 10) : 0,
				sport: sportKey,
			},
		];
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
		d.match(/^(.+?)\s+ou\s+(?:le\s+)?match\s+nul\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i) ||
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
		/^(?:le\s+)?match\s+nul\s+ou\s+(.+?)\s+et\s+(plus|moins)\s+de\s+(\d+(?:[.,]\d+)?)\s*buts?/i
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
		d.match(/^(.+?)\s+ou\s+(?:le\s+)?match\s+nul\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i) ||
		d.match(/^double\s+chance\s*:?\s*(.+?)\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i);
	if (dcTeamAndBttsMatch) {
		const cand = dcTeamAndBttsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChanceAndBtts', team, side: 'teamOrDraw', teamA, teamB, sport: sportKey }];
	}
	const dcDrawAndBttsMatch = d.match(
		/^(?:le\s+)?match\s+nul\s+ou\s+(.+?)\s+et\s+les\s+(?:2|deux)\s+equipes\s+marquent\b/i
	);
	if (dcDrawAndBttsMatch) {
		const cand = dcDrawAndBttsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChanceAndBtts', team, side: 'drawOrTeam', teamA, teamB, sport: sportKey }];
	}

	// "TeamX mène à la mi-temps et gagne le match" (même équipe aux deux
	// bouts) / "...et TeamY gagne le match" (équipes différentes) / "Match nul
	// à la mi-temps et TeamX gagne le match" / "TeamX mène à la mi-temps et
	// match nul (à la fin)" -- marché Pinnacle direct "Half-Time/Full-Time".
	const htftSameTeamMatch = d.match(/^(.+?)\s+m[eè]ne\s+[aà]\s+la\s+mi-?temps\s+et\s+gagne(?:\s+le\s+match)?\.?\s*$/i);
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

	// "Les 2/deux équipes marquent" (même match, pas de combo multi-matchs --
	// déjà géré plus haut) -- marché Pinnacle direct "Both Teams To Score?".
	if (/les\s+(?:2|deux)\s+equipes\s+marquent\b/i.test(d)) {
		return [{ type: 'btts', teamA, teamB, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX ou match nul" / "Double chance TeamX" -> Pinnacle "TeamX Or Draw" ;
	// "Match nul ou TeamY" -> "Draw Or TeamY". Marché "Double Chance" direct.
	const teamOrDrawMatch =
		d.match(/^(.+?)\s+ou\s+(?:le\s+)?match\s+nul\.?\s*$/i) || d.match(/^double\s+chance\s*:?\s*(.+?)\.?\s*$/i);
	if (teamOrDrawMatch) {
		const cand = teamOrDrawMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChance', team, side: 'teamOrDraw', period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}
	const drawOrTeamMatch = d.match(/^(?:le\s+)?match\s+nul\s+ou\s+(.+?)\.?\s*$/i);
	if (drawOrTeamMatch) {
		const cand = drawOrTeamMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'doubleChance', team, side: 'drawOrTeam', period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX ne perd pas" -- marché Pinnacle direct "Draw No Bet" (mise
	// remboursée en cas de nul, pas une combinaison à calculer).
	const drawNoBetMatch = d.match(/^(.+?)\s+ne\s+perd\s+pas(?:\s+(?:ce|le)\s+match)?\.?\s*$/i);
	if (drawNoBetMatch) {
		const cand = drawNoBetMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'drawNoBet', team, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX marque en premier" / "TeamX marque le premier but" -- marché
	// Pinnacle direct "First Team To Score" (Team/Team/Neither).
	const firstToScoreMatch =
		d.match(/^(.+?)\s+(?:marque|inscrit)\s+(?:le\s+)?premi[eè]re?\s+but\b/i) ||
		d.match(/^(.+?)\s+marque\s+en\s+premier\b/i);
	if (firstToScoreMatch) {
		const cand = firstToScoreMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'firstToScore', team, period: isFirstHalf ? 1 : 0, sport: sportKey }];
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
			return [{ type: 'teamGoalsOddEven', team, label: /impair/i.test(teamOddEvenMatch[2]) ? 'Odd' : 'Even', sport: sportKey }];
		}
	}

	// "Nombre/total de buts pair/impair" -- marché Pinnacle direct "Total
	// Goals Odd/Even".
	const oddEvenMatch = d.match(/(?:nombre|total)\s+(?:de\s+)?buts?\s+(impair|pair)\b/i);
	if (oddEvenMatch) {
		return [{ type: 'oddEvenTotal', label: /impair/i.test(oddEvenMatch[1]) ? 'Odd' : 'Even', period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX marque exactement N buts" -- marché Pinnacle direct "TeamX Goals".
	const exactTeamGoalsMatch = d.match(/^(.+?)\s+marque\s+exactement\s+(\d+)\s*buts?\b/i);
	if (exactTeamGoalsMatch) {
		const cand = exactTeamGoalsMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) {
			return [
				{ type: 'exactTeamGoals', team, n: parseInt(exactTeamGoalsMatch[2], 10), period: isFirstHalf ? 1 : 0, sport: sportKey },
			];
		}
	}

	// "Exactement N buts au total / dans le match" -- marché Pinnacle direct
	// "Exact Total Goals" (pas lié à une équipe précise).
	const exactTotalGoalsMatch = d.match(/exactement\s+(\d+)\s*buts?\s+(?:au\s+total|dans\s+le\s+match|marques?)\b/i);
	if (exactTotalGoalsMatch) {
		return [{ type: 'exactTotalGoals', n: parseInt(exactTotalGoalsMatch[1], 10), period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	// "TeamX marque" (au moins une fois), bare -- marché Pinnacle direct
	// "TeamX To Score?". Vérifié en dernier parmi les marchés "marque" : les
	// variantes plus spécifiques ("en premier", "exactement N buts") sont
	// déjà retournées plus haut si elles correspondent.
	const teamToScoreMatch = d.match(/^(.+?)\s+marque(?:\s+(?:au\s+moins\s+une\s+fois|un\s+but))?\.?\s*$/i);
	if (teamToScoreMatch) {
		const cand = teamToScoreMatch[1].trim();
		const team = isExactlyTeamName(teamA, cand) ? teamA : isExactlyTeamName(teamB, cand) ? teamB : null;
		if (team) return [{ type: 'teamToScore', team, period: isFirstHalf ? 1 : 0, sport: sportKey }];
	}

	const totalMatch = d.match(/(plus|moins) de (\d+(?:[.,]\d+)?)\s*(?:buts?|points?|runs?)/i);
	// Deux formulations existent pour la marge de victoire : "gagne par/de N
	// buts ou plus" et "gagne par au moins N buts d'écart".
	const marginMatch =
		d.match(/gagne\s+(?:par|de)\s+(\d+)\s*(?:buts?|points?|runs?)\s+ou\s+plus/i) ||
		d.match(/gagne\s+par\s+au\s+moins\s+(\d+)\s*(?:buts?|points?|runs?)(?:\s+d.ecart)?/i);
	const correctScoreMatch =
		winningTeam &&
		d.match(/gagne\s+le\s+match\s+((?:\d+\s*-\s*\d+\s*(?:,\s*|\s+ou\s+))+\d+\s*-\s*\d+)\.?\s*$/i);

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
	if (winningTeam && marginMatch) {
		return [
			{
				type: 'margin',
				team: winningTeam,
				opponent: winningTeam === teamA ? teamB : teamA,
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
				sport: sportKey,
			},
		];
	}
	if (correctScoreMatch) {
		// "TeamX gagne le match A-B, C-D ou E-F" -- somme exacte des scores exacts
		// concernés via le marché "Correct Score" de Pinnacle.
		const scoreLines = [...correctScoreMatch[1].matchAll(/(\d+)\s*-\s*(\d+)/g)].map((m) => [
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
	const m = d.match(/^([A-ZÀ-Ý][\w .'-]*?)\s+gagne\b/i);
	return m ? m[1].trim() : '';
}

// Comparaison stricte pour valider qu'un texte extrait EST le nom d'équipe,
// pas juste teamsMatch (inclusion de sous-chaîne trop permissive pour ce cas
// précis) -- sinon "Mohamed Salah buteur et Trabzonspor" se fait prendre pour
// le nom de l'équipe "Trabzonspor" juste parce que la chaîne se termine par
// ce nom, et un pari combiné but+victoire se fait passer pour une simple
// victoire (mauvaise cote de référence, pire qu'aucune référence).
function isExactlyTeamName(candidate, teamName) {
	const nc = normalizeTeam(candidate);
	const nt = normalizeTeam(teamName);
	if (!nc || !nt) return false;
	if (nc === nt) return true;
	if (Math.abs(nc.length - nt.length) > 4) return false; // texte bien plus long -> suspect
	return teamsMatch(candidate, teamName);
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
		const direct = findCombinedWinTotal(leagues, leg.team, leg.side, leg.points);
		if (direct) return direct;
		return null; // pas d'approximation : silencieux si le marché combiné direct n'existe pas
	}
	if (leg.type === 'margin') {
		return findWinningMargin(leagues, leg.team, leg.margin, leg.period || 0);
	}
	if (leg.type === 'total') {
		return findTotal(leagues, leg.teamA, leg.teamB, leg.side, leg.points);
	}
	if (leg.type === 'correctScore') {
		return findCorrectScoreSum(leagues, leg.team, leg.opponent, leg.scoreLines, leg.period || 0);
	}
	if (leg.type === 'winToNil') {
		return findWinToNil(leagues, leg.team, leg.period || 0);
	}
	if (leg.type === 'btts') {
		return findBtts(leagues, leg.teamA, leg.teamB, leg.period || 0);
	}
	if (leg.type === 'doubleChance') {
		return findDoubleChance(leagues, leg.team, leg.side, leg.period || 0);
	}
	if (leg.type === 'drawNoBet') {
		return findSpecialByTeam(leagues, leg.period === 1 ? 'Draw No Bet 1st Half' : 'Draw No Bet', leg.team);
	}
	if (leg.type === 'firstToScore') {
		return findSpecialByTeam(leagues, leg.period === 1 ? 'First Team To Score 1st Half' : 'First Team To Score', leg.team);
	}
	if (leg.type === 'oddEvenTotal') {
		return findSpecialByLabel(leagues, leg.period === 1 ? 'Total Goals Odd/Even 1st Half' : 'Total Goals Odd/Even', leg.label);
	}
	if (leg.type === 'exactTeamGoals') {
		return findExactTeamGoals(leagues, leg.team, leg.n, leg.period || 0);
	}
	if (leg.type === 'exactTotalGoals') {
		return findExactTotalGoals(leagues, leg.n, leg.period || 0);
	}
	if (leg.type === 'teamToScore') {
		return findTeamToScore(leagues, leg.team, leg.period || 0);
	}
	if (leg.type === 'teamGoalsOddEven') {
		return findTeamGoalsOddEven(leagues, leg.team, leg.label);
	}
	if (leg.type === 'playerProp') {
		return findPlayerProp(leagues, leg.player, leg.statLabel, leg.side, leg.threshold);
	}
	if (leg.type === 'bttsAndTotal') {
		return findBttsAndTotal(leagues, leg.teamA, leg.teamB, leg.side, leg.points);
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
	if (leg.type === 'scheduleBtts') {
		return findScheduleBtts(leagues, leg.count, leg.hour, leg.minute);
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
		return { type: 'single', league: resolved[0].league, decimal: resolved[0].decimal, exact: resolved[0].exact };
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
		})),
		decimal: 1 / probProduct,
		exact: true, // matchs différents = événements indépendants, pas d'approximation
		legCount: resolved.length,
	};
}

// Quand le sport n'est pas connu avec certitude (ex: Winamax ne fournit pas de
// champ sport fiable pour ses cotes boostées -- juste un titre libre, souvent
// sans aucun mot-clé sport dedans), on essaie chaque sport supporté à tour de
// rôle plutôt que d'abandonner. Le parsing du texte (parseLegs) est gratuit et
// identique quel que soit le sport essayé ; seul un sport qui matche vraiment
// déclenche des appels réseau. Foot en premier : de loin le plus fréquent.
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
		const approxTag = ref.exact === false ? ' ⚠️ approximatif (corrélation non prise en compte)' : '';
		return `📊 Pinnacle (${ref.league}) : ${ref.decimal.toFixed(2)}${approxTag}${edgeSuffix(boostDecimal, ref.decimal)}`;
	}
	if (ref.type === 'combo') {
		const breakdown = ref.legs.map((l) => `${l.label} : ${l.decimal.toFixed(2)}`).join('\n');
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
	const lines = [`${icon} ${label} — UNIBET`, ``, boost.eventName, boost.description];
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

async function formatMonitoringMessage(event) {
	const { type, boost, prevOdds } = event;
	const lines = buildMonitoringBodyLines(type, boost, prevOdds);

	// Référence Pinnacle : uniquement pour les nouvelles cotes, uniquement si un
	// pari équivalent (victoire simple / total buts) existe sur une grande ligue.
	let refLine = null;
	let edge = null;
	if (type === 'add') {
		try {
			const ref = await findPinnacleReference(boost.eventName, boost.description, boost.league, boost.sport);
			const boostDecimal = parseFrenchDecimal(boost.newOdds);
			const pinnacleDecimal = refComparableDecimal(ref);
			edge = boostDecimal && pinnacleDecimal ? (boostDecimal / pinnacleDecimal - 1) * 100 : null;
			refLine = formatPinnacleReference(ref, boostDecimal);
			if (refLine) lines.push(``, refLine);
		} catch {
			// silencieux : pas de reference dispo ne doit jamais bloquer l'alerte
		}
	}

	return { text: lines.join('\n'), refLine, edge };
}

const PIN_TRACK_TTL_SECONDS = SEEN_TTL_SECONDS; // même durée de vie qu'un boost "vu"

async function postMonitoringDiff(env, prevBoosts, currentBoosts) {
	if (!env.MONITORING_CHAT_ID || !prevBoosts) return;
	const events = diffBoosts(prevBoosts, currentBoosts);
	for (const event of events) {
		const { text, refLine, edge } = await formatMonitoringMessage(event);
		const sent = await sendToChat(env, env.MONITORING_CHAT_ID, text);

		if (event.type === 'add') {
			if (refLine && sent?.message_id) {
				// On garde de quoi revérifier et éditer ce message si la cote Pinnacle
				// bouge avant le début du match (voir refreshTrackedPinnacleRefs).
				await env.SEEN_BOOSTS.put(
					`pintrack:${event.boost.marketId}`,
					JSON.stringify({ chatId: env.MONITORING_CHAT_ID, messageId: sent.message_id, boost: event.boost, lastRefLine: refLine }),
					{ expirationTtl: PIN_TRACK_TTL_SECONDS }
				);
			}
			// Digest quotidien : toutes les cotes "classiques" suivies en monitoring,
			// pas seulement le sous-ensemble flash (≤10€, dispo quelques minutes)
			// qui part sur le canal public.
			try {
				await logDigestItem(env, event.boost, edge);
			} catch {
				// silencieux : le digest est une info secondaire
			}
		}
		if (event.type === 'remove') {
			// Le match est passé/le boost a disparu -- plus la peine de le revérifier.
			await env.SEEN_BOOSTS.delete(`pintrack:${event.boost.marketId}`);
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
			const refLine = formatPinnacleReference(ref, parseFrenchDecimal(boost.newOdds));
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

async function checkAndPost(env) {
	const res = await fetch(UNIBET_URL, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		},
	});
	if (!res.ok) {
		console.log(`Unibet fetch failed: ${res.status}`);
		return { checked: 0, posted: 0 };
	}
	const html = await res.text();
	const boosts = parseBoosts(html);
	const eligible = boosts.filter((b) => b.maxStake <= MAX_STAKE_EUR);

	// Lu AVANT d'écraser : sert de base de comparaison pour le suivi perso.
	const prevRaw = await env.SEEN_BOOSTS.get('current_snapshot');
	const prevBoosts = prevRaw ? JSON.parse(prevRaw).boosts : null;

	// Instantané complet (toutes les cotes, pas seulement les éligibles flash) pour
	// le tableau de suivi perso -- lu par /current, jamais re-scrapé à chaque visite.
	await env.SEEN_BOOSTS.put(
		'current_snapshot',
		JSON.stringify({ updatedAt: Date.now(), boosts }),
		{ expirationTtl: 15 * 60 }
	);
	await postMonitoringDiff(env, prevBoosts, boosts);
	await refreshTrackedPinnacleRefs(env);

	let posted = 0;
	for (const boost of eligible) {
		const key = `seen:${boost.marketId}:${boost.newOdds}`;
		const already = await env.SEEN_BOOSTS.get(key);
		if (already) continue;

		await sendTelegramMessage(env, formatTelegramMessage(boost));
		await env.SEEN_BOOSTS.put(key, '1', { expirationTtl: SEEN_TTL_SECONDS });
		posted++;
	}
	return { checked: boosts.length, eligible: eligible.length, posted };
}

export default {
	async fetch(request, env) {
		// Endpoint manuel pour tester/déclencher à la main (voir README).
		const url = new URL(request.url);
		if (url.pathname === '/run') {
			const result = await checkAndPost(env);
			return new Response(JSON.stringify(result), {
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (url.pathname === '/current') {
			const raw = await env.SEEN_BOOSTS.get('current_snapshot');
			return new Response(raw || JSON.stringify({ updatedAt: null, boosts: [] }), {
				headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			});
		}
		if (url.pathname === '/backfill-pinnacle') {
			const result = await backfillPinnacleRefs(env);
			return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/digest-data') {
			const date = url.searchParams.get('date') || todayKey();
			const stats = await computeDigestStats(env, date);
			return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/telegram-webhook' && request.method === 'POST') {
			// Vérifie que la requête vient bien de Telegram (secret configuré via
			// setWebhook), pas d'un tiers qui aurait deviné l'URL.
			if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
				return new Response('Forbidden', { status: 403 });
			}
			const update = await request.json().catch(() => null);
			console.log('telegram-webhook update:', JSON.stringify(update));
			const msg = update?.message || update?.channel_post;
			const text = (msg?.text || '').trim();
			// Réservé à l'usage perso (canal privé de monitoring) -- pas une
			// commande publique, on ignore tout le reste silencieusement. Restera
			// fermé (rien ne s'exécute) tant que MONITORING_CHAT_ID n'est pas
			// corrigé -- volontaire : mieux vaut échouer fermé qu'ouvert à tous.
			if (msg && String(msg.chat?.id) === String(env.MONITORING_CHAT_ID) && /^\/check\b/i.test(text)) {
				const args = text.replace(/^\/check\s*/i, '').trim();
				const teams = splitTeams(args);
				let reply;
				if (!teams) {
					reply = 'Format : /check Équipe1 - Équipe2';
				} else {
					const [teamA, teamB] = teams;
					try {
						const ref = await findPinnacleReference(`${teamA} - ${teamB}`, 'Résultat du match', null, null);
						reply = formatPinnacleReference(ref, null) || `Aucune référence Pinnacle trouvée pour ${teamA} - ${teamB}.`;
					} catch (e) {
						reply = `Erreur pendant la recherche : ${String(e)}`;
					}
				}
				await sendToChat(env, msg.chat.id, reply);
			}
			return new Response('OK', { status: 200 });
		}
		return new Response('OK. Utilise /run pour déclencher un check manuel, /current pour le suivi.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(checkAndPost(env));
	},
};
