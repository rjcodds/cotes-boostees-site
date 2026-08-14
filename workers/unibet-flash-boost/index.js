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
// PINNACLE_SPORTS plus bas) -- les autres (rugby, handball, volley, boxe,
// cyclisme, golf, snooker, fléchettes) sont soit bloqués côté API Pinnacle
// (401 sans authentification), soit hors du modèle "équipe A vs équipe B".
const PINNACLE_SPORT_KEY_BY_LABEL = {
	Football: 'football',
	Basketball: 'basketball',
	Tennis: 'tennis',
	Baseball: 'baseball',
	'Hockey sur glace': 'hockey',
	MMA: 'mma',
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

// Sports Pinnacle accessibles sans authentification via l'API "guest" publique
// (vérifié empiriquement : handball, volleyball, rugby, boxe et cyclisme renvoient
// tous 401 "No authorization token provided" sur ce endpoint -- probablement une
// restriction de licence par sport, pas contournable côté client).
const PINNACLE_SPORTS = {
	football: 29, // "Soccer" chez Pinnacle -- ne pas confondre avec leur sport "Football" (NFL)
	basketball: 4,
	tennis: 33,
	baseball: 3,
	hockey: 19,
	mma: 22,
};

// Emoji en tête de l'eventName (posé par formatEventName / SPORT_EMOJI) -> sport
// Pinnacle correspondant. Les sports absents (rugby, handball, volley, cyclisme,
// golf, snooker, fléchettes) sont soit bloqués côté API, soit incompatibles avec
// le modèle "équipe A vs équipe B" -- on les ignore silencieusement.
const SPORT_KEY_BY_EMOJI = {
	'⚽': 'football',
	'🏀': 'basketball',
	'🎾': 'tennis',
	'⚾': 'baseball',
	'🏒': 'hockey',
	'🥊': 'mma',
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

function teamsMatch(a, b) {
	const na = normalizeTeam(a);
	const nb = normalizeTeam(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.includes(nb) || nb.includes(na)) return true;
	const wordsA = [...new Set(na.split(' ').filter((w) => w.length > 2))];
	const wordsB = [...new Set(nb.split(' ').filter((w) => w.length > 2))];
	if (!wordsA.length || !wordsB.length) return false;
	let overlap = 0;
	for (const w of wordsA) if (wordsB.some((x) => wordsFuzzyMatch(w, x))) overlap++;
	return overlap >= Math.min(wordsA.length, wordsB.length) * 0.5;
}

function americanToDecimal(american) {
	return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

async function fetchLeagueData(leagueId) {
	const headers = {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	};
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
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			},
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

// Marché "Équipe By N" / "Équipe By N+" (marge de victoire) -- somme les
// probabilités de toutes les marges >= au seuil demandé. Exact (pas d'approximation).
function findWinningMargin(leagues, teamName, minMargin) {
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
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
function findCorrectScoreSum(leagues, teamName, opponentName, scoreLines) {
	for (const { league, matchups, markets } of leagues) {
		for (const m of matchups) {
			if (m.special?.description !== 'Correct Score') continue;
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

function findMoneyline(leagues, teamA, teamB) {
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
		const market = markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'moneyline' && mk.period === 0);
		if (!market) continue;
		return { league: league.name, market };
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
	const marginAll = d.match(/gagnent?\s+chacun\s+(?:de\s+)?(\d+)\s*(?:buts?|points?)\s+ou\s+plus/i);
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

	// Pari même-match combiné : "TeamX gagne et Plus/Moins de Y buts/points"
	const teams = splitTeams(eventName);
	if (!teams) return null;
	const [teamA, teamB] = teams;

	const winningTeam = teamsMatch(teamA, extractWinner(d)) ? teamA : teamsMatch(teamB, extractWinner(d)) ? teamB : null;

	const totalMatch = d.match(/(plus|moins) de (\d+(?:[.,]\d+)?)\s*(?:buts?|points?)/i);
	const marginMatch = d.match(/gagne\s+(?:par|de)\s+(\d+)\s*(?:buts?|points?)\s+ou\s+plus/i);
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
		return [{ type: 'moneyline', teamA, teamB, sport: sportKey }];
	}
	return null;
}

function extractWinner(d) {
	const m = d.match(/^([A-ZÀ-Ý][\w .'-]*?)\s+gagne\b/i);
	return m ? m[1].trim() : '';
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
		return findWinningMargin(leagues, leg.team, leg.margin);
	}
	if (leg.type === 'total') {
		return findTotal(leagues, leg.teamA, leg.teamB, leg.side, leg.points);
	}
	if (leg.type === 'correctScore') {
		return findCorrectScoreSum(leagues, leg.team, leg.opponent, leg.scoreLines);
	}
	if (leg.type === 'moneyline') {
		const found = findMoneyline(leagues, leg.teamA, leg.teamB);
		if (!found) return null;
		const home = found.market.prices.find((p) => p.designation === 'home');
		const away = found.market.prices.find((p) => p.designation === 'away');
		const draw = found.market.prices.find((p) => p.designation === 'draw');
		return { league: found.league, moneyline: { home, away, draw } };
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
		return { type: 'moneyline', league: resolved[0].league, moneyline: resolved[0].moneyline };
	}
	if (resolved.length === 1) {
		return { type: 'single', league: resolved[0].league, decimal: resolved[0].decimal, exact: resolved[0].exact };
	}
	// combo multi-matchs : legs indépendantes (matchs différents) -> multiplication exacte
	let probProduct = 1;
	for (const r of resolved) probProduct *= 1 / r.decimal;
	return {
		type: 'combo',
		legues: [...new Set(resolved.map((r) => r.league))],
		legs: resolved.map((r, i) => ({
			label: legs[i].teamA ? `${legs[i].teamA} - ${legs[i].teamB}` : legs[i].team,
			decimal: r.decimal,
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
	const sportsToTry = sportKey ? [sportKey] : Object.keys(PINNACLE_SPORTS);
	for (const sport of sportsToTry) {
		const ref = await findPinnacleReferenceForSport(eventName, description, leagueLabel, sport);
		if (ref) return ref;
	}
	return null;
}

function formatPinnacleReference(ref) {
	if (!ref) return null;
	if (ref.type === 'moneyline') {
		const { home, away, draw } = ref.moneyline;
		const parts = [];
		if (home) parts.push(`1: ${americanToDecimal(home.price).toFixed(2)}`);
		if (draw) parts.push(`N: ${americanToDecimal(draw.price).toFixed(2)}`);
		if (away) parts.push(`2: ${americanToDecimal(away.price).toFixed(2)}`);
		return `📊 Pinnacle (${ref.league}) : ${parts.join(' · ')}`;
	}
	if (ref.type === 'single') {
		return `📊 Pinnacle (${ref.league}) : ${ref.decimal.toFixed(2)}`;
	}
	if (ref.type === 'combo') {
		const breakdown = ref.legs.map((l) => `${l.label} : ${l.decimal.toFixed(2)}`).join('\n');
		const product = ref.legs.map((l) => l.decimal.toFixed(2)).join(' × ');
		return `📊 Pinnacle (combo ${ref.legCount} matchs) :\n${breakdown}\n${product} = ${ref.decimal.toFixed(2)}`;
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
	if (type === 'add') {
		try {
			const ref = await findPinnacleReference(boost.eventName, boost.description, boost.league, boost.sport);
			refLine = formatPinnacleReference(ref);
			if (refLine) lines.push(``, refLine);
		} catch {
			// silencieux : pas de reference dispo ne doit jamais bloquer l'alerte
		}
	}

	return { text: lines.join('\n'), refLine };
}

const PIN_TRACK_TTL_SECONDS = SEEN_TTL_SECONDS; // même durée de vie qu'un boost "vu"

async function postMonitoringDiff(env, prevBoosts, currentBoosts) {
	if (!env.MONITORING_CHAT_ID || !prevBoosts) return;
	const events = diffBoosts(prevBoosts, currentBoosts);
	for (const event of events) {
		const { text, refLine } = await formatMonitoringMessage(event);
		const sent = await sendToChat(env, env.MONITORING_CHAT_ID, text);

		if (event.type === 'add' && refLine && sent?.message_id) {
			// On garde de quoi revérifier et éditer ce message si la cote Pinnacle
			// bouge avant le début du match (voir refreshTrackedPinnacleRefs).
			await env.SEEN_BOOSTS.put(
				`pintrack:${event.boost.marketId}`,
				JSON.stringify({ chatId: env.MONITORING_CHAT_ID, messageId: sent.message_id, boost: event.boost, lastRefLine: refLine }),
				{ expirationTtl: PIN_TRACK_TTL_SECONDS }
			);
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
			const newRefLine = formatPinnacleReference(ref);
			if (!newRefLine || newRefLine === tracked.lastRefLine) continue;

			await editMessageText(env, tracked.chatId, tracked.messageId, rebuildAddMessageText(tracked.boost, newRefLine));
			tracked.lastRefLine = newRefLine;
			await env.SEEN_BOOSTS.put(key.name, JSON.stringify(tracked), { expirationTtl: PIN_TRACK_TTL_SECONDS });
		} catch (e) {
			console.log('refreshTrackedPinnacleRefs failed for', key.name, ':', String(e));
		}
	}
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
		return new Response('OK. Utilise /run pour déclencher un check manuel, /current pour le suivi.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(checkAndPost(env));
	},
};
