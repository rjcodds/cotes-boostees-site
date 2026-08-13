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

function formatMonitoringMessage(event) {
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
	return lines.join('\n');
}

async function postMonitoringDiff(env, prevBoosts, currentBoosts) {
	if (!env.MONITORING_CHAT_ID || !prevBoosts) return;
	const events = diffBoosts(prevBoosts, currentBoosts);
	for (const event of events) {
		await sendToChat(env, env.MONITORING_CHAT_ID, formatMonitoringMessage(event));
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
		// Laisse le temps au flux Socket.IO de pousser les cotes dans PRELOADED_STATE.
		await new Promise((r) => setTimeout(r, 4000));
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
