const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_LIVRES = path.join(ROOT, "uploads", "livres");
const UPLOAD_PREUVES = path.join(ROOT, "uploads", "preuves");

const PLANS = {
  "7j": { code: "7j", jours: 7, montant: 500, label: "7 jours" },
  "16j": { code: "16j", jours: 16, montant: 759, label: "16 jours" }
};

const NUMEROS_PAIEMENT = ["+243841194151", "+243998595006"];

const EXTS_LIVRES = [".pdf", ".epub", ".txt", ".doc", ".docx", ".mobi", ".rtf"];
const EXTS_PREUVES = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const ADMIN_EMAIL = "admin@marafiki.cd";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "MarafikiAdmin2026";

fs.mkdirSync(UPLOAD_LIVRES, { recursive: true });
fs.mkdirSync(UPLOAD_PREUVES, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });
  console.log("DATABASE_URL détectée.");
} else {
  console.log("Pas de DATABASE_URL : données en mémoire.");
}

const memoire = {
  utilisateurs: [],
  livres: [],
  abonnements: [],
  next: { utilisateurs: 1, livres: 1, abonnements: 1 }
};

const sessions = new Map();

function hasherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(motDePasse, sel, 64).toString("hex");
  return `${sel}:${hash}`;
}

function verifierMotDePasse(motDePasse, enregistre) {
  if (!enregistre || !enregistre.includes(":")) {
    return false;
  }
  const [sel, hash] = enregistre.split(":");
  const calcule = crypto.scryptSync(motDePasse, sel, 64);
  const attendu = Buffer.from(hash, "hex");
  if (calcule.length !== attendu.length) {
    return false;
  }
  return crypto.timingSafeEqual(calcule, attendu);
}

function lireCookie(req, nom) {
  const header = req.headers.cookie || "";
  const parties = header.split(";").map((p) => p.trim());
  for (const partie of parties) {
    if (partie.startsWith(`${nom}=`)) {
      return decodeURIComponent(partie.slice(nom.length + 1));
    }
  }
  return "";
}

function definirSession(res, jeton) {
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(jeton)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
  );
}

function effacerSession(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

function utilisateurActuel(req) {
  const jeton = lireCookie(req, "session");
  if (!jeton || !sessions.has(jeton)) {
    return null;
  }
  return sessions.get(jeton);
}

function exigerConnexion(req, res, next) {
  const user = utilisateurActuel(req);
  if (!user) {
    return res.status(401).json({ success: false, error: "Connexion requise" });
  }
  req.utilisateur = user;
  next();
}

function exigerAdmin(req, res, next) {
  const user = utilisateurActuel(req);
  if (!user) {
    return res.status(401).json({ success: false, error: "Connexion requise" });
  }
  if (user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Accès administrateur requis" });
  }
  req.utilisateur = user;
  next();
}

function publicUtilisateur(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    nom: user.nom,
    email: user.email,
    role: user.role
  };
}

function normaliserTexte(valeur) {
  return String(valeur || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function publicLivre(livre, options = {}) {
  const data = {
    id: livre.id,
    titre: livre.titre,
    auteur: livre.auteur,
    annee: livre.annee,
    genre: livre.genre,
    resume: livre.resume,
    couverture: livre.couverture,
    type_fichier: livre.type_fichier,
    nom_fichier_origine: livre.nom_fichier_origine,
    created_at: livre.created_at
  };
  if (options.avecFichier) {
    data.fichier = livre.fichier;
  }
  return data;
}

function abonnementActif(abo) {
  if (!abo || abo.statut !== "actif") {
    return false;
  }
  if (!abo.date_fin) {
    return false;
  }
  return new Date(abo.date_fin).getTime() > Date.now();
}

function extensionFichier(nom) {
  return path.extname(nom || "").toLowerCase();
}

function typeDepuisExtension(ext) {
  const map = {
    ".pdf": "pdf",
    ".epub": "epub",
    ".txt": "txt",
    ".doc": "doc",
    ".docx": "docx",
    ".mobi": "mobi",
    ".rtf": "rtf",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".gif": "image"
  };
  return map[ext] || "autre";
}

function mimeDepuisExtension(ext) {
  const map = {
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
    ".txt": "text/plain; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mobi": "application/x-mobipocket-ebook",
    ".rtf": "application/rtf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  return map[ext] || "application/octet-stream";
}

function stockageDisque(dossier, extsAutorisees) {
  return multer.diskStorage({
    destination: dossier,
    filename(req, file, cb) {
      const ext = extensionFichier(file.originalname);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    }
  });
}

function filtreExtensions(exts) {
  return (req, file, cb) => {
    const ext = extensionFichier(file.originalname);
    if (!exts.includes(ext)) {
      cb(new Error(`Type de fichier non accepté (${ext || "inconnu"})`));
      return;
    }
    cb(null, true);
  };
}

const uploadLivre = multer({
  storage: stockageDisque(UPLOAD_LIVRES, EXTS_LIVRES),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: filtreExtensions(EXTS_LIVRES)
});

const uploadPreuve = multer({
  storage: stockageDisque(UPLOAD_PREUVES, EXTS_PREUVES),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: filtreExtensions(EXTS_PREUVES)
});

function normaliserNumero(valeur) {
  return String(valeur || "").replace(/[\s.-]/g, "");
}

async function envoyerTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram non configuré.");
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
    const resultat = await response.json();
    if (!resultat.ok) {
      console.error("Erreur Telegram :", resultat);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Erreur connexion Telegram :", error.message);
    return false;
  }
}

async function envoyerTelegramPhoto(chemin, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram non configuré.");
    return false;
  }
  try {
    const buffer = await fs.promises.readFile(chemin);
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("caption", caption.slice(0, 1024));
    form.append("photo", new Blob([buffer]), path.basename(chemin));
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form
    });
    const resultat = await response.json();
    if (!resultat.ok) {
      console.error("Erreur Telegram photo :", resultat);
      return envoyerTelegram(caption);
    }
    return true;
  } catch (error) {
    console.error("Erreur Telegram photo :", error.message);
    return envoyerTelegram(caption);
  }
}

