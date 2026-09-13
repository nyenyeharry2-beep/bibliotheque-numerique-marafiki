# Bibliothèque numérique Marafiki

Les lecteurs cherchent des livres, s’abonnent en francs congolais, et l’administrateur dépose des PDF, EPUB et autres fichiers.

## Tarifs

- **500 FC** — 7 jours
- **759 FC** — 16 jours

Paiement Mobile Money :

- **+243 841 194 151**
- **+243 998 595 006**

Après le paiement, le lecteur envoie une **capture d’écran**. L’admin la voit dans `/admin` et valide ou refuse. Un message Telegram part si le bot est configuré.

Sans abonnement actif, le catalogue et les résumés restent visibles. Le fichier complet (lecture ou téléchargement) est réservé aux abonnés.

## Lancer en local

```bash
npm install
npm start
```

Ouvrez http://localhost:10000

Compte administrateur de démonstration :

- e-mail : `admin@marafiki.cd`
- mot de passe : `MarafikiAdmin2026`

Changez ce mot de passe en production avec la variable `ADMIN_PASSWORD`.

## Render

1. Créez un service Web pointant vers ce dépôt.
2. **Build** : laissez vide, ou `npm install`.
3. **Start** : `npm start`
4. Ajoutez un **disque persistant** monté sur `/opt/render/project/src/uploads` (ou le dossier `uploads` du projet), sinon les livres et les captures disparaissent au redémarrage.

Variables d’environnement :

| Variable | Rôle |
| --- | --- |
| `PORT` | Fourni par Render |
| `DATABASE_URL` | PostgreSQL Render (sinon données en mémoire) |
| `TELEGRAM_BOT_TOKEN` | Jeton du bot |
| `TELEGRAM_CHAT_ID` | Chat qui reçoit les preuves |
| `ADMIN_PASSWORD` | Mot de passe du compte `admin@marafiki.cd` |

Sans `DATABASE_URL` ni Telegram, le site fonctionne quand même : les données restent en mémoire jusqu’au redémarrage du processus.
