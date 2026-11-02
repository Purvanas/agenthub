'use strict';

// Fenêtres de décision et avis, à la place de `confirm`, `alert` et `prompt`.
//
// Les boîtes natives sont laides, non stylables, et surtout **bloquantes** : tant que
// « 127.0.0.1 indique » est à l'écran, plus rien ne tourne dans la page — ni le flux
// d'un turn en cours, ni le websocket qui pousse les avis, ni le rafraîchissement des
// quotas. Sur un outil dont tout l'intérêt est de regarder des agents travailler,
// arrêter la page pour demander « Supprimer ? » est le pire moment possible.
//
// Deux remplacements, et le choix entre les deux n'est pas cosmétique :
//
// - **La suppression ne se confirme plus, elle s'annule.** L'action part tout de suite
//   pour l'œil — la ligne disparaît — mais l'appel réseau est retenu quelques secondes
//   derrière un « Annuler ». On échange une question posée à tout le monde à chaque fois
//   contre une issue de secours offerte à ceux qui se sont trompés. C'est le bon change :
//   se tromper est rare, être interrompu est constant.
// - **La modale reste pour ce qui n'est pas une suppression** : fusionner une branche
//   dans le dépôt principal, lancer trois agents qui vont dépenser des jetons sans
//   surveillance. Là il y a quelque chose à lire avant de décider, et différer l'action
//   n'aide en rien.
//
// Le module se suffit à lui-même : il fabrique son propre balisage, pour qu'ajouter un
// avis quelque part ne demande jamais de toucher à `index.html`.

/** Délai par défaut avant qu'une action différée parte pour de bon. */
const UNDO_MS = 6000;

/** Durée d'affichage d'un avis simple, et d'une erreur — qu'on veut avoir le temps de lire. */
const TOAST_MS = 4000;
const ERROR_MS = 9000;

/**
 * File des actions différées.
 *
 * Séparée du DOM pour être vérifiable sans navigateur, mais aussi parce que c'est là
 * qu'est le vrai risque : une action qu'on annule et qui part quand même, ou une action
 * validée qu'on perd en fermant l'onglet. Le second cas est le plus vicieux — l'écran a
 * dit « supprimé », l'utilisateur est parti, et rien n'a été supprimé.
 */
function createUndoQueue({ delay = UNDO_MS, setTimer = setTimeout, clearTimer = clearTimeout, onError } = {}) {
  const pending = new Map();
  let seq = 0;

  function fire(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimer(entry.timer);
    let out;
    try {
      out = entry.run();
    } catch (err) {
      if (onError) onError(err, entry);
      return null;
    }
    return out && typeof out.catch === 'function' && onError
      ? out.catch((err) => onError(err, entry))
      : out;
  }

  return {
    /**
     * Programme `run`, et renvoie de quoi l'annuler. Le délai est réglable par action
     * parce qu'il doit rester égal à celui de la barre affichée : ce qu'on voit descendre
     * est une promesse, pas une décoration.
     */
    push(run, meta, ms) {
      const id = ++seq;
      const entry = { run, meta };
      entry.timer = setTimer(() => fire(id), ms === undefined ? delay : ms);
      pending.set(id, entry);
      return id;
    },

    /** Annule : `run` ne sera jamais appelé. Renvoie false si c'était déjà parti. */
    cancel(id) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      clearTimer(entry.timer);
      return true;
    },

    fire,

    /**
     * Tout faire partir maintenant. Appelé quand la page se ferme ou passe en arrière-plan :
     * l'utilisateur a vu « supprimé » et n'a pas annulé, son intention est claire. Attendre
     * un délai qui ne s'écoulera plus perdrait l'action en silence.
     */
    flush() {
      return [...pending.keys()].map((id) => fire(id));
    },

    size: () => pending.size,
  };
}

const dialogs = { createUndoQueue, UNDO_MS, TOAST_MS, ERROR_MS };
if (typeof module !== 'undefined' && module.exports) module.exports = dialogs;

// --- Tout ce qui suit demande un DOM -----------------------------------------------