async function initialiserBase() {
  if (!pool) {
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS utilisateurs (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      mot_de_passe TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'lecteur',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS livres (
      id SERIAL PRIMARY KEY,
      titre TEXT NOT NULL,
      auteur TEXT NOT NULL,
      annee INTEGER,
      genre TEXT,
      resume TEXT,
      couverture TEXT,
      fichier TEXT,
      type_fichier TEXT,
      nom_fichier_origine TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonnements (
      id SERIAL PRIMARY KEY,
      utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id),
      plan TEXT NOT NULL,
      montant INTEGER NOT NULL,
      numero_paiement TEXT,
      fichier_preuve TEXT,
      statut TEXT NOT NULL DEFAULT 'en_attente',
      date_debut TIMESTAMPTZ,
      date_fin TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("Base PostgreSQL initialisée.");
}

async function trouverUtilisateurParEmail(email) {
  const cle = String(email || "").trim().toLowerCase();
  if (pool) {
    const result = await pool.query("SELECT * FROM utilisateurs WHERE lower(email) = $1 LIMIT 1", [cle]);
    return result.rows[0] || null;
  }
  return memoire.utilisateurs.find((u) => u.email.toLowerCase() === cle) || null;
}

async function trouverUtilisateurParId(id) {
  const num = Number(id);
  if (pool) {
    const result = await pool.query("SELECT * FROM utilisateurs WHERE id = $1 LIMIT 1", [num]);
    return result.rows[0] || null;
  }
  return memoire.utilisateurs.find((u) => u.id === num) || null;
}

async function creerUtilisateur({ nom, email, motDePasse, role }) {
  const hash = hasherMotDePasse(motDePasse);
  const emailNorm = email.trim().toLowerCase();
  if (pool) {
    const result = await pool.query(
      `INSERT INTO utilisateurs (nom, email, mot_de_passe, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [nom.trim(), emailNorm, hash, role || "lecteur"]
    );
    return result.rows[0];
  }
  const user = {
    id: memoire.next.utilisateurs++,
    nom: nom.trim(),
    email: emailNorm,
    mot_de_passe: hash,
    role: role || "lecteur",
    created_at: new Date().toISOString()
  };
  memoire.utilisateurs.push(user);
  return user;
}

async function listerLivres({ q, genre } = {}) {
  let livres;
  if (pool) {
    const result = await pool.query("SELECT * FROM livres ORDER BY id DESC");
    livres = result.rows;
  } else {
    livres = [...memoire.livres].sort((a, b) => b.id - a.id);
  }
  const recherche = normaliserTexte(q).trim();
  const filtreGenre = normaliserTexte(genre).trim();
  return livres.filter((livre) => {
    const texte = normaliserTexte(`${livre.titre} ${livre.auteur} ${livre.genre} ${livre.resume}`);
    const okRecherche = !recherche || texte.includes(recherche);
    const okGenre = !filtreGenre || normaliserTexte(livre.genre) === filtreGenre;
    return okRecherche && okGenre;
  });
}

async function trouverLivre(id) {
  const num = Number(id);
  if (pool) {
    const result = await pool.query("SELECT * FROM livres WHERE id = $1 LIMIT 1", [num]);
    return result.rows[0] || null;
  }
  return memoire.livres.find((l) => l.id === num) || null;
}

async function creerLivre(data) {
  if (pool) {
    const result = await pool.query(
      `INSERT INTO livres (titre, auteur, annee, genre, resume, couverture, fichier, type_fichier, nom_fichier_origine)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        data.titre,
        data.auteur,
        data.annee,
        data.genre,
        data.resume,
        data.couverture,
        data.fichier,
        data.type_fichier,
        data.nom_fichier_origine
      ]
    );
    return result.rows[0];
  }
  const livre = {
    id: memoire.next.livres++,
    ...data,
    created_at: new Date().toISOString()
  };
  memoire.livres.push(livre);
  return livre;
}

async function mettreAJourLivre(id, data) {
  const actuel = await trouverLivre(id);
  if (!actuel) {
    return null;
  }
  const fusion = { ...actuel, ...data };
  if (pool) {
    const result = await pool.query(
      `UPDATE livres
       SET titre = $1, auteur = $2, annee = $3, genre = $4, resume = $5, couverture = $6,
           fichier = $7, type_fichier = $8, nom_fichier_origine = $9
       WHERE id = $10
       RETURNING *`,
      [
        fusion.titre,
        fusion.auteur,
        fusion.annee,
        fusion.genre,
        fusion.resume,
        fusion.couverture,
        fusion.fichier,
        fusion.type_fichier,
        fusion.nom_fichier_origine,
        Number(id)
      ]
    );
    return result.rows[0];
  }
  Object.assign(actuel, fusion);
  return actuel;
}

async function supprimerLivre(id) {
  const livre = await trouverLivre(id);
  if (!livre) {
    return null;
  }
  if (livre.fichier) {
    const chemin = path.join(UPLOAD_LIVRES, path.basename(livre.fichier));
    fs.promises.unlink(chemin).catch(() => {});
  }
  if (pool) {
    await pool.query("DELETE FROM livres WHERE id = $1", [Number(id)]);
  } else {
    memoire.livres = memoire.livres.filter((l) => l.id !== Number(id));
  }
  return livre;
}

async function creerAbonnement(data) {
  if (pool) {
    const result = await pool.query(
      `INSERT INTO abonnements (utilisateur_id, plan, montant, numero_paiement, fichier_preuve, statut)
       VALUES ($1, $2, $3, $4, $5, 'en_attente')
       RETURNING *`,
      [data.utilisateur_id, data.plan, data.montant, data.numero_paiement, data.fichier_preuve]
    );
    return result.rows[0];
  }
  const abo = {
    id: memoire.next.abonnements++,
    utilisateur_id: data.utilisateur_id,
    plan: data.plan,
    montant: data.montant,
    numero_paiement: data.numero_paiement,
    fichier_preuve: data.fichier_preuve,
    statut: "en_attente",
    date_debut: null,
    date_fin: null,
    created_at: new Date().toISOString()
  };
  memoire.abonnements.push(abo);
  return abo;
}

async function listerAbonnements({ utilisateurId, statut } = {}) {
  let rows;
  if (pool) {
    const result = await pool.query("SELECT * FROM abonnements ORDER BY id DESC");
    rows = result.rows;
  } else {
    rows = [...memoire.abonnements].sort((a, b) => b.id - a.id);
  }
  if (utilisateurId) {
    rows = rows.filter((a) => Number(a.utilisateur_id) === Number(utilisateurId));
  }
  if (statut) {
    rows = rows.filter((a) => a.statut === statut);
  }
  return rows;
}

async function trouverAbonnement(id) {
  const num = Number(id);
  if (pool) {
    const result = await pool.query("SELECT * FROM abonnements WHERE id = $1 LIMIT 1", [num]);
    return result.rows[0] || null;
  }
  return memoire.abonnements.find((a) => a.id === num) || null;
}

async function mettreAJourAbonnement(id, champs) {
  const actuel = await trouverAbonnement(id);
  if (!actuel) {
    return null;
  }
  const fusion = { ...actuel, ...champs };
  if (pool) {
    const result = await pool.query(
      `UPDATE abonnements
       SET statut = $1, date_debut = $2, date_fin = $3
       WHERE id = $4
       RETURNING *`,
      [fusion.statut, fusion.date_debut, fusion.date_fin, Number(id)]
    );
    return result.rows[0];
  }
  Object.assign(actuel, fusion);
  return actuel;
}

async function abonnementCourant(utilisateurId) {
  const liste = await listerAbonnements({ utilisateurId });
  const actifs = liste.filter(abonnementActif);
  if (actifs.length > 0) {
    return actifs[0];
  }
  return liste[0] || null;
}

function echapperPdf(texte) {
  return String(texte)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7EÀ-ÿ’'«»—–-]/g, " ");
}

function couperLignes(texte, max) {
  const mots = String(texte).split(/\s+/);
  const lignes = [];
  let ligne = "";
  for (const mot of mots) {
    const essai = ligne ? `${ligne} ${mot}` : mot;
    if (essai.length > max) {
      if (ligne) {
        lignes.push(ligne);
      }
      ligne = mot;
    } else {
      ligne = essai;
    }
  }
  if (ligne) {
    lignes.push(ligne);
  }
  return lignes;
}

function ecrirePdfSimple(chemin, titre, paragraphes) {
  const commandes = [];
  commandes.push(`BT /F1 18 Tf 50 750 Td (${echapperPdf(titre)}) Tj ET`);
  let y = 710;
  for (const paragraphe of paragraphes) {
    for (const ligne of couperLignes(paragraphe, 86)) {
      if (y < 60) {
        break;
      }
      commandes.push(`BT /F1 11 Tf 50 ${y} Td (${echapperPdf(ligne)}) Tj ET`);
      y -= 16;
    }
    y -= 8;
  }
  const contenu = commandes.join("\n") + "\n";
  const obj4 = `<< /Length ${Buffer.byteLength(contenu)} >>\nstream\n${contenu}endstream\n`;
  const objets = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n${obj4}endobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const objet of objets) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += objet;
  }
  const startxref = Buffer.byteLength(pdf);
  let xref = `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  fs.writeFileSync(chemin, pdf);
}

async function compterLivres() {
  if (pool) {
    const result = await pool.query("SELECT COUNT(*)::int AS n FROM livres");
    return result.rows[0].n;
  }
  return memoire.livres.length;
}

async function remplirDonneesDemo() {
  const existant = await trouverUtilisateurParEmail(ADMIN_EMAIL);
  if (!existant) {
    await creerUtilisateur({
      nom: "Administrateur Marafiki",
      email: ADMIN_EMAIL,
      motDePasse: ADMIN_PASSWORD,
      role: "admin"
    });
    console.log(`Compte admin créé : ${ADMIN_EMAIL}`);
  }

  if ((await compterLivres()) > 0) {
    return;
  }

  const livresDemo = [
    {
      titre: "Les Contes de la rivière",
      auteur: "Collectif Marafiki",
      annee: 2024,
      genre: "Contes",
      couverture: "#1b4332",
      resume:
        "Une veillée au bord de l’eau : trois récits originaux sur l’entraide, la ruse et la mémoire des anciens.",
      fichierNom: "contes-riviere.txt",
      type: "txt",
      texte: [
        "LES CONTES DE LA RIVIÈRE",
        "",
        "Premier conte — La calebasse partagée",
        "Au village de Luzolo, la saison sèche avait duré trop longtemps. Les jarres sonnaient creux. Une enfant, Amina, proposa que chaque famille verse une tasse dans une grande calebasse posée sous l’arbre à palabres. Personne n’avait beaucoup. Tout le monde donna un peu. Le soir, la calebasse était pleine, et personne n’alla se coucher sans boire.",
        "",
        "Deuxième conte — Le pêcheur et le filet troué",
        "Koffi réparait son filet trop vite. Les poissons passaient. Un vieil homme lui dit : « Un nœud bien fait vaut dix nœuds pressés. » Koffi prit le temps. Le matin suivant, le filet tenait, et le marché aussi.",
        "",
        "Troisième conte — La voix des tambours",
        "Quand les tambours parlaient, les enfants apprenaient les noms des rivières. Ainsi la mémoire ne se perdait pas dans la poussière."
      ].join("\n")
    },
    {
      titre: "Poèmes du matin",
      auteur: "Nuru Kalala",
      annee: 2023,
      genre: "Poésie",
      couverture: "#c9a227",
      resume: "Courts poèmes originaux sur l’aube, le marché et le chemin de l’école.",
      fichierNom: "poemes-matin.txt",
      type: "txt",
      texte: [
        "POÈMES DU MATIN",
        "",
        "Aube",
        "Le soleil pose une pièce d’or sur le fleuve.",
        "Les pirogues glissent comme des phrases lentes.",
        "",
        "Marché",
        "Les mangues rient dans les bassines.",
        "On paie en pièces, on repart en parfums.",
        "",
        "Chemin",
        "Mon cartable tape mon dos.",
        "Chaque pas écrit une lettre vers demain."
      ].join("\n")
    },
    {
      titre: "Fables pour les enfants",
      auteur: "Tata Béatrice",
      annee: 2022,
      genre: "Jeunesse",
      couverture: "#bc6c25",
      resume: "Deux fables originales : la chèvre trop pressée et le caillou qui voulait rouler.",
      fichierNom: "fables-enfants.txt",
      type: "txt",
      texte: [
        "FABLES POUR LES ENFANTS",
        "",
        "La chèvre trop pressée",
        "Une chèvre voulut manger toutes les feuilles avant midi. Elle tomba dans le fossé. Une tortue passa et dit : « Mieux vaut une feuille à l’ombre qu’un ventre dans la boue. »",
        "",
        "Le caillou qui voulait rouler",
        "Un caillou enviait la rivière. Il se jeta du talus, heurta un autre caillou, et s’arrêta. La rivière murmura : « Chacun a son rythme. Reste, et tu verras tout l’eau passer. »"
      ].join("\n")
    },
    {
      titre: "Guide de la lecture numérique",
      auteur: "Équipe Marafiki",
      annee: 2025,
      genre: "Guides",
      couverture: "#2d6a4f",
      resume:
        "Comment chercher un livre, s’abonner et lire sur téléphone. Texte original rédigé pour cette bibliothèque.",
      fichierNom: "guide-lecture.txt",
      type: "txt",
      texte: [
        "GUIDE DE LA LECTURE NUMÉRIQUE",
        "",
        "1. Cherchez un titre, un auteur ou un genre dans la barre de recherche.",
        "2. Ouvrez la fiche pour lire le résumé.",
        "3. Pour ouvrir le fichier complet, prenez un abonnement : 500 FC pour 7 jours, ou 759 FC pour 16 jours.",
        "4. Payez au +243841194151 ou au +243998595006, puis envoyez la capture d’écran.",
        "5. L’administrateur valide votre preuve. Ensuite, le bouton Lire s’ouvre."
      ].join("\n")
    },
    {
      titre: "Petite histoire des bibliothèques",
      auteur: "Isaac Mbala",
      annee: 2021,
      genre: "Histoire",
      couverture: "#3a5a40",
      resume:
        "Texte original : pourquoi les communautés gardent des livres, du manuscrit à l’écran.",
      fichierNom: "histoire-bibliotheques.txt",
      type: "txt",
      texte: [
        "PETITE HISTOIRE DES BIBLIOTHÈQUES",
        "",
        "Une bibliothèque n’est pas seulement un meuble. C’est une promesse : demain, quelqu’un pourra encore lire ce qu’aujourd’hui nous savons.",
        "Autrefois, on copiait à la main. Plus tard, l’imprimerie multiplia les pages. Aujourd’hui, un téléphone peut porter des centaines de titres.",
        "Marafiki veut que cette promesse tienne aussi près du fleuve, près de l’école, près de la maison."
      ].join("\n")
    }
  ];

  for (const item of livresDemo) {
    const chemin = path.join(UPLOAD_LIVRES, item.fichierNom);
    fs.writeFileSync(chemin, item.texte, "utf8");
    await creerLivre({
      titre: item.titre,
      auteur: item.auteur,
      annee: item.annee,
      genre: item.genre,
      resume: item.resume,
      couverture: item.couverture,
      fichier: item.fichierNom,
      type_fichier: item.type,
      nom_fichier_origine: item.fichierNom
    });
  }

  const pdfNom = "introduction-litterature.pdf";
  ecrirePdfSimple(path.join(UPLOAD_LIVRES, pdfNom), "Introduction a la litterature", [
    "Ce court document presente la lecture comme un geste collectif.",
    "On y rappelle que chercher un livre, c'est deja commencer a le lire.",
    "Les recits, les poemes et les guides de cette bibliotheque sont des textes originaux destines a Marafiki.",
    "Abonnez-vous pour ouvrir les fichiers complets : 500 FC pour 7 jours, 759 FC pour 16 jours."
  ]);
  await creerLivre({
    titre: "Introduction à la littérature",
    auteur: "Claire Mwamba",
    annee: 2024,
    genre: "Essais",
    resume: "Un essai court, au format PDF, sur la lecture partagée et le rôle d’une bibliothèque de quartier.",
    couverture: "#40916c",
    fichier: pdfNom,
    type_fichier: "pdf",
    nom_fichier_origine: pdfNom
  });

  console.log("Livres de démonstration ajoutés.");
}

function pageHtml(nom) {
  return path.join(PUBLIC_DIR, nom);
}

app.get("/", (req, res) => {
  res.sendFile(pageHtml("index.html"));
});

app.get("/catalogue", (req, res) => {
  res.sendFile(pageHtml("catalogue.html"));
});

app.get("/livre", (req, res) => {
  res.sendFile(pageHtml("livre.html"));
});

app.get("/lire", (req, res) => {
  res.sendFile(pageHtml("lire.html"));
});

app.get("/tarifs", (req, res) => {
  res.sendFile(pageHtml("tarifs.html"));
});

app.get("/compte", (req, res) => {
  res.sendFile(pageHtml("compte.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(pageHtml("admin.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    serveur: "bibliotheque-numerique-marafiki",
    database: Boolean(pool),
    telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/plans", (req, res) => {
  res.json({
    success: true,
    plans: Object.values(PLANS),
    numeros: NUMEROS_PAIEMENT
  });
});

app.get("/api/livres", async (req, res) => {
  try {
    const livres = await listerLivres({ q: req.query.q, genre: req.query.genre });
    const genres = [...new Set(livres.map((l) => l.genre).filter(Boolean))].sort();
    res.json({
      success: true,
      count: livres.length,
      genres,
      data: livres.map((livre) => publicLivre(livre))
    });
  } catch (error) {
    console.error("GET /api/livres :", error);
    res.status(500).json({ success: false, error: "Erreur catalogue" });
  }
});

app.get("/api/livres/:id", async (req, res) => {
  try {
    const livre = await trouverLivre(req.params.id);
    if (!livre) {
      return res.status(404).json({ success: false, error: "Livre introuvable" });
    }
    const user = utilisateurActuel(req);
    let peutLire = false;
    if (user) {
      if (user.role === "admin") {
        peutLire = true;
      } else {
        const abo = await abonnementCourant(user.id);
        peutLire = abonnementActif(abo);
      }
    }
    res.json({
      success: true,
      data: publicLivre(livre),
      peutLire
    });
  } catch (error) {
    console.error("GET /api/livres/:id :", error);
    res.status(500).json({ success: false, error: "Erreur fiche livre" });
  }
});

app.get("/api/livres/:id/fichier", async (req, res) => {
  try {
    const user = utilisateurActuel(req);
    if (!user) {
      return res.status(401).json({ success: false, error: "Connexion requise" });
    }
    if (user.role !== "admin") {
      const abo = await abonnementCourant(user.id);
      if (!abonnementActif(abo)) {
        return res.status(403).json({ success: false, error: "Abonnement actif requis" });
      }
    }
    const livre = await trouverLivre(req.params.id);
    if (!livre || !livre.fichier) {
      return res.status(404).json({ success: false, error: "Fichier introuvable" });
    }
    const chemin = path.join(UPLOAD_LIVRES, path.basename(livre.fichier));
    if (!fs.existsSync(chemin)) {
      return res.status(404).json({ success: false, error: "Fichier absent du disque" });
    }
    const ext = extensionFichier(livre.fichier);
    res.setHeader("Content-Type", mimeDepuisExtension(ext));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(livre.nom_fichier_origine || livre.fichier)}"`
    );
    fs.createReadStream(chemin).pipe(res);
  } catch (error) {
    console.error("GET /api/livres/:id/fichier :", error);
    res.status(500).json({ success: false, error: "Erreur lecture fichier" });
  }
});

