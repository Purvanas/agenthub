'use strict';

// Messages planifiés dans une conversation.
//
// Ce qu'il ne faut pas casser : un message ne part qu'une fois, une échéance passée est
// refusée plutôt que déclenchée aussitôt, et un message dont la conversation a disparu ne
// repart pas à chaque tick du planificateur.

process.env.TZ = 'Europe/Paris';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-planned-'));
process.env.AGENTHUB_DATA = DATA;

const planned = require('../lib/planned');

const CONV = '11111111-1111-4111-8111-111111111111';
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString();

test('un message planifié attend son heure', () => {
  const { planned: p, error } = planned.add({
    convId: CONV,
    prompt: 'merge le fix dans dev',
    runAt: soon(120),
    mode: 'fork',
  });
  assert.equal(error, undefined);
  assert.equal(p.status, 'pending');
  assert.equal(p.mode, 'fork');
  assert.equal(planned.due(new Date()).length, 0, 'rien à faire avant l’échéance');
  assert.equal(planned.pending(CONV).length, 1);
});

test('le fork est le mode par défaut, et un mode inconnu y retombe', () => {
  // C'est celui qui laisse le fil parent utilisable : le bon défaut.
  assert.equal(planned.add({ convId: CONV, prompt: 'a', runAt: soon(10) }).planned.mode, 'fork');
  assert.equal(
    planned.add({ convId: CONV, prompt: 'b', runAt: soon(10), mode: 'ailleurs' }).planned.mode,
    'fork'
  );
});

test('une échéance passée est refusée plutôt que déclenchée aussitôt', () => {
  const { error } = planned.add({ convId: CONV, prompt: 'x', runAt: soon(-5) });
  assert.match(error, /déjà passée/);
});

test('les champs obligatoires sont refusés vides', () => {
  assert.match(planned.add({ convId: CONV, prompt: '  ', runAt: soon(5) }).error, /vide/);
  assert.match(planned.add({ convId: '', prompt: 'x', runAt: soon(5) }).error, /Conversation/);
  assert.match(planned.add({ convId: CONV, prompt: 'x', runAt: 'ce soir' }).error, /illisibles/);
});

test('à l’échéance, le message devient dû — et une seule fois', () => {
  const { planned: p } = planned.add({ convId: CONV, prompt: 'tard', runAt: soon(1) });
  const apres = new Date(Date.now() + 2 * 60_000);

  assert.ok(planned.due(apres).some((x) => x.id === p.id));
  planned.sent(p.id, 'enfant-1');

  assert.equal(
    planned.due(apres).some((x) => x.id === p.id),
    false,
    'un message parti ne redevient jamais dû'
  );
  const done = planned.forConversation(CONV).find((x) => x.id === p.id);
  assert.equal(done.status, 'sent');
  assert.equal(done.ranIn, 'enfant-1', 'où il est parti reste consultable');
});

test('un échec est final, il ne se rejoue pas à chaque tick', () => {
  const { planned: p } = planned.add({ convId: CONV, prompt: 'perdu', runAt: soon(1) });
  planned.failed(p.id, 'La conversation a été supprimée avant l’échéance.');

  const apres = new Date(Date.now() + 2 * 60_000);
  assert.equal(planned.due(apres).some((x) => x.id === p.id), false);
  const ko = planned.forConversation(CONV).find((x) => x.id === p.id);
  assert.equal(ko.status, 'failed');
  assert.match(ko.error, /supprimée/);
});

test('annuler rend l’enregistrement retiré, pas un simple oui', () => {
  // L’appelant a besoin de savoir s’il doit aussi supprimer la copie gelée créée pour lui.
  const { planned: p } = planned.add({
    convId: CONV,
    prompt: 'annulable',
    runAt: soon(60),
    ownsConv: true,
    frozenSession: 'session-gelee',
  });
  const retire = planned.cancel(p.id);
  assert.equal(retire.id, p.id);
  assert.equal(retire.ownsConv, true);
  assert.equal(retire.frozenSession, 'session-gelee');

  assert.equal(planned.cancel(p.id), null, 'annuler deux fois ne ment pas');

  const { planned: q } = planned.add({ convId: CONV, prompt: 'parti', runAt: soon(60) });
  planned.sent(q.id, CONV);
  assert.equal(planned.cancel(q.id), null, 'on n’annule pas ce qui est déjà parti');
});

test('une copie gelée est retenue comme telle, avec son origine', () => {
  const { planned: p } = planned.add({
    convId: 'enfant-gele',
    prompt: 'merge',
    runAt: soon(30),
    mode: 'frozen',
    ownsConv: true,
    frozenSession: 's-gel',
    fromConvId: CONV,
  });
  assert.equal(p.mode, 'frozen');
  assert.equal(p.fromConvId, CONV, 'sans ça la copie serait un fil orphelin');
  planned.cancel(p.id);
});

test('le nettoyage oublie ce qui vise une conversation disparue', () => {
  const AUTRE = '22222222-2222-4222-8222-222222222222';
  planned.add({ convId: AUTRE, prompt: 'orphelin', runAt: soon(90) });

  const retires = planned.sweep((id) => id === CONV);
  assert.ok(retires >= 1);
  assert.equal(planned.pending(AUTRE).length, 0);
  assert.ok(planned.pending(CONV).length >= 0, 'les autres survivent');
});

test('les messages partis finissent par être oubliés', () => {
  const { planned: p } = planned.add({ convId: CONV, prompt: 'vieux', runAt: soon(1) });
  planned.sent(p.id, CONV);

  const bienPlusTard = new Date(Date.now() + planned.KEEP_DONE_MS + 60_000);
  planned.sweep(() => true, bienPlusTard);
  assert.equal(
    planned.forConversation(CONV).some((x) => x.id === p.id),
    false
  );
});

test('la liste met les messages en attente avant ceux qui sont partis', () => {
  planned.add({ convId: CONV, prompt: 'a venir', runAt: soon(240) });
  const list = planned.all();
  const premierParti = list.findIndex((p) => p.status !== 'pending');
  const dernierAttente = list.map((p) => p.status).lastIndexOf('pending');
  if (premierParti !== -1) assert.ok(dernierAttente < premierParti);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
