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

// Sports pour lesquels Pinnacle expose une recherche par compétition sans
// authentification (voir PINNACLE_SPORTS plus bas) -- les autres (rugby,
// handball, volley, boxe) sont bloqués côté API (401), donc ignorés ici.
const SPORT_KEY_BY_EMOJI = {
	'⚽': 'football',
	'🏀': 'basketball',
	'🎾': 'tennis',
	'⚾': 'baseball',
	'🏒': 'hockey',
	'🥊': 'mma',
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
		const sportEmoji = guessSportEmoji(match.title || '');
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
			sport: SPORT_KEY_BY_EMOJI[sportEmoji] || null,
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

	const winningTeam = teamsMatch(teamA, extractWinner(d)) ? teamA : teamsMatch(teamB, extractWinner(d)) ? teamB : null;

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

// Winamax ne fournit pas de champ sport fiable pour ses cotes boostées (juste
// un titre libre, souvent sans aucun mot-clé sport dedans -- voir
// guessSportEmoji) : on essaie chaque sport supporté à tour de rôle plutôt que
// d'abandonner. Le parsing du texte (parseLegs) est gratuit et identique quel
// que soit le sport essayé ; seul un sport qui matche vraiment déclenche des
// appels réseau. Foot en premier : de loin le plus fréquent.
async function findPinnacleReference(eventName, description, leagueLabel, sportKey) {
	const sportsToTry = sportKey ? [sportKey] : Object.keys(PINNACLE_SPORTS);
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
		return `📊 Pinnacle (${ref.league}) : ${ref.decimal.toFixed(2)}${edgeSuffix(boostDecimal, ref.decimal)}`;
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
			const { text, refLine, edge } = await formatMonitoringMessage(event);
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
			if (event.type === 'remove') {
				await env.SEEN_BOOSTS.delete(`pintrack:${event.boost.marketId}`);
			}
		} catch (e) {
			console.log('postMonitoringDiff: sendToChat failed:', String(e));
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
	await refreshTrackedPinnacleRefs(env);
	await detectDuplicates(env, boosts);

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
		if (url.pathname === '/backfill-pinnacle') {
			const result = await backfillPinnacleRefs(env);
			return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response('OK. Utilise /run pour déclencher un check manuel, /current pour le suivi.', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		if (event.cron === '7 8 * * *') {
			ctx.waitUntil(postDailyDigest(env).catch((e) => console.error('postDailyDigest failed:', e)));
			return;
		}
		ctx.waitUntil(
			checkAndPost(env).catch((e) => console.error('checkAndPost failed:', e))
		);
	},
};
