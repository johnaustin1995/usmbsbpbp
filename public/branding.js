(function bootstrapBranding() {
  const BRANDING_DATA_URL = "/data/team-branding.json";
  const brandByName = new Map();
  let loadPromise = null;

  function load() {
    if (loadPromise) {
      return loadPromise;
    }

    loadPromise = fetch(BRANDING_DATA_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Branding request failed (${response.status})`);
        }
        return response.json();
      })
      .then((payload) => {
        buildIndex(payload);
        return {
          loadedTeams: brandByName.size,
        };
      })
      .catch((error) => {
        // Swallow load errors so UI can continue without branding.
        // eslint-disable-next-line no-console
        console.warn("Branding load failed:", error);
        return {
          loadedTeams: 0,
        };
      });

    return loadPromise;
  }

  function buildIndex(payload) {
    brandByName.clear();

    const teams = Array.isArray(payload?.teams) ? payload.teams : [];
    teams.forEach((team) => {
      const keys = new Set([
        team?.school,
        team?.displayName,
        team?.shortDisplayName,
        team?.abbreviation,
        ...(Array.isArray(team?.aliases) ? team.aliases : []),
      ]);

      keys.forEach((value) => {
        const normalized = normalizeTeamName(value);
        if (!normalized) {
          return;
        }

        if (!brandByName.has(normalized)) {
          brandByName.set(normalized, team);
        }
      });
    });
  }

  function lookup(teamName) {
    const normalized = normalizeTeamName(teamName);
    if (!normalized) {
      return null;
    }

    return brandByName.get(normalized) || null;
  }

  function chooseLogo(teamBranding, options = {}) {
    const preferDark = options.preferDark === true;
    if (!teamBranding || !teamBranding.logo) {
      return null;
    }

    const primary = teamBranding.logo.primary || null;
    const dark = teamBranding.logo.dark || null;
    const first = preferDark ? dark : primary;
    const fallback = preferDark ? primary : dark;

    return resolveLogoPath(first) || resolveLogoPath(fallback);
  }

  function resolveLogoPath(logoEntry) {
    if (!logoEntry) {
      return null;
    }

    return logoEntry.localPath || logoEntry.href || null;
  }

  function safeColor(value) {
    const raw = String(value || "").trim().replace(/^#/u, "");
    if (!/^[0-9a-fA-F]{6}$/u.test(raw)) {
      return null;
    }

    return `#${raw.toUpperCase()}`;
  }

  function normalizeTeamName(value) {
    const input = String(value || "").trim();
    if (!input) {
      return "";
    }

    return input
      .replace(/^#\d+\s+/u, "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\w\s]/g, " ")
      .replace(/\buniversity\b/g, "u")
      .replace(/\bstate\b/g, "st")
      .replace(/\bsaint\b/g, "st")
      .replace(/\bmount\b/g, "mt")
      .replace(/\s+/g, " ")
      .trim();
  }

  window.ncaabsbBranding = {
    load,
    lookup,
    chooseLogo,
    safeColor,
    normalizeTeamName,
  };
})();