app.post("/api/inscription", async (req, res) => {
  try {
    const nom = String(req.body.nom || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const motDePasse = String(req.body.motDePasse || req.body.password || "");
    if (nom.length < 2 || !email.includes("@") || motDePasse.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Nom, e-mail valide et mot de passe (6 caractères min.) requis"
      });
    }
    const deja = await trouverUtilisateurParEmail(email);
    if (deja) {
      return res.status(409).json({ success: false, error: "Cet e-mail est déjà utilisé" });
    }
    const user = await creerUtilisateur({ nom, email, motDePasse, role: "lecteur" });
    const jeton = crypto.randomBytes(24).toString("hex");
    sessions.set(jeton, publicUtilisateur(user));
    definirSession(res, jeton);
    await envoyerTelegram(`Nouvel inscrit Marafiki : ${nom} (${email})`);
    res.json({ success: true, utilisateur: publicUtilisateur(user) });
  } catch (error) {
    console.error("POST /api/inscription :", error);
    res.status(500).json({ success: false, error: "Erreur inscription" });
  }
});

app.post("/api/connexion", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const motDePasse = String(req.body.motDePasse || req.body.password || "");
    const user = await trouverUtilisateurParEmail(email);
    if (!user || !verifierMotDePasse(motDePasse, user.mot_de_passe)) {
      return res.status(401).json({ success: false, error: "E-mail ou mot de passe incorrect" });
    }
    const jeton = crypto.randomBytes(24).toString("hex");
    sessions.set(jeton, publicUtilisateur(user));
    definirSession(res, jeton);
    res.json({ success: true, utilisateur: publicUtilisateur(user) });
  } catch (error) {
    console.error("POST /api/connexion :", error);
    res.status(500).json({ success: false, error: "Erreur connexion" });
  }
});

