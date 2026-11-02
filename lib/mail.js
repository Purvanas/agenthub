'use strict';

// Envoi de mail, pour les rapports de fin de déclencheur.
//
// Pourquoi une dépendance (`nodemailer`) alors que le projet n'en a que deux : parce qu'un
// client SMTP correct n'est pas 50 lignes. Il faut STARTTLS, AUTH en base64, l'encodage
// « encoded-word » d'un sujet accentué, le dot-stuffing d'une ligne qui commence par un
// point, et le MIME multipart pour envoyer texte et HTML. Chacun de ces points est un
// piège silencieux : le mail part, et arrive illisible.
//
// Les réglages se saisissent dans la page Paramètres et vivent dans `data/settings.json`,
// hors du dépôt : ils portent un mot de passe. `config/mail.json` reste lu s'il existe, et
// `config/mail.example.json` documente les champs — mais il n'y a plus à créer de fichier à
// la main pour envoyer un mail.

const path = require('path');
const settings = require('./settings');

const CONFIG_FILE =
  process.env.AGENTHUB_MAIL_CONFIG || path.join(__dirname, '..', 'config', 'mail.json');

/** Relue à chaque envoi, comme les autres configurations : pas de redémarrage. */
function config() {
  const raw = settings.read('mail');
  return {
    enabled: Boolean(raw.enabled) && Boolean(raw.host) && Boolean(raw.from),
    host: raw.host || '',
    port: Number(raw.port) || 587,
    secure: Boolean(raw.secure),
    user: raw.user || '',
    pass: raw.pass || '',
    from: raw.from || '',
    to: raw.to || '',
  };
}

/** L'envoi de mail est-il utilisable ? Décide si l'UI propose le champ. */
function available() {
  return config().enabled;
}

/**
 * Envoie un mail. Ne rejette jamais : un rapport non délivré ne doit pas faire échouer une
 * exécution qui, elle, a réussi. La raison est renvoyée pour être écrite dans le fil.
 *
 * @param {{to?: string, subject: string, text: string, html?: string}} message
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function send(message) {
  const conf = config();
  if (!conf.enabled) return { sent: false, reason: 'config/mail.json absent ou désactivé' };

  const to = (message.to || conf.to || '').trim();
  if (!to) return { sent: false, reason: 'aucun destinataire' };

  try {
    // Requis tardivement : une installation sans mail configuré n'a aucune raison de
    // charger un client SMTP au démarrage.
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: conf.host,
      port: conf.port,
      secure: conf.secure,
      auth: conf.user ? { user: conf.user, pass: conf.pass } : undefined,
    });
    await transport.sendMail({
      from: conf.from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true, to };
  } catch (err) {
    console.error(`mail non envoyé : ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { send, available, config, CONFIG_FILE };
