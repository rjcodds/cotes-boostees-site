// Étage 1 du pipeline de génération de contenu (TikTok/Instagram) : repère
// la meilleure cote boostée classique du jour (edge % vs Pinnacle/Piwi/
// Matchbook déjà calculé ailleurs) et génère un script court via Claude.
// Volontairement PAS de génération vidéo ni de publication automatique --
// le script est envoyé sur un canal Telegram dédié pour validation manuelle,
// le temps de valider le format avant d'automatiser plus loin (étages 2/3).

// URLs utilisées seulement pour construire la requête passée au service
// binding (voir wrangler.toml) -- le binding court-circuite le DNS/réseau
// public, ces domaines ne sont jamais réellement résolus, mais fetch() sur
// un binding a quand même besoin d'une URL bien formée.
const WINAMAX_URL = 'https://winamax-flash-boost.jc-hd-affiliation.workers.dev';
const UNIBET_URL = 'https://unibet-flash-boost.jc-hd-affiliation.workers.dev';

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

async function fetchDigestData(binding, baseUrl, date) {
	try {
		const res = await binding.fetch(`${baseUrl}/digest-data?date=${date}`);
		if (!res.ok) return { count: 0, withRef: 0, best: null };
		return await res.json();
	} catch {
		return { count: 0, withRef: 0, best: null };
	}
}

// Combine les stats des deux bookmakers (même logique que postDailyDigest
// dans winamax-flash-boost) et renvoie la cote avec le meilleur edge %,
// tous bookmakers confondus.
async function findBestBoostOfDay(env, date) {
	const [winamax, unibet] = await Promise.all([
		fetchDigestData(env.WINAMAX_WORKER, WINAMAX_URL, date),
		fetchDigestData(env.UNIBET_WORKER, UNIBET_URL, date),
	]);
	const candidates = [winamax.best, unibet.best].filter(Boolean);
	if (!candidates.length) return null;
	candidates.sort((a, b) => b.edge - a.edge);
	return candidates[0];
}

// Prompt volontairement structuré pour un format court (15-30s), priorité
// annoncée par l'utilisatrice : accroche foot d'abord, la cote/l'edge en
// second, jamais de ton "mise ton argent ici" appuyé.
function buildPrompt(boost) {
	return `Tu écris le script d'une vidéo courte (15-30 secondes) pour TikTok/Instagram Reels, sur le football et les paris sportifs, pour le compte @RJCBoost.

Voici les données de la meilleure cote boostée détectée aujourd'hui (l'edge % = à quel point cette cote paie plus que sa vraie valeur de marché, calculé face à Pinnacle/Betfair) :

Match : ${boost.eventName}
Pari : ${boost.description}
Cote boostée : ${boost.newOdds}
Edge : +${Number(boost.edge).toFixed(1)}% vs la valeur de marché réelle

Consignes de ton :
- L'accroche (les 2 premières secondes) doit parler du MATCH/du FOOT, pas des paris -- on capte l'attention par le sport, pas par la cote.
- La cote et l'edge arrivent ensuite, présentés comme un fait intéressant ("cette cote paie X% de plus que sa vraie valeur"), jamais comme une injonction à parier.
- Pas de ton commercial appuyé, pas de "fonce", pas de garantie de gain.
- Français, oral, direct, phrases courtes.

Réponds UNIQUEMENT avec ce format exact (rien avant, rien après) :

ACCROCHE: [1 phrase, 2-3 secondes à l'oral]
CORPS: [3-4 phrases max, le contexte du match puis la cote/l'edge]
TEXTE_A_L_ECRAN: [2-3 mots-clés courts à afficher en overlay, séparés par des virgules]`;
}

async function generateScript(env, boost) {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-sonnet-5',
			max_tokens: 500,
			messages: [{ role: 'user', content: buildPrompt(boost) }],
		}),
	});
	if (!res.ok) {
		throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
	}
	const data = await res.json();
	return data.content?.[0]?.text?.trim() || null;
}

async function sendToChat(env, chatId, text) {
	const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
	});
	if (!res.ok) {
		throw new Error(`Telegram sendMessage ${res.status}: ${await res.text()}`);
	}
	return res.json();
}

async function runPipeline(env) {
	const date = todayKey();
	const best = await findBestBoostOfDay(env, date);
	if (!best) {
		return { ok: true, found: false };
	}
	const script = await generateScript(env, best);
	if (!script) {
		return { ok: true, found: true, scripted: false };
	}
	const message = [
		`🎬 Brief contenu — ${date}`,
		``,
		`<b>Source</b> : ${best.eventName}`,
		best.description,
		`${best.newOdds} (+${Number(best.edge).toFixed(1)}% vs marché)`,
		``,
		`<b>Script proposé :</b>`,
		script,
	].join('\n');
	await sendToChat(env, env.CONTENT_REVIEW_CHAT_ID, message);
	return { ok: true, found: true, scripted: true, boost: best };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/debug') {
			const date = todayKey();
			const [winamax, unibet] = await Promise.all([
				fetchDigestData(env.WINAMAX_WORKER, WINAMAX_URL, date),
				fetchDigestData(env.UNIBET_WORKER, UNIBET_URL, date),
			]);
			return new Response(JSON.stringify({ date, winamax, unibet }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/run') {
			try {
				const result = await runPipeline(env);
				return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(JSON.stringify({ ok: false, error: String(e) }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}
		return new Response('OK. Utilise /run pour déclencher un brief manuel.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(runPipeline(env).catch((e) => console.error('runPipeline failed:', e)));
	},
};
