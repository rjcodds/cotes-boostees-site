// Surveille les "Super Boost" Bet365 (page d'accueil) et les poste automatiquement
// dans le canal Telegram privé. Aucune relecture manuelle.
//
// Bet365 protège sa page avec Cloudflare (bloque les requêtes simples) ET rend
// son contenu en React après coup, avec un chargement paresseux qui ne se
// déclenche qu'au scroll. Ce worker utilise un vrai navigateur (Cloudflare
// Browser Rendering) avec des patches anti-détection pour contourner le blocage,
// scrolle pour déclencher le chargement, puis lit directement le DOM rendu
// (les classes CSS de Bet365 sont générées/hashées à chaque build, donc on
// repère les cartes par leur contenu textuel -- "Misez X, Gagnez Y" -- plutôt
// que par nom de classe, plus robuste dans le temps).

import puppeteer from '@cloudflare/puppeteer';

const BET365_URL = 'https://www.bet365.fr/';
const SEEN_TTL_SECONDS = 6 * 60 * 60; // 6h : évite de reposter la même cote à chaque poll

async function applyStealthPatches(page) {
	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
		window.chrome = window.chrome || { runtime: {} };
		Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
		Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr'] });
		const originalQuery = window.navigator.permissions?.query;
		if (originalQuery) {
			window.navigator.permissions.query = (parameters) =>
				parameters.name === 'notifications'
					? Promise.resolve({ state: Notification.permission })
					: originalQuery(parameters);
		}
	});
}

async function extractBoosts(page) {
	return page.evaluate(() => {
		function findCard(stakeEl) {
			let node = stakeEl;
			for (let i = 0; i < 8 && node; i++) {
				if (node.querySelector && node.querySelector('img[src*="Boost"]')) return node;
				node = node.parentElement;
			}
			return stakeEl.parentElement;
		}

		const results = [];
		const stakeEls = Array.from(document.querySelectorAll('div')).filter(
			(el) => /^Misez\s/.test((el.textContent || '').trim()) && el.children.length === 0
		);

		for (const stakeEl of stakeEls) {
			const card = findCard(stakeEl);
			if (!card) continue;
			const img = card.querySelector('img[src*="Boost"]');
			const badgeSrc = img ? img.getAttribute('src') : null;
			const isSuperBoost = badgeSrc ? /super-?boost/i.test(badgeSrc) : false;

			const oddsContainer = stakeEl.parentElement.querySelector('div > div');
			let oldOdds = null, newOdds = null;
			if (oddsContainer && oddsContainer.parentElement) {
				const nums = Array.from(oddsContainer.parentElement.querySelectorAll('div'))
					.map((d) => d.textContent.trim())
					.filter((t) => /^\d+([.,]\d+)?$/.test(t));
				if (nums.length >= 2) { oldOdds = nums[0]; newOdds = nums[nums.length - 1]; }
			}

			const allDivs = Array.from(card.querySelectorAll('div'));
			let description = null;
			for (const d of allDivs) {
				const t = d.textContent.trim();
				if (t.length > 5 && t.length < 120 && d.children.length === 0 && !/^\d/.test(t) && !/^Misez/.test(t)) {
					description = t;
					break;
				}
			}

			results.push({
				marketId: `${description}|${oldOdds}|${newOdds}`,
				description,
				oldOdds,
				newOdds,
				stakeLine: stakeEl.textContent.trim(),
				isSuperBoost,
			});
		}
		return results;
	});
}

function formatTelegramMessage(boost) {
	const lines = [
		`⚡ SUPER BOOST — BET365`,
		``,
		boost.description,
		``,
		`Cote : ${boost.oldOdds} → ${boost.newOdds}`,
		`💰 ${boost.stakeLine}`,
		``,
		`* Mise comptabilisée pour le bilan`,
		``,
		`Disponible jusqu'au début du match`,
	];
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
	const browser = await puppeteer.launch(env.BROWSER);
	let boosts = [];
	try {
		const page = await browser.newPage();
		await applyStealthPatches(page);
		await page.setViewport({ width: 1280, height: 2000 });
		await page.setUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		);
		await page.goto(BET365_URL, { waitUntil: 'networkidle2', timeout: 30000 });
		await new Promise((r) => setTimeout(r, 2000));

		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll('button'));
			const accept = btns.find((b) => /accepter tous/i.test(b.textContent));
			if (accept) accept.click();
		});
		await new Promise((r) => setTimeout(r, 1500));
		await page.evaluate(() => window.scrollTo(0, 800));
		await new Promise((r) => setTimeout(r, 3000));
		await page.evaluate(() => window.scrollTo(0, 1600));
		await new Promise((r) => setTimeout(r, 4000));

		boosts = await extractBoosts(page);
		var debugInfo = await page.evaluate(() => ({
			title: document.title,
			bodyTextLength: document.body.innerText.length,
			bodyTextSample: document.body.innerText.slice(0, 300),
			hasAcceptButton: Array.from(document.querySelectorAll('button')).some((b) => /accepter tous/i.test(b.textContent)),
			isChallenge: /checking your browser|attention required|cloudflare/i.test(document.title + document.body.innerText.slice(0, 2000)),
		}));
	} finally {
		await browser.close();
	}

	const superBoosts = boosts.filter((b) => b.isSuperBoost);
	let posted = 0;
	for (const boost of superBoosts) {
		const key = `seen:${boost.marketId}`;
		const already = await env.SEEN_BOOSTS.get(key);
		if (already) continue;

		await sendTelegramMessage(env, formatTelegramMessage(boost));
		await env.SEEN_BOOSTS.put(key, '1', { expirationTtl: SEEN_TTL_SECONDS });
		posted++;
	}
	return { totalBoostsOnPage: boosts.length, superBoostsFound: superBoosts.length, posted, debugInfo };
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
		return new Response('OK. Utilise /run pour déclencher un check manuel.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(checkAndPost(env));
	},
};
