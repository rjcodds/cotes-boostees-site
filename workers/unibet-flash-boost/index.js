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
}

async function sendTelegramMessage(env, text) {
	return sendToChat(env, env.TELEGRAM_CHAT_ID, text);
}

// Recherche une cote de référence Pinnacle (bookmaker "sharp") pour une cote
// boostée détectée sur Unibet/Winamax -- limité aux grandes compétitions et
// aux paris simples (victoire/nul/défaite, total de buts). Silencieux si rien
// n'est trouvé : beaucoup de paris boostés (spéciaux, exotiques) n'ont pas
// d'équivalent direct.

const PINNACLE_LEAGUES = [
	{ id: 1980, name: 'England - Premier League' },
	{ id: 2036, name: 'France - Ligue 1' },
	{ id: 2037, name: 'France - Ligue 2' },
	{ id: 2035, name: 'France - Super Cup' }, // Trophée des Champions
	{ id: 1842, name: 'Germany - Bundesliga' },
	{ id: 1843, name: 'Germany - Bundesliga 2' },
	{ id: 2054, name: 'Germany - Super Cup' },
	{ id: 2436, name: 'Italy - Serie A' },
	{ id: 2196, name: 'Spain - La Liga' },
	{ id: 1928, name: 'Netherlands - Eredivisie' },
	{ id: 2627, name: 'UEFA - Champions League' },
	{ id: 2632, name: 'UEFA - Europa League Qualifiers' },
	{ id: 271382, name: 'UEFA - Conference League Qualifiers' },
	{ id: 205451, name: 'UEFA - Champions League Qualifiers' },
];

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

function teamsMatch(a, b) {
	const na = normalizeTeam(a);
	const nb = normalizeTeam(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.includes(nb) || nb.includes(na)) return true;
	const wordsA = new Set(na.split(' ').filter((w) => w.length > 2));
	const wordsB = new Set(nb.split(' ').filter((w) => w.length > 2));
	if (!wordsA.size || !wordsB.size) return false;
	let overlap = 0;
	for (const w of wordsA) if (wordsB.has(w)) overlap++;
	return overlap >= Math.min(wordsA.size, wordsB.size) * 0.5;
}

// Extrait "TeamA - TeamB" ou "TeamA vs TeamB" d'un nom d'événement, en
// retirant emoji/drapeaux éventuellement présents devant.
function splitTeams(eventName) {
	const cleaned = (eventName || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
	const parts = cleaned.split(/\s+(?:-|vs\.?)\s+/i);
	if (parts.length !== 2) return null;
	return [parts[0].trim(), parts[1].trim().replace(/\s*[\u{1F1E6}-\u{1F1FF}]+\s*$/gu, '').trim()];
}

// Classe le type de pari à partir du texte français libre -- forcément
// approximatif, ne couvre que les paris simples (pas BTTS, pas les spéciaux).
function classifyBetType(description) {
	const d = stripDiacritics(description || '').toLowerCase();
	let m = d.match(/plus de (\d+(?:[.,]\d+)?)\s*buts?/);
	if (m) return { type: 'total', side: 'over', points: parseFloat(m[1].replace(',', '.')) };
	m = d.match(/moins de (\d+(?:[.,]\d+)?)\s*buts?/);
	if (m) return { type: 'total', side: 'under', points: parseFloat(m[1].replace(',', '.')) };
	if (/resultat du match|resultat final|1x2|double chance/.test(d)) return { type: 'moneyline' };
	return null;
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

// Cherche une cote Pinnacle correspondant au pari boosté (mêmes équipes, même
// type de pari simple). Retourne {decimalOdds, americanOdds, matchupId} ou null.
async function findPinnacleReference(eventName, description) {
	const teams = splitTeams(eventName);
	const betType = classifyBetType(description);
	if (!teams || !betType) return null;
	const [teamA, teamB] = teams;

	const results = await Promise.all(
		PINNACLE_LEAGUES.map(async (league) => {
			try {
				const data = await fetchLeagueData(league.id);
				return data ? { league, data } : null;
			} catch {
				return null;
			}
		})
	);

	for (const entry of results) {
		if (!entry) continue;
		const { league, data } = entry;
		const matchup = data.matchups.find(
			(m) =>
				m.participants?.length >= 2 &&
				((teamsMatch(m.participants[0]?.name, teamA) && teamsMatch(m.participants[1]?.name, teamB)) ||
					(teamsMatch(m.participants[0]?.name, teamB) && teamsMatch(m.participants[1]?.name, teamA)))
		);
		if (!matchup) continue;

		if (betType.type === 'moneyline') {
			const market = data.markets.find((mk) => mk.matchupId === matchup.id && mk.type === 'moneyline' && mk.period === 0);
			if (!market) return null;
			return { league: league.name, market, betType };
		}
		if (betType.type === 'total') {
			const market = data.markets.find(
				(mk) => mk.matchupId === matchup.id && mk.type === 'total' && mk.period === 0 && mk.prices?.[0]?.points === betType.points
			);
			if (!market) return null;
			return { league: league.name, market, betType };
		}
	}
	return null;
}

function formatPinnacleReference(ref) {
	if (!ref) return null;
	const { market, betType, league } = ref;
	if (betType.type === 'moneyline') {
		const home = market.prices.find((p) => p.designation === 'home');
		const away = market.prices.find((p) => p.designation === 'away');
		const draw = market.prices.find((p) => p.designation === 'draw');
		const parts = [];
		if (home) parts.push(`1: ${americanToDecimal(home.price).toFixed(2)}`);
		if (draw) parts.push(`N: ${americanToDecimal(draw.price).toFixed(2)}`);
		if (away) parts.push(`2: ${americanToDecimal(away.price).toFixed(2)}`);
		return `📊 Pinnacle (${league}) : ${parts.join(' · ')}`;
	}
	if (betType.type === 'total') {
		const side = market.prices.find((p) => p.designation === betType.side);
		if (!side) return null;
		return `📊 Pinnacle (${league}) : ${betType.side === 'over' ? 'Plus' : 'Moins'} de ${betType.points} → ${americanToDecimal(side.price).toFixed(2)}`;
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

async function formatMonitoringMessage(event) {
	const { type, boost, prevOdds } = event;
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

	// Référence Pinnacle : uniquement pour les nouvelles cotes, uniquement si un
	// pari équivalent (victoire simple / total buts) existe sur une grande ligue.
	if (type === 'add') {
		try {
			const ref = await findPinnacleReference(boost.eventName, boost.description);
			const refLine = formatPinnacleReference(ref);
			if (refLine) lines.push(``, refLine);
		} catch {
			// silencieux : pas de reference dispo ne doit jamais bloquer l'alerte
		}
	}

	return lines.join('\n');
}

async function postMonitoringDiff(env, prevBoosts, currentBoosts) {
	if (!env.MONITORING_CHAT_ID || !prevBoosts) return;
	const events = diffBoosts(prevBoosts, currentBoosts);
	for (const event of events) {
		await sendToChat(env, env.MONITORING_CHAT_ID, await formatMonitoringMessage(event));
		await new Promise((r) => setTimeout(r, 350)); // évite le flood control Telegram
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
