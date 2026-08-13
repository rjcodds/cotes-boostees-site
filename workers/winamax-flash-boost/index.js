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

		boosts.push({
			marketId: String(bet.betId),
			eventName,
			sportEmoji: guessSportEmoji(match.title || ''),
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
	const lines = [`${icon} ${label} — WINAMAX`, ``, `${boost.sportEmoji} ${boost.eventName}`, boost.description];
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

async function fetchPreloadedState(env) {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		);
		await page.goto(WINAMAX_URL, { waitUntil: 'networkidle2', timeout: 30000 });
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

async function checkAndPost(env) {
	const state = await fetchPreloadedState(env);
	const boosts = parseBoosts(state);
	const eligible = boosts.filter((b) => b.maxStake <= MAX_STAKE_EUR);

	const prevRaw = await env.SEEN_BOOSTS.get('current_snapshot');
	const prevBoosts = prevRaw ? JSON.parse(prevRaw).boosts : null;

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
