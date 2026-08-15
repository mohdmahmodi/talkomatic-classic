/**
 * Talkomatic Update Popup Manager
 * Handles showing update popups based on version changes and time intervals
 */
class TalkomaticPopupManager {
  constructor() {
    // Current version - update this when you release new versions.
    // Bumping this re-shows the popup to everyone (see shouldShowPopup).
    this.currentVersion = "5.5.0";
    // Cookie names
    this.cookieNames = {
      lastShown: "talkomatic_popup_last_shown",
      lastVersion: "talkomatic_popup_last_version",
    };
    // Time intervals (in milliseconds)
    this.intervals = {
      thirtyDays: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
    };
    this.popupContainer = null;
    this.isPopupVisible = false;
  }

  /**
   * Initialize the popup manager - call this on page load
   */
  init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () =>
        this.checkAndShowPopup(),
      );
    } else {
      this.checkAndShowPopup();
    }
  }

  /**
   * Check if popup should be shown and display it if needed
   */
  checkAndShowPopup() {
    if (this.shouldShowPopup()) {
      this.createAndShowPopup();
    }
  }

  /**
   * Determine if the popup should be shown
   * @returns {boolean} - true if popup should be shown
   */
  shouldShowPopup() {
    const lastShown = this.getCookie(this.cookieNames.lastShown);
    const lastVersion = this.getCookie(this.cookieNames.lastVersion);
    // First visit - show popup
    if (!lastShown || !lastVersion) {
      return true;
    }
    // Version changed - show popup regardless of time
    if (lastVersion !== this.currentVersion) {
      return true;
    }
    // Same version - check if 30 days have passed
    const lastShownDate = new Date(parseInt(lastShown));
    const now = new Date();
    const timeDifference = now.getTime() - lastShownDate.getTime();
    return timeDifference >= this.intervals.thirtyDays;
  }

  /**
   * Create popup styles
   */
  createPopupStyles() {
    const styleId = "talkomatic-popup-styles";
    if (document.getElementById(styleId)) {
      return; // Styles already added
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
            /* Talkomatic Popup Styles */
            .talkomatic-popup-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.85);
                z-index: 999999;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
                box-sizing: border-box;
                animation: talkomaticFadeIn 0.3s ease-in-out;
            }
            @keyframes talkomaticFadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes talkomaticFadeOut {
                from { opacity: 1; }
                to { opacity: 0; }
            }
            @keyframes talkomaticSlideIn {
                from {
                    transform: translateY(-30px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
            .talkomatic-popup-content {
                background-color: #202020;
                border: 1px solid #616161;
                border-radius: 2px;
                max-width: 950px;
                width: 100%;
                max-height: 90vh;
                overflow-y: auto;
                position: relative;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
                color: white;
                font-family: Arial, sans-serif;
                animation: talkomaticSlideIn 0.3s ease-out;
            }
            .talkomatic-popup-header {
                background: linear-gradient(to bottom, #616161, #303030);
                padding: 2rem;
                position: relative;
                border-bottom: 1px solid #616161;
            }
            .talkomatic-popup-close {
                position: absolute;
                right: 1rem;
                top: 1rem;
                font-size: 1.8rem;
                cursor: pointer;
                color: #FF9800;
                transition: all 0.2s;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: 1px solid #616161;
                border-radius: 2px;
                background-color: #000000;
            }
            .talkomatic-popup-close:hover {
                background-color: #FF9800;
                color: #000000;
                transform: scale(1.1);
            }
            .talkomatic-popup-title {
                margin: 0;
                font-size: 26px;
                font-weight: bold;
                color: #FF9800;
                margin-bottom: 0.5rem;
                padding-right: 40px;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            .talkomatic-popup-version {
                margin: 0;
                font-size: 14px;
                color: #ffffff;
                opacity: 0.9;
                font-weight: 500;
            }
            .talkomatic-version-pill {
                display: inline-block;
                background: #FF9800;
                color: #000000;
                font-size: 12px;
                font-weight: bold;
                padding: 3px 12px;
                border-radius: 2px;
                margin-top: 10px;
                letter-spacing: 1px;
                text-transform: uppercase;
            }
            .talkomatic-popup-body {
                padding: 2rem;
                line-height: 1.6;
            }
            .talkomatic-update-section {
                margin-bottom: 3rem;
            }
            .talkomatic-update-section h3 {
                color: #FF9800;
                margin-bottom: 1.5rem;
                font-size: 22px;
                font-weight: bold;
                border-bottom: 2px solid #FF9800;
                padding-bottom: 0.5rem;
            }
            .talkomatic-feature-list {
                list-style: none;
                padding: 0;
                margin-bottom: 1rem;
            }
            .talkomatic-feature-list li {
                padding: 15px 0;
                border-bottom: 1px solid #404040;
                position: relative;
                padding-left: 30px;
                color: #ffffff;
                font-size: 15px;
                transition: background-color 0.2s ease;
            }
            .talkomatic-feature-list li:hover {
                background-color: rgba(255, 152, 0, 0.05);
                border-radius: 2px;
                margin: 0 -10px;
                padding-left: 40px;
                padding-right: 10px;
            }
            .talkomatic-feature-list li:before {
                content: "\\2022";
                color: #FF9800;
                font-weight: bold;
                position: absolute;
                left: 0;
                font-size: 20px;
            }
            .talkomatic-feature-list li:last-child {
                border-bottom: none;
            }
            .talkomatic-feature-list.tk-iconed li {
                padding-left: 40px;
            }
            .talkomatic-feature-list.tk-iconed li:hover {
                margin: 0;
                padding-left: 40px;
                padding-right: 0;
            }
            .talkomatic-feature-list.tk-iconed li:before {
                display: none;
            }
            .talkomatic-feature-list .tk-lic {
                position: absolute;
                left: 8px;
                top: 18px;
                color: #FF9800;
                font-size: 15px;
                width: 22px;
                text-align: center;
            }
            .talkomatic-update-section h3 i {
                margin-right: 8px;
            }
            .talkomatic-feature-icon i {
                line-height: 1;
            }
            .talkomatic-badge {
                display: inline-block;
                padding: 4px 10px;
                border-radius: 2px;
                font-size: 11px;
                font-weight: bold;
                margin-left: 12px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .talkomatic-badge.new {
                background: #FF9800;
                color: #000000;
                box-shadow: 0 2px 4px rgba(255, 152, 0, 0.3);
            }
            .talkomatic-badge.improved {
                background: #01ffff;
                color: #000000;
                box-shadow: 0 2px 4px rgba(1, 255, 255, 0.3);
            }
            .talkomatic-badge.fixed {
                background: #616161;
                color: #ffffff;
                box-shadow: 0 2px 4px rgba(97, 97, 97, 0.3);
            }
            .talkomatic-badge.privacy {
                background: #4caf50;
                color: #000000;
                box-shadow: 0 2px 4px rgba(76, 175, 80, 0.3);
            }
            .talkomatic-feature-grid {
                display: grid;
                gap: 1.5rem;
                margin-top: 1rem;
            }
            .talkomatic-feature-item {
                background-color: #000000;
                padding: 2rem;
                border-radius: 2px;
                border: 1px solid #616161;
                transition: all 0.3s ease;
                text-align: center;
            }
            .talkomatic-feature-item:hover {
                border-color: #FF9800;
                transform: translateY(-4px);
                box-shadow: 0 8px 20px rgba(255, 152, 0, 0.15);
            }
            .talkomatic-feature-icon {
                width: 56px;
                height: 56px;
                margin: 0 auto 1.5rem;
                background: linear-gradient(135deg, #FF9800, #ff8c42);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 28px;
                color: #000000;
                box-shadow: 0 4px 12px rgba(255, 152, 0, 0.3);
            }
            .talkomatic-feature-item h4 {
                margin: 0.5rem 0 1rem 0;
                color: #FF9800;
                font-size: 18px;
                font-weight: bold;
            }
            .talkomatic-feature-item p {
                margin: 0;
                color: #cccccc;
                font-size: 15px;
                line-height: 1.6;
            }
            .talkomatic-highlight-box {
                background: linear-gradient(135deg, #000000, #1a1a1a);
                border: 2px solid #FF9800;
                border-radius: 2px;
                padding: 2rem;
                margin: 2rem 0;
                position: relative;
                overflow: hidden;
            }
            .talkomatic-highlight-box:before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg, #FF9800, #ff8c42, #FF9800);
            }
            .talkomatic-highlight-box h4 {
                color: #FF9800;
                margin-bottom: 1rem;
                font-size: 20px;
                font-weight: bold;
            }
            .talkomatic-highlight-box p {
                color: #ffffff;
                margin: 0;
                font-size: 16px;
                line-height: 1.6;
            }
            .talkomatic-popup-footer {
                padding: 24px 2rem;
                background: linear-gradient(to bottom, #000000, #1a1a1a);
                border-radius: 0 0 2px 2px;
                border-top: 1px solid #616161;
                text-align: center;
            }
            .talkomatic-popup-footer button {
                padding: 14px 24px;
                background-color: #000000;
                color: white;
                border: 2px solid #FF9800;
                border-radius: 2px;
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
                transition: all 0.3s ease;
                font-family: inherit;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            .talkomatic-popup-footer button:hover {
                background-color: #FF9800;
                color: #000000;
                transform: translateY(-2px);
                box-shadow: 0 6px 16px rgba(255, 152, 0, 0.4);
            }
            .talkomatic-popup-content::-webkit-scrollbar {
                width: 12px;
            }
            .talkomatic-popup-content::-webkit-scrollbar-track {
                background: #202020;
            }
            .talkomatic-popup-content::-webkit-scrollbar-thumb {
                background: #FF9800;
                border-radius: 2px;
            }
            @media (min-width: 768px) {
                .talkomatic-feature-grid {
                    grid-template-columns: repeat(2, 1fr);
                }
            }
            @media (min-width: 992px) {
                .talkomatic-feature-grid {
                    grid-template-columns: repeat(3, 1fr);
                }
            }
            @media (max-width: 767px) {
                .talkomatic-popup-content {
                    width: 95%;
                    margin: 1rem;
                    max-height: 95vh;
                }
                .talkomatic-popup-header {
                    padding: 1.5rem;
                }
                .talkomatic-popup-body {
                    padding: 1.5rem;
                }
                .talkomatic-popup-title {
                    font-size: 22px;
                    margin-bottom: 1rem;
                }
                .talkomatic-update-section h3 {
                    font-size: 20px;
                    margin-bottom: 1rem;
                }
                .talkomatic-feature-item {
                    padding: 1.5rem;
                }
                .talkomatic-feature-item h4 {
                    font-size: 16px;
                }
                .talkomatic-feature-item p {
                    font-size: 14px;
                }
                .talkomatic-popup-close {
                    right: 0.5rem;
                    top: 0.5rem;
                }
                .talkomatic-feature-grid {
                    grid-template-columns: 1fr;
                }
            }
            @media (max-width: 600px) {
                .talkomatic-popup-footer button {
                    padding: 12px 20px;
                    font-size: 14px;
                }
            }
        `;
    document.head.appendChild(style);
  }

  /**
   * Create popup HTML content
   */
  createPopupHTML() {
    const currentDate = new Date().toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    return `
            <div class="talkomatic-popup-overlay">
                <div class="talkomatic-popup-content">
                    <div class="talkomatic-popup-header">
                        <button class="talkomatic-popup-close" data-action="close">&times;</button>
                        <h2 class="talkomatic-popup-title"><i class="fas fa-wand-magic-sparkles"></i> What's New in Talkomatic</h2>
                        <p class="talkomatic-popup-version">Suggestion Board, Custom Themes, Avatars, Games &amp; More, ${currentDate}</p>
                        <span class="talkomatic-version-pill">Version 5.5</span>
                    </div>

                    <div class="talkomatic-popup-body">

                        <div class="talkomatic-update-section">
                            <div class="talkomatic-highlight-box">
                                <h4>The community update</h4>
                                <p>This is one of the biggest Talkomatic updates ever. There is now a public Suggestion Board where your ideas get voted on and you can watch them ship. You can repaint the entire site, lobby and rooms, with a visual theme editor and share your themes with everyone. Your Discord picture can ride along next to your name.</p>
                            </div>
                        </div>

                        <div class="talkomatic-update-section">
                            <h3><i class="fas fa-star"></i> The Highlights</h3>
                            <div class="talkomatic-feature-grid">
                                <div class="talkomatic-feature-item">
                                    <div class="talkomatic-feature-icon"><i class="fas fa-lightbulb"></i></div>
                                    <h4>Suggestion Board</h4>
                                    <p>A public board in the lobby. Post ideas, upvote or downvote, reply to each other, and see exactly what gets approved, declined, or shipped.</p>
                                </div>
                                <div class="talkomatic-feature-item">
                                    <div class="talkomatic-feature-icon"><i class="fas fa-palette"></i></div>
                                    <h4>Custom Themes</h4>
                                    <p>Recolor everything with zero CSS. Pick colors, fonts, roundness, and effects like glass, then publish your theme for everyone to use.</p>
                                </div>
                                <div class="talkomatic-feature-item">
                                    <div class="talkomatic-feature-icon"><i class="fab fa-discord"></i></div>
                                    <h4>Discord Avatars</h4>
                                    <p>Show your Discord profile picture next to your name in the lobby, in rooms, and on the board. Safe by design, it uses Discord's own moderated avatars.</p>
                                </div>
                            </div>
                        </div>

                        <div class="talkomatic-update-section">
                            <h3><i class="fas fa-lightbulb"></i> The Suggestion Board</h3>
                            <ul class="talkomatic-feature-list tk-iconed">
                                <li><i class="fas fa-comments tk-lic"></i> Everyone can post ideas, reply, and vote. Open it from the lobby menu <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-rocket tk-lic"></i> Ideas carry a visible status: Approved, Declined, or Implemented, set by the devs for all to see <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-shield-halved tk-lic"></i> Staff posts wear real MOD and DEV badges that cannot be faked, and the word filter is always on here <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-bolt tk-lic"></i> New posts appear live while you browse, without losing your place or the reply you were typing <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-scale-balanced tk-lic"></i> Voting is one per person with limits that stop new-tab vote farming, and posting is capped at 3 ideas a day <span class="talkomatic-badge new">NEW</span></li>
                            </ul>
                        </div>

                        <div class="talkomatic-update-section">
                            <h3><i class="fas fa-palette"></i> Make Talkomatic Yours</h3>
                            <ul class="talkomatic-feature-list tk-iconed">
                                <li><i class="fas fa-eye-dropper tk-lic"></i> A visual theme editor with live preview: press Customize in the lobby, or Apps then Theme Editor in a room. No CSS needed <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-layer-group tk-lic"></i> Effect styles that change the whole feel: Glassmorphism, Neo-brutalism, or Soft, plus a corner roundness slider <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-font tk-lic"></i> Google font pickers for the main text, headings, and even your chat text in rooms <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-upload tk-lic"></i> Publish your theme to the redesigned Themes page, browse community themes with palette previews, and apply any of them in one click <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-code tk-lic"></i> Power users get an Advanced mode with every knob and a raw custom CSS box <span class="talkomatic-badge new">NEW</span></li>
                            </ul>
                        </div>


                        <div class="talkomatic-update-section">
                            <h3><i class="fas fa-gears"></i> Under the Hood</h3>
                            <ul class="talkomatic-feature-list tk-iconed">
                                <li><i class="fab fa-docker tk-lic"></i> Talkomatic can now be self-hosted with Docker or Dokploy in a few minutes, with data that survives redeploys <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-heart-pulse tk-lic"></i> New public health and status APIs power uptime monitoring, so problems get spotted before you feel them <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-signal tk-lic"></i> A live status page at <a href="https://status.talkomatic.co" target="_blank" rel="noopener noreferrer" style="color:#FF9800">status.talkomatic.co</a> shows whether Talkomatic and its services are up, in real time <span class="talkomatic-badge new">NEW</span></li>
                                <li><i class="fas fa-broom tk-lic"></i> The whole repository was reorganized and documented, with a rewritten README and proper API docs for bot builders <span class="talkomatic-badge improved">IMPROVED</span></li>
                                <li><i class="fas fa-user-secret tk-lic"></i> Your IP address stays private. Only developers can ever see it, never moderators or other users <span class="talkomatic-badge privacy">PRIVACY</span></li>
                            </ul>
                        </div>

                        <div class="talkomatic-update-section">
                            <div class="talkomatic-highlight-box">
                                <h4>Built with you</h4>
                                <p>Half of this update came straight from your ideas, and now there is a whole board for the other half. Post what you want next, vote on what matters, and watch it ship. Thanks for typing letter by letter with us.</p>
                            </div>
                        </div>

                    </div>

                    <div class="talkomatic-popup-footer">
                        <button data-action="close">Got it</button>
                    </div>
                </div>
            </div>
`;
  }

  /**
   * Create and show the popup
   */
  createAndShowPopup() {
    try {
      this.createPopupStyles();
      this.createPopupContainer();
      this.popupContainer.innerHTML = this.createPopupHTML();
      document.body.appendChild(this.popupContainer);
      this.showPopup();
      this.setupEventHandlers();
      this.isPopupVisible = true;
    } catch (error) {
      console.error("Error creating popup:", error);
    }
  }

  /**
   * Create the popup container element
   */
  createPopupContainer() {
    this.popupContainer = document.createElement("div");
    this.popupContainer.id = "talkomatic-popup-container";
    this.popupContainer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 999999;
            pointer-events: all;
        `;
  }

  /**
   * Show the popup with animation
   */
  showPopup() {
    if (this.popupContainer) {
      this.popupContainer.style.display = "block";
      document.body.style.overflow = "hidden";
    }
  }

  /**
   * Set up event handlers for closing the popup
   */
  setupEventHandlers() {
    this.popupContainer.addEventListener("click", (e) => {
      if (e.target.dataset.action === "close") {
        this.closePopup();
      }
      if (e.target.classList.contains("talkomatic-popup-overlay")) {
        this.closePopup();
      }
    });
    this.keyHandler = (e) => {
      if (e.key === "Escape" && this.isPopupVisible) {
        this.closePopup();
      }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  /**
   * Close the popup and save the state
   */
  closePopup() {
    if (!this.isPopupVisible) return;
    const popupElement = this.popupContainer?.querySelector(
      ".talkomatic-popup-overlay",
    );
    if (popupElement) {
      popupElement.style.animation = "talkomaticFadeOut 0.3s ease-in-out";
      setTimeout(() => {
        if (this.popupContainer && this.popupContainer.parentNode) {
          this.popupContainer.parentNode.removeChild(this.popupContainer);
        }
        document.body.style.overflow = "";
        this.savePopupState();
        if (this.keyHandler) {
          document.removeEventListener("keydown", this.keyHandler);
          this.keyHandler = null;
        }
        this.isPopupVisible = false;
        this.popupContainer = null;
      }, 300);
    }
  }

  /**
   * Save the current state to cookies
   */
  savePopupState() {
    const now = new Date().getTime();
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);
    this.setCookie(this.cookieNames.lastShown, now.toString(), expiryDate);
    this.setCookie(
      this.cookieNames.lastVersion,
      this.currentVersion,
      expiryDate,
    );
  }

  /**
   * Set a cookie
   */
  setCookie(name, value, expiry) {
    const expires = expiry ? "; expires=" + expiry.toUTCString() : "";
    document.cookie = `${name}=${value}${expires}; path=/; SameSite=Lax`;
  }

  /**
   * Get a cookie value
   */
  getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(";");
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === " ") c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
  }

  /**
   * Manually show the popup (for testing or admin purposes)
   */
  forceShowPopup() {
    this.createAndShowPopup();
  }

  /**
   * Reset popup state (clear cookies)
   */
  resetPopupState() {
    document.cookie = `${this.cookieNames.lastShown}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `${this.cookieNames.lastVersion}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
  }

  /**
   * Update the current version (call this when deploying new versions)
   */
  updateVersion(newVersion) {
    this.currentVersion = newVersion;
  }
}

// Auto-initialize when script loads
const talkomaticPopup = new TalkomaticPopupManager();
talkomaticPopup.init();
window.TalkomaticPopup = talkomaticPopup;
