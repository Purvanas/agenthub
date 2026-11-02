'use strict';

// Journal de consommation. Un enregistrement par (turn, modèle), ajouté en fin
// de ligne dans un JSONL : append-only, donc rien à perdre en cas de crash, et
// les agrégats se recalculent à la lecture (le volume reste modeste).

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const LEDGER = path.join(DATA_DIR, 'usage.jsonl');
const PRICING_FILE = path.join(__dirname, '..', 'config', 'pricing.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')).providers || {};
  } catch {
    return {};
  }
}

/**
 * Modèles réellement portés au compte pour un turn. Les providers qui publient
 * `modelUsage` donnent la source la plus précise (et peuvent en utiliser plusieurs).
 * Codex ne donne que ses tokens : dans ce cas le modèle imposé, puis le défaut de la
 * table de prix, est le meilleur relevé disponible.
 */
function billedModels(provider, item, fallbackModel) {
  const measured = Object.keys((item && item.modelUsage) || {});
  if (measured.length) return measured;
  if (fallbackModel) return [fallbackModel];
  const defaultModel = (loadPricing()[provider] || {}).defaultModel;
  return defaultModel ? [defaultModel] : [];
}

/**
 * Coût calculé depuis la table de prix, pour tout turn que son fournisseur n'a pas chiffré.
 *
 * Les tokens relus depuis le cache ont leur propre tarif, un dixième de l'entrée chez
 * OpenAI. Les compter au plein tarif d'entrée — ce que faisait cette fonction — presque
 * doublait le coût affiché d'un turn Codex, qui relit couramment la moitié de son contexte.
 *
 * L'écriture de cache, elle, est plus CHÈRE que l'entrée chez Claude : deux fois le tarif
 * pour un cache d'une heure, une fois et quart pour cinq minutes. La compter au tarif
 * d'entrée sous-estimait de moitié un turn qui écrit beaucoup de contexte. Le partage entre
 * les deux durées vient du flux, quand il le donne ; sinon tout est compté au tarif court,
 * le moins cher — on préfère sous-estimer qu'inventer.
 */
function priceFromTable(provider, model, rec) {
  const table = loadPricing()[provider] || {};
  const models = table.models || {};
  // Un turn sans modèle imposé est journalisé « défaut » : sans ce repli il ne
  // correspondait à aucune ligne de prix et comptait pour zéro.
  const name = model === 'défaut' ? table.defaultModel || model : model;
  const entry = models[name] || models[String(name).replace(/\[.*\]$/, '')];
  if (!entry) return null;

  const cachedRate = entry.cachedInput === undefined ? entry.input || 0 : entry.cachedInput;
  const shortWrite = entry.cacheWrite === undefined ? entry.input || 0 : entry.cacheWrite;
  const longWrite = entry.cacheWrite1h === undefined ? shortWrite : entry.cacheWrite1h;
  const created = rec.cacheCreateTokens || 0;
  const createdLong = Math.min(rec.cacheCreate1hTokens || 0, created);

  return (
    ((rec.inputTokens || 0) / 1e6) * (entry.input || 0) +
    ((created - createdLong) / 1e6) * shortWrite +
    (createdLong / 1e6) * longWrite +
    ((rec.cacheReadTokens || 0) / 1e6) * cachedRate +
    ((rec.outputTokens || 0) / 1e6) * (entry.output || 0)
  );
}

/**
 * Dernier cumul Codex connu pour une conversation.
 *
 * Codex ne publie pas ce que le turn a consommé, mais le total de la **session** depuis son
 * début — un total qui repart du fichier de session, donc qui survit à ses process. Chaque
 * turn journalisait ce total complet : sur six turns, le même contexte était compté six fois.
 * Le delta se prend donc contre ce relevé.
 *
 * Les lignes écrites avant l'ajout de `codexTotals` portent le cumul brut dans leurs propres
 * champs : elles servent de repère sans conversion, et un turn Codex déjà journalisé ne
 * recompte pas son passé au premier turn suivant ce changement.
 */
