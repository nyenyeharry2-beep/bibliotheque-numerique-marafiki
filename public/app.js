const NUMEROS = ["+243841194151", "+243998595006"];

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isForm = options.body instanceof FormData;
  if (!isForm && options.body && typeof options.body === "object" && !(options.body instanceof URLSearchParams)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const reponse = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers
  });
  const type = reponse.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await reponse.json() : null;
  if (!reponse.ok) {
    throw new Error((data && data.error) || `Erreur ${reponse.status}`);
  }
  return data;
}

function params() {
  return new URLSearchParams(window.location.search);
}

function formatDate(valeur) {
  if (!valeur) {
    return "—";
  }
  return new Date(valeur).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatNumero(numero) {
  const n = String(numero || "").replace(/\s/g, "");
  if (n === "+243841194151") {
    return "+243 841 194 151";
  }
  if (n === "+243998595006") {
    return "+243 998 595 006";
  }
  return numero;
}

function statutLabel(abo) {
  if (!abo) {
    return "Aucun abonnement";
  }
  if (abo.actif || (abo.statut === "actif" && new Date(abo.date_fin) > new Date())) {
    return `Actif jusqu’au ${formatDate(abo.date_fin)}`;
  }
  if (abo.statut === "en_attente") {
    return "Preuve en attente de validation";
  }
  if (abo.statut === "refuse") {
    return "Preuve refusée";
  }
  return "Abonnement expiré";
}

function headerHtml(utilisateur) {
  const compte = utilisateur
    ? `<a href="/compte">${utilisateur.role === "admin" ? "Admin" : "Mon compte"}</a>`
    : `<a href="/compte">Connexion</a>`;
  const admin = utilisateur && utilisateur.role === "admin" ? `<a href="/admin">Administration</a>` : "";
  return `
    <header class="site-header">
      <div class="wrap site-header__inner">
        <a class="brand" href="/">
          <span class="brand__mark">M</span>
          <div>
            <p class="brand__eyebrow">Communauté de lecture</p>
            <h1>Bibliothèque numérique Marafiki</h1>
          </div>
        </a>
        <nav class="site-header__nav">
          <a href="/">Accueil</a>
          <a href="/catalogue">Catalogue</a>
          <a href="/tarifs">Tarifs</a>
          ${admin}
          ${compte}
        </nav>
      </div>
    </header>
  `;
}

function footerHtml() {
  return `
    <footer class="site-footer">
      <div class="wrap">
        Marafiki — 500 FC / 7 jours · 759 FC / 16 jours · paiement au +243 841 194 151 ou +243 998 595 006
      </div>
    </footer>
  `;
}

function carteLivre(livre) {
  const couleur = livre.couverture || "#1b4332";
  const initiale = (livre.titre || "M").trim().charAt(0).toUpperCase();
  return `
    <a class="book-card" href="/livre?id=${encodeURIComponent(livre.id)}">
      <div class="book-card__cover" style="background:${couleur}">${initiale}</div>
      <div class="book-card__body">
        <h3>${escapeHtml(livre.titre)}</h3>
        <p>${escapeHtml(livre.auteur)}</p>
        <p class="meta">${escapeHtml(livre.genre || "")} · ${escapeHtml(String(livre.type_fichier || "").toUpperCase())}</p>
      </div>
    </a>
  `;
}

function escapeHtml(texte) {
  return String(texte ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function bootstrapPage() {
  let moi = { utilisateur: null, abonnement: null };
  try {
    moi = await api("/api/moi");
  } catch (error) {
    console.error(error);
  }
  const shell = document.getElementById("app-shell");
  if (shell) {
    shell.insertAdjacentHTML("afterbegin", headerHtml(moi.utilisateur));
    shell.insertAdjacentHTML("beforeend", footerHtml());
  }
  document.querySelectorAll(".site-header__nav a").forEach((lien) => {
    const href = lien.getAttribute("href");
    if (href === window.location.pathname) {
      lien.classList.add("active");
    }
  });
  return moi;
}

window.Marafiki = {
  api,
  params,
  formatDate,
  formatNumero,
  statutLabel,
  carteLivre,
  escapeHtml,
  bootstrapPage,
  NUMEROS
};