app.post("/api/deconnexion", (req, res) => {
  const jeton = lireCookie(req, "session");
  if (jeton) {
    sessions.delete(jeton);
  }
  effacerSession(res);
  res.json({ success: true });
});

app.get("/api/moi", async (req, res) => {
  try {
    const user = utilisateurActuel(req);
    if (!user) {
      return res.json({ success: true, utilisateur: null, abonnement: null });
    }
    const frais = await trouverUtilisateurParId(user.id);
    const profil = publicUtilisateur(frais || user);
    const abo = frais ? await abonnementCourant(frais.id) : null;
    res.json({
      success: true,
      utilisateur: profil,
      abonnement: abo
        ? {
            ...abo,
            actif: abonnementActif(abo)
          }
        : null
    });
  } catch (error) {
    console.error("GET /api/moi :", error);
    res.status(500).json({ success: false, error: "Erreur profil" });
  }
});

app.post("/api/abonnements", exigerConnexion, (req, res) => {
  uploadPreuve.single("preuve")(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ success: false, error: err.message || "Fichier de preuve invalide" });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, error: "La capture de paiement est obligatoire" });
      }
      const plan = PLANS[String(req.body.plan || "")];
      if (!plan) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ success: false, error: "Choisissez 7 jours ou 16 jours" });
      }
      const numero = normaliserNumero(req.body.numero || req.body.numero_paiement);
      if (!NUMEROS_PAIEMENT.includes(numero)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({
          success: false,
          error: "Indiquez le numéro utilisé : +243841194151 ou +243998595006"
        });
      }
      const existants = await listerAbonnements({
        utilisateurId: req.utilisateur.id,
        statut: "en_attente"
      });
      if (existants.length > 0) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(409).json({
          success: false,
          error: "Une preuve est déjà en attente de validation"
        });
      }
      const abo = await creerAbonnement({
        utilisateur_id: req.utilisateur.id,
        plan: plan.code,
        montant: plan.montant,
        numero_paiement: numero,
        fichier_preuve: req.file.filename
      });
      const caption = [
        "Preuve de paiement Marafiki",
        `Lecteur : ${req.utilisateur.nom} (${req.utilisateur.email})`,
        `Plan : ${plan.label} — ${plan.montant} FC`,
        `Numéro payé : ${numero}`,
        "Validez ou refusez dans /admin"
      ].join("\n");
      await envoyerTelegramPhoto(req.file.path, caption);
      res.json({ success: true, abonnement: abo });
    } catch (error) {
      console.error("POST /api/abonnements :", error);
      res.status(500).json({ success: false, error: "Erreur envoi de la preuve" });
    }
  });
});

