const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'invite.html'), 'utf8');

const INVITES = {
  'dna-studio': {
    lang: 'es-MX',
    pageTitle: 'Invitación privada para DNA Studio — Silver Glider Events',
    metaDescription: 'Una invitación privada para probar Silver Glider Events.',
    privateLabel: 'Invitación privada',
    agency: 'DNA Studio',
    headline: 'DNA Studio, ayúdennos a crear una nueva experiencia para organizar eventos.',
    intro: 'Estamos creando Silver Glider Events: una herramienta sencilla para diseñar páginas de eventos, recibir confirmaciones de asistencia y gestionar su lista de invitados.',
    context: 'Por la manera creativa en que DNA Studio concibe sus eventos, nos encantaría que fueran uno de los primeros equipos en CDMX en probarla.',
    invitation: 'Creen un evento real o de prueba, exploren la plataforma y cuéntennos qué les resulta útil, qué podría ser más claro y qué hace falta. Su opinión influirá directamente en lo que construyamos después.',
    question: 'Silver Glider está disponible actualmente en inglés. ¿Les interesaría una versión completa en español?',
    pilot: 'Estamos considerando una prueba piloto en español con un grupo selecto de organizadores en CDMX. Nos gustaría desarrollarla junto con personas que conocen y forman parte de la comunidad creativa local.',
    sfNote: 'Estamos basados en San Francisco, California, y venimos del mundo de los eventos creativos.',
    primaryCta: 'Probar ahora en inglés',
    secondaryCta: 'Nos interesa en español',
    successCta: 'Gracias por su interés',
    response: 'Gracias. Respondan a la persona que les envió esta invitación para confirmar que desean participar en la prueba piloto en español.',
    footer: 'Acceso privado · Gratis para probar · Creado junto con nuestros primeros organizadores'
  },
  'dna-studio-en': {
    lang: 'en',
    pageTitle: 'Private invitation for DNA Studio — Silver Glider Events',
    metaDescription: 'A private invitation to try Silver Glider Events.',
    privateLabel: 'Private invitation',
    agency: 'DNA Studio',
    headline: 'DNA Studio, help us shape a new way to create events.',
    intro: 'We are building Silver Glider Events: a simple tool for designing event pages, collecting RSVPs, and managing your guest list.',
    context: 'Because of the creative way DNA Studio approaches events, we would love for you to be one of the first teams in Mexico City to try it.',
    invitation: 'Create a real or test event, explore the platform, and tell us what feels useful, what could be clearer, and what is missing. Your perspective will directly influence what we build next.',
    question: 'Silver Glider is currently available in English. Would a complete Spanish version be useful to your team?',
    pilot: 'We are considering a Spanish pilot with a select group of event organizers in Mexico City. We would like to shape it alongside people who know and contribute to the local creative community.',
    sfNote: 'We are based in San Francisco, California, and come from the world of creative events.',
    primaryCta: 'Try Silver Glider',
    secondaryCta: 'We are interested in Spanish',
    successCta: 'Thanks for your interest',
    response: 'Thank you. Reply to the person who sent this invitation to confirm that you would like to participate in the Spanish-language pilot.',
    footer: 'Private access · Free to try · Built with our first event organizers'
  },
  mmmargarita: {
    lang: 'es-MX',
    pageTitle: 'Invitación privada para MMMargarita Talent Agency — Silver Glider Events',
    metaDescription: 'Una invitación privada para probar Silver Glider Events.',
    privateLabel: 'Invitación privada',
    agency: 'MMMargarita Talent Agency',
    headline: 'MMMargarita, ayúdennos a crear una forma más sencilla de lanzar eventos.',
    intro: 'Silver Glider Events permite crear páginas de eventos atractivas, recibir confirmaciones de asistencia, comunicarse con los invitados y gestionar la lista de asistentes, todo desde un solo enlace.',
    context: 'Por el trabajo de MMMargarita con talento, promotores y audiencias, creemos que su equipo puede aportar una perspectiva especialmente valiosa a la plataforma.',
    invitation: 'Nos encantaría que la probaran con un evento real o próximo y nos dijeran qué la haría verdaderamente útil para su trabajo.',
    question: 'Silver Glider está disponible actualmente en inglés. ¿Su equipo preferiría utilizarla en español?',
    pilot: 'Estamos explorando una prueba piloto en español para un grupo selecto de organizadores en CDMX. Su opinión puede ayudarnos a crear esa versión desde el principio.',
    sfNote: 'Estamos basados en San Francisco, California, y venimos del mundo de los eventos creativos.',
    primaryCta: 'Probar ahora en inglés',
    secondaryCta: 'Nos interesa en español',
    successCta: 'Gracias por su interés',
    response: 'Gracias. Respondan a la persona que les envió esta invitación para confirmar que desean participar en la prueba piloto en español.',
    footer: 'Acceso privado · Gratis para probar · Su opinión le da forma al producto'
  }
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

router.get('/invite/mmmargaritta', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.redirect(302, '/invite/mmmargarita');
});

router.get('/invite/:slug', (req, res) => {
  const invite = INVITES[req.params.slug];
  if (!invite) return res.status(404).send('Invitation not found');

  res.set('X-Robots-Tag', 'noindex, nofollow');
  let html = template;
  Object.entries(invite).forEach(([key, value]) => {
    const placeholder = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    html = html.replace(new RegExp(`{{${placeholder}}}`, 'g'), esc(value));
  });
  res.send(html);
});

module.exports = router;