function lastCodexTotals(convId) {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.provider !== 'codex' || row.convId !== convId) continue;
    if (row.codexTotals) return row.codexTotals;
    return {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      cacheReadTokens: row.cacheReadTokens || 0,
    };
  }
  return null;
}

/**
 * Progression entre deux cumuls de session Codex : ce que le turn a réellement consommé.
 *
 * Un cumul en baisse veut dire qu'on regarde une autre session — Codex a reforké, ou la
 * conversation a été reprise ailleurs. Son total est alors le sien, pas un delta.
 *
 * Fonction pure, et c'est ce qui compte : la réparation de l'historique rejoue exactement
 * cette règle sur les lignes déjà écrites, sans la réécrire à côté.
 */
function codexProgress(before, totals) {
  if (!before || totals.inputTokens < before.inputTokens) return totals;
  return {
    inputTokens: Math.max(0, totals.inputTokens - (before.inputTokens || 0)),
    outputTokens: Math.max(0, totals.outputTokens - (before.outputTokens || 0)),
    cacheReadTokens: Math.max(0, totals.cacheReadTokens - (before.cacheReadTokens || 0)),
  };
}

/**
 * Ce que ce turn Codex a consommé, en champs **disjoints** — la même convention que Claude.
 *
 * Deuxième piège de Codex, et le plus coûteux : son `input_tokens` **inclut** les tokens relus
 * du cache, comme le `prompt_tokens` d'OpenAI inclut ses `cached_tokens`. Les additionner
 * facturait donc deux fois la part en cache — plein tarif d'entrée, puis tarif de cache — et
 * comptait deux fois ses tokens.
 *
 * Vérifié le 03/08/2026 sur 29 lignes du journal : le cache lu ne dépasse jamais l'entrée, et
 * sa part monte à 97 % quand la session grossit. La preuve décisive tient dans deux turns
 * minuscules lancés exprès — « dis bonjour », puis « redis bonjour » : le second annonce
 * 15 102 tokens d'entrée dont 14 080 en cache. Sous la lecture disjointe, redire bonjour aurait
 * envoyé 15 000 tokens neufs alors que tout son contexte était déjà en cache.
 *
 * @param {object|null} before cumul de la ligne précédente de la conversation
 * @param {object} totals cumul annoncé par ce turn
 */
function codexTokens(before, totals) {
  const delta = codexProgress(before, totals);
  return {
    // Ce qui a réellement été envoyé neuf : l'entrée annoncée moins ce qui venait du cache.
    inputTokens: Math.max(0, delta.inputTokens - delta.cacheReadTokens),
    outputTokens: delta.outputTokens,
    cacheReadTokens: delta.cacheReadTokens,
  };
}

/** Consommation de ce turn, mesurée contre la dernière ligne de sa conversation. */
function codexDelta(convId, totals) {
  return codexTokens(lastCodexTotals(convId), totals);
}

function append(record) {
  fs.appendFileSync(LEDGER, `${JSON.stringify(record)}\n`);
}

/**
 * Enregistre la consommation d'un turn terminé.
 * Claude fournit un détail par modèle avec son propre coût ; les autres
 * providers donnent un total brut qu'on chiffre via config/pricing.json.
 *
 * `item.partial` marque un turn coupé avant son relevé final : le détail par modèle a été
 * reconstitué depuis le flux, il ne porte donc aucun coût et passe par la table de prix.
 *
 * @returns {Array<object>} les lignes écrites — leur somme est le coût du turn pour les
 *   fournisseurs qui ne le chiffrent pas eux-mêmes.
 */