app.get("/api/abonnements", exigerConnexion, async (req, res) => {
  try {
    const liste = await listerAbonnements({ utilisateurId: req.utilisateur.id });
    res.json({
      success: true,
      data: liste.map((abo) => ({ ...abo, actif: abonnementActif(abo) }))
    });
  } catch (error) {
    console.error("GET /api/abonnements :", error);
    res.status(500).json({ success: false, error: "Erreur abonnements" });
  }
});

app.get("/api/admin/abonnements", exigerAdmin, async (req, res) => {
  try {
    const liste = await listerAbonnements({ statut: req.query.statut });
    const enrichis = [];
    for (const abo of liste) {
      const user = await trouverUtilisateurParId(abo.utilisateur_id);
      enrichis.push({
        ...abo,
        actif: abonnementActif(abo),
        utilisateur: publicUtilisateur(user)
      });
    }
    res.json({ success: true, data: enrichis });
  } catch (error) {
    console.error("GET /api/admin/abonnements :", error);
    res.status(500).json({ success: false, error: "Erreur file d’attente" });
  }
});

app.get("/api/admin/preuves/:id", exigerAdmin, async (req, res) => {
  try {
    const abo = await trouverAbonnement(req.params.id);
    if (!abo || !abo.fichier_preuve) {
      return res.status(404).json({ success: false, error: "Preuve introuvable" });
    }
    const chemin = path.join(UPLOAD_PREUVES, path.basename(abo.fichier_preuve));
    if (!fs.existsSync(chemin)) {
      return res.status(404).json({ success: false, error: "Image absente" });
    }
    res.setHeader("Content-Type", mimeDepuisExtension(extensionFichier(chemin)));
    fs.createReadStream(chemin).pipe(res);
  } catch (error) {
    console.error("GET /api/admin/preuves/:id :", error);
    res.status(500).json({ success: false, error: "Erreur preuve" });
  }
});

