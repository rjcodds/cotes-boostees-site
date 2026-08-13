// Surveille la page "cotes boostées" d'Unibet et poste automatiquement dans le
// canal Telegram privé toute cote boostée dont la mise max est <= MAX_STAKE_EUR.
//
// Tourne sur un Cron Trigger Cloudflare (voir wrangler.toml). Les données sont
// extraites du JSON embarqué dans le HTML de la page (rendu côté serveur par
// Unibet), pas d'un navigateur headless -- la page est directement exploitable
// via une simple requête HTTP.

const UNIBET_URL = 'https://www.unibet.fr/cotes-boostees';
const MAX_STAKE_EUR = 10;
const SEEN_TTL_SECONDS = 6 * 60 * 60; // 6h : évite de reposter la même cote à chaque poll

// Repère chaque paire eventDesc/marketDesc telle qu'elle apparaît dans le JSON
// embarqué (voir sample capturé sur la page réelle) :
//   "eventDesc":"N.Osaka vs E.Rybakina","groupId":190560683,"marketDesc":"CB - ... (2,20 -> 2,50 / Mise max 50€) - Match"
// Les cotes "CB FLASH" utilisent parfois une flèche unicode (→) au lieu de "->",
// et peuvent avoir une clause en plus entre l'encadré cote/mise et la période
// (ex: "(Remboursé si non titulaire) - 90 Mins") -- le regex gère les deux cas.
const ENTRY_RE = /"eventDesc":"([^"]+)","groupId":(\d+),"marketDesc":"([^"]+)"/g;
const ODDS_RE = /\(([\d,]+)\s*(?:->|→)\s*([\d,]+)\s*\/\s*Mise max\s*(\d+)\s*€\)/;

function parseBoosts(html) {
	const boosts = [];
	const seenMarketIds = new Set();
	for (const m of html.matchAll(ENTRY_RE)) {
		const [, eventDesc, groupId, marketDesc] = m;
		if (seenMarketIds.has(groupId)) continue; // dédoublonne les répétitions internes à la page
		seenMarketIds.add(groupId);

		const oddsMatch = marketDesc.match(ODDS_RE);
		if (!oddsMatch) continue;
		const [, oldOdds, newOdds, maxStake] = oddsMatch;

		boosts.push({
			marketId: groupId,
			eventDesc,
			description: marketDesc.replace(ODDS_RE, '').replace(/\s+/g, ' ').trim(),
			oldOdds,
			newOdds,
			maxStake: parseInt(maxStake, 10),
		});
	}
	return boosts;
}

function formatTelegramMessage(boost) {
	return (
		`⚡ COTE BOOSTÉE FLASH — UNIBET\n` +
		`${boost.eventDesc}\n` +
		`${boost.description}\n` +
		`Cote : ${boost.oldOdds} → ${boost.newOdds}\n` +
		`💰 Mise max : ${boost.maxStake}€\n` +
		`🔗 ${UNIBET_URL}`
	);
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
