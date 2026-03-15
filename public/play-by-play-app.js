const pageTitleEl = document.getElementById("page-title");
const backLinkEl = document.getElementById("pbp-back-link");
const desktopLinkEl = document.getElementById("pbp-desktop-link");
const refreshBtnEl = document.getElementById("pbp-refresh-btn");

initPlayByPlayAppChrome();

function initPlayByPlayAppChrome() {
  const params = new URLSearchParams(window.location.search);
  const id = Number.parseInt(params.get("id") || "", 10);
  const date = params.get("date");

  if (backLinkEl) {
    if (Number.isFinite(id)) {
      const gameParams = new URLSearchParams({ id: String(id) });
      if (date) {
        gameParams.set("date", date);
      }
      backLinkEl.href = `/game.html?${gameParams.toString()}`;
      backLinkEl.textContent = "← Game Dashboard";
    } else if (date) {
      backLinkEl.href = `/?date=${encodeURIComponent(date)}`;
    }
  }

  if (desktopLinkEl) {
    desktopLinkEl.href = Number.isFinite(id) ? `/usm-live-169.html?id=${id}` : "/usm-live-169.html";
  }

  if (refreshBtnEl) {
    refreshBtnEl.addEventListener("click", () => {
      window.location.reload();
    });
  }

  if (pageTitleEl) {
    const syncDocumentTitle = () => {
      const title = String(pageTitleEl.textContent || "").trim();
      document.title = title ? `${title} • Play-by-Play App` : "Play-by-Play App • NCAA Baseball";
    };

    syncDocumentTitle();
    new MutationObserver(syncDocumentTitle).observe(pageTitleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
}