app.post("/api/admin/abonnements/:id/valider", exigerAdmin, async (req, res) => {
  try {
    const abo = await trouverAbonnement(req.params.id);
    if (!abo) {
      return res.status(404).json({ success: false, error: "Abonnement introuvable" });
    }
    const plan = PLANS[abo.plan];
    const debut = new Date();
    const fin = new Date(debut.getTime() + plan.jours * 24 * 60 * 60 * 1000);
    const maj = await mettreAJourAbonnement(abo.id, {
      statut: "actif",
      date_debut: debut.toISOString(),
      date_fin: fin.toISOString()
    });
    const user = await trouverUtilisateurParId(abo.utilisateur_id);
    await envoyerTelegram(
      `Abonnement validé : ${user ? user.nom : abo.utilisateur_id} — ${plan.label} jusqu’au ${fin.toLocaleDateString("fr-FR")}`
    );
    res.json({ success: true, abonnement: maj });
  } catch (error) {
    console.error("POST valider :", error);
    res.status(500).json({ success: false, error: "Erreur validation" });
  }
});

app.post("/api/admin/abonnements/:id/refuser", exigerAdmin, async (req, res) => {
  try {
    const abo = await trouverAbonnement(req.params.id);
    if (!abo) {
      return res.status(404).json({ success: false, error: "Abonnement introuvable" });
    }
    const maj = await mettreAJourAbonnement(abo.id, {
      statut: "refuse",
      date_debut: abo.date_debut,
      date_fin: abo.date_fin
    });
    res.json({ success: true, abonnement: maj });
  } catch (error) {
    console.error("POST refuser :", error);
    res.status(500).json({ success: false, error: "Erreur refus" });
  }
});