function record({ provider, convId, item, fallbackModel, triggerId, project }) {
  const ts = new Date().toISOString();
  const rows = [];
  // Recopié sur la ligne au moment de l'écriture, comme l'est déjà le provider : agréger
  // par déclencheur en remontant les conversations à chaque lecture serait fragile — une
  // conversation supprimée emporterait son coût — et coûteux.
  const trigger = triggerId || null;
  // Le projet, pour exactement la même raison, et elle se vérifie : sur cette installation,
  // 122 des 125 conversations du journal n'existaient plus. Sans le projet écrit ici, tout
  // leur coût — la quasi-totalité du total — n'aurait plus été rattachable à rien.
  const repo = project || null;

  if (item.modelUsage && Object.keys(item.modelUsage).length) {
    for (const [model, usage] of Object.entries(item.modelUsage)) {
      const base = {
        ts,
        provider,
        convId,
        triggerId: trigger,
        project: repo,
        model,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheCreateTokens: usage.cacheCreationInputTokens || 0,
        cacheReadTokens: usage.cacheReadInputTokens || 0,
        webSearches: usage.webSearchRequests || 0,
      };
      // Part du cache écrite pour une heure : elle coûte le double du tarif court. Seul le
      // relevé reconstitué la connaît, d'où le champ facultatif.
      if (usage.cacheCreation1hInputTokens) {
        base.cacheCreate1hTokens = usage.cacheCreation1hInputTokens;
      }
      if (!item.partial) {
        rows.push({ ...base, costUsd: usage.costUSD || 0, costSource: 'provider' });
        continue;
      }
      const computed = priceFromTable(provider, model, base);
      rows.push({
        ...base,
        costUsd: computed || 0,
        // `table` et non un état à part : c'est bien un prix estimé, et l'interface sait déjà
        // l'annoncer comme tel. `partial` dit en plus d'où vient l'estimation.
        costSource: computed == null ? 'inconnu' : 'table',
        partial: true,
      });
    }
  } else if (item.codexUsage) {
    const totals = {
      inputTokens: item.codexUsage.inputTokens || 0,
      outputTokens: item.codexUsage.outputTokens || 0,
      cacheReadTokens: item.codexUsage.cacheReadTokens || 0,
    };
    const delta = codexDelta(convId, totals);
    const base = {
      ts,
      provider,
      convId,
      triggerId: trigger,
      project: repo,
      model: fallbackModel || 'défaut',
      ...delta,
      cacheCreateTokens: 0,
      webSearches: 0,
      // Le cumul tel qu'annoncé, pour que le turn suivant sache contre quoi se soustraire.
      codexTotals: totals,
    };
    const computed = priceFromTable(provider, base.model, base);
    // Un delta nul est un turn qui n'a rien consommé de neuf — une reprise qui n'a pas
    // rappelé le modèle, par exemple. L'écrire gonflerait le compte des turns pour rien.
    if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens) {
      rows.push({
        ...base,
        costUsd: computed || 0,
        costSource: computed == null ? 'inconnu' : 'table',
      });
    }
  } else if (item.costUsd) {
    // Provider qui ne donne qu'un coût global, sans détail de tokens.
    rows.push({
      ts,
      provider,
      convId,
      triggerId: trigger,
      project: repo,
      model: fallbackModel || 'défaut',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      webSearches: 0,
      costUsd: item.costUsd,
      costSource: 'provider',
    });
  }

  for (const row of rows) append(row);
  return rows;
}

function readAll() {
  let raw;
  try {
    raw = fs.readFileSync(LEDGER, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ligne corrompue : on l'ignore plutôt que de perdre tout le journal */
    }
  }
  return rows;
}

const EMPTY = () => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  tokens: 0,
  costUsd: 0,
});

function add(target, row) {
  target.turns += 1;
  target.inputTokens += row.inputTokens || 0;
  target.outputTokens += row.outputTokens || 0;
  target.cacheCreateTokens += row.cacheCreateTokens || 0;
  target.cacheReadTokens += row.cacheReadTokens || 0;
  target.tokens +=
    (row.inputTokens || 0) +
    (row.outputTokens || 0) +
    (row.cacheCreateTokens || 0) +
    (row.cacheReadTokens || 0);
  target.costUsd += row.costUsd || 0;
}

/**
 * @param {string} month 'all' ou 'YYYY-MM'
 */