if (typeof document !== 'undefined') {
  const UNDO = createUndoQueue({
    onError: (err, entry) => {
      // L'action a échoué APRÈS que l'écran a montré qu'elle avait réussi : il faut le dire,
      // et remettre en place ce qu'on avait fait disparaître par anticipation.
      if (entry.meta && entry.meta.hide) entry.meta.hide.classList.remove('vanishing');
      toastError(err && err.message ? err.message : String(err));
    },
  });

  // Ne pas perdre une suppression parce qu'on a changé d'onglet ou fermé la page.
  const flush = () => UNDO.flush();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  let deck = null;
  function toastDeck() {
    if (!deck) {
      deck = document.createElement('div');
      deck.className = 'toasts';
      document.body.appendChild(deck);
    }
    return deck;
  }

  function dismiss(el) {
    if (!el.parentNode || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  }

  /**
   * Avis passager. `action` ajoute un bouton — c'est par là que passe « Annuler ».
   * La barre de vie est calée sur la même durée que le minuteur : ce qu'on voit descendre
   * est bien le temps qu'il reste pour se raviser.
   */
  function toast(message, { kind = 'info', ms = TOAST_MS, action } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.appendChild(text);

    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        action.run();
        dismiss(el);
      });
      el.appendChild(button);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fermer');
    close.textContent = '×';
    // Fermer un avis d'annulation ne l'annule pas : c'est un accusé de réception, comme
    // laisser le délai s'écouler. Seul « Annuler » annule.
    close.addEventListener('click', () => dismiss(el));
    el.appendChild(close);

    if (ms) {
      const life = document.createElement('div');
      life.className = 'toast-life';
      life.style.animationDuration = `${ms}ms`;
      el.appendChild(life);
      setTimeout(() => dismiss(el), ms);
    }

    toastDeck().appendChild(el);
    return el;
  }

  function toastError(message) {
    return toast(message, { kind: 'error', ms: ERROR_MS });
  }

  /**
   * Fait l'action « tout de suite » pour l'utilisateur, mais ne l'exécute qu'après le
   * délai. `hide` est l'élément qui disparaît en attendant — la ligne supprimée — et qui
   * revient si on annule ; sans lui l'écran ne bougerait pas et l'avis mentirait.
   */
  function undoToast({ message, run, hide, ms = UNDO_MS, undone }) {
    if (hide) hide.classList.add('vanishing');
    const id = UNDO.push(run, { hide }, ms);

    toast(message, {
      kind: 'undo',
      ms,
      action: {
        label: 'Annuler',
        run: () => {
          if (!UNDO.cancel(id)) return; // déjà parti : ne pas laisser croire au retour
          if (hide) hide.classList.remove('vanishing');
          if (undone) undone();
        },
      },
    });
  }

  // --- Modales -----------------------------------------------------------------------

  let openBox = null;

  /**
   * Ouvre une modale et renvoie ce que l'utilisateur a décidé. Échap, clic à côté et
   * bouton d'annulation mènent tous à `cancelValue` : trois façons de dire non, et aucune
   * ne doit valider par accident.
   */
  function openDialog({ title, body, bodyHtml, buildBody, buttons, cancelValue = null, focus }) {
    // Une seule à la fois : ouvrir la seconde par-dessus laisserait la première sans
    // réponse et son `await` en suspens pour toujours.
    if (openBox) openBox.settle(openBox.cancelValue);

    const wasFocused = document.activeElement;
    const root = document.createElement('div');
    root.className = 'modal dialog-modal';
    root.innerHTML =
      '<div class="modal-box dialog-box" role="dialog" aria-modal="true">' +
      '<h3></h3><div class="modal-body dialog-body"></div>' +
      '<div class="modal-foot"></div></div>';

    root.querySelector('h3').textContent = title;

    const bodyEl = root.querySelector('.dialog-body');
    if (bodyHtml) bodyEl.innerHTML = bodyHtml;
    else if (body) {
      for (const paragraph of String(body).split('\n\n')) {
        const p = document.createElement('p');
        p.className = 'dialog-p';
        p.textContent = paragraph;
        bodyEl.appendChild(p);
      }
    }
    const extra = buildBody ? buildBody(bodyEl) : null;

    let done;
    const answer = new Promise((resolve) => {
      done = resolve;
    });

    function settle(value) {
      if (openBox !== box) return;
      openBox = null;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      if (wasFocused && wasFocused.focus) wasFocused.focus();
      done(value);
    }

    const foot = root.querySelector('.modal-foot');
    for (const spec of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = spec.danger ? 'danger modal-ok' : spec.primary ? 'primary modal-ok' : 'secondary';
      button.textContent = spec.label;
      button.addEventListener('click', () => settle(spec.value === undefined ? true : spec.value));
      foot.appendChild(button);
    }

    // En capture, et l'événement est arrêté : Échap ne doit pas AUSSI replier un menu
    // derrière la modale, ni Entrée déclencher un raccourci de la page. Seules ces deux
    // touches sont interceptées — le reste doit atteindre le champ de saisie.
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(cancelValue);
      } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const validate = buttons.find((b) => b.primary || b.danger);
        if (!validate) return;
        e.preventDefault();
        e.stopPropagation();
        settle(validate.value === undefined ? true : validate.value);
      }
    }

    root.addEventListener('click', (e) => {
      if (e.target === root) settle(cancelValue);
    });
    document.addEventListener('keydown', onKey, true);

    const box = { settle, cancelValue };
    openBox = box;
    document.body.appendChild(root);

    const first = (focus && focus(root, extra)) || root.querySelector('.modal-ok');
    if (first) first.focus();

    return answer;
  }

  /** Oui / non. Renvoie une promesse booléenne. */
  function askConfirm({ title, body, ok = 'Confirmer', cancel = 'Annuler', danger }) {
    return openDialog({
      title,
      body,
      cancelValue: false,
      buttons: [
        { label: cancel, value: false },
        { label: ok, value: true, primary: !danger, danger },
      ],
    });
  }

  /** Une ligne de texte. Renvoie la saisie, ou null si on renonce. */
  function askInput({ title, label, value = '', ok = 'Valider', placeholder = '' }) {
    let input;
    return openDialog({
      title,
      cancelValue: null,
      buildBody: (bodyEl) => {
        const field = document.createElement('div');
        field.className = 'relay-field';
        if (label) {
          const tag = document.createElement('label');
          tag.className = 'relay-label';
          tag.textContent = label;
          field.appendChild(tag);
        }
        input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.placeholder = placeholder;
        field.appendChild(input);
        bodyEl.appendChild(field);
        return input;
      },
      // La valeur est lue au moment du clic, pas à la construction : sinon on validerait
      // toujours le texte d'origine.
      buttons: [
        { label: 'Annuler', value: null },
        { label: ok, value: undefined, primary: true },
      ],
      focus: () => {
        input.select();
        return input;
      },
    }).then((out) => (out === null || out === false ? null : input.value));
  }

  /** Choix parmi plusieurs actions, à la place d'un `prompt` où il fallait taper le mot. */
  function askChoice({ title, body, options }) {
    return openDialog({
      title,
      body,
      cancelValue: null,
      buildBody: (bodyEl) => {
        const list = document.createElement('div');
        list.className = 'dialog-choices';
        for (const option of options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `dialog-choice${option.danger ? ' danger-text' : ''}`;
          button.textContent = option.label;
          button.dataset.value = option.value;
          list.appendChild(button);
        }
        bodyEl.appendChild(list);
        return list;
      },
      buttons: [{ label: 'Annuler', value: null }],
      focus: (root) => {
        root.querySelector('.dialog-choices').addEventListener('click', (e) => {
          const pick = e.target.closest('.dialog-choice');
          if (pick && openBox) openBox.settle(pick.dataset.value);
        });
        return root.querySelector('.dialog-choice');
      },
    });
  }

  // Exposée pour les modales qui ne rentrent dans aucun des trois moules ci-dessus — le
  // formulaire des prompts enregistrés en est une : une liste et un formulaire à trous.
  window.openDialog = openDialog;
  window.toast = toast;
  window.toastError = toastError;
  window.undoToast = undoToast;
  window.askConfirm = askConfirm;
  window.askInput = askInput;
  window.askChoice = askChoice;
}