app.post("/api/admin/livres", exigerAdmin, (req, res) => {
  uploadLivre.single("fichier")(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ success: false, error: err.message || "Fichier livre invalide" });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, error: "Déposez un fichier (PDF, EPUB ou autre)" });
      }
      const titre = String(req.body.titre || "").trim();
      const auteur = String(req.body.auteur || "").trim();
      if (!titre || !auteur) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ success: false, error: "Titre et auteur requis" });
      }
      const ext = extensionFichier(req.file.originalname);
      const livre = await creerLivre({
        titre,
        auteur,
        annee: req.body.annee ? Number(req.body.annee) : null,
        genre: String(req.body.genre || "Autres").trim(),
        resume: String(req.body.resume || "").trim(),
        couverture: String(req.body.couverture || "#1b4332").trim(),
        fichier: req.file.filename,
        type_fichier: typeDepuisExtension(ext),
        nom_fichier_origine: req.file.originalname
      });
      await envoyerTelegram(`Nouveau livre déposé : ${titre} — ${auteur} (${ext})`);
      res.json({ success: true, livre: publicLivre(livre) });
    } catch (error) {
      console.error("POST /api/admin/livres :", error);
      res.status(500).json({ success: false, error: "Erreur dépôt du livre" });
    }
  });
});

app.put("/api/admin/livres/:id", exigerAdmin, async (req, res) => {
  try {
    const actuel = await trouverLivre(req.params.id);
    if (!actuel) {
      return res.status(404).json({ success: false, error: "Livre introuvable" });
    }
    const maj = await mettreAJourLivre(req.params.id, {
      titre: String(req.body.titre || actuel.titre).trim(),
      auteur: String(req.body.auteur || actuel.auteur).trim(),
      annee: req.body.annee ? Number(req.body.annee) : actuel.annee,
      genre: String(req.body.genre || actuel.genre || "").trim(),
      resume: String(req.body.resume ?? actuel.resume),
      couverture: String(req.body.couverture || actuel.couverture || "#1b4332")
    });
    res.json({ success: true, livre: publicLivre(maj) });
  } catch (error) {
    console.error("PUT /api/admin/livres/:id :", error);
    res.status(500).json({ success: false, error: "Erreur modification" });
  }
});

app.delete("/api/admin/livres/:id", exigerAdmin, async (req, res) => {
  try {
    const livre = await supprimerLivre(req.params.id);
    if (!livre) {
      return res.status(404).json({ success: false, error: "Livre introuvable" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/admin/livres/:id :", error);
    res.status(500).json({ success: false, error: "Erreur suppression" });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Route introuvable",
    route: req.originalUrl
  });
});

async function demarrer() {
  try {
    await initialiserBase();
    await remplirDonneesDemo();
  } catch (error) {
    console.error("Initialisation :", error);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log("======================================");
    console.log(" BIBLIOTHÈQUE NUMÉRIQUE MARAFIKI");
    console.log("======================================");
    console.log("PORT :", PORT);
    console.log("PAGES : / /catalogue /tarifs /compte /admin");
    console.log("DATABASE :", pool ? "CONNECTEE" : "MEMOIRE");
    console.log("TELEGRAM :", TELEGRAM_BOT_TOKEN ? "CONFIGURE" : "NON CONFIGURE");
    console.log("ADMIN :", ADMIN_EMAIL);
    console.log("======================================");
  });
}

demarrer();