function summary(month = 'all') {
  const rows = readAll();
  const months = [...new Set(rows.map((r) => r.ts.slice(0, 7)))].sort().reverse();
  const scoped = month === 'all' ? rows : rows.filter((r) => r.ts.startsWith(month));

  const totals = EMPTY();
  const byProvider = new Map();

  for (const row of scoped) {
    add(totals, row);

    if (!byProvider.has(row.provider)) {
      byProvider.set(row.provider, { provider: row.provider, ...EMPTY(), models: new Map() });
    }
    const provider = byProvider.get(row.provider);
    add(provider, row);

    if (!provider.models.has(row.model)) {
      provider.models.set(row.model, {
        model: row.model,
        costSource: row.costSource || 'inconnu',
        ...EMPTY(),
      });
    }
    const model = provider.models.get(row.model);
    // Une seule ligne estimée suffit à rendre le total du modèle estimé : annoncer « prix du
    // fournisseur » parce que la première ligne l'était serait faux dès qu'un turn a été coupé.
    if (row.costSource && row.costSource !== 'provider') model.costSource = row.costSource;
    add(model, row);
  }

  const providers = [...byProvider.values()]
    .map(({ models, ...rest }) => ({
      ...rest,
      models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return { month, months, totals, providers };
}

/**
 * Lundi de la semaine d'une date, en heure locale, au format `YYYY-MM-DD`.
 *
 * En **heure locale** et non UTC, comme le planificateur : le processus est aligné sur
 * `Europe/Paris`, et un turn lancé un dimanche à 23 h 30 appartient à la semaine qu'on a
 * vécue, pas à celle d'après. Lundi comme premier jour, parce que c'est la convention ISO et
 * celle de tout le monde ici — `getDay()` rend 0 pour dimanche, d'où le décalage.
 */
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Tableau de bord : où part l'argent, plutôt que combien il en part.
 *
 * `summary` répond « combien », par fournisseur et par modèle. C'est la question qu'on se pose
 * une fois. Les trois autres viennent ensuite et n'avaient pas de réponse : quel **projet**
 * coûte, est-ce que ça **monte** d'une semaine à l'autre, et quelle **conversation** a mangé
 * le mois. Elles se lisent dans le même journal, sur la même lecture de fichier.
 *
 * **Le projet vient de la ligne**, écrit au moment du turn comme l'est déjà le déclencheur.
 * `resolve` ne sert qu'aux lignes antérieures à ce champ, et au titre — qui, lui, n'a aucune
 * raison d'être figé : renommer une conversation doit renommer sa ligne du classement.
 *
 * Le rattachement ne pouvait pas se faire à la lecture, et la mesure le prouve : sur cette
 * installation, 122 des 125 conversations du journal n'existaient plus. Presque tout le coût
 * du mois se serait retrouvé sous « projet inconnu ».
 *
 * **Une conversation supprimée garde son coût.** Elle n'a plus de titre, et c'est exactement
 * ce qu'il faut montrer : l'argent a été dépensé, l'effacer du tableau ferait mentir le
 * total. Elle apparaît sous « conversation supprimée », non cliquable — mais sous son projet.
 *
 * @param {object} opts
 * @param {string} [opts.month] 'all' ou 'YYYY-MM'
 * @param {(convId: string) => ({project?: string, title?: string, provider?: string}|null)}
 *   [opts.resolve]
 * @param {number} [opts.weeks] nombre de semaines rendues, les plus récentes
 * @param {number} [opts.top] nombre de conversations classées
 */
function dashboard({ month = 'all', resolve, weeks = 12, top = 15 } = {}) {
  const rows = readAll();
  const scoped = month === 'all' ? rows : rows.filter((r) => r.ts.startsWith(month));
  const known = typeof resolve === 'function' ? resolve : () => null;
  const seen = new Map(); // convId -> ce que `resolve` en a dit, appelé une fois par conversation

  const byProject = new Map();
  const byWeek = new Map();
  const byConv = new Map();

  for (const row of scoped) {
    const convId = row.convId || null;
    if (convId && !seen.has(convId)) seen.set(convId, known(convId));
    const meta = (convId && seen.get(convId)) || null;

    // La ligne d'abord, le magasin ensuite : seules les lignes écrites avant l'ajout du champ
    // ont besoin qu'on remonte à la conversation, et elles n'y arrivent que si elle existe
    // encore. Un projet introuvable est regroupé sous une clé vide plutôt qu'ignoré : la
    // somme des projets doit faire le total.
    const project = row.project || (meta && meta.project) || '';
    if (!byProject.has(project)) byProject.set(project, { project, convs: new Set(), ...EMPTY() });
    const p = byProject.get(project);
    add(p, row);
    if (convId) p.convs.add(convId);

    const week = weekStart(row.ts);
    if (!byWeek.has(week)) byWeek.set(week, { week, providers: {}, ...EMPTY() });
    const w = byWeek.get(week);
    add(w, row);
    w.providers[row.provider] = (w.providers[row.provider] || 0) + (row.costUsd || 0);

    if (!convId) continue;
    if (!byConv.has(convId)) {
      byConv.set(convId, {
        convId,
        title: (meta && meta.title) || null,
        project,
        provider: (meta && meta.provider) || row.provider,
        // Ce qu'il faut savoir avant de cliquer : une conversation supprimée ne s'ouvre pas.
        missing: !meta,
        lastAt: row.ts,
        ...EMPTY(),
      });
    }
    const c = byConv.get(convId);
    add(c, row);
    if (row.ts > c.lastAt) c.lastAt = row.ts;
  }

  return {
    projects: [...byProject.values()]
      .map(({ convs, ...rest }) => ({ ...rest, convs: convs.size }))
      .sort((a, b) => b.costUsd - a.costUsd),
    // Chronologique, et non par coût : une courbe se lit dans le sens du temps. Les semaines
    // sans consommation ne sont pas comblées — le journal n'en sait rien, et une semaine
    // absente est une semaine sans agent, ce qui se voit très bien par son absence.
    weeks: [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-weeks),
    top: [...byConv.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, top),
  };
}

/**
 * Agrégat par déclencheur : ce que coûte le fait de le laisser tourner.
 *
 * Le nombre d'exécutions compte les conversations distinctes et non les lignes : une
 * exécution produit un turn au minimum, et un turn produit plusieurs lignes dès qu'il
 * passe par plusieurs modèles. Compter les lignes gonflerait le dénominateur et la
 * moyenne par exécution serait fausse.
 *
 * Les lignes écrites avant l'ajout du champ n'en portent pas : elles sont ignorées plutôt
 * que rattachées à tort.
 *
 * @returns {Object<string, {costUsd: number, tokens: number, turns: number, runs: number, avgCostUsd: number}>}
 */
function byTrigger() {
  const perTrigger = new Map();

  for (const row of readAll()) {
    if (!row.triggerId) continue;
    if (!perTrigger.has(row.triggerId)) {
      perTrigger.set(row.triggerId, { costUsd: 0, tokens: 0, turns: 0, convs: new Set() });
    }
    const agg = perTrigger.get(row.triggerId);
    agg.costUsd += row.costUsd || 0;
    agg.tokens +=
      (row.inputTokens || 0) +
      (row.outputTokens || 0) +
      (row.cacheCreateTokens || 0) +
      (row.cacheReadTokens || 0);
    agg.turns += 1;
    if (row.convId) agg.convs.add(row.convId);
  }

  const out = {};
  for (const [id, agg] of perTrigger) {
    const runs = agg.convs.size;
    out[id] = {
      costUsd: agg.costUsd,
      tokens: agg.tokens,
      turns: agg.turns,
      runs,
      avgCostUsd: runs ? agg.costUsd / runs : 0,
    };
  }
  return out;
}

/** Agrégat vide, pour un déclencheur qui n'a encore rien exécuté. */
const NO_USAGE = () => ({ costUsd: 0, tokens: 0, turns: 0, runs: 0, avgCostUsd: 0 });

module.exports = {
  record,
  billedModels,
  summary,
  dashboard,
  weekStart,
  byTrigger,
  NO_USAGE,
  // Exposés pour la réparation de l'historique (`scripts/`), qui doit chiffrer et déduire
  // exactement comme le fait l'écriture courante — les deux règles vivent ici, pas ailleurs.
  priceFromTable,
  codexTokens,
  LEDGER,
};
