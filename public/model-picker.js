'use strict';

// Sélecteur modèle + effort partagé. Il ne crée ni modale ni overlay : l'appelant choisit
// l'endroit où il le monte, ce qui évite les conflits de focus et de clavier sur mobile.
(function modelPickerModule(global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AgentHubModelPicker = api;
})(typeof window !== 'undefined' ? window : null, function createModelPicker() {
  const CUSTOM = '__agenthub_custom_model__';
  let mountSequence = 0;

  function esc(value) {
    return String(value == null ? '' : value).replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    );
  }

  function models(provider, catalog) {
    const rows = catalog && catalog[provider];
    return Array.isArray(rows) ? rows : [];
  }

  function entryOf(provider, value, catalog) {
    return models(provider, catalog).find((entry) => String(entry.value || '') === String(value || '')) || null;
  }

  function shortLabel(label) {
    const text = String(label || '').trim();
    const split = text.split(/\s+[—–]\s+/, 1)[0];
    return split || text;
  }

  /** Nom court destiné aux boutons et aux cartes, sans la note ajoutée après le tiret long. */
  function name(provider, value, catalog) {
    const entry = entryOf(provider, value, catalog);
    if (entry) return String(entry.name || entry.displayName || shortLabel(entry.label) || value || 'Défaut du CLI');
    return String(value || 'Défaut du CLI');
  }

  function effortOptions(provider, value, catalog) {
    // `null` signifie volontairement « identifiant personnalisé ». Il ne faut alors pas
    // confondre ce cas avec la valeur vide du modèle par défaut.
    const entry = value == null ? null : entryOf(provider, value, catalog);
    const own = entry && Array.isArray(entry.efforts) && entry.efforts.length ? entry.efforts : null;
    const shared = catalog && catalog.efforts && catalog.efforts[provider];
    const rows = own || (Array.isArray(shared) && shared.length ? shared : null) || [
      { value: '', label: 'Défaut du modèle' },
    ];
    return rows.map((effort) => ({ ...effort, value: String(effort.value || ''), label: effort.value ? effort.label : 'Réglage du CLI' }));
  }

  function resolvedDefault(provider, catalog) {
    const value = catalog && catalog.defaults && catalog.defaults[provider];
    if (!value) return null;
    if (typeof value === 'string' && value.trim()) return { model: value.trim() };
    // Le backend publie aussi `{ model: null, source: 'unknown' }` pour indiquer qu'il
    // a explicitement cherché sans pouvoir résoudre le défaut. Ce n'est pas un défaut connu.
    if (typeof value === 'object' && typeof value.model === 'string' && value.model.trim()) {
      return { ...value, model: value.model.trim() };
    }
    return null;
  }

  function resolvedDefaultName(provider, resolved, catalog) {
    const raw = String(resolved.label || name(provider, resolved.model, catalog)).trim();
    // Le catalogue Grok historique appelait l'entrée roulante « Dernier modèle — X ».
    // Dans « actuellement … », seul X est utile et évite une phrase redondante.
    return raw.replace(/^Dernier modèle\s+[—–]\s+/i, '') || resolved.model;
  }

  function effortLabel(provider, model, effort, catalog, fallback) {
    const options = effortOptions(provider, model, catalog);
    const match = options.find((option) => option.value === String(effort || ''));
    return (match && match.label) || fallback || String(effort || 'Défaut du modèle');
  }

  /** Description stable utilisée par le badge du composeur comme par l'aperçu de création. */
  function describe(provider, model, effort, catalog) {
    const value = String(model || '');
    const entry = entryOf(provider, value, catalog);
    const resolved = !value ? resolvedDefault(provider, catalog) : null;
    let label;
    let detail = (entry && (entry.note || entry.title)) || '';

    if (!value && resolved) {
      const resolvedName = resolvedDefaultName(provider, resolved, catalog);
      label = `Défaut du CLI · actuellement ${resolvedName}`;
      if (!detail && resolved.source) detail = `Défaut relevé depuis ${resolved.source}.`;
    } else if (!value) {
      label = 'Défaut du CLI · modèle non confirmé';
    } else {
      label = name(provider, value, catalog);
      if (!entry) detail = 'Identifiant personnalisé transmis directement au CLI.';
    }

    let selectedEffort = String(effort || '');
    let selectedEffortLabel;
    if (!selectedEffort && resolved && resolved.effort) {
      selectedEffort = String(resolved.effort);
      const current = effortLabel(provider, resolved.model || value, selectedEffort, catalog, selectedEffort);
      selectedEffortLabel = `Défaut · actuellement ${current}`;
    } else {
      selectedEffortLabel = effortLabel(provider, value, selectedEffort, catalog);
    }

    return { label, detail, effortLabel: selectedEffortLabel };
  }

  function fastModel(entry) {
    if (!entry) return false;
    return Boolean(
      entry.fast ||
        Number(entry.priceMultiplier) > 1 ||
        /(?:^|[-\s])fast(?:$|[-\s])/i.test(String(entry.value || '')) ||
        /variante rapide|\bfast\b/i.test(`${entry.label || ''} ${entry.note || ''} ${entry.title || ''}`)
    );
  }

  function modelCard(provider, entry, catalog, selected, radioName) {
    const value = String(entry.value || '');
    const description = describe(provider, value, '', catalog);
    const fast = fastModel(entry);
    const badge = !value
      ? '<span class="model-picker-badge">Automatique</span>'
      : fast
        ? `<span class="model-picker-badge fast">Rapide${Number(entry.priceMultiplier) > 1 || /deux fois|2x/i.test(`${entry.label || ''} ${entry.note || ''}`) ? ' · 2× prix' : ''}</span>`
        : entry.legacy
          ? '<span class="model-picker-badge legacy">Ancien</span>'
          : '';
    const note = !value
      ? 'Suit le modèle par défaut du CLI.'
      : fast
        ? 'Variante rapide de la même génération.'
        : provider === 'grok'
          ? 'Version fixe, conservée pour les prochains messages.'
          : provider === 'claude' && ['opus', 'fable', 'sonnet', 'haiku'].includes(value)
            ? 'Alias Claude : la version exacte est résolue au lancement.'
            : description.detail;
    return `<label class="model-picker-card${fast ? ' is-fast' : ''}">
      <input type="radio" name="${radioName}" data-model-choice value="${esc(value)}"${selected === value ? ' checked' : ''}>
      <span class="model-picker-card-copy">
        <span class="model-picker-card-title"><strong>${esc(description.label)}</strong>${badge}</span>
        ${note ? `<span class="model-picker-card-note">${esc(note)}</span>` : ''}
      </span>
    </label>`;
  }

  function mount(host, options = {}) {
    if (!host || typeof host.querySelector !== 'function') {
      throw new TypeError('AgentHubModelPicker.mount attend un élément DOM');
    }
    const provider = String(options.provider || '');
    const catalog = options.catalog || {};
    const rows = models(provider, catalog);
    const known = rows.some((entry) => String(entry.value || '') === String(options.model || ''));
    const initialModel = String(options.model || '');
    const initialChoice = known ? initialModel : initialModel ? CUSTOM : '';
    const radioName = `agenthub-model-${++mountSequence}`;
    // Même un catalogue partiel doit toujours permettre de laisser le CLI choisir. Sans
    // cette carte, `model: ''` n'aurait aucun radio coché et le formulaire serait invalide.
    const defaultRows = rows.some((entry) => String(entry.value || '') === '')
      ? rows
      : [{ value: '', label: 'Défaut du CLI' }, ...rows];
    const advancedOpen = initialChoice === CUSTOM ? ' open' : '';

    host.innerHTML = `<div class="model-picker" data-provider="${esc(provider)}">
      <div class="model-picker-settings">
        <label class="model-picker-effort-label">Effort de raisonnement
          <select class="model-picker-effort"></select>
        </label>
        <p class="model-picker-notice hidden" role="status"></p>
        <div class="model-picker-preview" aria-live="polite"></div>
        <p class="model-picker-next-note">${options.running ? 'Le traitement en cours conserve son modèle. Ce choix s’appliquera au prochain message.' : 'Ce choix s’appliquera au prochain message.'}</p>
      </div>
      <fieldset class="model-picker-models">
        <legend>Modèle du prochain message</legend>
        <div class="model-picker-list">
          ${defaultRows.map((entry) => modelCard(provider, entry, catalog, initialChoice, radioName)).join('')}
        </div>
      </fieldset>
      <details class="model-picker-advanced"${advancedOpen}>
        <summary>Avancé · identifiant personnalisé</summary>
        <label class="model-picker-card custom">
          <input type="radio" name="${radioName}" data-model-choice value="${CUSTOM}"${initialChoice === CUSTOM ? ' checked' : ''}>
          <span class="model-picker-card-copy"><strong>Autre modèle</strong><span class="model-picker-card-note">Transmis tel quel au CLI. À utiliser seulement si le modèle n’est pas encore dans la liste.</span></span>
        </label>
        <label class="model-picker-custom-label">Identifiant
          <input class="model-picker-custom" value="${esc(initialChoice === CUSTOM ? initialModel : '')}" placeholder="ex. grok-4.7-build-fast" autocomplete="off" spellcheck="false">
        </label>
      </details>
    </div>`;

    const root = host.querySelector('.model-picker');
    const custom = root.querySelector('.model-picker-custom');
    const customRadio = root.querySelector(`input[data-model-choice][value="${CUSTOM}"]`);
    const effort = root.querySelector('.model-picker-effort');
    const notice = root.querySelector('.model-picker-notice');
    const preview = root.querySelector('.model-picker-preview');

    function selectedChoice() {
      return root.querySelector('input[data-model-choice]:checked');
    }

    function selectedModel() {
      const choice = selectedChoice();
      if (!choice) return '';
      return choice.value === CUSTOM ? custom.value.trim() : choice.value;
    }

    function allowedEfforts(model) {
      return effortOptions(provider, selectedChoice() && selectedChoice().value === CUSTOM ? null : model, catalog);
    }

    function refreshPreview() {
      const value = selectedModel();
      if (selectedChoice() && selectedChoice().value === CUSTOM && !value) {
        preview.innerHTML = '<span>Prochain message</span><strong>Identifiant personnalisé requis</strong>';
        return;
      }
      const description = describe(provider, value, effort.value, catalog);
      preview.innerHTML = `<span>Prochain message</span><strong>${esc(description.label)}</strong><small>${esc(description.effortLabel)}</small>`;
    }

    function isValid() {
      const choice = selectedChoice();
      if (!choice) return false;
      if (choice.value === CUSTOM && !custom.value.trim()) return false;
      return allowedEfforts(selectedModel()).some((option) => option.value === effort.value);
    }

    function read() {
      return { model: selectedModel(), effort: isValid() ? effort.value : '' };
    }

    function emitChange() {
      refreshPreview();
      if (typeof options.onChange === 'function') {
        const value = read();
        options.onChange({
          ...value,
          valid: isValid(),
          description: describe(provider, value.model, value.effort, catalog),
        });
      }
    }

    function renderEfforts(wanted, announce, notify = true) {
      const choices = allowedEfforts(selectedModel());
      effort.innerHTML = choices
        .map((entry) => {
          const title = entry.title ? ` title="${esc(entry.title)}"` : '';
          return `<option value="${esc(entry.value)}"${title}>${esc(entry.label)}</option>`;
        })
        .join('');
      const accepted = choices.some((entry) => entry.value === String(wanted || ''));
      const fallback = choices.find((entry) => entry.value === '') || choices[0];
      effort.value = accepted ? String(wanted || '') : fallback ? fallback.value : '';
      if (announce && wanted && !accepted) {
        notice.textContent = 'Cet effort n’est pas disponible avec ce modèle. Retour au réglage par défaut.';
        notice.classList.remove('hidden');
      } else {
        notice.textContent = '';
        notice.classList.add('hidden');
      }
      if (notify) emitChange();
      else refreshPreview();
    }

    // Les listeners vivent sur la racine remplacée par le prochain mount, pas sur `host` :
    // remonter le sélecteur dans une modale réutilisée ne garde donc aucune ancienne closure.
    root.addEventListener('change', (event) => {
      if (event.target.matches('input[data-model-choice]')) {
        renderEfforts(effort.value, true);
      } else if (event.target === effort) {
        notice.textContent = '';
        notice.classList.add('hidden');
        emitChange();
      }
    });
    custom.addEventListener('focus', () => {
      if (!customRadio.checked) {
        customRadio.checked = true;
        renderEfforts(effort.value, true);
      }
    });
    custom.addEventListener('input', emitChange);

    // Pas de callback pendant le montage : `onChange` décrit une action utilisateur et ne
    // doit pas déclencher un PATCH simplement parce que la modale vient de s'ouvrir.
    renderEfforts(String(options.effort || ''), true, false);

    return {
      read,
      isValid,
      focus() {
        const target = selectedChoice();
        if (target && typeof target.focus === 'function') target.focus();
      },
    };
  }

  return { name, effortOptions, describe, mount };
});
