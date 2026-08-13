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

async function sendTelegramMessage(env, text) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: env.TELEGRAM_CHAT_ID,
			text,
			disable_web_page_preview: true,
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
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
		return new Response('OK. Utilise /run pour déclencher un check manuel.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(checkAndPost(env));
	},
};
